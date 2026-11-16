/**
 * Formatting-preservation tests for the External Secrets generator.
 *
 * The generator (secret-references-external-secrets-generator.ts) writes values files only through
 * initializeCommonsExternalSecrets and applyExternalSecretsToWorkload: once per commons file, then
 * once per generated section (app, flywayInitContainer) per workload. These tests run those calls on
 * copies of real values files and compare the result byte by byte: the only allowed changes are the
 * externalSecrets block and, when requested, the removed envFromSecrets blocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import {
  applyExternalSecretsToWorkload,
  createBackup,
  initializeCommonsExternalSecrets,
} from '../../lib/values-yaml-patcher.js';
import type { ContainerExternalSecretsConfig } from '../../lib/external-secrets-types.js';

const fixture = (name: string): string =>
  fs.readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf-8');

const MICROSERVICE = fixture('external-secrets-generator/authorization-process-prod.yaml');
const CRONJOB = fixture('external-secrets-generator/check-selfcare-diff-prod.yaml');
const MIGRATED = fixture('list-external-secrets/in-app-notification-manager-vapt.yaml');
const COMMONS_INITIALIZED = fixture('external-secrets-generator/commons-dev-values-microservice.yaml');
const COMMONS_EMPTY = fixture('external-secrets-generator/commons-prod-values-microservice.yaml');

const remoteRef = (secretKey: string, key: string, property: string, version = 'uuid/v1') => ({
  secretKey,
  remoteRef: { key, property, version },
});

const APP_CONFIG: ContainerExternalSecretsConfig = {
  create: true,
  data: [
    remoteRef('SELFCARE_V2_API_KEY', 'app/backend/selfcare-v2', 'SELFCARE_V2_API_KEY'),
    remoteRef('EVENTSTORE_DB_USERNAME', 'app/backend/event-store', 'POSTGRES_USR'),
  ],
};

const FLYWAY_CONFIG: ContainerExternalSecretsConfig = {
  create: true,
  data: [
    remoteRef('FLYWAY_USER', 'app/backend/event-store', 'POSTGRES_USR'),
    remoteRef('FLYWAY_PASSWORD', 'app/backend/event-store', 'POSTGRES_PSW'),
  ],
};

const APP_BLOCK = `externalSecrets:
  app:
    create: true
    data:
      - secretKey: SELFCARE_V2_API_KEY
        remoteRef:
          key: app/backend/selfcare-v2
          property: SELFCARE_V2_API_KEY
          version: uuid/v1
      - secretKey: EVENTSTORE_DB_USERNAME
        remoteRef:
          key: app/backend/event-store
          property: POSTGRES_USR
          version: uuid/v1`;

const FLYWAY_SECTION = `  flywayInitContainer:
    create: true
    data:
      - secretKey: FLYWAY_USER
        remoteRef:
          key: app/backend/event-store
          property: POSTGRES_USR
          version: uuid/v1
      - secretKey: FLYWAY_PASSWORD
        remoteRef:
          key: app/backend/event-store
          property: POSTGRES_PSW
          version: uuid/v1`;

// Sections follow the order in which the generator applies them (see applyLikeGenerator)
const FLYWAY_AND_APP_BLOCK = APP_BLOCK.replace('externalSecrets:\n', `externalSecrets:\n${FLYWAY_SECTION}\n`);

const MS_FLYWAY_ENV_FROM_SECRETS = `    envFromSecrets:
      FLYWAY_USER: "event-store.POSTGRES_USR"
      FLYWAY_PASSWORD: "event-store.POSTGRES_PSW"
`;

const MS_APP_ENV_FROM_SECRETS = `  envFromSecrets:
    SELFCARE_V2_API_KEY: "selfcare-v2.SELFCARE_V2_API_KEY"
    EVENTSTORE_DB_USERNAME: "event-store.POSTGRES_USR"
    EVENTSTORE_DB_PASSWORD: "event-store.POSTGRES_PSW"
    READMODEL_DB_USERNAME: "read-model.READONLY_USR"
    READMODEL_DB_PASSWORD: "read-model.READONLY_PSW"
    READMODEL_SQL_DB_USERNAME: "platform-data-authorization-process-user.username"
    READMODEL_SQL_DB_PASSWORD: "platform-data-authorization-process-user.password"
`;

const CRONJOB_ENV_FROM_SECRETS = `
  envFromSecrets:
    SELFCARE_V2_API_KEY: "selfcare-v2.SELFCARE_V2_API_KEY"
    READMODEL_SQL_DB_USERNAME: "platform-data-check-selfcare-diff-user.username"
    READMODEL_SQL_DB_PASSWORD: "platform-data-check-selfcare-diff-user.password"
`;

/** Replaces exactly one occurrence, failing loudly if the fixture does not contain it. */
function replaceOnce(content: string, search: string, replacement: string): string {
  expect(content.split(search), `expected exactly one occurrence of:\n${search}`).toHaveLength(2);
  return content.replace(search, replacement);
}

const insertBefore = (content: string, anchor: 'deployment' | 'cronjob', block: string) =>
  replaceOnce(content, `\n\n${anchor}:`, `\n\n${block}\n\n${anchor}:`);

describe('external-secrets generator: values files formatting', () => {
  let tempDir: string;

  const writeTemp = (name: string, content: string): string => {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const read = (file: string) => fs.readFileSync(file, 'utf-8');

  const apply = (
    file: string,
    app: ContainerExternalSecretsConfig | undefined,
    flyway: ContainerExternalSecretsConfig | undefined,
    removeOldRefs = false,
    dryRun = false
  ) => {
    const result = applyExternalSecretsToWorkload(file, app, flyway, removeOldRefs, dryRun);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  };

  /**
   * Mirrors the generator: one call per generated section, in the order their secret references
   * appear in the file (deployment.flywayInitContainer.envFromSecrets precedes deployment.envFromSecrets).
   */
  const applyLikeGenerator = (file: string, removeOldRefs: boolean) => {
    apply(file, undefined, FLYWAY_CONFIG, removeOldRefs);
    apply(file, APP_CONFIG, undefined, removeOldRefs);
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-generator-format-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // No-op calls must never touch the file
  // -------------------------------------------------------------------------

  describe('applyExternalSecretsToWorkload without changes to apply', () => {
    it.each([
      ['microservice (long lines, multi-line folded scalar)', MICROSERVICE],
      ['cronjob (aligned inline comment, blank lines)', CRONJOB],
      ['already migrated microservice', MIGRATED],
    ])('leaves the %s file byte-identical', (_label, content) => {
      const file = writeTemp('values.yaml', content);
      apply(file, undefined, undefined, false);
      expect(read(file)).toBe(content);
    });

    it('leaves a file without envFromSecrets byte-identical when removeOldRefs is requested', () => {
      const file = writeTemp('values.yaml', MIGRATED);
      apply(file, undefined, undefined, true);
      expect(read(file)).toBe(MIGRATED);
    });
  });

  // -------------------------------------------------------------------------
  // First migration of a microservice
  // -------------------------------------------------------------------------

  describe('microservice migration', () => {
    it('inserts only the app block before deployment, keeping the rest byte-identical', () => {
      const file = writeTemp('values.yaml', MICROSERVICE);
      apply(file, APP_CONFIG, undefined, false);
      expect(read(file)).toBe(insertBefore(MICROSERVICE, 'deployment', APP_BLOCK));
    });

    it('inserts flywayInitContainer and app blocks with sequential calls, in the generator order', () => {
      const file = writeTemp('values.yaml', MICROSERVICE);
      applyLikeGenerator(file, false);
      expect(read(file)).toBe(insertBefore(MICROSERVICE, 'deployment', FLYWAY_AND_APP_BLOCK));
    });

    it('removes only the envFromSecrets blocks when old refs are removed', () => {
      const file = writeTemp('values.yaml', MICROSERVICE);
      applyLikeGenerator(file, true);

      let expected = insertBefore(MICROSERVICE, 'deployment', FLYWAY_AND_APP_BLOCK);
      expected = replaceOnce(expected, MS_FLYWAY_ENV_FROM_SECRETS, '');
      expected = replaceOnce(expected, MS_APP_ENV_FROM_SECRETS, '');
      expect(read(file)).toBe(expected);
    });

    it('preserves long quoted strings, folded scalars and unquoted URLs', () => {
      const file = writeTemp('values.yaml', MICROSERVICE);
      applyLikeGenerator(file, true);
      const patched = read(file);

      expect(patched).toContain(
        '  roleArn: "arn:aws:iam::{{.Values.local.awsAccountId}}:role/interop-be-authorization-process-{{.Values.namespace}}-es1"\n'
      );
      expect(patched).toContain(
        '    WELL_KNOWN_URLS: >-\n' +
          '      {{.Values.local.well_known_url.AUTHSRV}},\n' +
          '      {{.Values.local.well_known_url.BFF}},\n' +
          '      {{.Values.local.well_known_url.INTERNAL}},\n' +
          '      {{.Values.local.well_known_url.MAINTENANCE}}\n'
      );
      expect(patched).toContain('      FLYWAY_URL: jdbc:postgresql://$(POSTGRES_HOST):$(POSTGRES_PORT)/$(POSTGRES_DB)\n');
      expect(patched).not.toMatch(/\\\n/);
    });

    it('is idempotent: running the generator twice gives the same file as running it once', () => {
      const once = writeTemp('once.yaml', MICROSERVICE);
      applyLikeGenerator(once, true);
      const twice = writeTemp('twice.yaml', MICROSERVICE);
      applyLikeGenerator(twice, true);
      applyLikeGenerator(twice, true);
      expect(read(twice)).toBe(read(once));
    });

    it('does not write anything in dry-run mode', () => {
      const file = writeTemp('values.yaml', MICROSERVICE);
      apply(file, APP_CONFIG, undefined, true, true);
      apply(file, undefined, FLYWAY_CONFIG, true, true);
      expect(read(file)).toBe(MICROSERVICE);
    });
  });

  // -------------------------------------------------------------------------
  // First migration of a cronjob
  // -------------------------------------------------------------------------

  describe('cronjob migration', () => {
    it('inserts the app block before cronjob, keeping comments and blank lines byte-identical', () => {
      const file = writeTemp('values.yaml', CRONJOB);
      apply(file, APP_CONFIG, undefined, false);

      const patched = read(file);
      expect(patched).toBe(insertBefore(CRONJOB, 'cronjob', APP_BLOCK));
      expect(patched).toContain('  schedule: "0 2 * * *"  # Daily at 2 AM UTC\n');
    });

    it('removes only cronjob.envFromSecrets (with its separating blank line) when old refs are removed', () => {
      const file = writeTemp('values.yaml', CRONJOB);
      apply(file, APP_CONFIG, undefined, true);

      const expected = replaceOnce(insertBefore(CRONJOB, 'cronjob', APP_BLOCK), CRONJOB_ENV_FROM_SECRETS, '');
      expect(read(file)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // Re-running the generator on an already migrated file
  // -------------------------------------------------------------------------

  describe('already migrated file', () => {
    const migratedConfig = (): { app: ContainerExternalSecretsConfig; flyway: ContainerExternalSecretsConfig } => {
      const { externalSecrets } = parseYaml(MIGRATED);
      return { app: externalSecrets.app, flyway: externalSecrets.flywayInitContainer };
    };

    it('stays byte-identical when the same app config is applied again', () => {
      const file = writeTemp('values.yaml', MIGRATED);
      apply(file, migratedConfig().app, undefined, true);
      expect(read(file)).toBe(MIGRATED);
    });

    it('stays byte-identical, keeping the existing section order, when flyway and app configs are applied again', () => {
      const file = writeTemp('values.yaml', MIGRATED);
      const { app, flyway } = migratedConfig();
      apply(file, undefined, flyway, true);
      apply(file, app, undefined, true);
      expect(read(file)).toBe(MIGRATED);
    });

    it('changes only the app version lines when AWS versions are updated', () => {
      const file = writeTemp('values.yaml', MIGRATED);
      const { app } = migratedConfig();
      const updated = {
        ...app,
        data: app.data.map((d) => ({ ...d, remoteRef: { ...d.remoteRef, version: 'uuid/terraform-new' } })),
      };
      apply(file, updated, undefined, true);

      const expected = MIGRATED.replaceAll(
        'version: uuid/terraform-2025112617422738190000000e',
        'version: uuid/terraform-new'
      );
      expect(read(file)).toBe(expected);
    });

    it('adds a new app secret without touching the flywayInitContainer section or the rest of the file', () => {
      const file = writeTemp('values.yaml', MIGRATED);
      const { app } = migratedConfig();
      apply(file, { ...app, data: [...app.data, remoteRef('NEW_SECRET', 'app/backend/new', 'VALUE')] }, undefined, true);

      const lastAppEntry = `          key: rds/interop-platform-data-vapt/users/vapt_in_app_notification_manager_user
          property: password
          version: uuid/terraform-2025112617422738190000000e
`;
      const expected = replaceOnce(
        MIGRATED,
        lastAppEntry,
        `${lastAppEntry}      - secretKey: NEW_SECRET
        remoteRef:
          key: app/backend/new
          property: VALUE
          version: uuid/v1
`
      );
      expect(read(file)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // YAML constructs found across the repository
  // -------------------------------------------------------------------------

  describe('YAML constructs outside externalSecrets', () => {
    const EDGE_CASES = `name: "interop-be-edge-case"

# Top-level comment
serviceAccount:
  roleArn: "arn:aws:iam::{{.Values.local.awsAccountId}}:role/interop-be-a-very-long-workload-name-{{.Values.namespace}}-es1"

deployment:
  command: ["bin/interop-be-edge-case"]
  args: [--port, "8088"]
  env:
    
    SINGLE_QUOTED: 'value'
    LONG_FOLDED: >-
      {{.Values.local.well_known_url.AUTHSRV}},
      {{.Values.local.well_known_url.BFF}}
    LITERAL: |
      first line
        indented line
    EMPTY: ""
    TILDE: ~
  replicas: 2  # aligned comment
  envFromSecrets:
    DB_USER: "db.USER"`;

    it('preserves flow sequences, quoting, block scalars, comments, whitespace-only lines and the missing final newline', () => {
      const file = writeTemp('values.yaml', EDGE_CASES);
      apply(file, APP_CONFIG, undefined, false);
      expect(read(file)).toBe(insertBefore(EDGE_CASES, 'deployment', APP_BLOCK));
    });

    it('removes a trailing envFromSecrets without reformatting the rest of the file', () => {
      const file = writeTemp('values.yaml', EDGE_CASES);
      apply(file, APP_CONFIG, undefined, true);
      const expected = replaceOnce(
        insertBefore(EDGE_CASES, 'deployment', APP_BLOCK),
        '\n  envFromSecrets:\n    DB_USER: "db.USER"',
        ''
      );
      expect(read(file)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // Commons initialization
  // -------------------------------------------------------------------------

  describe('initializeCommonsExternalSecrets', () => {
    it('leaves an already initialized commons file byte-identical (store read from commons)', () => {
      const file = writeTemp('values-microservice.yaml', COMMONS_INITIALIZED);
      expect(initializeCommonsExternalSecrets(file, false).success).toBe(true);
      expect(read(file)).toBe(COMMONS_INITIALIZED);
    });

    it('leaves an already initialized commons file byte-identical when the same store is passed', () => {
      const file = writeTemp('values-microservice.yaml', COMMONS_INITIALIZED);
      expect(initializeCommonsExternalSecrets(file, false, 'app-secret-store').success).toBe(true);
      expect(read(file)).toBe(COMMONS_INITIALIZED);
    });

    it('only appends the externalSecrets block to an uninitialized commons file', () => {
      const file = writeTemp('values-microservice.yaml', COMMONS_EMPTY);
      expect(initializeCommonsExternalSecrets(file, false, 'app-secret-store').success).toBe(true);

      const patched = read(file);
      expect(patched.startsWith(COMMONS_EMPTY)).toBe(true);
      expect(parseYaml(patched.slice(COMMONS_EMPTY.length))).toEqual({
        externalSecrets: {
          app: { secretStoreRef: { name: 'app-secret-store', kind: 'SecretStore' } },
          flywayInitContainer: { secretStoreRef: { name: 'app-secret-store', kind: 'SecretStore' } },
        },
      });
    });

    it('appends a missing section after the existing ones, keeping their order', () => {
      const flywayOnly = `local:
  env: "dev"

externalSecrets:
  flywayInitContainer:
    secretStoreRef:
      name: app-secret-store
      kind: SecretStore
`;
      const file = writeTemp('values-microservice.yaml', flywayOnly);
      expect(initializeCommonsExternalSecrets(file, false, 'app-secret-store').success).toBe(true);
      expect(read(file)).toBe(`${flywayOnly}  app:
    secretStoreRef:
      name: app-secret-store
      kind: SecretStore
`);
    });

    it('migrates legacy sections keeping their original order', () => {
      const store = `    secretStoreRef:
      name: app-secret-store
      kind: SecretStore
`;
      const legacy = `local:\n  env: "dev"\n\nexternalSecrets:\n  initContainer:\n${store}  container:\n${store}`;
      const file = writeTemp('values-microservice.yaml', legacy);
      expect(initializeCommonsExternalSecrets(file, false).success).toBe(true);
      expect(read(file)).toBe(
        `local:\n  env: "dev"\n\nexternalSecrets:\n  flywayInitContainer:\n${store}  app:\n${store}`
      );
    });

    it('is idempotent on an uninitialized commons file', () => {
      const once = writeTemp('once.yaml', COMMONS_EMPTY);
      initializeCommonsExternalSecrets(once, false, 'app-secret-store');
      const twice = writeTemp('twice.yaml', COMMONS_EMPTY);
      initializeCommonsExternalSecrets(twice, false, 'app-secret-store');
      initializeCommonsExternalSecrets(twice, false, 'app-secret-store');
      expect(read(twice)).toBe(read(once));
    });

    it.each([
      ['initialized', COMMONS_INITIALIZED],
      ['uninitialized', COMMONS_EMPTY],
    ])('does not write the %s commons file in dry-run mode', (_label, content) => {
      const file = writeTemp('values-microservice.yaml', content);
      expect(initializeCommonsExternalSecrets(file, true, 'app-secret-store').success).toBe(true);
      expect(read(file)).toBe(content);
    });

    it('does not write the commons file when the requested store conflicts', () => {
      const file = writeTemp('values-microservice.yaml', COMMONS_INITIALIZED);
      expect(initializeCommonsExternalSecrets(file, false, 'another-store').success).toBe(false);
      expect(read(file)).toBe(COMMONS_INITIALIZED);
    });
  });

  // -------------------------------------------------------------------------
  // Full generator sequence and backups
  // -------------------------------------------------------------------------

  describe('generator write sequence', () => {
    it('commons check, commons init, backup and per-section apply change only the expected parts', () => {
      const commons = writeTemp('values-microservice.yaml', COMMONS_INITIALIZED);
      const values = writeTemp('values.yaml', MICROSERVICE);

      expect(initializeCommonsExternalSecrets(commons, true).success).toBe(true);
      expect(initializeCommonsExternalSecrets(commons, false).success).toBe(true);
      const backup = createBackup(values);
      apply(values, undefined, FLYWAY_CONFIG, true);
      createBackup(values);
      apply(values, APP_CONFIG, undefined, true);

      let expected = insertBefore(MICROSERVICE, 'deployment', FLYWAY_AND_APP_BLOCK);
      expected = replaceOnce(expected, MS_FLYWAY_ENV_FROM_SECRETS, '');
      expected = replaceOnce(expected, MS_APP_ENV_FROM_SECRETS, '');

      expect(read(commons)).toBe(COMMONS_INITIALIZED);
      expect(read(values)).toBe(expected);
      expect(read(backup)).toBe(MICROSERVICE);
    });
  });
});
