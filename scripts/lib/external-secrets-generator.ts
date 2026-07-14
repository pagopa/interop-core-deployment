/**
 * Core logic for generating ExternalSecrets configuration from repo inventory and cluster annotations
 */

import type { SecretReferenceRecord } from './types.js';
import type { SecretInventoryRecord } from './k8s-types.js';
import type {
  ExternalSecretsData,
  ContainerExternalSecretsConfig,
  GeneratedExternalSecret,
  SkippedSecret,
  RemoteRef,
} from './external-secrets-types.js';
import {
  AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION,
  AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION,
} from './k8s-inventory.js';

interface WorkloadSecretGroup {
  workloadType: 'microservice' | 'cronjob';
  workloadName: string;
  workloadPath: string;
  containerType: 'container' | 'initContainer';
  secrets: Map<string, Set<string>>; // secretName -> Set<secretKey>
}

/**
 * Group repo inventory records by (workload, containerType, secretName)
 * Supports both individual secret keys and envFromSecrets references
 */
export function groupRepoInventoryByWorkload(
  repoRecords: SecretReferenceRecord[]
): WorkloadSecretGroup[] {
  const groups = new Map<string, WorkloadSecretGroup>();
  let envFromSecretsCount = 0;
  let secretRefCount = 0;
  const referenceTypeCounts = new Map<string, number>();

  for (const record of repoRecords) {
    // Track reference types
    const typeKey = record.referenceType || 'unknown';
    referenceTypeCounts.set(typeKey, (referenceTypeCounts.get(typeKey) || 0) + 1);

    if (record.referenceType === 'envFromSecrets') {
      // For envFromSecrets, the entire Secret is imported as env vars
      // In ExternalSecrets, we need to create a data entry for each key in the Secret
      // Since we don't know which keys exist at parse time, we'll use a wildcard approach
      // by storing an empty secretKey to mean "all keys from this secret"
      envFromSecretsCount++;
    } else {
      secretRefCount++;
    }

    // Determine container type from record
    const containerType =
      record.containerPath?.toLowerCase().includes('initcontainer') ||
      record.yamlPath?.toLowerCase().includes('initcontainer')
        ? 'initContainer'
        : 'container';

    const groupKey = `${record.workloadType}/${record.component}/${containerType}`;
    let group = groups.get(groupKey);

    if (!group) {
      group = {
        workloadType: record.workloadType as 'microservice' | 'cronjob',
        workloadName: record.component,
        workloadPath: record.sourceFile,
        containerType,
        secrets: new Map(),
      };
      groups.set(groupKey, group);
    }

    if (!group.secrets.has(record.secretName)) {
      group.secrets.set(record.secretName, new Set());
    }
    
    // For envFromSecrets, store empty string to mean "all keys"
    // For individual refs, store the specific key
    const keyToStore = record.referenceType === 'envFromSecrets' ? '__ALL__' : (record.secretKey || '');
    group.secrets.get(record.secretName)!.add(keyToStore);
  }

  if (envFromSecretsCount > 0 || secretRefCount > 0) {
    console.debug(
      `   [groupRepoInventoryByWorkload] Reference types: ${Array.from(referenceTypeCounts.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}; envFromSecrets=${envFromSecretsCount}, individualRefs=${secretRefCount}`
    );
  }

  return Array.from(groups.values());
}

/**
 * Build RemoteRef from cluster annotations
 */
export function buildRemoteRef(
  secretName: string,
  secretKey: string,
  clusterSecrets: Map<string, SecretInventoryRecord>
): RemoteRef | null {
  const secretInfo = clusterSecrets.get(secretName);
  if (!secretInfo) {
    console.debug(`   [buildRemoteRef] Secret "${secretName}" not found in cluster inventory`);
    return null;
  }

  if (!secretInfo.annotations) {
    console.debug(`   [buildRemoteRef] Secret "${secretName}" has no annotations object`);
    return null;
  }

  const secretIdAnnotation = secretInfo.annotations[AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION];
  if (!secretIdAnnotation) {
    const annotationKeys = Object.keys(secretInfo.annotations);
    console.debug(
      `   [buildRemoteRef] Secret "${secretName}" missing AWS annotation. Has ${annotationKeys.length} annotations: ${annotationKeys.slice(0, 3).join(', ')}${annotationKeys.length > 3 ? '...' : ''}`
    );
    return null;
  }

  const versionAnnotation = secretInfo.annotations[AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION];

  return {
    key: secretIdAnnotation,
    property: secretKey,
    version: versionAnnotation,
  };
}

/**
 * Generate ExternalSecretsData entries for a workload's secrets
 * Handles both individual secret keys and envFromSecrets (all keys)
 */
export function generateExternalSecretsData(
  group: WorkloadSecretGroup,
  clusterSecrets: Map<string, SecretInventoryRecord>,
  defaultSecretStoreRef: string
): { data: ExternalSecretsData[]; skipped: SkippedSecret[] } {
  const data: ExternalSecretsData[] = [];
  const skipped: SkippedSecret[] = [];

  for (const [secretName, secretKeys] of group.secrets) {
    for (const secretKey of secretKeys) {
      // Handle envFromSecrets (all keys) vs individual references
      const keysToProcess = secretKey === '__ALL__' ? ['__ALL__'] : [secretKey];

      for (const keyToProcess of keysToProcess) {
        if (!keyToProcess || (keyToProcess !== '__ALL__' && keyToProcess === '')) {
          // Skip truly empty references
          continue;
        }

        if (keyToProcess === '__ALL__') {
          // For envFromSecrets, create entries for all keys in the secret
          const secretInfo = clusterSecrets.get(secretName);
          if (!secretInfo) {
            skipped.push({
              workloadType: group.workloadType,
              workloadName: group.workloadName,
              secretName,
              reason: 'secret-not-found',
              details: `Secret '${secretName}' not found in cluster inventory`,
            });
            continue;
          }

          // Verify the secret has the AWS annotation
          if (!secretInfo.hasAwsSecretsManagerSecretId) {
            skipped.push({
              workloadType: group.workloadType,
              workloadName: group.workloadName,
              secretName,
              reason: 'no-aws-annotation',
              details: `Secret '${secretName}' does not have AWS Secrets Manager annotation (envFromSecrets reference)`,
            });
            continue;
          }

          // Generate one data entry per actual key in the secret
          for (const actualKey of secretInfo.keys) {
            const remoteRef = buildRemoteRef(secretName, actualKey, clusterSecrets);
            if (remoteRef) {
              data.push({
                secretKey: actualKey,
                remoteRef,
              });
            }
          }
        } else {
          // Individual secret key reference
          const remoteRef = buildRemoteRef(secretName, keyToProcess, clusterSecrets);
          if (!remoteRef) {
            skipped.push({
              workloadType: group.workloadType,
              workloadName: group.workloadName,
              secretName,
              reason: 'no-aws-annotation',
              details: `Secret '${secretName}' does not have AWS Secrets Manager annotation`,
            });
            continue;
          }

          data.push({
            secretKey: keyToProcess,
            remoteRef,
          });
        }
      }
    }
  }

  return { data, skipped };
}

/**
 * Build full ContainerExternalSecretsConfig from generated data
 */
export function buildContainerConfig(
  externalSecretsData: ExternalSecretsData[],
  targetSecretName: string,
  defaultSecretStoreRef: string
): ContainerExternalSecretsConfig {
  return {
    create: true,
    secretStoreRef: {
      name: defaultSecretStoreRef,
      kind: 'ClusterSecretStore',
    },
    targetSecret: {
      name: targetSecretName,
      creationPolicy: 'Owner',
      deletionPolicy: 'Retain',
    },
    data: externalSecretsData,
  };
}

/**
 * Generate default target secret name based on workload and container type
 */
export function generateTargetSecretName(workloadName: string, containerType: 'container' | 'initContainer'): string {
  if (containerType === 'initContainer') {
    return `${workloadName}-flyway`;
  }
  return workloadName;
}

/**
 * Main entry point: generate all ExternalSecrets from workload groups
 */
export function generateExternalSecretsFromWorkloads(
  repoRecords: SecretReferenceRecord[],
  clusterSecrets: Map<string, SecretInventoryRecord>,
  defaultSecretStoreRef: string = 'aws-secretsmanager'
): {
  generated: GeneratedExternalSecret[];
  skipped: SkippedSecret[];
} {
  const groups = groupRepoInventoryByWorkload(repoRecords);
  const generated: GeneratedExternalSecret[] = [];
  const skipped: SkippedSecret[] = [];

  for (const group of groups) {
    const targetSecretName = generateTargetSecretName(group.workloadName, group.containerType);
    const { data, skipped: groupSkipped } = generateExternalSecretsData(group, clusterSecrets, defaultSecretStoreRef);

    if (data.length > 0) {
      const config = buildContainerConfig(data, targetSecretName, defaultSecretStoreRef);
      generated.push({
        workloadType: group.workloadType,
        workloadName: group.workloadName,
        workloadPath: group.workloadPath,
        containerType: group.containerType,
        secretName: targetSecretName,
        externalSecretsConfig: config,
      });
    }

    skipped.push(...groupSkipped);
  }

  return { generated, skipped };
}

/**
 * Convert cluster inventory records to Map for easy lookup
 */
export function buildClusterSecretsMap(clusterRecords: SecretInventoryRecord[]): Map<string, SecretInventoryRecord> {
  const map = new Map<string, SecretInventoryRecord>();
  for (const record of clusterRecords) {
    map.set(record.secretName, record);
  }
  return map;
}
