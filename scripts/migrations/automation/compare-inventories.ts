#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { flywayConfigMapName } from '../flyway/workloads.js';
import { assertInventoryReport, IGNORED_MIGRATION_DOMAINS, readReport, writeCsv, type ConsumerEntry, type InventoryReport, type Severity } from './inventory-common.js';

interface Options { repository: string; cluster: string; output: string; environment?: string; namespace?: string; context?: string; }
function options(args: string[]): Options {
  const value: Options = { repository: '', cluster: '', output: 'migration-inventory/compare.json' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]; const next = args[++i]; if (!next) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--repository') value.repository = next; else if (arg === '--cluster') value.cluster = next; else if (arg === '--output') value.output = next;
    else if (arg === '--environment') value.environment = next; else if (arg === '--namespace') value.namespace = next; else if (arg === '--context') value.context = next;
    else throw new Error(`Unknown option '${arg}'.`);
  }
  if (!value.repository || !value.cluster) throw new Error('--repository and --cluster are required.');
  return value;
}

export type DifferenceCode = 'INPUT_INVALID' | 'MIG_MISSING_IN_CLUSTER' | 'MIG_EXTRA_IN_CLUSTER' | 'MIG_CONTENT_MISMATCH' | 'CONSUMER_MISSING_IN_CLUSTER' | 'CONSUMER_EXTRA_IN_CLUSTER';

export const DIFFERENCE_DEFINITIONS: Record<DifferenceCode, { severity: Severity; description: string }> = {
  INPUT_INVALID: { severity: 'critical', description: 'Inventory inputs are invalid, contain blocking issues or do not identify the same requested environment/namespace/context.' },
  MIG_MISSING_IN_CLUSTER: { severity: 'critical', description: 'Migration key is missing from the expected ConfigMap: <domain> for legacy, <workload>-<domain> when the domain starts with flyway, otherwise <workload>-flyway-<domain>.' },
  MIG_EXTRA_IN_CLUSTER: { severity: 'warning', description: 'Migration key exists in the cluster ConfigMap but not in the repository. Flyway may already have applied it: verify before removing.' },
  MIG_CONTENT_MISMATCH: { severity: 'critical', description: 'Migration key exists in both but the content differs (sha256). Flyway checksum validation will fail on already-applied migrations.' },
  CONSUMER_MISSING_IN_CLUSTER: { severity: 'warning', description: 'The workload does not reference the chart-generated ConfigMap expected for its migrationDomain, or the shared domain ConfigMap expected for migrationsConfigmap.' },
  CONSUMER_EXTRA_IN_CLUSTER: { severity: 'warning', description: 'A workload in the cluster mounts this migration ConfigMap but the repository values do not reference it.' },
};

interface Difference {
  code: DifferenceCode;
  severity: Severity;
  item: string;
  description: string;
  repositorySha256?: string;
  clusterSha256?: string;
  affectedWorkloads: string[];
  affectedConfigMaps: string[];
  sourceFiles: string[];
}

const workloadId = (item: ConsumerEntry) => `${item.workloadType}/${item.workloadName}`;
const unique = (values: Array<string | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

/**
 * ConfigMaps expected in the cluster for the repository state:
 * - the shared legacy ConfigMap `<domain>` for every source ConfigMap still in the repository
 *   (deployed from commons/<env>/configmaps, mounted by workloads that use migrationsConfigmap);
 * - one chart-named ConfigMap per workload that uses migrationDomain (see flywayConfigMapName).
 * Every expected ConfigMap must contain exactly the migrations of its domain.
 */
function expectedConfigMaps(repository: InventoryReport): Map<string, { domain: string; users: ConsumerEntry[] }> {
  const expected = new Map<string, { domain: string; users: ConsumerEntry[] }>();
  for (const domain of repository.configMaps) expected.set(domain, { domain, users: [] });
  for (const item of repository.consumers) {
    if (item.referenceType === 'legacy') expected.get(item.configMap)?.users.push(item);
    if (item.referenceType === 'target') expected.set(flywayConfigMapName(item.workloadName, item.configMap), { domain: item.configMap, users: [item] });
  }
  return expected;
}

/** ConfigMap that the workload must mount in the cluster according to its repository reference. */
function expectedMount(item: ConsumerEntry): string {
  return item.referenceType === 'target' ? flywayConfigMapName(item.workloadName, item.configMap) : item.configMap;
}

export function compare(repository: InventoryReport, cluster: InventoryReport): Difference[] {
  assertInventoryReport(repository, 'repository');
  assertInventoryReport(cluster, 'cluster');
  if (repository.source !== 'repository' || cluster.source !== 'cluster') throw new Error('Expected full repository and cluster inventories, in that order.');
  if (repository.environment !== cluster.environment || repository.namespace !== cluster.namespace) throw new Error('Inventory environment/namespace mismatch.');
  for (const report of [repository, cluster]) {
    const critical = report.anomalies.filter(item => item.severity === 'critical' || item.code === 'CM_UNDEFINED');
    if (report.issues.length || critical.length) {
      throw new Error(`${report.source} inventory is blocked: ${[...report.issues, ...critical.map(item => `${item.code}: ${item.configMap}: ${item.description}`)].join('; ')}`);
    }
  }
  const differences: Difference[] = [];
  const add = (code: DifferenceCode, item: string, configMap: string, users: ConsumerEntry[], extra: Partial<Difference> = {}) => differences.push({
    code, severity: DIFFERENCE_DEFINITIONS[code].severity, item, description: DIFFERENCE_DEFINITIONS[code].description,
    affectedWorkloads: unique(users.map(workloadId)), affectedConfigMaps: [configMap], sourceFiles: unique(users.map(user => user.file)), ...extra,
  });
  const usersOf = (report: InventoryReport, configMap: string) => report.consumers.filter(item => item.configMap === configMap);

  const domainMigrations = new Map<string, InventoryReport['migrations']>();
  for (const item of repository.migrations) {
    if (!domainMigrations.has(item.configMap)) domainMigrations.set(item.configMap, []);
    domainMigrations.get(item.configMap)!.push(item);
  }
  const expected = expectedConfigMaps(repository);
  const expectedKeys = new Set<string>();
  const clusterMap = new Map(cluster.migrations.map(item => [`${item.configMap}/${item.key}`, item]));
  for (const [configMap, { domain, users }] of expected) {
    if (IGNORED_MIGRATION_DOMAINS.has(domain)) continue;
    for (const item of domainMigrations.get(domain) ?? []) {
      const key = `${configMap}/${item.key}`;
      expectedKeys.add(key);
      const actual = clusterMap.get(key);
      if (!actual) add('MIG_MISSING_IN_CLUSTER', key, configMap, users, { repositorySha256: item.sha256 });
      else if (actual.sha256 !== item.sha256) add('MIG_CONTENT_MISMATCH', key, configMap, users, { repositorySha256: item.sha256, clusterSha256: actual.sha256 });
    }
  }
  for (const [key, item] of clusterMap) {
    if (expectedKeys.has(key) || IGNORED_MIGRATION_DOMAINS.has(item.configMap)) continue;
    add('MIG_EXTRA_IN_CLUSTER', key, item.configMap, usersOf(cluster, item.configMap), { clusterSha256: item.sha256 });
  }

  const pair = (workload: ConsumerEntry, configMap: string) => `${workloadId(workload)}/${configMap}`;
  const clusterPairs = new Set(cluster.consumers.map(item => pair(item, item.configMap)));
  const expectedConsumers = repository.consumers.filter(item => item.referenceType === 'legacy' || item.referenceType === 'target');
  const expectedPairs = new Set(expectedConsumers.map(item => pair(item, expectedMount(item))));
  for (const item of expectedConsumers) {
    const configMap = expectedMount(item);
    if (!clusterPairs.has(pair(item, configMap))) add('CONSUMER_MISSING_IN_CLUSTER', pair(item, configMap), configMap, [item]);
  }
  const reported = new Set<string>();
  for (const item of cluster.consumers) {
    const key = pair(item, item.configMap);
    if (expectedPairs.has(key) || reported.has(key) || IGNORED_MIGRATION_DOMAINS.has(item.configMap)) continue;
    reported.add(key);
    add('CONSUMER_EXTRA_IN_CLUSTER', key, item.configMap, [item]);
  }
  return differences;
}

export function run(args: string[]): number {
  const input = options(args);
  let differences: Difference[];
  try {
    const repository = readReport(input.repository);
    const cluster = readReport(input.cluster);
    if (input.environment && repository.environment !== input.environment) throw new Error(`Requested environment '${input.environment}' does not match the repository inventory.`);
    if (input.namespace && repository.namespace !== input.namespace) throw new Error(`Requested namespace '${input.namespace}' does not match the repository inventory.`);
    if (input.context && cluster.context !== input.context) throw new Error(`Requested context '${input.context}' does not match the cluster inventory.`);
    differences = compare(repository, cluster);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAILED - comparison inputs: ${message}`);
    differences = [{
      code: 'INPUT_INVALID', severity: 'critical', item: `${input.repository}; ${input.cluster}`,
      description: message, affectedWorkloads: [], affectedConfigMaps: [], sourceFiles: [input.repository, input.cluster],
    }];
  }
  const count = (severity: Severity) => differences.filter(item => item.severity === severity).length;
  const summary = {
    total: differences.length,
    bySeverity: { critical: count('critical'), warning: count('warning'), info: count('info') },
    byCode: Object.fromEntries([...new Set(differences.map(d => d.code))].sort().map(code => [code, differences.filter(d => d.code === code).length])),
    affectedConfigMaps: new Set(differences.flatMap(d => d.affectedConfigMaps)).size,
    affectedWorkloads: new Set(differences.flatMap(d => d.affectedWorkloads)).size,
  };
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), repository: input.repository, cluster: input.cluster, summary, differences, success: differences.length === 0 };

  const outputPath = join(dirname(input.output), 'compare', basename(input.output));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  writeCsv(outputPath.replace(extname(outputPath), '.csv'), [
    ['code', 'severity', 'item', 'description', 'repositorySha256', 'clusterSha256', 'affectedWorkloads', 'affectedConfigMaps', 'sourceFiles'],
    ...differences.map(diff => [diff.code, diff.severity, diff.item, diff.description, diff.repositorySha256 ?? '', diff.clusterSha256 ?? '', diff.affectedWorkloads.join('; '), diff.affectedConfigMaps.join('; '), diff.sourceFiles.join('; ')]),
  ]);

  console.log(`${report.success ? 'SUCCESS' : 'FAILED'} - ${summary.total} difference(s): ${summary.bySeverity.critical} critical, ${summary.bySeverity.warning} warning, across ${summary.affectedConfigMaps} ConfigMap(s) and ${summary.affectedWorkloads} workload(s). Reports in ${dirname(outputPath)}.`);
  return report.success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
