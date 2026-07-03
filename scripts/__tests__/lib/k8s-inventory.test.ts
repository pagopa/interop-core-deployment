/**
 * Tests for Kubernetes secret inventory management
 */

import { describe, it, expect } from 'vitest';
import {
  buildSecretInventory,
  deduplicateReferences,
  formatInventoryForOutput,
} from '../../lib/k8s-inventory.js';
import type { K8sSecretReference } from '../../lib/k8s-types.js';

describe('k8s-inventory', () => {
  describe('buildSecretInventory', () => {
    it('builds inventory from secrets and references', () => {
      const secretsMap = new Map([
        ['db-secret', ['password', 'username']],
        ['api-key-secret', ['api-key']],
      ]);

      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'app',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'db-secret',
          secretKey: 'password',
        },
      ];

      const inventory = buildSecretInventory(secretsMap, references);
      expect(inventory).toHaveLength(2);

      const dbSecret = inventory.find((r) => r.secretName === 'db-secret');
      expect(dbSecret?.isUnused).toBe(false);
      expect(dbSecret?.referencedBy).toContain('Deployment/app:app');
      expect(dbSecret?.keys).toEqual(['password', 'username']);

      const apiSecret = inventory.find((r) => r.secretName === 'api-key-secret');
      expect(apiSecret?.isUnused).toBe(true);
      expect(apiSecret?.referencedBy).toHaveLength(0);
    });

    it('marks secrets as unused when not referenced', () => {
      const secretsMap = new Map([['orphan-secret', ['key1', 'key2']]]);
      const references: K8sSecretReference[] = [];

      const inventory = buildSecretInventory(secretsMap, references);
      const orphan = inventory[0];

      expect(orphan.isUnused).toBe(true);
      expect(orphan.referencedBy).toHaveLength(0);
    });

    it('deduplicates references to same secret by workload/container', () => {
      const secretsMap = new Map([['config', ['key1', 'key2']]]);

      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'config',
          secretKey: 'key1',
        },
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'config',
          secretKey: 'key2',
        },
      ];

      const inventory = buildSecretInventory(secretsMap, references);
      const config = inventory[0];

      expect(config.referencedBy).toEqual(['Deployment/app:main']);
    });

    it('tracks multiple workloads referencing same secret', () => {
      const secretsMap = new Map([['shared-config', ['value']]]);

      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'service-a',
          workloadNamespace: 'dev',
          containerName: 'app',
          containerType: 'container',
          referenceType: 'envFrom.secretRef',
          secretName: 'shared-config',
        },
        {
          workloadType: 'Deployment',
          workloadName: 'service-b',
          workloadNamespace: 'dev',
          containerName: 'app',
          containerType: 'container',
          referenceType: 'envFrom.secretRef',
          secretName: 'shared-config',
        },
      ];

      const inventory = buildSecretInventory(secretsMap, references);
      const shared = inventory[0];

      expect(shared.referencedBy).toContain('Deployment/service-a:app');
      expect(shared.referencedBy).toContain('Deployment/service-b:app');
      expect(shared.isUnused).toBe(false);
    });

    it('handles empty secrets map', () => {
      const secretsMap = new Map();
      const references: K8sSecretReference[] = [];

      const inventory = buildSecretInventory(secretsMap, references);
      expect(inventory).toHaveLength(0);
    });
  });

  describe('deduplicateReferences', () => {
    it('removes exact duplicate references', () => {
      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'secret1',
          secretKey: 'key1',
        },
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'secret1',
          secretKey: 'key1',
        },
      ];

      const deduped = deduplicateReferences(references);
      expect(deduped).toHaveLength(1);
    });

    it('keeps references with different keys', () => {
      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'secret1',
          secretKey: 'key1',
        },
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'secret1',
          secretKey: 'key2',
        },
      ];

      const deduped = deduplicateReferences(references);
      expect(deduped).toHaveLength(2);
    });

    it('keeps references with different containers', () => {
      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'secret1',
          secretKey: 'key1',
        },
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'sidecar',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'secret1',
          secretKey: 'key1',
        },
      ];

      const deduped = deduplicateReferences(references);
      expect(deduped).toHaveLength(2);
    });

    it('treats undefined secretKey as no-key marker', () => {
      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'envFrom.secretRef',
          secretName: 'secret1',
        },
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'envFrom.secretRef',
          secretName: 'secret1',
        },
      ];

      const deduped = deduplicateReferences(references);
      expect(deduped).toHaveLength(1);
    });

    it('handles empty input', () => {
      const deduped = deduplicateReferences([]);
      expect(deduped).toHaveLength(0);
    });
  });

  describe('formatInventoryForOutput', () => {
    it('formats inventory records for CSV output', () => {
      const inventory = [
        {
          secretName: 'db-secret',
          secretNamespace: 'current',
          keys: ['password', 'username'],
          referencedBy: ['Deployment/app:main', 'StatefulSet/worker:app'],
          isUnused: false,
        },
        {
          secretName: 'orphan',
          secretNamespace: 'current',
          keys: ['key'],
          referencedBy: [],
          isUnused: true,
        },
      ];

      const output = formatInventoryForOutput(inventory, 'dev');

      expect(output).toHaveLength(2);
      expect(output[0]).toEqual({
        secretName: 'db-secret',
        secretNamespace: 'dev',
        keyCount: 2,
        keys: 'password;username',
        isUnused: false,
        usageCount: 2,
        usageList: 'Deployment/app:main | StatefulSet/worker:app',
      });

      expect(output[1]).toEqual({
        secretName: 'orphan',
        secretNamespace: 'dev',
        keyCount: 1,
        keys: 'key',
        isUnused: true,
        usageCount: 0,
        usageList: '',
      });
    });

    it('handles secrets with no keys', () => {
      const inventory = [
        {
          secretName: 'empty',
          secretNamespace: 'current',
          keys: [],
          referencedBy: [],
          isUnused: true,
        },
      ];

      const output = formatInventoryForOutput(inventory, 'dev');

      expect(output[0].keyCount).toBe(0);
      expect(output[0].keys).toBe('');
    });

    it('substitutes namespace parameter', () => {
      const inventory = [
        {
          secretName: 'secret',
          secretNamespace: 'current',
          keys: ['key'],
          referencedBy: [],
          isUnused: false,
        },
      ];

      const output = formatInventoryForOutput(inventory, 'production');
      expect(output[0].secretNamespace).toBe('production');
    });
  });
});
