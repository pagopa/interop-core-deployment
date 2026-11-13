import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IGNORED_MIGRATION_DOMAINS, readSourceConfigMaps, type SourceConfigMap } from '../flyway/common.js';
import { readFlywayReference, workloadValuesFiles } from '../flyway/workloads.js';

export { IGNORED_MIGRATION_DOMAINS };

export interface InventoryOptions {
  root: string;
  environment: string;
  namespace: string;
  context: string;
  outputDir: string;
  help: boolean;
}

export interface MigrationEntry {
  configMap: string;
  key: string;
  sha256: string;
  bytes: number;
}

export type InventorySource = 'repository' | 'cluster';
export type ContainerType = 'initContainer' | 'container' | 'none' | '';

/**
 * referenceType values:
 * - repository: legacy (migrationsConfigmap), target (migrationDomain), ignored (known exception)
 * - cluster: volume, projected (projected volume source), envFrom, env
 */
export interface ConsumerEntry {
  workloadType: string;
  workloadName: string;
  configMap: string;
  referenceType: string;
  containerType?: ContainerType;
  containerName?: string;
  volumeName?: string;
  mountPath?: string;
  file?: string;
}

export interface InventoryReport {
  schemaVersion: 1;
  reportType: 'full';
  source: InventorySource;
  environment: string;
  namespace: string;
  /** Kubernetes context the cluster inventory was read from. */
  context?: string;
  generatedAt: string;
  migrations: MigrationEntry[];
  consumers: ConsumerEntry[];
  configMaps: string[];
  anomalies: Anomaly[];
  issues: string[];
}

export type AnomalyCode = 'CM_UNDEFINED' | 'CM_UNREFERENCED' | 'CM_IGNORED';
export type Severity = 'critical' | 'warning' | 'info';

export interface Anomaly {
  code: AnomalyCode;
  severity: Severity;
  configMap: string;
  description: string;
  affectedItems: string[];
  sourceFiles: string[];
}

export const ANOMALY_DEFINITIONS: Record<AnomalyCode, { title: string; severity: Severity; description: Record<InventorySource, string> }> = {
  CM_UNDEFINED: {
    title: 'Migration ConfigMap undefined',
    severity: 'critical',
    description: {
      repository: 'Workload values reference this migration ConfigMap (flywayInitContainer) but no flyway ConfigMap with this name is defined in commons/<env>/configmaps. The Flyway init container would fail.',
      cluster: 'Workload mounts this ConfigMap as Flyway migrations (/flyway/sql) but the ConfigMap does not exist in the namespace. The pod cannot start.',
    },
  },
  CM_UNREFERENCED: {
    title: 'Migration ConfigMap unreferenced',
    severity: 'warning',
    description: {
      repository: 'Migration ConfigMap is defined in commons/<env>/configmaps but no workload values reference it. It may be obsolete or a workload is missing its flywayInitContainer reference.',
      cluster: 'Migration ConfigMap exists in the namespace but no Deployment or CronJob references it. It may be an orphan left by a previous release.',
    },
  },
  CM_IGNORED: {
    title: 'Migration ConfigMap ignored',
    severity: 'info',
    description: {
      repository: 'Known exception, excluded from checks:',
      cluster: 'Known exception, excluded from checks:',
    },
  },
};

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseInventoryOptions(args: string[], requireCluster: boolean): InventoryOptions {
  const result: InventoryOptions = {
    root: process.cwd(), environment: '', namespace: '', context: '', outputDir: 'migration-inventory', help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { result.help = true; return result; }
    const value = args[++i];
    if (!value) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--root' || arg === '-r') result.root = value;
    else if (arg === '--environment' || arg === '--env' || arg === '-e') result.environment = value;
    else if (arg === '--namespace' || arg === '-n') result.namespace = value;
    else if (arg === '--context' || arg === '--cluster' || arg === '-c') result.context = value;
    else if (arg === '--output-dir' || arg === '-o') result.outputDir = value;
    else throw new Error(`Unknown option '${arg}'.`);
  }
  if (!result.environment) throw new Error('--environment is required.');
  if (!result.namespace) result.namespace = result.environment;
  if (requireCluster && !result.context) throw new Error('--context is required.');
  if (!existsSync(result.root) || !statSync(result.root).isDirectory()) throw new Error(`Invalid root: ${result.root}`);
  return result;
}

/** Flyway source ConfigMaps of commons/<env>/configmaps (shared reader of the flyway toolset). */
export function sourceConfigMaps(root: string, environment: string): SourceConfigMap[] {
  return readSourceConfigMaps(join(root, 'commons', environment, 'configmaps'));
}

/**
 * Workload references to migration domains declared in microservices|jobs/<name>/<env>/values.yaml
 * (shared reader of the flyway toolset). Malformed workload files are returned as errors, not thrown.
 */
export function repositoryConsumers(root: string, environment: string): { consumers: ConsumerEntry[]; errors: string[] } {
  const consumers: ConsumerEntry[] = [];
  const errors: string[] = [];
  for (const workload of workloadValuesFiles(root, environment)) {
    let reference;
    try {
      reference = readFlywayReference(workload);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const [configMap, referenceType] of [[reference.legacy, 'legacy'], [reference.target, 'target']] as const) {
      if (!configMap) continue;
      consumers.push({
        workloadType: workload.workloadType,
        workloadName: reference.workloadName,
        configMap,
        referenceType: IGNORED_MIGRATION_DOMAINS.has(configMap) ? 'ignored' : referenceType,
        containerType: 'initContainer',
        file: relative(root, workload.file),
      });
    }
  }
  return { consumers, errors };
}

export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function writeCsv(file: string, rows: unknown[][]): void {
  writeFileSync(file, `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`);
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function workloadId(consumer: ConsumerEntry): string {
  return `${consumer.workloadType}/${consumer.workloadName}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

/**
 * Anomalies are computed only from the data of the given source: `definedConfigMaps` are the migration
 * ConfigMaps that exist in that source, `consumers` are the workload references to migration ConfigMaps.
 */
export function computeAnomalies(source: InventorySource, environment: string, definedConfigMaps: string[], migrations: MigrationEntry[], consumers: ConsumerEntry[]): Anomaly[] {
  const defined = new Set(definedConfigMaps);
  const referenced = new Set(consumers.map(item => item.configMap));
  const anomalies: Anomaly[] = [];
  for (const configMap of [...new Set([...defined, ...referenced])].sort()) {
    const users = consumers.filter(item => item.configMap === configMap);
    const ignoredReason = IGNORED_MIGRATION_DOMAINS.get(configMap);
    let code: AnomalyCode | undefined;
    let description = '';
    if (ignoredReason) {
      code = 'CM_IGNORED';
      const state = defined.has(configMap) ? 'present' : 'not present';
      description = `${ANOMALY_DEFINITIONS.CM_IGNORED.description[source]} ${ignoredReason} (ConfigMap ${state} in ${source}).`;
    } else if (!defined.has(configMap)) {
      code = 'CM_UNDEFINED';
    } else if (!users.length) {
      code = 'CM_UNREFERENCED';
    }
    if (!code) continue;
    const keys = migrations.filter(item => item.configMap === configMap).length;
    anomalies.push({
      code,
      severity: ANOMALY_DEFINITIONS[code].severity,
      configMap,
      description: (description || ANOMALY_DEFINITIONS[code].description[source]).replaceAll('<env>', environment),
      affectedItems: users.length ? unique(users.map(workloadId)) : [`${keys} migration key(s), no workload`],
      sourceFiles: unique(users.map(item => item.file)),
    });
  }
  return anomalies.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.configMap.localeCompare(b.configMap));
}

/**
 * Writes all the reports of an inventory into `outputDir`:
 * <stem>.json (full), <stem>-configmaps.{json,csv}, <stem>-workloads.{json,csv}, <stem>-mapping.csv, <stem>-anomalies.csv.
 * The anomalies report is always written (header only when empty) so stale results never survive a new run.
 */
export function writeReports(report: InventoryReport, outputDir: string, stem: string): void {
  mkdirSync(outputDir, { recursive: true });
  const json = (file: string, value: unknown) => writeFileSync(join(outputDir, file), `${JSON.stringify(value, null, 2)}\n`);

  json(`${stem}.json`, report);
  json(`${stem}-configmaps.json`, { ...report, reportType: 'configmaps', consumers: [], anomalies: [] });
  json(`${stem}-workloads.json`, { ...report, reportType: 'workloads', migrations: [], anomalies: [] });

  const workloadsByConfigMap = new Map<string, Set<string>>();
  for (const consumer of report.consumers) {
    if (!workloadsByConfigMap.has(consumer.configMap)) workloadsByConfigMap.set(consumer.configMap, new Set());
    workloadsByConfigMap.get(consumer.configMap)!.add(workloadId(consumer));
  }

  writeCsv(join(outputDir, `${stem}-configmaps.csv`), [
    ['configMap', 'key', 'sha256', 'bytes', 'usedByWorkloads'],
    ...report.migrations.map(item => [item.configMap, item.key, item.sha256, item.bytes, workloadsByConfigMap.get(item.configMap)?.size ?? 0]),
  ]);

  writeCsv(join(outputDir, `${stem}-workloads.csv`), [
    ['configMap', 'workloadType', 'workloadName', 'referenceType', 'file'],
    ...report.consumers.map(item => [item.configMap, item.workloadType, item.workloadName, item.referenceType, item.file ?? '']),
  ]);

  const mapping = [...report.consumers].sort((a, b) => `${workloadId(a)}/${a.containerName ?? ''}/${a.configMap}`.localeCompare(`${workloadId(b)}/${b.containerName ?? ''}/${b.configMap}`));
  writeCsv(join(outputDir, `${stem}-mapping.csv`), [
    ['workloadType', 'workloadName', 'containerType', 'containerName', 'configMap', 'referenceType', 'volumeName', 'mountPath', 'file'],
    ...mapping.map(item => [item.workloadType, item.workloadName, item.containerType ?? '', item.containerName ?? '', item.configMap, item.referenceType, item.volumeName ?? '', item.mountPath ?? '', item.file ?? '']),
  ]);

  writeCsv(join(outputDir, `${stem}-anomalies.csv`), [
    ['code', 'severity', 'configMap', 'description', 'affectedItems', 'sourceFiles'],
    ...report.anomalies.map(item => [item.code, item.severity, item.configMap, item.description, item.affectedItems.join('; '), item.sourceFiles.join('; ')]),
  ]);
}

export function anomalySummary(anomalies: Anomaly[]): string {
  const count = (severity: Severity) => anomalies.filter(item => item.severity === severity).length;
  return `${count('critical')} critical, ${count('warning')} warning, ${count('info')} info anomaly(ies)`;
}

export function assertInventoryReport(value: unknown, label: string): asserts value is InventoryReport {
  const invalid = (detail: string): never => { throw new Error(`${label}: invalid inventory report: ${detail}.`); };
  function record(item: unknown, field: string): asserts item is Record<string, unknown> {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid(`${field} must be an object`);
  }
  function text(item: unknown, field: string): asserts item is string {
    if (typeof item !== 'string' || !item.trim()) invalid(`${field} must be a non-empty string`);
  }
  function list(item: unknown, field: string): asserts item is unknown[] {
    if (!Array.isArray(item)) invalid(`${field} must be an array`);
  }
  function strings(item: unknown, field: string): asserts item is string[] {
    list(item, field);
    for (const entry of item) text(entry, field);
  }
  record(value, 'report');
  if (value.schemaVersion !== 1) invalid('unsupported schemaVersion');
  if (value.reportType !== 'full') invalid('reportType must be full; regenerate older inventories and do not use partial reports');
  if (value.source !== 'repository' && value.source !== 'cluster') invalid('source must be repository or cluster');
  for (const key of ['environment', 'namespace', 'generatedAt']) text(value[key], key);
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) invalid('generatedAt must be a valid timestamp');
  if (value.source === 'cluster') text(value.context, 'context');
  strings(value.configMaps, 'configMaps');
  if (new Set(value.configMaps).size !== value.configMaps.length) invalid('duplicate configMaps');
  strings(value.issues, 'issues');
  list(value.migrations, 'migrations');
  const migrationKeys = new Set<string>();
  for (const item of value.migrations) {
    record(item, 'migration');
    text(item.configMap, 'migration.configMap');
    text(item.key, 'migration.key');
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) invalid('migration.sha256 must be a SHA-256 hex digest');
    if (typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0) invalid('migration.bytes must be a non-negative integer');
    if (!value.configMaps.includes(item.configMap)) invalid(`migration references unlisted ConfigMap '${item.configMap}'`);
    const key = `${item.configMap}/${item.key}`;
    if (migrationKeys.has(key)) invalid(`duplicate migration '${key}'`);
    migrationKeys.add(key);
  }
  list(value.consumers, 'consumers');
  for (const item of value.consumers) {
    record(item, 'consumer');
    for (const key of ['workloadType', 'workloadName', 'configMap', 'referenceType']) text(item[key], `consumer.${key}`);
    if (item.workloadType !== 'Deployment' && item.workloadType !== 'CronJob') invalid('unsupported consumer workloadType');
    const allowed = value.source === 'repository' ? ['legacy', 'target', 'ignored'] : ['volume', 'projected', 'envFrom', 'env'];
    if (typeof item.referenceType !== 'string' || !allowed.includes(item.referenceType)) invalid('unsupported consumer referenceType');
    for (const key of ['containerName', 'volumeName', 'mountPath', 'file']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') invalid(`consumer.${key} must be a string`);
    }
    if (item.containerType !== undefined && !['initContainer', 'container', 'none', ''].includes(String(item.containerType))) invalid('unsupported consumer containerType');
    if (value.source === 'repository' && !value.configMaps.includes(String(item.configMap)) && !IGNORED_MIGRATION_DOMAINS.has(String(item.configMap))) {
      invalid(`consumer references unknown domain '${item.configMap}'`);
    }
  }
  list(value.anomalies, 'anomalies');
  for (const item of value.anomalies) {
    record(item, 'anomaly');
    if (typeof item.code !== 'string' || !['CM_UNDEFINED', 'CM_UNREFERENCED', 'CM_IGNORED'].includes(item.code)) invalid('unsupported anomaly code');
    if (typeof item.severity !== 'string' || !['critical', 'warning', 'info'].includes(item.severity)) invalid('unsupported anomaly severity');
    text(item.configMap, 'anomaly.configMap');
    text(item.description, 'anomaly.description');
    strings(item.affectedItems, 'anomaly.affectedItems');
    strings(item.sourceFiles, 'anomaly.sourceFiles');
  }
}

export function readReport(file: string): InventoryReport {
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: cannot read inventory JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertInventoryReport(report, file);
  return report;
}
