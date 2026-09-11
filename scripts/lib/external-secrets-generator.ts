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
  secrets: Map<string, Map<string, string>>; // secretName -> (envVar -> secretKey)
}

/**
 * Group repo inventory records by (workload, containerType, secretName)
 * Preserves mapping between envVar (env variable name) and secretKey (remote property)
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
      group.secrets.set(record.secretName, new Map());
    }
    
    // Store mapping: envVar -> secretKey
    // For envFromSecrets, the envVar name becomes the secretKey in ExternalSecrets
    const envVarName = record.envVar || record.secretKey || '';
    const remoteSecretKey = record.secretKey || '';
    
    group.secrets.get(record.secretName)!.set(envVarName, remoteSecretKey);
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
 * Uses envVar as secretKey and secretKey as remoteRef.property
 */
export function generateExternalSecretsData(
  group: WorkloadSecretGroup,
  clusterSecrets: Map<string, SecretInventoryRecord>,
  defaultSecretStoreRef: string
): { data: ExternalSecretsData[]; skipped: SkippedSecret[] } {
  const data: ExternalSecretsData[] = [];
  const skipped: SkippedSecret[] = [];

  for (const [secretName, envVarMap] of group.secrets) {
    // Verify the secret has the AWS annotation
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

    if (!secretInfo.hasAwsSecretsManagerSecretId) {
      skipped.push({
        workloadType: group.workloadType,
        workloadName: group.workloadName,
        secretName,
        reason: 'no-aws-annotation',
        details: `Secret '${secretName}' does not have AWS Secrets Manager annotation`,
      });
      continue;
    }

    // For each env variable -> remote secret key mapping
    for (const [envVar, secretKey] of envVarMap) {
      if (!envVar || !secretKey) {
        continue;
      }

      const remoteRef = buildRemoteRef(secretName, secretKey, clusterSecrets);
      if (remoteRef) {
        data.push({
          secretKey: envVar,  // Use env variable name as the secretKey
          remoteRef,          // remoteRef.property is the remote secret key
        });
      }
    }
  }

  return { data, skipped };
}

/**
 * Build full ContainerExternalSecretsConfig from generated data
 * Note: secretStoreRef and targetSecret are NOT included - they're defined in commons templates
 * Generator only provides: create flag and data array
 * Commons templates provide: secretStoreRef for store reference and targetSecret metadata
 */
export function buildContainerConfig(
  externalSecretsData: ExternalSecretsData[],
  targetSecretName: string,
  defaultSecretStoreRef: string
): ContainerExternalSecretsConfig {
  return {
    create: true,
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
