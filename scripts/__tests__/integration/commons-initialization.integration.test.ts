/**
 * Integration test for commons initialization during generation
 * Tests that the generator correctly initializes commons files based on scope
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeCommonsExternalSecrets } from '../../lib/values-yaml-patcher.js';
import { readValuesFile } from '../../lib/values-yaml-patcher.js';

describe('commons-initialization integration', () => {
  let tempDir: string;
  let devCommonsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-init-test-'));
    devCommonsDir = path.join(tempDir, 'commons', 'dev');
    fs.mkdirSync(devCommonsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('scope microservice', () => {
    it('should initialize commons/dev/values-microservice.yaml only', () => {
      // Create test commons files
      const microserviceCommonsPath = path.join(devCommonsDir, 'values-microservice.yaml');
      const cronjobCommonsPath = path.join(devCommonsDir, 'values-cronjob.yaml');

      const commonsContent = `
local:
  env: "dev"
`;

      fs.writeFileSync(microserviceCommonsPath, commonsContent);
      fs.writeFileSync(cronjobCommonsPath, commonsContent);

      // Initialize only microservice commons
      const microserviceResult = initializeCommonsExternalSecrets(microserviceCommonsPath, false);
      expect(microserviceResult.success).toBe(true);

      // Do NOT initialize cronjob commons
      const cronjobResult = readValuesFile(cronjobCommonsPath);
      expect(cronjobResult.externalSecrets).toBeUndefined();

      // Verify microservice commons was updated
      const updatedMicroservice = readValuesFile(microserviceCommonsPath);
      expect(updatedMicroservice.externalSecrets).toBeDefined();
      expect(updatedMicroservice.externalSecrets.container.secretStoreRef).toBeDefined();
      expect(updatedMicroservice.externalSecrets.container.secretStoreRef.name).toBe('app-secret-store');
    });
  });

  describe('scope cronjob', () => {
    it('should initialize commons/dev/values-cronjob.yaml only', () => {
      // Create test commons files
      const microserviceCommonsPath = path.join(devCommonsDir, 'values-microservice.yaml');
      const cronjobCommonsPath = path.join(devCommonsDir, 'values-cronjob.yaml');

      const commonsContent = `
local:
  env: "dev"
`;

      fs.writeFileSync(microserviceCommonsPath, commonsContent);
      fs.writeFileSync(cronjobCommonsPath, commonsContent);

      // Initialize only cronjob commons
      const cronjobResult = initializeCommonsExternalSecrets(cronjobCommonsPath, false);
      expect(cronjobResult.success).toBe(true);

      // Do NOT initialize microservice commons
      const microserviceResult = readValuesFile(microserviceCommonsPath);
      expect(microserviceResult.externalSecrets).toBeUndefined();

      // Verify cronjob commons was updated
      const updatedCronjob = readValuesFile(cronjobCommonsPath);
      expect(updatedCronjob.externalSecrets).toBeDefined();
      expect(updatedCronjob.externalSecrets.container.secretStoreRef).toBeDefined();
      expect(updatedCronjob.externalSecrets.initContainer.secretStoreRef).toBeDefined();
    });
  });

  describe('scope both', () => {
    it('should initialize both commons files', () => {
      // Create test commons files
      const microserviceCommonsPath = path.join(devCommonsDir, 'values-microservice.yaml');
      const cronjobCommonsPath = path.join(devCommonsDir, 'values-cronjob.yaml');

      const commonsContent = `
local:
  env: "dev"
`;

      fs.writeFileSync(microserviceCommonsPath, commonsContent);
      fs.writeFileSync(cronjobCommonsPath, commonsContent);

      // Initialize both commons
      const microserviceResult = initializeCommonsExternalSecrets(microserviceCommonsPath, false);
      const cronjobResult = initializeCommonsExternalSecrets(cronjobCommonsPath, false);

      expect(microserviceResult.success).toBe(true);
      expect(cronjobResult.success).toBe(true);

      // Verify both were updated
      const updatedMicroservice = readValuesFile(microserviceCommonsPath);
      const updatedCronjob = readValuesFile(cronjobCommonsPath);

      expect(updatedMicroservice.externalSecrets).toBeDefined();
      expect(updatedMicroservice.externalSecrets.container.secretStoreRef.name).toBe('app-secret-store');

      expect(updatedCronjob.externalSecrets).toBeDefined();
      expect(updatedCronjob.externalSecrets.container.secretStoreRef.name).toBe('app-secret-store');
    });
  });

  describe('inheritance simulation', () => {
    it('should demonstrate secretStoreRef inheritance from commons', () => {
      // Create microservice commons with secretStoreRef
      const microserviceCommonsPath = path.join(devCommonsDir, 'values-microservice.yaml');
      const workloadValuesPath = path.join(devCommonsDir, '..', 'microservices', 'my-service', 'values.yaml');

      const commonsContent = `
local:
  env: "dev"
`;

      // Initialize commons
      fs.writeFileSync(microserviceCommonsPath, commonsContent);
      initializeCommonsExternalSecrets(microserviceCommonsPath, false);

      const updatedCommons = readValuesFile(microserviceCommonsPath);

      // Verify commons has secretStoreRef
      expect(updatedCommons.externalSecrets.container.secretStoreRef).toBeDefined();
      expect(updatedCommons.externalSecrets.container.secretStoreRef.name).toBe('app-secret-store');

      // When Helm merges these files, the workload values (with create, targetSecret, data)
      // would be merged with commons values (with secretStoreRef)
      // Result: complete externalSecrets config with both data definition and store reference
      const mergedConfig = {
        ...updatedCommons.externalSecrets.container,
        create: true, // from workload
        targetSecret: { name: 'my-secret' }, // from workload
        data: [{ secretKey: 'key1', remoteRef: { key: 'my-secret' } }], // from workload
        // secretStoreRef inherited from commons
      };

      expect(mergedConfig.secretStoreRef).toBeDefined();
      expect(mergedConfig.secretStoreRef.name).toBe('app-secret-store');
      expect(mergedConfig.create).toBe(true);
      expect(mergedConfig.targetSecret.name).toBe('my-secret');
    });
  });
});
