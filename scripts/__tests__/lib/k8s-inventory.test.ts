/**
 * Tests for Kubernetes secret inventory management
 */

import { describe, it, expect } from 'vitest';
import {
  buildSecretInventory,
  classifySecretAnnotations,
  formatInventoryForOutput,
  formatInventoryWorkloadCentric,
  AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION,
  AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION,
} from '../../lib/k8s-inventory.js';
import type { K8sSecretInfo, K8sSecretReference, SecretInventoryRecord } from '../../lib/k8s-types.js';

const makeSecretInfo = (keys: string[], annotations: Record<string, string> = {}): K8sSecretInfo => ({
  keys,
  annotations,
});

describe('k8s-inventory', () => {
  describe('buildSecretInventory', () => {
    it('builds inventory from secrets and references', () => {
      const secretsMap = new Map<string, K8sSecretInfo>([
        ['db-secret', makeSecretInfo(['password', 'username'], { [AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION]: 'sm/db-secret' })],
        ['api-key-secret', makeSecretInfo(['api-key'])],
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
      expect(dbSecret?.hasAwsSecretsManagerSecretId).toBe(true);
      expect(dbSecret?.hasNoManagedAnnotations).toBe(false);
      expect(dbSecret?.referencedWithoutManagedAnnotations).toBe(false);

      const apiSecret = inventory.find((r) => r.secretName === 'api-key-secret');
      expect(apiSecret?.isUnused).toBe(true);
      expect(apiSecret?.referencedBy).toHaveLength(0);
      expect(apiSecret?.hasNoManagedAnnotations).toBe(true);
    });

    it('marks secrets as unused when not referenced', () => {
      const secretsMap = new Map<string, K8sSecretInfo>([['orphan-secret', makeSecretInfo(['key1', 'key2'])]]);
      const references: K8sSecretReference[] = [];

      const inventory = buildSecretInventory(secretsMap, references);
      const orphan = inventory[0];

      expect(orphan.isUnused).toBe(true);
      expect(orphan.referencedBy).toHaveLength(0);
    });

    it('deduplicates references to same secret by workload/container', () => {
      const secretsMap = new Map<string, K8sSecretInfo>([['config', makeSecretInfo(['key1', 'key2'])]]);

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
      const secretsMap = new Map<string, K8sSecretInfo>([['shared-config', makeSecretInfo(['value'])]]);

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
      expect(shared.referencedWithoutManagedAnnotations).toBe(true);
    });

    it('handles empty secrets map', () => {
      const secretsMap = new Map<string, K8sSecretInfo>();
      const references: K8sSecretReference[] = [];

      const inventory = buildSecretInventory(secretsMap, references);
      expect(inventory).toHaveLength(0);
    });
    it('classifies referenced secrets without managed annotations', () => {
      const secretsMap = new Map<string, K8sSecretInfo>([
        ['plain-secret', makeSecretInfo(['password'])],
        ['managed-secret', makeSecretInfo(['token'], { [AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION]: 'sm/managed-secret' })],
        ['partial-secret', makeSecretInfo(['value'], { [AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION]: 'version-1' })],
      ]);

      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'plain-secret',
          secretKey: 'password',
        },
        {
          workloadType: 'CronJob',
          workloadName: 'job',
          workloadNamespace: 'dev',
          containerName: 'job',
          containerType: 'container',
          referenceType: 'envFrom.secretRef',
          secretName: 'managed-secret',
        },
      ];

      const inventory = buildSecretInventory(secretsMap, references);

      expect(inventory.find((r) => r.secretName === 'plain-secret')).toMatchObject({
        hasNoManagedAnnotations: true,
        managedAnnotationStatus: 'no-managed-annotations',
        referencedWithoutManagedAnnotations: true,
      });
      expect(inventory.find((r) => r.secretName === 'managed-secret')).toMatchObject({
        hasAwsSecretsManagerSecretId: true,
        managedAnnotationStatus: 'aws-secretsmanager-secret-id',
        referencedWithoutManagedAnnotations: false,
      });
      expect(inventory.find((r) => r.secretName === 'partial-secret')).toMatchObject({
        hasAnyManagedAnnotation: true,
        hasNoManagedAnnotations: false,
        managedAnnotationStatus: 'partial-managed-annotations',
        referencedWithoutManagedAnnotations: false,
      });
    });
  });

  describe('classifySecretAnnotations', () => {
    it('distinguishes aws secret id, partial annotations, and no managed annotations', () => {
      expect(classifySecretAnnotations({ [AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION]: 'sm/id' })).toMatchObject({
        hasAwsSecretsManagerSecretId: true,
        hasNoManagedAnnotations: false,
        managedAnnotationStatus: 'aws-secretsmanager-secret-id',
      });

      expect(classifySecretAnnotations({ [AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION]: '' })).toMatchObject({
        hasAwsSecretsManagerSecretId: true,
        hasNoManagedAnnotations: false,
        managedAnnotationStatus: 'aws-secretsmanager-secret-id',
      });

      expect(classifySecretAnnotations({ [AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION]: 'version' })).toMatchObject({
        hasAnyManagedAnnotation: true,
        hasNoManagedAnnotations: false,
        managedAnnotationStatus: 'partial-managed-annotations',
      });

      expect(classifySecretAnnotations({ unrelated: 'value' })).toMatchObject({
        hasAnyManagedAnnotation: false,
        hasNoManagedAnnotations: true,
        managedAnnotationStatus: 'no-managed-annotations',
      });
    });
  });


  describe('formatInventoryForOutput', () => {
    it('formats inventory records for CSV output', () => {
      const inventory: SecretInventoryRecord[] = [
        {
          secretName: 'db-secret',
          secretNamespace: 'current',
          keys: ['password', 'username'],
          annotations: { [AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION]: 'sm/db-secret' },
          referencedBy: ['Deployment/app:main', 'StatefulSet/worker:app'],
          isUnused: false,
          hasAwsSecretsManagerSecretId: true,
          hasAwsSecretsManagerVersionId: false,
          hasUpdatedAt: false,
          hasAnyManagedAnnotation: true,
          hasNoManagedAnnotations: false,
          managedAnnotationStatus: 'aws-secretsmanager-secret-id',
          referencedWithoutManagedAnnotations: false,
        },
        {
          secretName: 'orphan',
          secretNamespace: 'current',
          keys: ['key'],
          annotations: {},
          referencedBy: [],
          isUnused: true,
          hasAwsSecretsManagerSecretId: false,
          hasAwsSecretsManagerVersionId: false,
          hasUpdatedAt: false,
          hasAnyManagedAnnotation: false,
          hasNoManagedAnnotations: true,
          managedAnnotationStatus: 'no-managed-annotations',
          referencedWithoutManagedAnnotations: false,
        },
      ];

      const output = formatInventoryForOutput(inventory, 'dev');

      expect(output).toHaveLength(2);
      expect(output[0]).toEqual({
        secretName: 'db-secret',
        secretNamespace: 'dev',
        keyCount: 2,
        keys: 'password;username',
        annotationKeys: AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION,
        hasAwsSecretsManagerSecretId: true,
        hasAwsSecretsManagerVersionId: false,
        hasUpdatedAt: false,
        hasAnyManagedAnnotation: true,
        hasNoManagedAnnotations: false,
        managedAnnotationStatus: 'aws-secretsmanager-secret-id',
        isUnused: false,
        usageCount: 2,
        usageList: 'Deployment/app:main\nStatefulSet/worker:app',
        referencedWithoutManagedAnnotations: false,
      });

      expect(output[1]).toEqual({
        secretName: 'orphan',
        secretNamespace: 'dev',
        keyCount: 1,
        keys: 'key',
        annotationKeys: '',
        hasAwsSecretsManagerSecretId: false,
        hasAwsSecretsManagerVersionId: false,
        hasUpdatedAt: false,
        hasAnyManagedAnnotation: false,
        hasNoManagedAnnotations: true,
        managedAnnotationStatus: 'no-managed-annotations',
        isUnused: true,
        usageCount: 0,
        usageList: '',
        referencedWithoutManagedAnnotations: false,
      });
    });

    it('handles secrets with no keys', () => {
      const inventory: SecretInventoryRecord[] = [
        {
          secretName: 'empty',
          secretNamespace: 'current',
          keys: [],
          annotations: {},
          referencedBy: [],
          isUnused: true,
          hasAwsSecretsManagerSecretId: false,
          hasAwsSecretsManagerVersionId: false,
          hasUpdatedAt: false,
          hasAnyManagedAnnotation: false,
          hasNoManagedAnnotations: true,
          managedAnnotationStatus: 'no-managed-annotations',
          referencedWithoutManagedAnnotations: false,
        },
      ];

      const output = formatInventoryForOutput(inventory, 'dev');

      expect(output[0].keyCount).toBe(0);
      expect(output[0].keys).toBe('');
    });

    it('substitutes namespace parameter', () => {
      const inventory: SecretInventoryRecord[] = [
        {
          secretName: 'secret',
          secretNamespace: 'current',
          keys: ['key'],
          annotations: {},
          referencedBy: [],
          isUnused: false,
          hasAwsSecretsManagerSecretId: false,
          hasAwsSecretsManagerVersionId: false,
          hasUpdatedAt: false,
          hasAnyManagedAnnotation: false,
          hasNoManagedAnnotations: true,
          managedAnnotationStatus: 'no-managed-annotations',
          referencedWithoutManagedAnnotations: false,
        },
      ];

      const output = formatInventoryForOutput(inventory, 'production');
      expect(output[0].secretNamespace).toBe('production');
    });
  });

  describe('formatInventoryWorkloadCentric', () => {
    it('adds managed annotation status to workload references', () => {
      const references: K8sSecretReference[] = [
        {
          workloadType: 'Deployment',
          workloadName: 'app',
          workloadNamespace: 'dev',
          containerName: 'main',
          containerType: 'container',
          referenceType: 'env.secretKeyRef',
          secretName: 'plain-secret',
          secretKey: 'password',
        },
      ];
      const inventory = buildSecretInventory(new Map([['plain-secret', makeSecretInfo(['password'])]]), references);

      const output = formatInventoryWorkloadCentric(references, 'dev', inventory);

      expect(output[0]).toMatchObject({
        secretManagedAnnotationStatus: 'no-managed-annotations',
        secretHasAwsSecretsManagerSecretId: false,
        secretHasNoManagedAnnotations: true,
        referencedSecretWithoutManagedAnnotations: true,
      });
    });
  });
});
