/**
 * Type definitions for ExternalSecrets configuration generation
 */

export interface ExternalSecretsGeneratorConfig {
  env: string;
  cluster: string;
  namespace: string;
  scope: 'microservice' | 'cronjob' | 'both';
  keepOldRefs: boolean;
  validateHelm: boolean;
  dryRun: boolean;
  outputDir?: string;
}

export interface RemoteRef {
  key: string; // AWS Secrets Manager path (e.g., "rds/interop-platform-data-dev/users/...")
  property: string; // Specific key within the secret (e.g., "password")
  version?: string; // Version ID from annotation (e.g., "uuid/terraform-...")
}

export interface ExternalSecretsData {
  secretKey: string;
  remoteRef: RemoteRef;
}

export interface ContainerExternalSecretsConfig {
  create: boolean;
  secretStoreRef: {
    name: string;
    kind: 'SecretStore' | 'ClusterSecretStore';
  };
  targetSecret: {
    name: string;
    creationPolicy: string;
    deletionPolicy: string;
  };
  data: ExternalSecretsData[];
}

export interface ExternalSecretsConfigFull {
  container?: ContainerExternalSecretsConfig;
  initContainer?: ContainerExternalSecretsConfig;
}

export interface GeneratedExternalSecret {
  workloadType: 'microservice' | 'cronjob';
  workloadName: string;
  workloadPath: string;
  containerType: 'container' | 'initContainer';
  secretName: string;
  externalSecretsConfig: ContainerExternalSecretsConfig;
}

export interface SkippedSecret {
  workloadType: 'microservice' | 'cronjob';
  workloadName: string;
  secretName: string;
  reason: 'no-aws-annotation' | 'missing-version' | 'missing-key-annotation' | 'secret-not-found';
  details: string;
}

export interface MigrationReport {
  environment: string;
  scope: string;
  totalWorkloads: number;
  migratedWorkloads: number;
  skippedWorkloads: number;
  totalSecretsProcessed: number;
  successfulMigrations: number;
  skippedSecrets: SkippedSecret[];
  errors: Array<{ workload: string; message: string }>;
  generatedExternalSecrets: GeneratedExternalSecret[];
}

export interface ValuesMergeResult {
  workloadPath: string;
  success: boolean;
  containerMerged: boolean;
  initContainerMerged: boolean;
  oldRefsRemoved: boolean;
  error?: string;
}
