import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readValuesFile,
  writeValuesFile,
  mergeExternalSecretsContainer,
  mergeExternalSecretsInitContainer,
  removeEnvFromSecretsReferences,
  applyExternalSecretsToWorkload,
  listEnvFromSecretsReferences,
  initializeCommonsExternalSecrets,
} from '../../lib/values-yaml-patcher.js';
import type { ContainerExternalSecretsConfig } from '../../lib/external-secrets-types.js';

describe('values-yaml-patcher', () => {
  let tempDir: string;
  let testValuesFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'values-patcher-test-'));
    testValuesFile = path.join(tempDir, 'values.yaml');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  const mockExternalSecretsConfig: ContainerExternalSecretsConfig = {
    create: true,
    secretStoreRef: {
      name: 'aws-secretsmanager',
      kind: 'ClusterSecretStore',
    },
    targetSecret: {
      name: 'my-secret',
      creationPolicy: 'Owner',
      deletionPolicy: 'Retain',
    },
    data: [
      {
        secretKey: 'password',
        remoteRef: {
          key: 'rds/test',
          property: 'password',
          version: 'uuid/v1',
        },
      },
    ],
  };

  describe('readValuesFile and writeValuesFile', () => {
    it('should read and write YAML correctly', () => {
      const testData = {
        name: 'test-app',
        replicas: 3,
        env: [{ name: 'TEST', value: 'true' }],
      };

      writeValuesFile(testValuesFile, testData);
      const read = readValuesFile(testValuesFile);

      expect(read.name).toBe('test-app');
      expect(read.replicas).toBe(3);
      expect(read.env).toHaveLength(1);
    });

    it('should handle empty files', () => {
      fs.writeFileSync(testValuesFile, '');
      const read = readValuesFile(testValuesFile);
      expect(read).toEqual({});
    });
  });

  describe('mergeExternalSecretsContainer', () => {
    it('should merge container config into values', () => {
      const values = { name: 'test' };
      mergeExternalSecretsContainer(values, mockExternalSecretsConfig);

      expect(values.externalSecrets).toBeDefined();
      expect(values.externalSecrets.app).toBeDefined();
      expect(values.externalSecrets.app.create).toBe(true);
      expect(values.externalSecrets.app.data).toHaveLength(1);
    });

    it('should preserve existing externalSecrets fields', () => {
      const values = {
        externalSecrets: {
          app: {
            create: false,
          },
        },
      };

      mergeExternalSecretsContainer(values, mockExternalSecretsConfig);

      expect(values.externalSecrets.app.create).toBe(true);
      expect(values.externalSecrets.app.data).toHaveLength(1);

      mergeExternalSecretsContainer(values, mockExternalSecretsConfig, 'cronjob');
      expect(values.externalSecrets.app.data).toHaveLength(1);
    });
  });

  describe('mergeExternalSecretsInitContainer', () => {
    it('should merge initContainer config into values', () => {
      const values = { name: 'test' };
      mergeExternalSecretsInitContainer(values, mockExternalSecretsConfig);

      expect(values.externalSecrets).toBeDefined();
      expect(values.externalSecrets.flywayInitContainer).toBeDefined();
      expect(values.externalSecrets.flywayInitContainer.create).toBe(true);

      mergeExternalSecretsInitContainer(values, mockExternalSecretsConfig, 'cronjob');
      expect(values.externalSecrets.flywayInitContainer.create).toBe(true);
    });
  });

  describe('removeEnvFromSecretsReferences', () => {
    it('should remove top-level envFromSecrets array', () => {
      const values = {
        envFromSecrets: ['secret1', 'secret2'],
        name: 'test',
      };

      const removed = removeEnvFromSecretsReferences(values);

      expect(removed).toBe(true);
      expect(values.envFromSecrets).toBeUndefined();
      expect(values.name).toBe('test');
    });

    it('should return false if no envFromSecrets', () => {
      const values = { name: 'test' };
      const removed = removeEnvFromSecretsReferences(values);

      expect(removed).toBe(false);
    });

    it('should remove container.env.fromSecrets', () => {
      const values = {
        container: {
          env: {
            fromSecrets: ['secret1'],
          },
        },
      };

      const removed = removeEnvFromSecretsReferences(values);

      expect(removed).toBe(true);
      expect(values.container.env.fromSecrets).toBeUndefined();
    });
  });

  describe('listEnvFromSecretsReferences', () => {
    it('should list string references', () => {
      const values = {
        envFromSecrets: ['secret1', 'secret2'],
      };

      const refs = listEnvFromSecretsReferences(values);

      expect(refs).toEqual(['secret1', 'secret2']);
    });

    it('should list object references with name field', () => {
      const values = {
        envFromSecrets: [{ name: 'secret1' }, { name: 'secret2' }],
      };

      const refs = listEnvFromSecretsReferences(values);

      expect(refs).toEqual(['secret1', 'secret2']);
    });

    it('should return empty array if no envFromSecrets', () => {
      const values = { name: 'test' };
      const refs = listEnvFromSecretsReferences(values);

      expect(refs).toEqual([]);
    });
  });

  describe('applyExternalSecretsToWorkload', () => {
    beforeEach(() => {
      const initialValues = {
        name: 'test-app',
        replicas: 3,
      };
      writeValuesFile(testValuesFile, initialValues);
    });

    it('should apply container config to file', () => {
      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        undefined,
        false,
        false
      );

      expect(result.success).toBe(true);
      expect(result.containerMerged).toBe(true);
      expect(result.initContainerMerged).toBe(false);

      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets.app).toBeDefined();
    });

    it('should apply both container and initContainer configs', () => {
      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        mockExternalSecretsConfig,
        false,
        false
      );

      expect(result.success).toBe(true);
      expect(result.containerMerged).toBe(true);
      expect(result.initContainerMerged).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets.app).toBeDefined();
      expect(updated.externalSecrets.flywayInitContainer).toBeDefined();
    });

    it('should migrate legacy cronjob sections to the shared chart sections', () => {
      writeValuesFile(testValuesFile, {
        name: 'test-job',
        externalSecrets: {
          container: { create: false },
          initContainer: { create: false },
        },
        cronjob: { schedule: '0 0 * * *' },
      });

      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        mockExternalSecretsConfig,
        false,
        false,
        'cronjob'
      );

      expect(result.success).toBe(true);
      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets.app.data).toHaveLength(1);
      expect(updated.externalSecrets.flywayInitContainer.data).toHaveLength(1);
      expect(updated.externalSecrets.container).toBeUndefined();
      expect(updated.externalSecrets.initContainer).toBeUndefined();
    });

    it('should remove old refs if requested', () => {
      const valuesWithOldRefs = {
        name: 'test-app',
        envFromSecrets: ['old-secret'],
      };
      writeValuesFile(testValuesFile, valuesWithOldRefs);

      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        undefined,
        true,
        false
      );

      expect(result.success).toBe(true);
      expect(result.oldRefsRemoved).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.envFromSecrets).toBeUndefined();
      expect(updated.externalSecrets.app).toBeDefined();
    });

    it('should remove Flyway initContainer refs if requested', () => {
      writeValuesFile(testValuesFile, {
        name: 'test-app',
        deployment: {
          flywayInitContainer: {
            create: true,
            envFromSecrets: {
              FLYWAY_USER: 'event-store.POSTGRES_USR',
              FLYWAY_PASSWORD: 'event-store.POSTGRES_PSW',
            },
          },
        },
      });

      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        undefined,
        mockExternalSecretsConfig,
        true,
        false,
        'microservice'
      );

      expect(result.success).toBe(true);
      expect(result.oldRefsRemoved).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.deployment.flywayInitContainer.envFromSecrets).toBeUndefined();
      expect(updated.externalSecrets.flywayInitContainer).toBeDefined();
    });

    it('should not modify file in dry-run mode', () => {
      const originalContent = fs.readFileSync(testValuesFile, 'utf-8');

      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        undefined,
        false,
        true
      );

      expect(result.success).toBe(true);

      const currentContent = fs.readFileSync(testValuesFile, 'utf-8');
      expect(currentContent).toBe(originalContent);
    });

    it('should handle missing files gracefully', () => {
      const result = applyExternalSecretsToWorkload(
        path.join(tempDir, 'nonexistent.yaml'),
        mockExternalSecretsConfig,
        undefined,
        false,
        false
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should insert externalSecrets before deployment key', () => {
      const valuesWithDeployment = {
        name: 'test-app',
        serviceAccount: { name: 'test-sa' },
        deployment: {
          replicas: 3,
          image: 'test:latest',
        },
      };
      writeValuesFile(testValuesFile, valuesWithDeployment);

      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        undefined,
        false,
        false
      );

      expect(result.success).toBe(true);

      const fileContent = fs.readFileSync(testValuesFile, 'utf-8');
      const externalSecretsIndex = fileContent.indexOf('externalSecrets:');
      const deploymentIndex = fileContent.indexOf('deployment:');

      expect(externalSecretsIndex).toBeGreaterThan(-1);
      expect(deploymentIndex).toBeGreaterThan(-1);
      expect(externalSecretsIndex).toBeLessThan(deploymentIndex);

      // Verify spacing (blank line before and after)
      const beforeES = fileContent.substring(externalSecretsIndex - 3, externalSecretsIndex);
      const afterES = fileContent.substring(fileContent.indexOf(':', externalSecretsIndex) + 1, fileContent.indexOf('deployment:'));
      expect(beforeES.includes('\n\n')).toBe(true);
      expect(afterES.includes('\n\n')).toBe(true);
    });

    it('should insert externalSecrets before cronjob key', () => {
      const valuesWithCronjob = {
        name: 'test-job',
        serviceAccount: { name: 'test-sa' },
        cronjob: {
          schedule: '0 0 * * *',
          restartPolicy: 'OnFailure',
        },
      };
      writeValuesFile(testValuesFile, valuesWithCronjob);

      const result = applyExternalSecretsToWorkload(
        testValuesFile,
        mockExternalSecretsConfig,
        undefined,
        false,
        false
      );

      expect(result.success).toBe(true);

      const fileContent = fs.readFileSync(testValuesFile, 'utf-8');
      const externalSecretsIndex = fileContent.indexOf('externalSecrets:');
      const cronjobIndex = fileContent.indexOf('cronjob:');

      expect(externalSecretsIndex).toBeGreaterThan(-1);
      expect(cronjobIndex).toBeGreaterThan(-1);
      expect(externalSecretsIndex).toBeLessThan(cronjobIndex);
    });
  });

  describe('initializeCommonsExternalSecrets', () => {
    it('should add externalSecrets section to empty commons file', () => {
      const commonsContent = `
local:
  env: "dev"
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, false, 'test-secret-store');
      expect(result.success).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets).toBeDefined();
      expect(updated.externalSecrets.app).toBeDefined();
      expect(updated.externalSecrets.app.secretStoreRef).toBeDefined();
      expect(updated.externalSecrets.app.secretStoreRef.name).toBe('test-secret-store');
      expect(updated.externalSecrets.app.secretStoreRef.kind).toBe('SecretStore');
      expect(updated.externalSecrets.flywayInitContainer).toBeDefined();
      expect(updated.externalSecrets.flywayInitContainer.secretStoreRef).toBeDefined();
    });

    it('should take the secret store from commons when not provided', () => {
      const commonsContent = `
local:
  env: "dev"
externalSecrets:
  app:
    secretStoreRef:
      name: commons-store
      kind: SecretStore
  flywayInitContainer:
    secretStoreRef:
      name: commons-store
      kind: SecretStore
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, false);
      expect(result.success).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets.app.secretStoreRef.name).toBe('commons-store');
      expect(updated.externalSecrets.flywayInitContainer.secretStoreRef.name).toBe('commons-store');
    });

    it('should accept a provided secret store equal to the commons one', () => {
      const commonsContent = `
local:
  env: "dev"
externalSecrets:
  app:
    secretStoreRef:
      name: commons-store
      kind: SecretStore
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, false, 'commons-store');
      expect(result.success).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets.app.secretStoreRef.name).toBe('commons-store');
      expect(updated.externalSecrets.flywayInitContainer.secretStoreRef.name).toBe('commons-store');
    });

    it('should fail when no secret store is provided nor set in commons', () => {
      const commonsContent = `
local:
  env: "dev"
externalSecrets:
  app: {}
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, false);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing secretStoreRef');
      expect(fs.readFileSync(testValuesFile, 'utf-8')).toBe(commonsContent);
    });

    it('should fail when the provided secret store conflicts with commons', () => {
      const commonsContent = `
local:
  env: "dev"
externalSecrets:
  app:
    secretStoreRef:
      name: commons-store
      kind: SecretStore
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, false, 'other-store');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Conflicting secretStoreRef');
      expect(fs.readFileSync(testValuesFile, 'utf-8')).toBe(commonsContent);
    });

    it('should use the provided secret store name', () => {
      const commonsContent = `
local:
  env: "dev"
externalSecrets:
  app: {}
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, false, 'custom-store');
      expect(result.success).toBe(true);

      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets.app.secretStoreRef.name).toBe('custom-store');
      expect(updated.externalSecrets.flywayInitContainer.secretStoreRef.name).toBe('custom-store');
    });

    it('should handle dry-run mode without writing', () => {
      const commonsContent = `
local:
  env: "dev"
`;
      fs.writeFileSync(testValuesFile, commonsContent);

      const result = initializeCommonsExternalSecrets(testValuesFile, true, 'test-secret-store');
      expect(result.success).toBe(true);

      // File should remain unchanged
      const updated = readValuesFile(testValuesFile);
      expect(updated.externalSecrets).toBeUndefined();
    });

    it('should return error for non-existent file', () => {
      const result = initializeCommonsExternalSecrets(path.join(tempDir, 'nonexistent.yaml'), false);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
