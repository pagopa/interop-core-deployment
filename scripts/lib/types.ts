export type OutputFormat = "csv" | "json" | "both";
export type WorkloadType = "microservice" | "cronjob";
export type SourceScope = "common" | "workload";
export type ReferenceType = "envFromSecrets" | "secretKeyRef" | "secretRef" | "volumeSecret";

export interface CliArgs {
  env: string;
  root: string;
  outputDir: string;
  format: OutputFormat;
}

export interface PartialCliArgs {
  env: string | null;
  root: string;
  outputDir: string;
  format: OutputFormat;
}

export interface Workload {
  component: string;
  workloadType: WorkloadType;
  valueFiles: string[];
}

export interface RecordContext {
  environment: string;
  workloadType: WorkloadType;
  component: string;
  sourceScope: SourceScope;
  sourceFile: string;
}

export interface SecretReferenceRecord extends RecordContext {
  line: number | "";
  yamlPath: string;
  containerPath: string;
  referenceType: ReferenceType;
  envVar: string;
  secretName: string;
  secretKey: string;
  rawReference: string;
}

export interface SecretAddress {
  secretName: string;
  secretKey: string;
}
