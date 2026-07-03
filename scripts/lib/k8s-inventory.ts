/**
 * Kubernetes Secret inventory management and unused detection
 */

import type { K8sSecretReference, SecretInventoryRecord } from './k8s-types.js';

/**
 * Build secret inventory from references and secret names
 */
export function buildSecretInventory(
  secretsMap: Map<string, string[]>,
  references: K8sSecretReference[]
): SecretInventoryRecord[] {
  const inventory: SecretInventoryRecord[] = [];
  const referencedSecrets = new Set<string>();

  // Build map of which secrets are referenced
  references.forEach((ref) => {
    referencedSecrets.add(ref.secretName);
  });

  // Create inventory records
  secretsMap.forEach((keys, secretName) => {
    const referencedBy: string[] = [];

    // Find all references to this secret
    references.forEach((ref) => {
      if (ref.secretName === secretName) {
        const refStr = `${ref.workloadType}/${ref.workloadName}:${ref.containerName}`;
        if (!referencedBy.includes(refStr)) {
          referencedBy.push(refStr);
        }
      }
    });

    inventory.push({
      secretName,
      secretNamespace: 'current', // placeholder, actual namespace tracked separately
      keys,
      referencedBy,
      isUnused: referencedBy.length === 0,
    });
  });

  return inventory;
}

/**
 * Deduplicate secret references by composite key (workload + container + secret + key)
 */
export function deduplicateReferences(references: K8sSecretReference[]): K8sSecretReference[] {
  const seen = new Set<string>();
  const deduped: K8sSecretReference[] = [];

  references.forEach((ref) => {
    // For envFrom.secretRef, key is undefined, so we use a marker
    const key = ref.secretKey || '__no-key__';
    const composite = `${ref.workloadType}/${ref.workloadName}/${ref.containerName}/${ref.secretName}/${key}/${ref.referenceType}`;

    if (!seen.has(composite)) {
      seen.add(composite);
      deduped.push(ref);
    }
  });

  return deduped;
}

/**
 * Format inventory for output - secret-centric view (mirrors the repo inventory format)
 */
export interface SecretCentricOutputRecord {
  secretName: string;
  secretNamespace: string;
  keyCount: number;
  keys: string;
  isUnused: boolean;
  usageCount: number;
  usageList: string;
}

export function formatInventoryForOutput(
  inventory: SecretInventoryRecord[],
  namespace: string
): SecretCentricOutputRecord[] {
  return inventory.map((record) => ({
    secretName: record.secretName,
    secretNamespace: namespace,
    keyCount: record.keys.length,
    keys: record.keys.join(';'),
    isUnused: record.isUnused,
    usageCount: record.referencedBy.length,
    usageList: record.referencedBy.join(' | '),
  }));
}

/**
 * Format inventory for output - workload-centric view
 * One row per secret reference from each workload
 */
export interface WorkloadCentricOutputRecord {
  workloadType: string;
  workloadName: string;
  workloadNamespace: string;
  containerName: string;
  containerType: string;
  referenceType: string;
  secretName: string;
  secretKey: string;
}

export function formatInventoryWorkloadCentric(
  references: K8sSecretReference[],
  namespace: string
): WorkloadCentricOutputRecord[] {
  return references.map((ref) => ({
    workloadType: ref.workloadType,
    workloadName: ref.workloadName,
    workloadNamespace: namespace,
    containerName: ref.containerName,
    containerType: ref.containerType,
    referenceType: ref.referenceType,
    secretName: ref.secretName,
    secretKey: ref.secretKey || '',
  }));
}
