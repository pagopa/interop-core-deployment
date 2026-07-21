import { describe, it, expect } from 'vitest';
import {
  groupRepoInventoryByWorkload,
  buildRemoteRef,
  generateExternalSecretsData,
  buildContainerConfig,
  generateTargetSecretName,
  generateExternalSecretsFromWorkloads,
} from '../../lib/external-secrets-generator.js';
import type { SecretReferenceRecord, WorkloadType, SourceScope, ReferenceType } from '../../lib/types.js';
import type { SecretInventoryRecord } from '../../lib/k8s-types.js';

const mockRepoRecords: SecretReferenceRecord[] = [
  {
    environment: 'dev',
    workloadType: 'microservice',
    component: 'email-digest-dispatcher',
    sourceScope: 'workload' as SourceScope,
    sourceFile: 'microservices/email-digest-dispatcher/dev/values.yaml',
    line: 10,
    yamlPath: 'env[0].valueFrom.secretKeyRef',
    containerPath: 'containers[0]',
    referenceType: 'secretKeyRef' as ReferenceType,
    envVar: 'DIGEST_TRACKING_DB_PASSWORD',
    secretName: 'rds-secret',
    secretKey: 'password',
    rawReference: 'rds-secret:password',
  },
  {
    environment: 'dev',
    workloadType: 'microservice',
    component: 'email-digest-dispatcher',
    sourceScope: 'workload' as SourceScope,
    sourceFile: 'microservices/email-digest-dispatcher/dev/values.yaml',
    line: 12,
    yamlPath: 'env[1].valueFrom.secretKeyRef',
    containerPath: 'containers[0]',
    referenceType: 'secretKeyRef' as ReferenceType,
    envVar: 'DIGEST_TRACKING_DB_USERNAME',
    secretName: 'rds-secret',
    secretKey: 'username',
    rawReference: 'rds-secret:username',
  },
  {
    environment: 'dev',
    workloadType: 'microservice',
    component: 'flyway-migrator',
    sourceScope: 'workload' as SourceScope,
    sourceFile: 'microservices/flyway-migrator/dev/values.yaml',
    line: 5,
    yamlPath: 'initContainers[0].env[0].valueFrom.secretKeyRef',
    containerPath: 'initContainers[0]',
    referenceType: 'secretKeyRef' as ReferenceType,
    envVar: 'DB_PASSWORD',
    secretName: 'flyway-db-secret',
    secretKey: 'password',
    rawReference: 'flyway-db-secret:password',
  },
];

const mockClusterSecrets: SecretInventoryRecord[] = [
  {
    secretName: 'rds-secret',
    secretNamespace: 'default',
    keys: ['password', 'username'],
    annotations: {
      'infra.interop.pagopa.it/aws-secretsmanager-secret-id': 'rds/interop-platform-data-dev/users/email_digest_dispatcher_user',
      'infra.interop.pagopa.it/aws-secretsmanager-version-id': 'uuid/terraform-20260212133048976200000002',
      'infra.interop.pagopa.it/updated-at': '2026-02-12T13:30:48Z',
    },
    referencedBy: ['microservice/email-digest-dispatcher:containers[0]'],
    isUnused: false,
    hasAwsSecretsManagerSecretId: true,
    hasAwsSecretsManagerVersionId: true,
    hasUpdatedAt: true,
    hasAnyManagedAnnotation: true,
    hasNoManagedAnnotations: false,
    managedAnnotationStatus: 'aws-secretsmanager-secret-id',
    referencedWithoutManagedAnnotations: false,
  },
  {
    secretName: 'flyway-db-secret',
    secretNamespace: 'default',
    keys: ['password'],
    annotations: {
      'infra.interop.pagopa.it/aws-secretsmanager-secret-id': 'rds/interop-platform-data-dev/flyway',
      'infra.interop.pagopa.it/aws-secretsmanager-version-id': 'uuid/terraform-20260212133048976200000003',
    },
    referencedBy: ['microservice/flyway-migrator:initContainers[0]'],
    isUnused: false,
    hasAwsSecretsManagerSecretId: true,
    hasAwsSecretsManagerVersionId: true,
    hasUpdatedAt: false,
    hasAnyManagedAnnotation: true,
    hasNoManagedAnnotations: false,
    managedAnnotationStatus: 'aws-secretsmanager-secret-id',
    referencedWithoutManagedAnnotations: false,
  },
];

describe('external-secrets-generator', () => {
  describe('groupRepoInventoryByWorkload', () => {
    it('should group records by workload and container type', () => {
      const groups = groupRepoInventoryByWorkload(mockRepoRecords);

      expect(groups).toHaveLength(2);
      expect(groups[0].workloadName).toBe('email-digest-dispatcher');
      expect(groups[0].containerType).toBe('container');
      expect(groups[1].workloadName).toBe('flyway-migrator');
      expect(groups[1].containerType).toBe('initContainer');
    });

    it('should aggregate secrets by name within same container', () => {
      const groups = groupRepoInventoryByWorkload(mockRepoRecords);
      const emailGroup = groups.find(
        (g) => g.workloadName === 'email-digest-dispatcher' && g.containerType === 'container'
      );

      expect(emailGroup).toBeDefined();
      expect(emailGroup!.secrets.has('rds-secret')).toBe(true);
      const rdsSecretMap = emailGroup!.secrets.get('rds-secret');
      expect(rdsSecretMap).toBeDefined();
      // Should have mapping: envVar -> secretKey
      expect(rdsSecretMap!.get('DIGEST_TRACKING_DB_PASSWORD')).toBe('password');
      expect(rdsSecretMap!.get('DIGEST_TRACKING_DB_USERNAME')).toBe('username');
    });

    it('should skip envFromSecrets references', () => {
      const records: SecretReferenceRecord[] = [
        ...mockRepoRecords,
        {
          ...mockRepoRecords[0],
          referenceType: 'envFromSecrets' as ReferenceType,
          secretKey: undefined,
        },
      ];

      const groups = groupRepoInventoryByWorkload(records);
      // Should still have same number of groups since envFromSecrets is skipped
      expect(groups.length).toBeGreaterThan(0);
    });
  });

  describe('buildRemoteRef', () => {
    it('should build RemoteRef from cluster annotations', () => {
      const clusterSecretsMap = new Map(mockClusterSecrets.map((s) => [s.secretName, s]));
      const remoteRef = buildRemoteRef('rds-secret', 'password', clusterSecretsMap);

      expect(remoteRef).toBeDefined();
      expect(remoteRef?.key).toBe('rds/interop-platform-data-dev/users/email_digest_dispatcher_user');
      expect(remoteRef?.property).toBe('password');
      expect(remoteRef?.version).toBe('uuid/terraform-20260212133048976200000002');
    });

    it('should return null if secret not found in cluster', () => {
      const clusterSecretsMap = new Map<string, SecretInventoryRecord>();
      const remoteRef = buildRemoteRef('nonexistent-secret', 'password', clusterSecretsMap);

      expect(remoteRef).toBeNull();
    });

    it('should return null if secret has no AWS annotation', () => {
      const secretWithoutAnnotation: SecretInventoryRecord = {
        ...mockClusterSecrets[0],
        annotations: {},
        hasAwsSecretsManagerSecretId: false,
      };
      const clusterSecretsMap = new Map([['rds-secret', secretWithoutAnnotation]]);
      const remoteRef = buildRemoteRef('rds-secret', 'password', clusterSecretsMap);

      expect(remoteRef).toBeNull();
    });
  });

  describe('generateTargetSecretName', () => {
    it('should use workload name for container', () => {
      const name = generateTargetSecretName('email-digest-dispatcher', 'container');
      expect(name).toBe('email-digest-dispatcher');
    });

    it('should append -flyway for initContainer', () => {
      const name = generateTargetSecretName('email-digest-dispatcher', 'initContainer');
      expect(name).toBe('email-digest-dispatcher-flyway');
    });
  });

  describe('generateExternalSecretsData', () => {
    it('should generate data entries for all secrets', () => {
      const clusterSecretsMap = new Map(mockClusterSecrets.map((s) => [s.secretName, s]));
      const groups = groupRepoInventoryByWorkload(mockRepoRecords);
      const emailGroup = groups.find((g) => g.workloadName === 'email-digest-dispatcher');

      expect(emailGroup).toBeDefined();
      const { data, skipped } = generateExternalSecretsData(emailGroup!, clusterSecretsMap, 'aws-secretsmanager');

      expect(data).toHaveLength(2);
      // secretKey should be the envVar name (original variable name)
      expect(data[0].secretKey).toBe('DIGEST_TRACKING_DB_PASSWORD');
      // remoteRef.property should be the remote secret key
      expect(data[0].remoteRef.property).toBe('password');
      
      expect(data[1].secretKey).toBe('DIGEST_TRACKING_DB_USERNAME');
      expect(data[1].remoteRef.property).toBe('username');
      
      expect(skipped).toHaveLength(0);
    });

    it('should skip secrets without AWS annotations', () => {
      const secretWithoutAnnotation: SecretInventoryRecord = {
        ...mockClusterSecrets[0],
        secretName: 'old-secret',
        annotations: {},
        hasAwsSecretsManagerSecretId: false,
      };

      const repoRecordsWithOldSecret: SecretReferenceRecord[] = [
        {
          ...mockRepoRecords[0],
          secretName: 'old-secret',
        },
      ];

      const clusterSecretsMap = new Map([['old-secret', secretWithoutAnnotation]]);
      const groups = groupRepoInventoryByWorkload(repoRecordsWithOldSecret);
      const group = groups[0];

      const { data, skipped } = generateExternalSecretsData(group, clusterSecretsMap, 'aws-secretsmanager');

      expect(data).toHaveLength(0);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].reason).toBe('no-aws-annotation');
    });
  });

  describe('buildContainerConfig', () => {
    it('should build container config with all required fields', () => {
      const data = [
        {
          secretKey: 'password',
          remoteRef: {
            key: 'rds/test',
            property: 'password',
            version: 'uuid/v1',
          },
        },
      ];

      const config = buildContainerConfig(data, 'my-secret', 'aws-secretsmanager');

      expect(config.create).toBe(true);
      // secretStoreRef and targetSecret are NOT included - inherited from commons
      expect(config.secretStoreRef).toBeUndefined();
      expect(config.targetSecret).toBeUndefined();
      expect(config.data).toEqual(data);
    });
  });

  describe('generateExternalSecretsFromWorkloads', () => {
    it('should generate all external secrets end-to-end', () => {
      const clusterSecretsMap = new Map(mockClusterSecrets.map((s) => [s.secretName, s]));
      const { generated, skipped } = generateExternalSecretsFromWorkloads(mockRepoRecords, clusterSecretsMap);

      expect(generated).toHaveLength(2);
      expect(skipped).toHaveLength(0);

      const emailSecret = generated.find((g) => g.workloadName === 'email-digest-dispatcher');
      expect(emailSecret).toBeDefined();
      expect(emailSecret?.externalSecretsConfig.data).toHaveLength(2);

      const flywaySecret = generated.find((g) => g.workloadName === 'flyway-migrator');
      expect(flywaySecret).toBeDefined();
      expect(flywaySecret?.containerType).toBe('initContainer');
    });
  });
});
