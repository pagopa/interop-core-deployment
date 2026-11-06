import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isMap, parseDocument } from 'yaml';

const directory = dirname(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const entrypoints = {
  generate: 'generate-flyway-migrations.ts',
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

test('CLI modules export main and do not execute when imported', async () => {
  for (const script of Object.values(entrypoints)) {
    const module = await import(`./${script}`) as { main?: () => Promise<void> };
    assert.equal(typeof module.main, 'function');
  }
});