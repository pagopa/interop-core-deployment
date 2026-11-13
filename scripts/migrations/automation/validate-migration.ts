#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { extractReportDir, writePhaseReport, type ReportRow, type StatusDefinition } from '../flyway/phase-report.js';
import { flywayConfigMapName } from '../flyway/workloads.js';
import { parseInventoryOptions, repositoryConsumers, sourceConfigMaps } from './inventory-common.js';

// Generated content equivalence is checked by the flyway verify:sha256 / verify:crc32 phases,
// which run-migration.sh executes in the same validate phase; this script validates the workloads.
const DEFINITIONS: Record<string, StatusDefinition> = {
  WORKLOAD_MIGRATED: { severity: 'ok', description: 'Workload uses migrationDomain pointing to a known Flyway migration domain.' },
  WORKLOAD_LEGACY_REMAINS: { severity: 'critical', description: 'Workload still uses legacy migrationsConfigmap; run the migrate phase.' },
  WORKLOAD_IGNORED: { severity: 'info', description: 'Known exception (deprecated Scala MongoDB domain); excluded from validation.' },
  WORKLOAD_UNKNOWN_DOMAIN: { severity: 'critical', description: 'Workload references a domain absent from the validated source ConfigMaps in commons/<env>/configmaps (metadata.name); known exclusions are handled separately.' },
  WORKLOAD_INVALID: { severity: 'critical', description: 'Workload values file is malformed or its flywayInitContainer reference is invalid.' },
};
const COLUMNS = ['workloadType', 'workloadName', 'configMap', 'referenceType', 'clusterConfigMap', 'valuesFile'];

export function run(rawArgs: string[]): number {
  const { reportDir, args } = extractReportDir(rawArgs);
  const options = parseInventoryOptions(args, false);
  if (options.help) { console.log('Usage: npm run validate:migration -- --environment <env> [--root <path>] [--report-dir <dir>]'); return 0; }
  const rows: ReportRow[] = [];
  const errors: string[] = [];
  const known = new Set(sourceConfigMaps(options.root, options.environment).map(item => item.name));
  const { consumers, errors: invalid } = repositoryConsumers(options.root, options.environment);
  for (const message of invalid) {
    errors.push(message);
    rows.push({ status: 'WORKLOAD_INVALID', detail: message });
  }
  for (const consumer of consumers) {
    const referenceType = consumer.referenceType === 'legacy' ? 'migrationsConfigmap' : consumer.referenceType === 'target' ? 'migrationDomain' : consumer.referenceType;
    const clusterConfigMap = consumer.referenceType === 'target' ? flywayConfigMapName(consumer.workloadName, consumer.configMap) : consumer.configMap;
    const base = { workloadType: consumer.workloadType, workloadName: consumer.workloadName, configMap: consumer.configMap, referenceType, clusterConfigMap, valuesFile: consumer.file };
    if (consumer.referenceType === 'ignored') rows.push({ status: 'WORKLOAD_IGNORED', ...base, detail: `flywayInitContainer: ${consumer.configMap} (known exception).` });
    else if (!known.has(consumer.configMap)) {
      const message = `flywayInitContainer.${referenceType}: ${consumer.configMap} has no flyway ConfigMap in commons/${options.environment}/configmaps (${consumer.file}).`;
      errors.push(message);
      rows.push({ status: 'WORKLOAD_UNKNOWN_DOMAIN', ...base, detail: message });
    }
    else if (consumer.referenceType === 'legacy') {
      const message = `${consumer.file}: legacy migrationsConfigmap '${consumer.configMap}' remains.`;
      errors.push(message);
      rows.push({ status: 'WORKLOAD_LEGACY_REMAINS', ...base, detail: message });
    } else rows.push({ status: 'WORKLOAD_MIGRATED', ...base, detail: `flywayInitContainer.migrationDomain: ${consumer.configMap}.` });
  }
  writePhaseReport(reportDir, `validate-${options.environment}-workloads`, {
    phase: 'validate-workloads', environment: options.environment, root: options.root, definitions: DEFINITIONS, columns: COLUMNS, rows,
  });
  if (errors.length) { console.error(`FAILED - ${errors.length} error(s):\n- ${errors.join('\n- ')}`); return 1; }
  console.log(`SUCCESS - ${consumers.length} workload reference(s) checked against ${known.size} migration domain(s); no legacy reference remains.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
