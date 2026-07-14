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
      expect(values.externalSecrets.container).toBeDefined();
      expect(values.externalSecrets.container.create).toBe(true);
      expect(values.externalSecrets.container.data).toHaveLength(1);
    });

    it('should preserve existing externalSecrets fields', () => {
      const values = {
        externalSecrets: {
          container: {
            create: false,
          },
        },
      };

      mergeExternalSecretsContainer(values, mockExternalSecretsConfig);

      expect(values.externalSecrets.container.create).toBe(true);
      expect(values.externalSecrets.container.data).toHaveLength(1);
    });
  });

  describe('mergeExternalSecretsInitContainer', () => {
    it('should merge initContainer config into values', () => {
      const values = { name: 'test' };
      mergeExternalSecretsInitContainer(values, mockExternalSecretsConfig);

      expect(values.externalSecrets).toBeDefined();
      expect(values.externalSecrets.initContainer).toBeDefined();
      expect(values.externalSecrets.initContainer.create).toBe(true);
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
      expect(updated.externalSecrets.container).toBeDefined();
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
      expect(updated.externalSecrets.container).toBeDefined();
      expect(updated.externalSecrets.initContainer).toBeDefined();
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
      expect(updated.externalSecrets.container).toBeDefined();
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
  });
});
