/**
 * Kubernetes Secret inventory management and unused detection
 */

import type { K8sSecretInfo, K8sSecretReference, SecretInventoryRecord, SecretManagedAnnotationStatus } from './k8s-types.js';

export const AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION = 'infra.interop.pagopa.it/aws-secretsmanager-secret-id';
export const AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION = 'infra.interop.pagopa.it/aws-secretsmanager-version-id';
export const UPDATED_AT_ANNOTATION = 'infra.interop.pagopa.it/updated-at';

/**
 * Build secret inventory from references and secret names
 */
export function buildSecretInventory(
  secretsMap: Map<string, K8sSecretInfo>,
  references: K8sSecretReference[]
): SecretInventoryRecord[] {
  const inventory: SecretInventoryRecord[] = [];
  const referencedSecrets = new Set<string>();

  // Build map of which secrets are referenced
  references.forEach((ref) => {
    referencedSecrets.add(ref.secretName);
  });

  // Create inventory records
  secretsMap.forEach((secretInfo, secretName) => {
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

    const annotationClassification = classifySecretAnnotations(secretInfo.annotations);

    inventory.push({
      secretName,
      secretNamespace: 'current', // placeholder, actual namespace tracked separately
      keys: secretInfo.keys,
      annotations: secretInfo.annotations,
      referencedBy,
      isUnused: referencedBy.length === 0,
      ...annotationClassification,
      referencedWithoutManagedAnnotations: referencedBy.length > 0 && annotationClassification.hasNoManagedAnnotations,
    });
  });

  return inventory;
}

/**
 * Classify a Secret by ExternalSecrets/SecretsManager-related annotations.
 */
export function classifySecretAnnotations(annotations: Record<string, string>): {
  hasAwsSecretsManagerSecretId: boolean;
  hasAwsSecretsManagerVersionId: boolean;
  hasUpdatedAt: boolean;
  hasAnyManagedAnnotation: boolean;
  hasNoManagedAnnotations: boolean;
  managedAnnotationStatus: SecretManagedAnnotationStatus;
} {
  const hasAwsSecretsManagerSecretId = hasAnnotation(annotations, AWS_SECRETSMANAGER_SECRET_ID_ANNOTATION);
  const hasAwsSecretsManagerVersionId = hasAnnotation(annotations, AWS_SECRETSMANAGER_VERSION_ID_ANNOTATION);
  const hasUpdatedAt = hasAnnotation(annotations, UPDATED_AT_ANNOTATION);
  const hasAnyManagedAnnotation = hasAwsSecretsManagerSecretId || hasAwsSecretsManagerVersionId || hasUpdatedAt;
  const hasNoManagedAnnotations = !hasAnyManagedAnnotation;

  return {
    hasAwsSecretsManagerSecretId,
    hasAwsSecretsManagerVersionId,
    hasUpdatedAt,
    hasAnyManagedAnnotation,
    hasNoManagedAnnotations,
    managedAnnotationStatus: getManagedAnnotationStatus(hasAwsSecretsManagerSecretId, hasNoManagedAnnotations),
  };
}

function hasAnnotation(annotations: Record<string, string>, annotation: string): boolean {
  return Object.prototype.hasOwnProperty.call(annotations, annotation);
}

function getManagedAnnotationStatus(
  hasAwsSecretsManagerSecretId: boolean,
  hasNoManagedAnnotations: boolean
): SecretManagedAnnotationStatus {
  if (hasAwsSecretsManagerSecretId) {
    return 'aws-secretsmanager-secret-id';
  }
  if (hasNoManagedAnnotations) {
    return 'no-managed-annotations';
  }
  return 'partial-managed-annotations';
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
  annotationKeys: string;
  hasAwsSecretsManagerSecretId: boolean;
  hasAwsSecretsManagerVersionId: boolean;
  hasUpdatedAt: boolean;
  hasAnyManagedAnnotation: boolean;
  hasNoManagedAnnotations: boolean;
  managedAnnotationStatus: SecretManagedAnnotationStatus;
  isUnused: boolean;
  usageCount: number;
  usageList: string;
  referencedWithoutManagedAnnotations: boolean;
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
    annotationKeys: Object.keys(record.annotations).sort().join(';'),
    hasAwsSecretsManagerSecretId: record.hasAwsSecretsManagerSecretId,
    hasAwsSecretsManagerVersionId: record.hasAwsSecretsManagerVersionId,
    hasUpdatedAt: record.hasUpdatedAt,
    hasAnyManagedAnnotation: record.hasAnyManagedAnnotation,
    hasNoManagedAnnotations: record.hasNoManagedAnnotations,
    managedAnnotationStatus: record.managedAnnotationStatus,
    isUnused: record.isUnused,
    usageCount: record.referencedBy.length,
    usageList: record.referencedBy.join('\n'),
    referencedWithoutManagedAnnotations: record.referencedWithoutManagedAnnotations,
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
  secretManagedAnnotationStatus: SecretManagedAnnotationStatus | 'secret-not-found';
  secretHasAwsSecretsManagerSecretId: boolean;
  secretHasNoManagedAnnotations: boolean;
  referencedSecretWithoutManagedAnnotations: boolean;
}

export function formatInventoryWorkloadCentric(
  references: K8sSecretReference[],
  namespace: string,
  inventory: SecretInventoryRecord[] = []
): WorkloadCentricOutputRecord[] {
  const inventoryBySecretName = new Map(inventory.map((record) => [record.secretName, record]));

  return references.map((ref) => ({
    ...formatWorkloadReference(ref, namespace, inventoryBySecretName.get(ref.secretName)),
  }));
}

function formatWorkloadReference(
  ref: K8sSecretReference,
  namespace: string,
  secretInventory?: SecretInventoryRecord
): WorkloadCentricOutputRecord {
  const secretHasNoManagedAnnotations = secretInventory?.hasNoManagedAnnotations ?? false;

  return {
    workloadType: ref.workloadType,
    workloadName: ref.workloadName,
    workloadNamespace: namespace,
    containerName: ref.containerName,
    containerType: ref.containerType,
    referenceType: ref.referenceType,
    secretName: ref.secretName,
    secretKey: ref.secretKey || '',
    secretManagedAnnotationStatus: secretInventory?.managedAnnotationStatus ?? 'secret-not-found',
    secretHasAwsSecretsManagerSecretId: secretInventory?.hasAwsSecretsManagerSecretId ?? false,
    secretHasNoManagedAnnotations,
    referencedSecretWithoutManagedAnnotations: Boolean(secretInventory) && secretHasNoManagedAnnotations,
  };
}
