#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { anomalySummary, computeAnomalies, parseInventoryOptions, repositoryConsumers, sha256, sourceConfigMaps, writeReports, type InventoryReport } from './inventory-common.js';

export function run(args: string[]): number {
  const options = parseInventoryOptions(args, false);
  if (options.help) {
    console.log('Usage: npm run inventory:repository -- --environment <env> [--namespace <ns>] [--root <path>] [--output-dir <dir>]');
    return 0;
  }
  const sources = sourceConfigMaps(options.root, options.environment);
  const { consumers, errors } = repositoryConsumers(options.root, options.environment);
  const known = new Set(sources.map(item => item.name));
  const issues = [...errors, ...consumers
    .filter(item => item.referenceType !== 'ignored' && !known.has(item.configMap))
    .map(item => `${item.file}: ${item.referenceType} migration domain '${item.configMap}' has no flyway source ConfigMap.`)];
  const configMaps = sources.map(item => item.name).sort();
  const migrations = sources.flatMap(item => Object.entries(item.data).map(([key, value]) => ({
    configMap: item.name, key, sha256: sha256(value), bytes: Buffer.byteLength(value),
  }))).sort((a, b) => `${a.configMap}/${a.key}`.localeCompare(`${b.configMap}/${b.key}`));
  const report: InventoryReport = {
    schemaVersion: 1, reportType: 'full', source: 'repository', environment: options.environment, namespace: options.namespace,
    generatedAt: new Date().toISOString(), configMaps, migrations, consumers,
    anomalies: computeAnomalies('repository', options.environment, configMaps, migrations, consumers),
    issues,
  };

  const reportDir = join(options.outputDir, 'repository');
  writeReports(report, reportDir, `repository-migrations-${options.environment}`);

  const critical = report.anomalies.filter(item => item.severity === 'critical').length;
  const failed = issues.length > 0 || critical > 0;
  console.log(`${failed ? 'FAILED' : 'SUCCESS'} - ${configMaps.length} migration ConfigMaps, ${migrations.length} migration keys, ${consumers.length} workload references, ${anomalySummary(report.anomalies)}.`);
  console.log(`Reports written to ${reportDir}.`);
  if (issues.length) console.error(`- ${issues.join('\n- ')}`);
  return failed ? 1 : 0;
}

export async function main(): Promise<void> {
  process.exitCode = run(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
