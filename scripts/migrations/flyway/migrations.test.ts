import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isMap, parseDocument } from 'yaml';
import { createHash } from 'node:crypto';
import { writePhaseReport } from './phase-report.js';

const directory = dirname(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const entrypoints = {
  generate: 'generate-flyway-migrations.ts',
  migrate: 'migrate-workload-values.ts',
  crc32: 'verify-flyway-migration-crc32.ts',
  sha256: 'verify-flyway-migration-sha256.ts',
} as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flyway-node-test-'));
  const configmaps = join(root, 'commons', 'dev', 'configmaps');
  const migrations = join(root, 'commons', 'dev', 'migrations');
  mkdirSync(configmaps, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  const input = `kind: ConfigMap
metadata:
  name: flyway-test
data:
  V1__Init.sql: |-
    CREATE TABLE test (id int);   

    SELECT 1;
binaryData:
  unused: Zm9v
`;
  writeFileSync(join(configmaps, 'flyway-test.yaml'), input);
  return { root, configmaps, migrations, input };
}

function run(script: string, root: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsxCli, join(directory, script), '--root', root, '--environment', 'dev', ...args], {
    encoding: 'utf8',
  });
}

test('generator preserves SQL and trailing whitespace and skips other top-level sections', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  const generated = join(data.migrations, 'flyway-test.yaml');
  const result = run(entrypoints.generate, data.root);
  assert.equal(result.status, 0, result.stderr);
  const output = readFileSync(generated, 'utf8');
  assert.match(output, /CREATE TABLE test \(id int\);   \n/);
  assert.doesNotMatch(output, /binaryData/);
  const sourceData = parseDocument(data.input).get('data');
  const targetMigrations = parseDocument(output).get('migrations');
  assert.ok(isMap(sourceData));
  assert.ok(isMap(targetMigrations));
  const targetData = targetMigrations.get('flyway-test', true);
  assert.ok(isMap(targetData));
  const sourceValue = sourceData.get('V1__Init.sql', true);
  const targetValue = targetData.get('V1__Init.sql', true);
  assert.ok(sourceValue && typeof sourceValue === 'object' && 'value' in sourceValue);
  assert.ok(targetValue && typeof targetValue === 'object' && 'value' in targetValue);
  assert.equal(sourceValue.value, targetValue.value);
  for (const script of [entrypoints.crc32, entrypoints.sha256]) {
    const verified = run(script, data.root);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /SUCCESS - Verified 1 /);
  }
});

test('generator prunes only with --prune', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  const stale = join(data.migrations, 'stale.yml');
  writeFileSync(stale, 'stale: true\n');
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  assert.deepEqual(readdirSync(data.migrations).sort(), ['flyway-test.yaml', 'stale.yml']);
  assert.equal(run(entrypoints.generate, data.root, '--prune').status, 0);
  assert.deepEqual(readdirSync(data.migrations), ['flyway-test.yaml']);
});

test('both verifiers report mismatches and extra keys', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  const target = join(data.migrations, 'flyway-test.yaml');
  writeFileSync(target, readFileSync(target, 'utf8').replace('SELECT 1;', 'SELECT 2;') + '    V2__Extra.sql: extra\n');
  for (const script of [entrypoints.crc32, entrypoints.sha256]) {
    const result = run(script, data.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /2 error\(s\)/);
    assert.match(result.stderr, /mismatch/);
    assert.match(result.stderr, /unexpected migration 'V2__Extra.sql'/);
  }
});

test('both verifiers reject extra, misplaced, duplicate and malformed generated catalog entries', async context => {
  const scenarios = [
    { name: 'orphan file and unknown domain', filename: 'orphan.yaml', content: 'migrations:\n  unknown:\n    V1.sql: SELECT 1;\n', statuses: ['UNEXPECTED_GENERATED_FILE', 'UNEXPECTED_GENERATED_DOMAIN'] },
    { name: 'extra domain in canonical file', filename: 'flyway-test.yaml', append: '  unknown:\n    V1.sql: SELECT 1;\n', statuses: ['UNEXPECTED_GENERATED_DOMAIN'] },
    { name: 'duplicate known domain in extra file', filename: 'copy.yml', content: 'migrations:\n  flyway-test:\n    V1.sql: SELECT 1;\n', statuses: ['UNEXPECTED_GENERATED_FILE', 'MISPLACED_GENERATED_DOMAIN', 'DUPLICATE_GENERATED_DOMAIN'] },
    { name: 'invalid YAML in extra file', filename: 'invalid.yaml', content: 'migrations: [\n', statuses: ['UNEXPECTED_GENERATED_FILE', 'INVALID_GENERATED_FILE'] },
    { name: 'missing root map', filename: 'flyway-test.yaml', content: 'data: {}\n', statuses: ['INVALID_GENERATED_FILE'] },
    { name: 'invalid domain map', filename: 'flyway-test.yaml', content: 'migrations:\n  flyway-test: scalar\n', statuses: ['INVALID_GENERATED_FILE', 'INVALID_DATA'] },
    { name: 'duplicate YAML keys', filename: 'flyway-test.yaml', content: 'migrations:\n  flyway-test: {}\n  flyway-test: {}\n', statuses: ['INVALID_GENERATED_FILE'] },
    { name: 'missing canonical domain', filename: 'flyway-test.yaml', content: 'migrations: {}\n', statuses: ['INVALID_DATA'] },
    { name: 'missing SQL key', filename: 'flyway-test.yaml', content: 'migrations:\n  flyway-test: {}\n', statuses: ['MISSING_IN_GENERATED'] },
    { name: 'non-string SQL value', filename: 'flyway-test.yaml', content: 'migrations:\n  flyway-test:\n    V1__Init.sql: 1\n', statuses: ['INVALID_VALUE'] },
    { name: 'renamed canonical file', filename: 'renamed.yml', rename: true, statuses: ['UNEXPECTED_GENERATED_FILE', 'MISPLACED_GENERATED_DOMAIN', 'MISSING_GENERATED_FILE'] },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, child => {
      const data = fixture();
      child.after(() => rmSync(data.root, { recursive: true, force: true }));
      assert.equal(run(entrypoints.generate, data.root).status, 0);
      const canonical = join(data.migrations, 'flyway-test.yaml');
      const original = readFileSync(canonical, 'utf8');
      writeFileSync(join(data.migrations, scenario.filename), scenario.content ?? original + (scenario.append ?? ''));
      if (scenario.rename) rmSync(canonical);
      for (const script of [entrypoints.sha256, entrypoints.crc32]) {
        const reportDir = join(data.root, 'reports');
        const result = run(script, data.root, '--report-dir', reportDir);
        assert.equal(result.status, 1, result.stderr);
        const mode = script === entrypoints.sha256 ? 'sha256' : 'crc32';
        const report = JSON.parse(readFileSync(join(reportDir, `verify-${mode}-dev.json`), 'utf8'));
        assert.equal(report.success, false);
        const statuses = report.items.map((item: { status: string }) => item.status);
        for (const expected of scenario.statuses) assert.ok(statuses.includes(expected), `${expected}: ${statuses.join(', ')}`);
      }
    });
  }
});

test('verifiers ignore non-YAML files and subdirectories like the Helm values loader', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  writeFileSync(join(data.migrations, 'notes.txt'), 'not a Helm values file');
  mkdirSync(join(data.migrations, 'nested'));
  writeFileSync(join(data.migrations, 'nested/extra.yaml'), 'migrations: {}');
  for (const script of [entrypoints.sha256, entrypoints.crc32]) assert.equal(run(script, data.root).status, 0);
});

test('workload migrator leaves deprecated Scala MongoDB domain unchanged', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  const directory = join(data.root, 'microservices', 'authorization-management', 'dev');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'values.yaml');
  const input = `name: authorization-management
deployment:
  flywayInitContainer:
    migrationsConfigmap: common-db-migrations
`;
  writeFileSync(file, input);
  const result = run(entrypoints.migrate, data.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /IGNORED/);
  assert.equal(readFileSync(file, 'utf8'), input);
});

test('CLI modules export main and do not execute when imported', async () => {
  for (const script of Object.values(entrypoints)) {
    const module = await import(`./${script}`) as { main?: () => Promise<void> };
    assert.equal(typeof module.main, 'function');
  }
});

test('phases write JSON/CSV reports with per-item status even when failing', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  const reports = join(data.root, 'reports');
  assert.equal(run(entrypoints.generate, data.root, '--report-dir', reports).status, 0);
  const generated = JSON.parse(readFileSync(join(reports, 'generate-dev.json'), 'utf8'));
  assert.equal(generated.success, true);
  assert.deepEqual(generated.items.map((item: { status: string }) => item.status), ['CREATED']);
  assert.match(readFileSync(join(reports, 'generate-dev.csv'), 'utf8'), /^status,severity,configMap,keys,sourceFile,targetFile,detail,description\nCREATED,ok,flyway-test,1,/);

  const target = join(data.migrations, 'flyway-test.yaml');
  writeFileSync(target, readFileSync(target, 'utf8').replace('SELECT 1;', 'SELECT 2;'));
  assert.equal(run(entrypoints.sha256, data.root, '--report-dir', reports).status, 1);
  const verified = JSON.parse(readFileSync(join(reports, 'verify-sha256-dev.json'), 'utf8'));
  assert.equal(verified.success, false);
  assert.equal(verified.items[0].status, 'MISMATCH');
  assert.equal(verified.items[0].severity, 'critical');

  const workload = join(data.root, 'microservices', 'svc', 'dev');
  mkdirSync(workload, { recursive: true });
  writeFileSync(join(workload, 'values.yaml'), 'name: svc\ndeployment:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test\n');
  assert.equal(run(entrypoints.migrate, data.root, '--dry-run', '--report-dir', reports).status, 0);
  const plan = JSON.parse(readFileSync(join(reports, 'plan-dev.json'), 'utf8'));
  assert.deepEqual(plan.items.map((item: { status: string; workloadType: string; workloadName: string; configMap: string }) => [item.status, item.workloadType, item.workloadName, item.configMap]), [['WOULD_UPDATE', 'Deployment', 'svc', 'flyway-test']]);
});

test('shared readers validate source ConfigMaps and workload references', async context => {
  const { readSourceConfigMaps, SourceConfigMapError, readSourceConfigMap } = await import('./common.js');
  const { readFlywayReference, workloadValuesFiles } = await import('./workloads.js');
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.deepEqual(readSourceConfigMaps(data.configmaps).map(item => [item.name, Object.keys(item.data)]), [['flyway-test', ['V1__Init.sql']]]);
  const invalid = join(data.configmaps, 'flyway-invalid.yaml');
  writeFileSync(invalid, 'kind: ConfigMap\nmetadata:\n  name: flyway-invalid\ndata: {}\n');
  assert.throws(() => readSourceConfigMap(invalid), (error: unknown) => error instanceof SourceConfigMapError && error.code === 'NO_MIGRATIONS');

  const write = (folder: string, content: string) => {
    const directory = join(data.root, 'microservices', folder, 'dev');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'values.yaml'), content);
  };
  write('a-legacy', 'name: interop-a\ndeployment:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test\n');
  write('b-none', 'name: interop-b\ndeployment:\n  image: x\n');
  write('c-conflict', 'deployment:\n  flywayInitContainer:\n    migrationsConfigmap: x\n    migrationDomain: y\n');
  const [legacy, none, conflict] = workloadValuesFiles(data.root, 'dev');
  const reference = readFlywayReference(legacy);
  assert.deepEqual([reference.state, reference.workloadName, reference.legacy, reference.domain], ['REFERENCE', 'interop-a', 'flyway-test', 'flyway-test']);
  assert.equal(readFlywayReference(none).state, 'NO_FLYWAY_INIT_CONTAINER');
  assert.throws(() => readFlywayReference(conflict), /conflicts with migrationDomain/);
});

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [file, content] of Object.entries(snapshot(path))) result[`${entry.name}/${file}`] = content;
    } else result[entry.name] = readFileSync(path).toString('base64');
  }
  return result;
}

test('generator validates every source before writing or pruning any target', async context => {
  const cases = [
    { name: 'duplicate metadata name', input: 'kind: ConfigMap\nmetadata:\n  name: flyway-test\ndata:\n  V1.sql: SELECT 2;\n', status: 'DUPLICATE_CONFIGMAP' },
    { name: 'malformed YAML', input: 'data: [', status: 'INVALID_SOURCE' },
    { name: 'wrong kind', input: 'kind: Secret\nmetadata:\n  name: invalid\ndata:\n  x: value\n', status: 'INVALID_SOURCE' },
    { name: 'non-string SQL', input: 'kind: ConfigMap\nmetadata:\n  name: invalid\ndata:\n  V1.sql: 123\n', status: 'INVALID_SOURCE' },
    { name: 'empty source', input: 'kind: ConfigMap\nmetadata:\n  name: invalid\ndata: {}\n', status: 'INVALID_SOURCE' },
  ];
  for (const scenario of cases) await context.test(scenario.name, child => {
    const data = fixture();
    child.after(() => rmSync(data.root, { recursive: true, force: true }));
    writeFileSync(join(data.migrations, 'flyway-test.yaml'), 'existing target\n');
    writeFileSync(join(data.migrations, 'orphan.yml'), 'must not be pruned\n');
    writeFileSync(join(data.configmaps, 'flyway-z-invalid.yaml'), scenario.input);
    const before = snapshot(data.root);
    const result = run(entrypoints.generate, data.root, '--prune', '--report-dir', join(data.root, 'reports'));
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(join(data.root, 'reports/generate-dev.json'), 'utf8'));
    assert.equal(report.success, false);
    assert.ok(report.items.some((item: { status: string }) => item.status === scenario.status));
    rmSync(join(data.root, 'reports'), { recursive: true });
    assert.deepEqual(snapshot(data.root), before);
  });
});

test('generator is repeatable and limits changes and prune to the selected environment', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  const qa = join(data.root, 'commons/qa/migrations');
  mkdirSync(qa, { recursive: true });
  writeFileSync(join(qa, 'orphan.yaml'), 'untouched QA\n');
  writeFileSync(join(data.migrations, 'notes.txt'), 'untouched non-YAML\n');
  const beforeQa = snapshot(join(data.root, 'commons/qa'));
  const reports = join(data.root, 'reports');
  for (const status of ['CREATED', 'UNCHANGED', 'UPDATED']) {
    if (status === 'UPDATED') writeFileSync(join(data.configmaps, 'flyway-test.yaml'), data.input.replace('SELECT 1;', 'SELECT 2;'));
    assert.equal(run(entrypoints.generate, data.root, '--prune', '--report-dir', reports).status, 0);
    const report = JSON.parse(readFileSync(join(reports, 'generate-dev.json'), 'utf8'));
    assert.equal(report.items[0].status, status);
    assert.deepEqual(snapshot(join(data.root, 'commons/qa')), beforeQa);
    assert.equal(readFileSync(join(data.migrations, 'notes.txt'), 'utf8'), 'untouched non-YAML\n');
  }
});

test('generator preserves scalar styles, placeholders, Unicode and significant blank-line whitespace', async context => {
  for (const scalar of [
    '|-\n    SELECT \'${NAMESPACE}\';   \n       \n    SELECT \'città\';',
    '|\n    SELECT 1;\n',
    '|+\n    SELECT 1;\n\n',
    '>-\n    SELECT\n    1;',
    '"SELECT \\"example\\";\\nSELECT 2;"',
    "'SELECT 1;'",
  ]) await context.test(JSON.stringify(scalar), child => {
    const data = fixture();
    child.after(() => rmSync(data.root, { recursive: true, force: true }));
    const input = `kind: ConfigMap\nmetadata:\n  name: flyway-test\ndata:\n  V1.sql: ${scalar}\n`;
    writeFileSync(join(data.configmaps, 'flyway-test.yaml'), input);
    const result = run(entrypoints.generate, data.root);
    assert.equal(result.status, 0, result.stderr);
    const source = parseDocument(input).toJS();
    const target = parseDocument(readFileSync(join(data.migrations, 'flyway-test.yaml'), 'utf8')).toJS();
    assert.deepEqual(target.migrations['flyway-test'], source.data);
  });
});

test('migration plan is read-only, migrate preserves formatting and a repeated migration is a no-op', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  const paths: string[] = [];
  for (const [folder, section] of [['microservices', 'deployment'], ['jobs', 'cronjob']]) {
    for (const env of ['dev', 'qa']) {
      const path = join(data.root, folder, 'folder-name', env);
      mkdirSync(path, { recursive: true });
      const file = join(path, 'values.yaml');
      writeFileSync(file, `# keep formatting\nname: "actual-name"\n${section}:\n  flywayInitContainer:\n    migrationsConfigmap: 'flyway-test' # keep comment\n  env:\n    CUSTOM: "migrationsConfigmap: must not change"\n`);
      paths.push(file);
    }
  }
  const before = snapshot(data.root);
  assert.equal(run(entrypoints.migrate, data.root, '--dry-run').status, 0);
  assert.deepEqual(snapshot(data.root), before);
  assert.equal(run(entrypoints.migrate, data.root).status, 0);
  for (const file of paths) {
    const original = readFileSync(file, 'utf8');
    assert.ok(original.includes(file.includes('/dev/') ? "migrationDomain: 'flyway-test' # keep comment" : "migrationsConfigmap: 'flyway-test' # keep comment"));
    assert.ok(original.includes('CUSTOM: "migrationsConfigmap: must not change"'));
  }
  const migrated = snapshot(data.root);
  const reports = join(data.root, 'reports');
  assert.equal(run(entrypoints.migrate, data.root, '--report-dir', reports).status, 0);
  const report = JSON.parse(readFileSync(join(reports, 'migrate-dev.json'), 'utf8'));
  assert.ok(report.items.every((item: { status: string; clusterConfigMap: string }) => item.status === 'ALREADY_MIGRATED' && item.clusterConfigMap === 'actual-name-flyway-test'));
  rmSync(reports, { recursive: true });
  assert.deepEqual(snapshot(data.root), migrated);
});

test('migrator removes only the redundant legacy line when both references agree', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  const path = join(data.root, 'jobs/example/dev');
  mkdirSync(path, { recursive: true });
  const input = 'cronjob:\n  flywayInitContainer:\n    migrationsConfigmap: flyway-test # remove\n    migrationDomain: flyway-test # retain\n    create: true\n  schedule: "* * * * *"\n';
  writeFileSync(join(path, 'values.yaml'), input);
  assert.equal(run(entrypoints.migrate, data.root).status, 0);
  assert.equal(readFileSync(join(path, 'values.yaml'), 'utf8'), input.replace('    migrationsConfigmap: flyway-test # remove\n', ''));
});

test('migrator blocks all changes on invalid references or unavailable generated domains', async context => {
  const cases = [
    { name: 'unknown domain', workload: '    migrationsConfigmap: unknown\n' },
    { name: 'conflicting references', workload: '    migrationsConfigmap: flyway-test\n    migrationDomain: other\n' },
    { name: 'empty reference', workload: '    migrationsConfigmap: ""\n' },
    { name: 'malformed YAML', workload: '    migrationsConfigmap: [\n' },
    { name: 'missing generated file', remove: true },
    { name: 'missing generated domain', generated: 'migrations: {}\n' },
    { name: 'invalid generated YAML', generated: 'migrations: [\n' },
  ];
  for (const scenario of cases) await context.test(scenario.name, child => {
    const data = fixture();
    child.after(() => rmSync(data.root, { recursive: true, force: true }));
    assert.equal(run(entrypoints.generate, data.root).status, 0);
    for (const name of ['a-valid', 'z-invalid']) {
      const path = join(data.root, 'microservices', name, 'dev');
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'values.yaml'), `deployment:\n  flywayInitContainer:\n${name === 'z-invalid' && scenario.workload ? scenario.workload : '    migrationsConfigmap: flyway-test\n'}`);
    }
    if (scenario.remove) rmSync(join(data.migrations, 'flyway-test.yaml'));
    if (scenario.generated) writeFileSync(join(data.migrations, 'flyway-test.yaml'), scenario.generated);
    const before = snapshot(data.root);
    assert.equal(run(entrypoints.migrate, data.root).status, 1);
    assert.deepEqual(snapshot(data.root), before);
  });

});

test('generator fails closed for inline source maps instead of silently losing SQL', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  writeFileSync(join(data.configmaps, 'flyway-test.yaml'), 'kind: ConfigMap\nmetadata:\n  name: flyway-test\ndata: {V1.sql: "SELECT 1;"}\n');
  const before = snapshot(data.root);
  const result = run(entrypoints.generate, data.root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /do not preserve source data/);
  assert.deepEqual(snapshot(data.root), before);
});

test('checksum reports match known Flyway signed CRC32 and SHA-256 values', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  const input = 'kind: ConfigMap\nmetadata:\n  name: flyway-test\ndata:\n  V1.sql: "\\uFEFF1234\\r\\n56789\\n"\n';
  writeFileSync(join(data.configmaps, 'flyway-test.yaml'), input);
  assert.equal(run(entrypoints.generate, data.root).status, 0);
  const reports = join(data.root, 'reports');
  for (const [mode, script, expected] of [
    ['crc32', entrypoints.crc32, -873187034],
    ['sha256', entrypoints.sha256, createHash('sha256').update('\uFEFF1234\r\n56789\n\n').digest('hex')],
  ] as const) {
    assert.equal(run(script, data.root, '--report-dir', reports).status, 0);
    const report = JSON.parse(readFileSync(join(reports, `verify-${mode}-dev.json`), 'utf8'));
    assert.equal(report.items[0].sourceChecksum, expected);
    assert.equal(report.items[0].generatedChecksum, expected);
  }
  writeFileSync(join(data.migrations, 'flyway-test.yaml'), 'migrations:\n  flyway-test:\n    V1.sql: "1234\\n56789\\n"\n');
  assert.equal(run(entrypoints.crc32, data.root).status, 0, 'Flyway ignores BOM and newline differences');
  assert.equal(run(entrypoints.sha256, data.root).status, 1, 'SHA-256 must still detect byte differences');
});

test('reports escape CSV, replace environment placeholders and reject missing details or unknown statuses', context => {
  const data = fixture();
  context.after(() => rmSync(data.root, { recursive: true, force: true }));
  const input = {
    phase: 'test', environment: 'dev', root: data.root,
    definitions: { OK: { severity: 'ok' as const, description: 'Result for commons/<env>/migrations.' } },
    columns: ['value'], rows: [{ status: 'OK', detail: 'line 1\nline "2", comma', value: 'a,b' }],
  };
  assert.equal(writePhaseReport(data.root, 'report', input), true);
  const csv = readFileSync(join(data.root, 'report.csv'), 'utf8');
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"line 1\nline ""2"", comma"'));
  assert.ok(csv.includes('commons/dev/migrations'));
  assert.throws(() => writePhaseReport(undefined, 'report', { ...input, rows: [{ status: 'OK', detail: '' }] }), /Missing detail/);
  assert.throws(() => writePhaseReport(undefined, 'report', { ...input, rows: [{ status: 'OTHER', detail: 'unknown' }] }), /Undefined report status/);
  assert.equal(writePhaseReport(data.root, 'report', { ...input, rows: [{ status: 'FATAL_ERROR', detail: 'failed' }] }), false);
  assert.equal(JSON.parse(readFileSync(join(data.root, 'report.json'), 'utf8')).success, false);
});
