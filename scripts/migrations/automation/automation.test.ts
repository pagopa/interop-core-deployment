import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as repositoryInventory } from './repository-inventory.js';
import { buildClusterReport } from './cluster-inventory.js';
import { compare, run as compareInventories } from './compare-inventories.js';
import { run as validateMigration } from './validate-migration.js';
import { assertInventoryReport, type InventoryReport } from './inventory-common.js';
import { flywayConfigMapName } from '../flyway/workloads.js';

test('repository inventory emits machine-readable migration data', context => {
  const root = mkdtempSync(join(tmpdir(), 'migration-automation-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const configmaps = join(root, 'commons', 'dev', 'configmaps');
  const deprecatedWorkload = join(root, 'microservices', 'authorization-management', 'dev');
  const output = join(root, 'reports');
  mkdirSync(configmaps, { recursive: true });
  mkdirSync(deprecatedWorkload, { recursive: true });
  writeFileSync(join(configmaps, 'flyway-test.yaml'), `kind: ConfigMap
metadata:
  name: flyway-test
data:
  V1__Init.sql: |-
    SELECT 1;
`);
  writeFileSync(join(deprecatedWorkload, 'values.yaml'), `name: authorization-management
deployment:
  flywayInitContainer:
    migrationsConfigmap: common-db-migrations
`);

  assert.equal(repositoryInventory([
    '--root', root,
    '--environment', 'dev',
    '--output-dir', output,
  ]), 0);

  const report = JSON.parse(readFileSync(join(output, 'repository', 'repository-migrations-dev.json'), 'utf8'));
  assert.deepEqual(report.configMaps, ['flyway-test']);
  assert.equal(report.migrations.length, 1);
  assert.equal(report.migrations[0].key, 'V1__Init.sql');
  assert.equal(report.migrations[0].sha256.length, 64);
  assert.equal(report.consumers[0].referenceType, 'ignored');
  assert.deepEqual(report.issues, []);
});

function deployment(name: string, configMap: string, mountPath = '/flyway/sql'): any {
  return {
    kind: 'Deployment',
    metadata: { name },
    spec: { template: { spec: {
      volumes: [{ name: 'migrations-files', projected: { sources: [{ configMap: { name: configMap } }] } }],
      initContainers: [{ name: 'migrate-db', volumeMounts: [{ name: 'migrations-files', mountPath }] }],
      containers: [{ name: 'app', envFrom: [{ configMapRef: { name: 'generic-config' } }] }],
    } } },
  };
}

test('cluster inventory resolves projected volumes and reports cluster-only anomalies', () => {
  const report = buildClusterReport(
    [
      { metadata: { name: 'flyway-used' }, data: { 'V1__Init.sql': 'SELECT 1;' } },
      { metadata: { name: 'flyway-orphan' }, data: { 'V1__Init.sql': 'SELECT 2;' } },
      { metadata: { name: 'generic-config' }, data: { KEY: 'value' } },
    ],
    [deployment('svc-a', 'flyway-used'), deployment('svc-b', 'flyway-missing'), deployment('svc-c', 'common-db-migrations')],
    'dev',
    'dev',
  );
  assert.deepEqual(report.configMaps, ['flyway-orphan', 'flyway-used']);
  assert.ok(report.consumers.every(item => item.configMap !== 'generic-config'));
  const used = report.consumers.find(item => item.configMap === 'flyway-used');
  assert.equal(used?.referenceType, 'projected');
  assert.equal(used?.containerType, 'initContainer');
  assert.equal(used?.containerName, 'migrate-db');
  assert.equal(used?.mountPath, '/flyway/sql');
  const codes = Object.fromEntries(report.anomalies.map(item => [item.configMap, item.code]));
  assert.deepEqual(codes, { 'flyway-missing': 'CM_UNDEFINED', 'flyway-orphan': 'CM_UNREFERENCED', 'common-db-migrations': 'CM_IGNORED' });
  assert.ok(report.anomalies.every(item => !/repository/i.test(item.description)));
});

test('compare detects consumers missing in the cluster', () => {
  const base = { schemaVersion: 1 as const, reportType: 'full' as const, environment: 'dev', namespace: 'dev', context: 'kind-test', generatedAt: new Date().toISOString(), configMaps: ['flyway-x'], anomalies: [], issues: [] };
  const migrations = [{ configMap: 'flyway-x', key: 'V1__Init.sql', sha256: 'a'.repeat(64), bytes: 1 }];
  const differences = compare(
    { ...base, source: 'repository', migrations, consumers: [{ workloadType: 'Deployment', workloadName: 'svc-a', configMap: 'flyway-x', referenceType: 'legacy' }] },
    { ...base, source: 'cluster', migrations, consumers: [{ workloadType: 'Deployment', workloadName: 'svc-b', configMap: 'flyway-x', referenceType: 'projected' }] },
  );
  assert.deepEqual(differences.map(item => item.code).sort(), ['CONSUMER_EXTRA_IN_CLUSTER', 'CONSUMER_MISSING_IN_CLUSTER']);
});

test('compare follows conditional chart naming for migrationDomain', () => {
  const base = { schemaVersion: 1 as const, reportType: 'full' as const, environment: 'dev', namespace: 'dev', context: 'kind-test', generatedAt: new Date().toISOString(), configMaps: ['flyway-x'], anomalies: [], issues: [] };
  const key = (configMap: string) => ({ configMap, key: 'V1__Init.sql', sha256: 'a'.repeat(64), bytes: 1 });
  const mount = (workloadName: string, configMap: string) => ({ workloadType: 'Deployment', workloadName, configMap, referenceType: 'projected' });
  const repository = {
    ...base, source: 'repository' as const, migrations: [key('flyway-x')],
    consumers: ['svc-a', 'svc-b'].map(workloadName => ({ workloadType: 'Deployment', workloadName, configMap: 'flyway-x', referenceType: 'target' })),
  };
  // After the rollout: per-workload ConfigMaps mounted, legacy shared ConfigMap still deployed but unused.
  const rolledOut = compare(repository, {
    ...base, source: 'cluster', configMaps: ['flyway-x', 'svc-a-flyway-x', 'svc-b-flyway-x'],
    migrations: [key('flyway-x'), key('svc-a-flyway-x'), key('svc-b-flyway-x')],
    consumers: [mount('svc-a', 'svc-a-flyway-x'), mount('svc-b', 'svc-b-flyway-x')],
  });
  assert.deepEqual(rolledOut, []);
  // Partial rollout: svc-b still runs the previous release mounting the legacy ConfigMap.
  const partial = compare(repository, {
    ...base, source: 'cluster', configMaps: ['flyway-x', 'svc-a-flyway-x'],
    migrations: [key('flyway-x'), key('svc-a-flyway-x')],
    consumers: [mount('svc-a', 'svc-a-flyway-x'), mount('svc-b', 'flyway-x')],
  });
  assert.deepEqual(partial.map(item => `${item.code} ${item.item}`).sort(), [
    'CONSUMER_EXTRA_IN_CLUSTER Deployment/svc-b/flyway-x',
    'CONSUMER_MISSING_IN_CLUSTER Deployment/svc-b/svc-b-flyway-x',
    'MIG_MISSING_IN_CLUSTER svc-b-flyway-x/V1__Init.sql',
  ]);
});

test('chart naming covers prefixed and unprefixed domains for service and job', () => {
  for (const workload of ['svc', 'job']) {
    assert.equal(flywayConfigMapName(workload, 'flyway-test'), `${workload}-flyway-test`);
    assert.equal(flywayConfigMapName(workload, 'flyway'), `${workload}-flyway`);
    assert.equal(flywayConfigMapName(workload, 'event-store-migrations'), `${workload}-flyway-event-store-migrations`);
    assert.equal(flywayConfigMapName(workload, 'Flyway-test'), `${workload}-flyway-Flyway-test`);
  }
});

test('validate rejects unknown legacy and target domains but preserves known exclusions', context => {
  const root = mkdtempSync(join(tmpdir(), 'migration-validate-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const configmaps = join(root, 'commons/dev/configmaps');
  mkdirSync(configmaps, { recursive: true });
  writeFileSync(join(configmaps, 'flyway-source.yaml'), 'kind: ConfigMap\nmetadata:\n  name: flyway-known\ndata:\n  V1.sql: SELECT 1;\n');
  const workload = join(root, 'jobs/job/dev');
  mkdirSync(workload, { recursive: true });
  const output = join(root, 'reports');
  for (const key of ['migrationDomain', 'migrationsConfigmap']) {
    writeFileSync(join(workload, 'values.yaml'), `name: job\ncronjob:\n  flywayInitContainer:\n    ${key}: flyway-missing\n`);
    assert.equal(validateMigration(['--root', root, '--environment', 'dev', '--report-dir', output]), 1);
    const report = JSON.parse(readFileSync(join(output, 'validate-dev-workloads.json'), 'utf8'));
    assert.equal(report.success, false);
    assert.equal(report.items[0].status, 'WORKLOAD_UNKNOWN_DOMAIN');
    assert.equal(report.items[0].severity, 'critical');
  }
  writeFileSync(join(workload, 'values.yaml'), 'name: job\ncronjob:\n  flywayInitContainer:\n    migrationDomain: flyway-known\n');
  assert.equal(validateMigration(['--root', root, '--environment', 'dev']), 0);
  writeFileSync(join(workload, 'values.yaml'), 'name: job\ncronjob:\n  flywayInitContainer:\n    migrationsConfigmap: common-db-migrations\n');
  assert.equal(validateMigration(['--root', root, '--environment', 'dev']), 0);
});

function emptyInventory(source: InventoryReport['source']): InventoryReport {
  return { schemaVersion: 1, reportType: 'full', source, environment: 'dev', namespace: 'dev', context: 'kind-test', generatedAt: new Date().toISOString(), configMaps: [], migrations: [], consumers: [], anomalies: [], issues: [] };
}

test('comparison rejects invalid schema, mismatched scope and blocking inventory issues', () => {
  const repository = emptyInventory('repository');
  const cluster = emptyInventory('cluster');
  assert.deepEqual(compare(repository, cluster), []);
  assert.throws(() => compare(repository, { ...cluster, environment: 'qa' }), /mismatch/);
  assert.throws(() => compare(repository, { ...cluster, namespace: 'other' }), /mismatch/);
  assert.throws(() => compare({ ...repository, issues: ['invalid workload'] }, cluster), /blocked/);
  assert.throws(() => compare(repository, { ...cluster, anomalies: [{ code: 'CM_UNDEFINED', severity: 'critical', configMap: 'missing', description: 'missing map', affectedItems: [], sourceFiles: [] }] }), /blocked/);
  for (const invalid of [
    { ...repository, schemaVersion: 2 },
    { ...repository, reportType: 'configmaps' },
    { ...repository, reportType: undefined },
    { ...repository, migrations: null },
    { ...repository, generatedAt: 'invalid' },
    { ...cluster, context: '' },
    { ...repository, consumers: [{ workloadType: 'Deployment', workloadName: 'svc', configMap: 'x', referenceType: 'volume' }] },
    { ...repository, configMaps: ['x', 'x'] },
    { ...repository, configMaps: ['x'], migrations: [{ configMap: 'x', key: 'V1.sql', sha256: 'bad', bytes: 0 }] },
    { ...repository, configMaps: ['x'], migrations: Array(2).fill({ configMap: 'x', key: 'V1.sql', sha256: 'a'.repeat(64), bytes: 0 }) },
  ]) assert.throws(() => assertInventoryReport(invalid, 'fixture'), /invalid inventory/);
});

test('comparison CLI writes failure reports for bad JSON and requested scope mismatches', context => {
  const root = mkdtempSync(join(tmpdir(), 'migration-compare-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository.json');
  const cluster = join(root, 'cluster.json');
  const output = join(root, 'result.json');
  const args = ['--repository', repository, '--cluster', cluster, '--output', output];
  writeFileSync(repository, JSON.stringify(emptyInventory('repository')));
  writeFileSync(cluster, JSON.stringify(emptyInventory('cluster')));
  assert.equal(compareInventories(args), 0);
  for (const option of [['--environment', 'qa'], ['--namespace', 'qa'], ['--context', 'other']]) {
    assert.equal(compareInventories([...args, ...option]), 1);
    const report = JSON.parse(readFileSync(join(root, 'compare/result.json'), 'utf8'));
    assert.equal(report.success, false);
    assert.equal(report.differences[0].code, 'INPUT_INVALID');
  }
  writeFileSync(cluster, '{ invalid');
  assert.equal(compareInventories(args), 1);
  assert.match(readFileSync(join(root, 'compare/result.csv'), 'utf8'), /INPUT_INVALID/);
});

test('inventory phase never runs compare after acquisition failure even with old reports', context => {
  const root = mkdtempSync(join(tmpdir(), 'migration-orchestrator-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts/migrations/automation', 'scripts/migrations/flyway', 'bin', 'reports/repository', 'reports/cluster']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, 'reports/repository/repository-migrations-dev.json'), JSON.stringify(emptyInventory('repository')));
  writeFileSync(join(root, 'reports/cluster/cluster-migrations-dev.json'), JSON.stringify(emptyInventory('cluster')));
  const calls = join(root, 'calls.txt');
  writeFileSync(join(root, 'bin/npm'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in *inventory:repository*) exit 1 ;; *) exit 0 ;; esac\n`, { mode: 0o755 });
  const script = join(dirname(fileURLToPath(import.meta.url)), 'run-migration.sh');
  const result = spawnSync('bash', [script, 'inventory', '--root', root, '--environment', 'dev', '--context', 'kind-test', '--output-dir', join(root, 'reports')], {
    encoding: 'utf8', env: { ...process.env, CALLS: calls, PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SKIPPED - compare/);
  const commands = readFileSync(calls, 'utf8');
  assert.match(commands, /inventory:repository/);
  assert.match(commands, /inventory:cluster/);
  assert.doesNotMatch(commands, /run compare/);
});

test('repository inventory and validate report malformed workload values without crashing', context => {
  const root = mkdtempSync(join(tmpdir(), 'migration-automation-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const configmaps = join(root, 'commons', 'dev', 'configmaps');
  mkdirSync(configmaps, { recursive: true });
  writeFileSync(join(configmaps, 'flyway-test.yaml'), 'kind: ConfigMap\nmetadata:\n  name: flyway-test\ndata:\n  V1__Init.sql: SELECT 1;\n');
  const workload = join(root, 'microservices', 'svc', 'dev');
  mkdirSync(workload, { recursive: true });
  writeFileSync(join(workload, 'values.yaml'), 'name: svc\ndeployment:\n  flywayInitContainer:\n    migrationsConfigmap: a\n    migrationDomain: b\n');
  const output = join(root, 'reports');

  assert.equal(repositoryInventory(['--root', root, '--environment', 'dev', '--output-dir', output]), 1);
  const report = JSON.parse(readFileSync(join(output, 'repository', 'repository-migrations-dev.json'), 'utf8'));
  assert.match(report.issues[0], /conflicts with migrationDomain/);

  assert.equal(validateMigration(['--root', root, '--environment', 'dev', '--report-dir', join(output, 'validate')]), 1);
  const validation = JSON.parse(readFileSync(join(output, 'validate', 'validate-dev-workloads.json'), 'utf8'));
  assert.deepEqual(validation.items.map((item: { status: string }) => item.status), ['WORKLOAD_INVALID']);
});
