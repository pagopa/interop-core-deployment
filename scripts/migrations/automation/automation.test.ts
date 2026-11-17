import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as repositoryInventory } from './repository-inventory.js';
import { buildClusterReport, workloadReferences } from './cluster-inventory.js';
import { compare, run as compareInventories } from './compare-inventories.js';
import { run as validateMigration } from './validate-migration.js';
import { assertInventoryReport, sha256, writeReports, type InventoryReport } from './inventory-common.js';
import { flywayConfigMapName } from '../flyway/workloads.js';
import { createRequire } from 'node:module';

const directory = dirname(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

function temporaryRoot(context: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'migration-coverage-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root: string, file: string, content: string): string {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function source(root: string, name = 'flyway-test'): void {
  put(root, `commons/dev/configmaps/${name}.yaml`, `kind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  V1__Init.sql: |-\n    SELECT 1;\n`);
}

function invoke(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [tsxCli, join(directory, script), ...args], { encoding: 'utf8', env });
}

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

test('repository inventory rejects duplicate sources, malformed YAML and unknown domains', async context => {
  for (const scenario of ['duplicate', 'invalid-yaml', 'unknown-domain']) await context.test(scenario, child => {
    const root = temporaryRoot(child);
    source(root);
    if (scenario === 'duplicate') put(root, 'commons/dev/configmaps/FLYWAY-duplicate.YML', readFileSync(join(root, 'commons/dev/configmaps/flyway-test.yaml'), 'utf8'));
    if (scenario === 'invalid-yaml') put(root, 'commons/dev/configmaps/flyway-invalid.yaml', 'data: [');
    if (scenario === 'unknown-domain') put(root, 'jobs/job/dev/values.yaml', 'cronjob:\n  flywayInitContainer:\n    migrationDomain: missing\n');
    const result = invoke('repository-inventory.ts', ['--root', root, '--environment', 'dev', '--output-dir', join(root, 'reports')]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, scenario === 'duplicate' ? /Duplicate/ : scenario === 'invalid-yaml' ? /YAML|flow|end|Unexpected/i : /no flyway source/);
  });
});

test('repository reports are reproducible, read-only and count workloads rather than containers or SQL keys', context => {
  const root = temporaryRoot(context);
  source(root);
  const configmap = join(root, 'commons/dev/configmaps/flyway-test.yaml');
  writeFileSync(configmap, readFileSync(configmap, 'utf8') + '  V2__Text.sql: "SELECT \'città\';\\n"\n');
  put(root, 'microservices/svc/dev/values.yaml', 'name: actual-svc\ndeployment:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test\n');
  put(root, 'jobs/job/dev/values.yaml', 'cronjob:\n  flywayInitContainer:\n    migrationDomain: flyway-test\n');
  put(root, 'jobs/job/qa/values.yaml', 'invalid: [');
  const inputFiles = ['commons/dev/configmaps/flyway-test.yaml', 'microservices/svc/dev/values.yaml', 'jobs/job/dev/values.yaml', 'jobs/job/qa/values.yaml'];
  const before = inputFiles.map(file => readFileSync(join(root, file), 'utf8'));
  const output = join(root, 'reports');
  const args = ['--root', root, '--environment', 'dev', '--namespace', 'custom-ns', '--output-dir', output];
  assert.equal(repositoryInventory(args), 0);
  const folder = join(output, 'repository');
  const original = Object.fromEntries(readdirSync(folder).map(file => {
    const text = readFileSync(join(folder, file), 'utf8');
    if (!file.endsWith('.json')) return [file, text];
    const report = JSON.parse(text);
    delete report.generatedAt;
    return [file, report];
  }));
  assert.equal(repositoryInventory(args), 0);
  for (const [file, expected] of Object.entries(original)) {
    const text = readFileSync(join(folder, file), 'utf8');
    if (file.endsWith('.json')) {
      const report = JSON.parse(text);
      delete report.generatedAt;
      assert.deepEqual(report, expected);
    } else assert.equal(text, expected);
  }
  const report: InventoryReport = JSON.parse(readFileSync(join(folder, 'repository-migrations-dev.json'), 'utf8'));
  assert.equal(report.namespace, 'custom-ns');
  assert.deepEqual(report.consumers.map(item => item.workloadName).sort(), ['actual-svc', 'job']);
  const unicode = report.migrations.find(item => item.key === 'V2__Text.sql')!;
  assert.equal(unicode.bytes, Buffer.byteLength("SELECT 'città';\n", 'utf8'));
  assert.equal(unicode.sha256, sha256("SELECT 'città';\n"));
  const csv = readFileSync(join(folder, 'repository-migrations-dev-configmaps.csv'), 'utf8').trim().split('\n');
  assert.ok(csv.slice(1).every(line => line.endsWith(',2')));
  for (const suffix of ['configmaps', 'workloads']) {
    const partial = JSON.parse(readFileSync(join(folder, `repository-migrations-dev-${suffix}.json`), 'utf8'));
    assert.throws(() => assertInventoryReport(partial, suffix), /reportType/);
  }
  assert.deepEqual(inputFiles.map(file => readFileSync(join(root, file), 'utf8')), before);
});

test('CronJob extraction covers direct/projected volumes, regular containers, env references and unused volumes', () => {
  const pod = {
    volumes: [
      { name: 'direct', configMap: { name: 'flyway-direct' } },
      { name: 'projected', projected: { sources: [{ secret: { name: 'never-read' } }, { configMap: { name: 'flyway-projected' } }] } },
      { name: 'unused', configMap: { name: 'flyway-unused' } },
    ],
    initContainers: [{
      name: 'migrate-db',
      volumeMounts: [{ name: 'direct', mountPath: '/flyway/sql/nested' }, { name: 'projected', mountPath: '/flyway/sql' }],
      envFrom: [{ configMapRef: { name: 'flyway-env' } }, { secretRef: { name: 'never-read' } }],
      env: [{ name: 'SQL', valueFrom: { configMapKeyRef: { name: 'flyway-env', key: 'V1.sql' } } }],
    }],
    containers: [{ name: 'app', volumeMounts: [{ name: 'direct', mountPath: '/copy' }] }],
  };
  const cronjob = { kind: 'CronJob', metadata: { name: 'cron' }, spec: { jobTemplate: { spec: { template: { spec: pod } } } } };
  const references = workloadReferences([cronjob]);
  assert.equal(references.length, 6);
  assert.ok(references.every(item => item.workloadType === 'CronJob' && item.workloadName === 'cron'));
  assert.ok(references.some(item => item.referenceType === 'volume' && item.containerType === 'container' && item.mountPath === '/copy'));
  assert.ok(references.some(item => item.referenceType === 'projected' && item.containerType === 'initContainer'));
  assert.ok(references.some(item => item.configMap === 'flyway-unused' && item.containerType === 'none'));
  assert.ok(references.some(item => item.referenceType === 'envFrom'));
  assert.ok(references.some(item => item.referenceType === 'env' && item.mountPath === 'env:SQL'));
  assert.ok(references.every(item => item.configMap !== 'never-read'));
  const maps = ['flyway-direct', 'flyway-projected', 'flyway-unused', 'flyway-env'].map(name => ({ metadata: { name }, data: { 'V1.sql': 'SELECT 1;' } }));
  const report = buildClusterReport(maps, [cronjob], 'dev', 'ns');
  assert.equal(report.consumers.length, 6);
});

function installKubectl(root: string, responses: Record<string, unknown>, failure = '', malformed = ''): NodeJS.ProcessEnv {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KUBE_CALLS, JSON.stringify(args) + '\\n');
const index = args.indexOf('get');
if (index < 0 || args.some(a => /secret/i.test(a))) process.exit(99);
const resource = args[index + 1];
if (resource === process.env.KUBE_FAIL) { console.error('Forbidden or invalid context'); process.exit(1); }
if (resource === process.env.KUBE_MALFORMED) { process.stdout.write('{ broken'); process.exit(0); }
const responses = JSON.parse(fs.readFileSync(process.env.KUBE_RESPONSES, 'utf8'));
if (!Object.hasOwn(responses, resource)) process.exit(98);
process.stdout.write(resource === 'namespace' ? 'namespace/test' : JSON.stringify(responses[resource]));
`;
  put(root, 'responses.json', JSON.stringify(responses));
  writeFileSync(join(bin, 'kubectl'), script, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, KUBE_CALLS: join(root, 'kube-calls.jsonl'), KUBE_RESPONSES: join(root, 'responses.json'), KUBE_FAIL: failure, KUBE_MALFORMED: malformed };
}

test('cluster CLI is read-only, scoped explicitly and rejects acquisition/parsing failures', async context => {
  for (const scenario of ['success', 'namespace', 'configmaps', 'deployments', 'cronjobs', 'malformed', 'missing-items']) await context.test(scenario, child => {
    const root = temporaryRoot(child);
    const responses = {
      namespace: {},
      configmaps: { items: [{ metadata: { name: 'flyway-test' }, data: { 'V1.sql': 'SELECT 1;' } }] },
      deployments: scenario === 'missing-items' ? {} : { items: [deployment('svc', 'flyway-test')] },
      cronjobs: { items: [] },
    };
    const env = installKubectl(root, responses, ['success', 'malformed', 'missing-items'].includes(scenario) ? '' : scenario, scenario === 'malformed' ? 'configmaps' : '');
    const result = invoke('cluster-inventory.ts', ['--environment', 'dev', '--context', 'kind-fixture', '--namespace', 'fixture-ns', '--output-dir', join(root, 'reports')], env);
    assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr);
    const calls: string[][] = readFileSync(env.KUBE_CALLS!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(args => args[0] === '--context' && args[1] === 'kind-fixture' && args.includes('get')));
    assert.ok(calls.every(args => !args.some(arg => /secret|apply|delete|patch/.test(arg))));
    if (scenario === 'success') {
      const report = JSON.parse(readFileSync(join(root, 'reports/cluster/cluster-migrations-dev.json'), 'utf8'));
      assertInventoryReport(report, 'cluster CLI');
      assert.equal(report.namespace, 'fixture-ns');
      assert.equal(report.context, 'kind-fixture');
      assert.equal(calls.length, 4);
    } else assert.ok(result.stderr.trim(), 'failure must be visible to the operator');
  });
});

test('comparison covers missing/extra/mismatched SQL and deduplicates repeated consumer references', context => {
  const root = temporaryRoot(context);
  const repository = emptyInventory('repository');
  repository.configMaps = ['flyway-test'];
  repository.migrations = ['V1.sql', 'V2.sql'].map(key => ({ configMap: 'flyway-test', key, sha256: 'a'.repeat(64), bytes: 1 }));
  repository.consumers = [{ workloadType: 'CronJob', workloadName: 'job', configMap: 'flyway-test', referenceType: 'legacy' }];
  const cluster = emptyInventory('cluster');
  cluster.configMaps = ['flyway-test'];
  cluster.migrations = [
    { configMap: 'flyway-test', key: 'V1.sql', sha256: 'b'.repeat(64), bytes: 1 },
    { configMap: 'flyway-test', key: 'V3.sql', sha256: 'a'.repeat(64), bytes: 1 },
  ];
  cluster.consumers = Array.from({ length: 2 }, () => ({ workloadType: 'CronJob', workloadName: 'other-job', configMap: 'flyway-test', referenceType: 'projected' }));
  assert.deepEqual(compare(repository, cluster).map(item => item.code).sort(), [
    'CONSUMER_EXTRA_IN_CLUSTER', 'CONSUMER_MISSING_IN_CLUSTER', 'MIG_CONTENT_MISMATCH', 'MIG_EXTRA_IN_CLUSTER', 'MIG_MISSING_IN_CLUSTER',
  ]);
  put(root, 'repo.json', JSON.stringify(repository));
  put(root, 'cluster.json', JSON.stringify(cluster));
  assert.equal(compareInventories(['--repository', join(root, 'repo.json'), '--cluster', join(root, 'cluster.json'), '--output', join(root, 'result.json')]), 1);
  const report = JSON.parse(readFileSync(join(root, 'compare/result.json'), 'utf8'));
  assert.equal(report.summary.total, 5);
  assert.equal(report.success, false);
  cluster.migrations = repository.migrations;
  assert.ok(compare(repository, cluster).every(item => item.severity === 'warning'));
  put(root, 'cluster.json', JSON.stringify(cluster));
  assert.equal(compareInventories(['--repository', join(root, 'repo.json'), '--cluster', join(root, 'cluster.json'), '--output', join(root, 'result.json')]), 1);
});

test('validate identifies remaining legacy references and excludes workloads with no Flyway reference', context => {
  const root = temporaryRoot(context);
  source(root);
  put(root, 'microservices/legacy/dev/values.yaml', 'deployment:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test\n');
  put(root, 'microservices/no-init/dev/values.yaml', 'deployment:\n  replicas: 1\n');
  put(root, 'jobs/no-reference/dev/values.yaml', 'cronjob:\n  flywayInitContainer:\n    create: false\n');
  const reports = join(root, 'reports');
  assert.equal(validateMigration(['--root', root, '--environment', 'dev', '--report-dir', reports]), 1);
  const report = JSON.parse(readFileSync(join(reports, 'validate-dev-workloads.json'), 'utf8'));
  assert.equal(report.success, false);
  assert.deepEqual(report.items.map((item: { status: string }) => item.status), ['WORKLOAD_LEGACY_REMAINS']);
});

function orchestratorFixture(context: { after: (fn: () => void) => void }) {
  const root = temporaryRoot(context);
  for (const folder of ['scripts/migrations/automation', 'scripts/migrations/flyway', 'bin']) mkdirSync(join(root, folder), { recursive: true });
  const calls = join(root, 'npm-calls.jsonl');
  writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALLS, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args.includes(process.env.FAIL_COMMAND)) process.exit(7);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, NPM_CALLS: calls };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync('bash', [join(directory, 'run-migration.sh'), args[0], '--root', root, ...args.slice(1)], { encoding: 'utf8', env: { ...env, ...extra } });
  const commands = (): Array<{ cwd: string; args: string[] }> => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, run, commands };
}

test('orchestrator rejects invalid arguments and protects mutating phases', async context => {
  const cases = [
    { args: ['repository'], message: /environment is required/ },
    { args: ['repository', '-e', '../qa'], message: /Invalid environment/ },
    { args: ['cluster', '-e', 'dev'], message: /context is required/ },
    { args: ['generate', '-e', 'dev'], message: /--apply/ },
    { args: ['migrate', '-e', 'dev'], message: /--apply/ },
    { args: ['generate', '-e', 'dev', '--apply', '--prune'], message: /Refusing --prune/ },
    { args: ['unknown', '-e', 'dev'], message: /Unknown phase/ },
    { args: ['plan', '-e', 'dev', '--unknown'], message: /Unknown option/ },
    { args: ['plan', '--environment'], message: /Missing environment/ },
  ];
  for (const scenario of cases) await context.test(scenario.args.join(' '), child => {
    const data = orchestratorFixture(child);
    const result = data.run(scenario.args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, scenario.message);
    assert.deepEqual(data.commands(), []);
  });
});

test('orchestrator forwards options without splitting paths and authorizes explicit prune', context => {
  const data = orchestratorFixture(context);
  source(data.root);
  const output = join(data.root, 'reports with spaces');
  for (const phase of ['generate', 'migrate', 'plan', 'compare']) {
    const args = [phase, '-e', 'dev', '-n', 'custom-ns', '-c', 'fixture-context', '-o', output];
    if (phase === 'generate') args.push('--apply', '--prune');
    if (phase === 'migrate') args.push('--apply');
    assert.equal(data.run(args).status, 0);
  }
  const commands = data.commands();
  assert.equal(commands.length, 4);
  assert.ok(commands[0].args.includes('--prune'));
  assert.ok(commands[0].args.includes(join(output, 'generate')));
  assert.ok(commands[2].args.includes('--dry-run'));
  assert.ok(commands[2].args.includes(join(output, 'plan')));
  assert.ok(commands[3].args.includes('custom-ns') && commands[3].args.includes('fixture-context'));
});

test('orchestrator propagates simple failures but collects every verify/validate result', async context => {
  for (const [phase, failing, expected, count] of [
    ['generate', 'generate', 7, 1],
    ['verify', 'verify:sha256', 1, 2],
    ['validate', 'validate:migration', 1, 3],
  ] as const) await context.test(phase, child => {
    const data = orchestratorFixture(child);
    const args = [phase, '-e', 'dev'];
    if (phase === 'generate') args.push('--apply');
    const result = data.run(args, { FAIL_COMMAND: failing });
    assert.equal(result.status, expected);
    assert.equal(data.commands().length, count);
    assert.doesNotMatch(result.stdout, /SUCCESS - phase/);
  });
});

test('orchestrator preflight checks Flyway before automation and stops on a failed prerequisite', context => {
  const data = orchestratorFixture(context);
  assert.equal(data.run(['preflight', '-e', 'dev']).status, 0);
  assert.deepEqual(data.commands().map(item => [item.cwd.endsWith('/flyway') ? 'flyway' : 'automation', item.args]), [
    ['flyway', ['ci']], ['flyway', ['run', 'typecheck']], ['flyway', ['test']],
    ['automation', ['ci']], ['automation', ['run', 'typecheck']], ['automation', ['test']],
  ]);
  const count = data.commands().length;
  assert.equal(data.run(['preflight', '-e', 'dev'], { FAIL_COMMAND: 'typecheck' }).status, 7);
  assert.equal(data.commands().length - count, 2);
});

test('orchestrator rejects an unsupported Node runtime before invoking npm', context => {
  const data = orchestratorFixture(context);
  writeFileSync(join(data.root, 'bin/node'), '#!/bin/bash\nif [[ "$1" == "--version" ]]; then echo v18.20.6; exit 0; fi\nexit 1\n', { mode: 0o755 });
  const result = data.run(['plan', '-e', 'dev']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Node.js >=22.2.0 is required/);
  assert.deepEqual(data.commands(), []);
});

test('inventory aggregation compares only successful acquisitions and forwards requested scope', async context => {
  for (const fail of ['', 'inventory:repository', 'inventory:cluster']) await context.test(fail || 'success', child => {
    const data = orchestratorFixture(child);
    const result = data.run(['inventory', '-e', 'dev', '-n', 'custom-ns', '-c', 'fixture-context'], { FAIL_COMMAND: fail });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.deepEqual(data.commands().map(item => item.args[1]), fail ? ['inventory:repository', 'inventory:cluster'] : ['inventory:repository', 'inventory:cluster', 'compare']);
    if (!fail) {
      const comparison = data.commands()[2].args;
      assert.ok(comparison.includes('fixture-context'));
      assert.ok(comparison.includes('custom-ns'));
    }
  });
});

test('comparison supports both domain prefixes for Deployment and CronJob and ignores deprecated domain', () => {
  for (const domain of ['flyway-example', 'event-store-migrations']) {
    const repository = emptyInventory('repository');
    repository.configMaps = [domain];
    repository.migrations = [{ configMap: domain, key: 'V1.sql', sha256: 'a'.repeat(64), bytes: 1 }];
    repository.consumers = [
      ...['Deployment', 'CronJob'].map(workloadType => ({ workloadType, workloadName: workloadType.toLowerCase(), configMap: domain, referenceType: 'target' })),
      { workloadType: 'Deployment', workloadName: 'deprecated', configMap: 'common-db-migrations', referenceType: 'ignored' },
    ];
    const cluster = emptyInventory('cluster');
    cluster.configMaps = [domain, ...repository.consumers.slice(0, 2).map(item => flywayConfigMapName(item.workloadName, domain))];
    cluster.migrations = cluster.configMaps.map(configMap => ({ ...repository.migrations[0], configMap }));
    cluster.consumers = repository.consumers.slice(0, 2).map(item => ({ ...item, configMap: flywayConfigMapName(item.workloadName, domain), referenceType: 'volume' }));
    assert.deepEqual(compare(repository, cluster), []);
  }
});

test('local porting lifecycle preserves shared SQL for service and CronJob and detects partial rollout', context => {
  const root = temporaryRoot(context);
  mkdirSync(join(root, 'scripts/migrations'), { recursive: true });
  symlinkSync(directory, join(root, 'scripts/migrations/automation'), 'dir');
  symlinkSync(join(directory, '../flyway'), join(root, 'scripts/migrations/flyway'), 'dir');
  source(root);
  put(root, 'microservices/svc/dev/values.yaml', 'name: actual-svc\ndeployment:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test\n');
  put(root, 'jobs/job/dev/values.yaml', 'name: actual-job\ncronjob:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test\n');
  put(root, 'microservices/ignored/dev/values.yaml', 'deployment:\n  flywayInitContainer:\n    migrationsConfigmap: common-db-migrations\n');
  const qa = put(root, 'jobs/job/qa/values.yaml', '# outside target\ninvalid: [');
  const output = join(root, 'reports with spaces');
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const phase = (name: string, ...args: string[]) => spawnSync('bash', [join(directory, 'run-migration.sh'), name, '--root', root, '--environment', 'dev', '--output-dir', output, ...args], { encoding: 'utf8', env });
  for (const [name, args] of [
    ['repository', []], ['generate', ['--apply']], ['verify', []], ['plan', []],
  ] as const) {
    const result = phase(name, ...args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  assert.match(readFileSync(join(root, 'microservices/svc/dev/values.yaml'), 'utf8'), /migrationsConfigmap/);
  assert.equal(phase('validate').status, 1, 'legacy references must fail before migrate');
  for (const [name, args] of [['migrate', ['--apply']], ['validate', []], ['repository', []], ['migrate', ['--apply']]] as const) {
    const result = phase(name, ...args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  const repository: InventoryReport = JSON.parse(readFileSync(join(output, 'repository/repository-migrations-dev.json'), 'utf8'));
  assert.deepEqual(repository.consumers.map(item => item.referenceType).sort(), ['ignored', 'target', 'target']);
  const sql = 'SELECT 1;';
  const maps = ['flyway-test', 'actual-svc-flyway-test', 'actual-job-flyway-test'].map(name => ({ metadata: { name }, data: { 'V1__Init.sql': sql } }));
  const job = (configMap: string) => ({
    kind: 'CronJob', metadata: { name: 'actual-job' },
    spec: { jobTemplate: { spec: { template: { spec: {
      volumes: [{ name: 'sql', configMap: { name: configMap } }],
      initContainers: [{ name: 'migrate-db', volumeMounts: [{ name: 'sql', mountPath: '/flyway/sql' }] }],
    } } } } },
  });
  const partial = { ...buildClusterReport(maps, [deployment('actual-svc', 'actual-svc-flyway-test'), job('flyway-test')], 'dev', 'dev'), context: 'kind-fixture' };
  assert.ok(compare(repository, partial).some(item => item.code === 'CONSUMER_MISSING_IN_CLUSTER'));
  const complete = { ...buildClusterReport(maps, [deployment('actual-svc', 'actual-svc-flyway-test'), job('actual-job-flyway-test')], 'dev', 'dev'), context: 'kind-fixture' };
  assert.deepEqual(compare(repository, complete), []);
  writeReports(complete, join(output, 'cluster'), 'cluster-migrations-dev');
  const result = phase('compare', '--context', 'kind-fixture');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(qa, 'utf8'), '# outside target\ninvalid: [');
  for (const [folder, stem] of [
    ['generate', 'generate-dev'], ['verify', 'verify-sha256-dev'], ['verify', 'verify-crc32-dev'],
    ['plan', 'plan-dev'], ['migrate', 'migrate-dev'], ['validate', 'validate-dev-workloads'],
    ['validate', 'verify-sha256-dev'], ['validate', 'verify-crc32-dev'],
  ]) {
    const report = JSON.parse(readFileSync(join(output, folder, `${stem}.json`), 'utf8'));
    assert.equal(report.success, true, stem);
    assert.ok(report.items.every((item: { detail: string; description: string }) => item.detail && !item.description.includes('<env>')));
    assert.ok(existsSync(join(output, folder, `${stem}.csv`)));
  }
});
