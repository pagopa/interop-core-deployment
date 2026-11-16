/**
 * Integration tests for list-external-secrets: runs the real script against a
 * temporary repository with a mocked AWS Secrets Manager and checks that only
 * the remoteRef.version values of outdated/misconfigured secrets are rewritten,
 * leaving every other byte of values.yaml untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { AwsSecretVersion } from '../../lib/aws-secrets-manager.js';

type AwsMock = Record<string, AwsSecretVersion | null>;

const awsState = vi.hoisted(() => ({ versions: {} as Record<string, unknown> }));

vi.mock('../../lib/aws-secrets-manager.js', () => ({
  createAwsClient: () => ({}),
  fetchLatestSecretVersion: async (_client: unknown, secretId: string) => awsState.versions[secretId] ?? null,
}));

const SCRIPT_PATH = fileURLToPath(
  new URL('../../external-secrets-generator/list-external-secrets.ts', import.meta.url)
);
const FIXTURE = fs.readFileSync(
  fileURLToPath(new URL('../fixtures/list-external-secrets/in-app-notification-manager-vapt.yaml', import.meta.url)),
  'utf-8'
);

const ENV = 'vapt';
const COMPONENT = 'in-app-notification-manager';
const FLYWAY_KEY = 'rds/interop-platform-data-vapt/users/flyway_user';
const APP_KEY = 'rds/interop-platform-data-vapt/users/vapt_in_app_notification_manager_user';
const FLYWAY_VERSION = 'terraform-20250826083827275600000003';
const APP_VERSION = 'terraform-2025112617422738190000000e';

const DB_USER_SECRET = { username: 'user', password: 'secret' };

function awsVersion(versionId: string, parsed: Record<string, unknown> = DB_USER_SECRET): AwsSecretVersion {
  return {
    versionId,
    versionStages: ['AWSCURRENT'],
    value: { raw: JSON.stringify(parsed), parsed, type: 'json' },
  };
}

/** Replaces the version line that follows `property: <property>` inside the remoteRef of `key`. */
function withVersion(content: string, key: string, property: string, from: string, to: string): string {
  const before = `key: ${key}\n          property: ${property}\n          version: ${from}\n`;
  const after = `key: ${key}\n          property: ${property}\n          version: ${to}\n`;
  expect(content.split(before)).toHaveLength(2);
  return content.replace(before, after);
}

/** Every line that differs must be a `version:` line; the line count must be unchanged. */
function expectOnlyVersionLinesChanged(original: string, patched: string): void {
  const a = original.split('\n');
  const b = patched.split('\n');
  expect(b).toHaveLength(a.length);
  a.forEach((line, i) => {
    if (line !== b[i]) {
      expect(line).toMatch(/^\s+version: /);
      expect(b[i]).toMatch(/^\s+version: /);
      expect(b[i].match(/^\s*/)![0]).toBe(line.match(/^\s*/)![0]);
    }
  });
}

/** Parsed documents must be identical once remoteRef.version fields are ignored. */
function stripVersions(content: string): unknown {
  return JSON.parse(JSON.stringify(parseYaml(content)), (k, v) => (k === 'version' ? undefined : v));
}

describe('list-external-secrets integration', () => {
  let root: string;
  let valuesFile: string;
  let originalArgv: string[];

  async function runScript(): Promise<string> {
    const outputDir = path.join(root, 'out');
    process.argv = ['node', SCRIPT_PATH, '--env', ENV, '--root', root, '--output-dir', outputDir];
    vi.resetModules();
    await import('../../external-secrets-generator/list-external-secrets.js');
    // Reports and patches are written in the same synchronous step at the end of main()
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(outputDir, `external-secrets-report-error-${ENV}.json`))).toBe(true);
    });
    return fs.readFileSync(valuesFile, 'utf-8');
  }

  function setup(content: string, versions: AwsMock): void {
    fs.writeFileSync(valuesFile, content);
    awsState.versions = versions;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'list-external-secrets-test-'));
    const dir = path.join(root, 'microservices', COMPONENT, ENV);
    fs.mkdirSync(dir, { recursive: true });
    valuesFile = path.join(dir, 'values.yaml');
    originalArgv = process.argv;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves values.yaml untouched when all versions are up to date', async () => {
    setup(FIXTURE, {
      [FLYWAY_KEY]: awsVersion(FLYWAY_VERSION),
      [APP_KEY]: awsVersion(APP_VERSION),
    });

    expect(await runScript()).toBe(FIXTURE);
  });

  it('updates only the app section versions when the app secret has a newer AWS version', async () => {
    const newVersion = 'terraform-20261116100000000000000001';
    setup(FIXTURE, {
      [FLYWAY_KEY]: awsVersion(FLYWAY_VERSION),
      [APP_KEY]: awsVersion(newVersion),
    });

    const patched = await runScript();

    let expected = withVersion(FIXTURE, APP_KEY, 'username', `uuid/${APP_VERSION}`, `uuid/${newVersion}`);
    expected = withVersion(expected, APP_KEY, 'password', `uuid/${APP_VERSION}`, `uuid/${newVersion}`);
    expect(patched).toBe(expected);
    expectOnlyVersionLinesChanged(FIXTURE, patched);
  });

  it('updates both flywayInitContainer and app sections with their own AWS versions', async () => {
    const newFlyway = 'terraform-20261116100000000000000002';
    const newApp = '9b0e5c1a-3f2d-4c8e-9a71-2f6d8b4e0c13';
    setup(FIXTURE, {
      [FLYWAY_KEY]: awsVersion(newFlyway),
      [APP_KEY]: awsVersion(newApp),
    });

    const patched = await runScript();

    let expected = FIXTURE;
    for (const property of ['username', 'password']) {
      expected = withVersion(expected, FLYWAY_KEY, property, `uuid/${FLYWAY_VERSION}`, `uuid/${newFlyway}`);
      expected = withVersion(expected, APP_KEY, property, `uuid/${APP_VERSION}`, `uuid/${newApp}`);
    }
    expect(patched).toBe(expected);
    expectOnlyVersionLinesChanged(FIXTURE, patched);
    expect(stripVersions(patched)).toEqual(stripVersions(FIXTURE));
  });

  it('preserves long lines, templates and folded scalars outside externalSecrets', async () => {
    setup(FIXTURE, {
      [FLYWAY_KEY]: awsVersion('terraform-20261116100000000000000003'),
      [APP_KEY]: awsVersion('terraform-20261116100000000000000004'),
    });

    const patched = await runScript();

    const unchangedLines = FIXTURE.split('\n').filter((l) => !/^\s+version: /.test(l));
    for (const line of unchangedLines) {
      expect(patched.split('\n')).toContain(line);
    }
    expect(patched).toContain(
      '  roleArn: "arn:aws:iam::{{.Values.local.awsAccountId}}:role/interop-be-in-app-notification-manager-{{.Values.namespace}}-es1"\n'
    );
    expect(patched).toContain(
      '    WELL_KNOWN_URLS: >-\n      {{.Values.local.well_known_url.AUTHSRV}}, {{.Values.local.well_known_url.BFF}}\n'
    );
    expect(patched).toContain('      FLYWAY_URL: jdbc:postgresql://$(POSTGRES_HOST):$(POSTGRES_PORT)/$(POSTGRES_DB)\n');
    expect(patched).not.toMatch(/\\\n/);
    expect(patched.endsWith('\n')).toBe(FIXTURE.endsWith('\n'));
    expect(patched.split('\n')).toHaveLength(FIXTURE.split('\n').length);
  });

  it('does not patch secrets whose AWS lookup fails, but still patches the others', async () => {
    const newApp = 'terraform-20261116100000000000000005';
    setup(FIXTURE, {
      [FLYWAY_KEY]: null,
      [APP_KEY]: awsVersion(newApp),
    });

    const patched = await runScript();

    let expected = withVersion(FIXTURE, APP_KEY, 'username', `uuid/${APP_VERSION}`, `uuid/${newApp}`);
    expected = withVersion(expected, APP_KEY, 'password', `uuid/${APP_VERSION}`, `uuid/${newApp}`);
    expect(patched).toBe(expected);
  });

  it('does not patch a secret whose property is missing in the latest AWS version', async () => {
    const newApp = 'terraform-20261116100000000000000006';
    setup(FIXTURE, {
      [FLYWAY_KEY]: awsVersion(FLYWAY_VERSION),
      [APP_KEY]: awsVersion(newApp, { username: 'user' }),
    });

    const patched = await runScript();

    expect(patched).toBe(withVersion(FIXTURE, APP_KEY, 'username', `uuid/${APP_VERSION}`, `uuid/${newApp}`));
  });

  it('replaces a misconfigured AWSCURRENT label with the explicit AWS version id', async () => {
    const content = withVersion(FIXTURE, FLYWAY_KEY, 'password', `uuid/${FLYWAY_VERSION}`, 'AWSCURRENT');
    setup(content, {
      [FLYWAY_KEY]: awsVersion(FLYWAY_VERSION),
      [APP_KEY]: awsVersion(APP_VERSION),
    });

    const patched = await runScript();

    expect(patched).toBe(FIXTURE);
  });

  it('adds a missing version right below the remoteRef property without touching anything else', async () => {
    const versionLine = `          version: uuid/${APP_VERSION}\n`;
    const withoutVersion = FIXTURE.replace(
      `property: password\n${versionLine}`,
      'property: password\n'
    );
    expect(withoutVersion).not.toBe(FIXTURE);
    setup(withoutVersion, {
      [FLYWAY_KEY]: awsVersion(FLYWAY_VERSION),
      [APP_KEY]: awsVersion(APP_VERSION),
    });

    expect(await runScript()).toBe(FIXTURE);
  });

  it('preserves comments, blank lines, quoting and multi-line scalars in a richer values.yaml', async () => {
    const newVersion = 'terraform-20261116100000000000000007';
    const content = `name: "interop-be-authorization-process"
techStack: "nodejs"

# Service account used by External Secrets
serviceAccount:
  roleArn: "arn:aws:iam::{{.Values.local.awsAccountId}}:role/interop-be-authorization-process-{{.Values.namespace}}-es1"

externalSecrets:
  app:
    create: true
    data:
      # event store credentials
      - secretKey: EVENTSTORE_DB_USERNAME
        remoteRef:
          key: ${APP_KEY}
          property: username # db user
          version: "uuid/${APP_VERSION}"

      - secretKey: EVENTSTORE_DB_PASSWORD
        remoteRef:
          key: ${APP_KEY}
          property: password
          version: 'uuid/${APP_VERSION}'

deployment:
  env:
    SERVICE_VERSION: "{{.Values.deployment.image.tag}}"
    WELL_KNOWN_URLS: >-
      {{.Values.local.well_known_url.AUTHSRV}},
      {{.Values.local.well_known_url.BFF}},
      {{.Values.local.well_known_url.INTERNAL}},
      {{.Values.local.well_known_url.MAINTENANCE}}
    SCRIPT: |
      echo "first line"
      echo "second line"
    EMPTY_VALUE: ""
    LIST: [a, b, c]
`;
    setup(content, { [APP_KEY]: awsVersion(newVersion) });

    const patched = await runScript();

    expect(patched).toBe(content.replaceAll(`uuid/${APP_VERSION}`, `uuid/${newVersion}`));
    expectOnlyVersionLinesChanged(content, patched);
  });
});
