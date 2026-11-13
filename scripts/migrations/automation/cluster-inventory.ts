#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { anomalySummary, computeAnomalies, IGNORED_MIGRATION_DOMAINS, parseInventoryOptions, sha256, writeReports, type ConsumerEntry, type ContainerType, type InventoryReport } from './inventory-common.js';

const WORKLOAD_RESOURCES = ['deployments', 'cronjobs'];
const FLYWAY_MOUNT_PATH = /^\/flyway\/sql(\/|$)/;
const SQL_KEY = /\.sql$/i;

function kubectl(context: string, namespace: string, resource: string): any {
  const result = spawnSync('kubectl', ['--context', context, '-n', namespace, 'get', resource, '-o', 'json'], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`kubectl get ${resource} failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

/** `kubectl get` on a missing namespace returns an empty list: fail explicitly instead of reporting zero resources. */
function assertNamespace(context: string, namespace: string): void {
  const result = spawnSync('kubectl', ['--context', context, 'get', 'namespace', namespace, '-o', 'name'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Namespace '${namespace}' not found or not readable in context '${context}': ${result.stderr.trim()}`);
}

function podSpec(item: any): any {
  return item.kind === 'CronJob' ? item.spec?.jobTemplate?.spec?.template?.spec : item.spec?.template?.spec;
}

/** Extracts every ConfigMap reference of the workloads, resolving volumes to the containers that mount them. */
export function workloadReferences(items: any[]): ConsumerEntry[] {
  const result: ConsumerEntry[] = [];
  for (const item of items) {
    const spec = podSpec(item);
    if (!spec) continue;
    const base = { workloadType: item.kind as string, workloadName: item.metadata.name as string };
    const containers: Array<{ containerType: ContainerType; container: any }> = [
      ...(spec.initContainers ?? []).map((container: any) => ({ containerType: 'initContainer' as const, container })),
      ...(spec.containers ?? []).map((container: any) => ({ containerType: 'container' as const, container })),
    ];
    for (const volume of spec.volumes ?? []) {
      const sources: Array<[string, string]> = volume?.configMap?.name
        ? [[volume.configMap.name, 'volume']]
        : (volume?.projected?.sources ?? []).filter((source: any) => source?.configMap?.name).map((source: any) => [source.configMap.name, 'projected']);
      for (const [configMap, referenceType] of sources) {
        const mounts = containers.flatMap(({ containerType, container }) => (container.volumeMounts ?? [])
          .filter((mount: any) => mount.name === volume.name)
          .map((mount: any) => ({ containerType, containerName: container.name, mountPath: mount.mountPath })));
        if (!mounts.length) result.push({ ...base, configMap, referenceType, containerType: 'none', volumeName: volume.name });
        for (const mount of mounts) result.push({ ...base, configMap, referenceType, volumeName: volume.name, ...mount });
      }
    }
    for (const { containerType, container } of containers) {
      for (const envFrom of container.envFrom ?? []) {
        if (envFrom?.configMapRef?.name) result.push({ ...base, configMap: envFrom.configMapRef.name, referenceType: 'envFrom', containerType, containerName: container.name });
      }
      for (const env of container.env ?? []) {
        if (env?.valueFrom?.configMapKeyRef?.name) result.push({ ...base, configMap: env.valueFrom.configMapKeyRef.name, referenceType: 'env', containerType, containerName: container.name, mountPath: `env:${env.name}` });
      }
    }
  }
  return result.sort((a, b) => `${a.configMap}/${a.workloadType}/${a.workloadName}/${a.containerName ?? ''}`.localeCompare(`${b.configMap}/${b.workloadType}/${b.workloadName}/${b.containerName ?? ''}`));
}

/**
 * A ConfigMap is considered a migration ConfigMap when at least one of these holds:
 * - it has at least one `.sql` key (this includes Flyway-named keys V<ver>__<desc>.sql / R__<desc>.sql);
 * - a workload mounts it on the Flyway location /flyway/sql;
 * - it is a known exception listed in IGNORED_MIGRATION_DOMAINS.
 */
export function buildClusterReport(configMapItems: any[], workloadItems: any[], environment: string, namespace: string): InventoryReport {
  const references = workloadReferences(workloadItems);
  const existing = new Map<string, any>(configMapItems.map((item: any) => [item.metadata.name, item]));
  const migrationNames = new Set<string>([
    ...configMapItems.filter((item: any) => Object.keys(item.data ?? {}).some(key => SQL_KEY.test(key))).map((item: any) => item.metadata.name as string),
    ...references.filter(item => item.mountPath && FLYWAY_MOUNT_PATH.test(item.mountPath)).map(item => item.configMap),
    ...[...IGNORED_MIGRATION_DOMAINS.keys()].filter(name => existing.has(name) || references.some(item => item.configMap === name)),
  ]);
  const configMaps = [...migrationNames].filter(name => existing.has(name)).sort();
  const migrations = configMaps.flatMap(name => Object.entries(existing.get(name).data ?? {}).map(([key, value]) => ({
    configMap: name, key, sha256: sha256(String(value)), bytes: Buffer.byteLength(String(value)),
  }))).sort((a, b) => `${a.configMap}/${a.key}`.localeCompare(`${b.configMap}/${b.key}`));
  const consumers = references.filter(item => migrationNames.has(item.configMap));
  return {
    schemaVersion: 1, reportType: 'full', source: 'cluster', environment, namespace,
    generatedAt: new Date().toISOString(), configMaps, migrations, consumers,
    anomalies: computeAnomalies('cluster', environment, configMaps, migrations, consumers),
    issues: [],
  };
}

export function run(args: string[]): number {
  const options = parseInventoryOptions(args, true);
  if (options.help) {
    console.log('Usage: npm run inventory:cluster -- --environment <env> --context <context> [--namespace <ns>] [--output-dir <dir>]');
    return 0;
  }
  assertNamespace(options.context, options.namespace);
  const configMapItems = kubectl(options.context, options.namespace, 'configmaps').items ?? [];
  const workloadItems = WORKLOAD_RESOURCES.flatMap(resource => kubectl(options.context, options.namespace, resource).items ?? []);
  const report = { ...buildClusterReport(configMapItems, workloadItems, options.environment, options.namespace), context: options.context };

  const reportDir = join(options.outputDir, 'cluster');
  writeReports(report, reportDir, `cluster-migrations-${options.environment}`);

  const critical = report.anomalies.filter(item => item.severity === 'critical').length;
  console.log(`${critical ? 'FAILED' : 'SUCCESS'} - ${report.configMaps.length} migration ConfigMaps, ${report.migrations.length} migration keys, ${report.consumers.length} workload references (${workloadItems.length} Deployments/CronJobs scanned), ${anomalySummary(report.anomalies)}.`);
  console.log(`Reports written to ${reportDir}.`);
  return critical ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
