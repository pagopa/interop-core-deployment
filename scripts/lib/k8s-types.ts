/**
 * Kubernetes-specific types for secret reference extraction and inventory
 */

export interface ClusterConfig {
  context: string;
  namespace: string;
}

export interface K8sSecretReference {
  workloadType: string;
  workloadName: string;
  workloadNamespace: string;
  containerName: string;
  containerType: 'container' | 'initContainer' | 'ephemeralContainer' | 'pod-volume';
  referenceType: 'env.secretKeyRef' | 'envFrom.secretRef' | 'volumes.secret';
  secretName: string;
  secretKey?: string; // undefined for envFrom.secretRef
}

export interface SecretInventoryRecord {
  secretName: string;
  secretNamespace: string;
  keys: string[]; // all keys in the Secret
  annotations: Record<string, string>; // all annotations in the Secret
  referencedBy: string[]; // list of "workloadType/workloadName:containerName" that reference it
  isUnused: boolean;
  hasAwsSecretsManagerSecretId: boolean; // true if the Secret has the "aws-secretsmanager-secret-id" annotation
  hasAwsSecretsManagerVersionId: boolean; // true if the Secret has the "aws-secretsmanager-version-id" annotation
  hasUpdatedAt: boolean; // true if the Secret has the "updated-at" annotation
  hasAnyManagedAnnotation: boolean; // true if the Secret has any of the managed annotations (aws-secretsmanager-secret-id, aws-secretsmanager-version-id, updated-at)
  hasNoManagedAnnotations: boolean; // true if the Secret has none of the managed annotations (aws-secretsmanager-secret-id, aws-secretsmanager-version-id, updated-at)
  managedAnnotationStatus: SecretManagedAnnotationStatus; // 'aws-secretsmanager-secret-id' | 'partial-managed-annotations' | 'no-managed-annotations'
  referencedWithoutManagedAnnotations: boolean; // true if the Secret is referenced by a workload but has no managed annotations
}

export interface K8sSecretInfo {
  keys: string[];
  annotations: Record<string, string>;
}

export type SecretManagedAnnotationStatus =
  | 'aws-secretsmanager-secret-id'
  | 'partial-managed-annotations'
  | 'no-managed-annotations';

export interface K8sCliArgs {
  cluster: string;
  namespace: string;
  outputDir?: string;
  format?: 'csv' | 'json' | 'both';
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob' | 'Pod';
