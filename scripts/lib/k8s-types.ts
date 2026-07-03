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
  referencedBy: string[]; // list of "workloadType/workloadName:containerName" that reference it
  isUnused: boolean;
}

export interface K8sCliArgs {
  cluster: string;
  namespace: string;
  outputDir?: string;
  format?: 'csv' | 'json' | 'both';
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob' | 'Pod';
