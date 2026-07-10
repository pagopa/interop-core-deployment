/**
 * Compare repo vs cluster secret extraction
 * Identifies discrepancies, missing references, and differences
 */

import type { SecretReferenceRecord, WorkloadType } from './types.js';

/**
 * Extract container name from YAML path for proper container identification.
 * Maps repo values.yaml paths to actual Kubernetes container names.
 * 
 * For flywayInitContainer, the name comes from Helm chart template:
 *   charts/interop-eks-microservice-chart/templates/deployment.yaml:
 *   `initContainers: [{ name: migrate-db, ...}]`
 *   charts/interop-eks-cronjob-chart/templates/cronjob.yaml:
 *   `initContainers: [{ name: migrate-db, ...}]`
 * 
 * Examples:
 *   "deployment.containers[0].env" → "container" (main container, name from values.name)
 *   "deployment.initContainers[0].env" → "initContainer"
 *   "deployment.flywayInitContainer.envFromSecrets" → "migrate-db" (Helm-defined name)
 *   "cronjob.flywayInitContainer.envFromSecrets" → "migrate-db" (Helm-defined name)
 *   "configmap" → "configmap"
 */
function extractContainerNameFromYamlPath(containerPath: string): string {
  if (!containerPath) return 'container';

  // Check for explicit container types in path
  // Flyway init container is rendered as "migrate-db" by Helm charts
  if (containerPath.includes('flywayInitContainer')) return 'migrate-db';
  
  if (containerPath.includes('initContainers')) return 'initContainer';
  if (containerPath.includes('containers[')) return 'container';
  if (containerPath.includes('ephemeralContainers')) return 'ephemeralContainer';
  if (containerPath.includes('volumes')) return 'pod-volume';

  // Default to main container — caller should replace this with the workload name
  return 'container';
}

/**
 * Extract container type from YAML path for proper containerType matching with K8s.
 * K8s distinguishes: container, initContainer, ephemeralContainer.
 *
 * Examples:
 *   "deployment.envFromSecrets"                 → "container"
 *   "deployment.flywayInitContainer.envFromSecrets" → "initContainer"
 *   "deployment.initContainers[0].env"          → "initContainer"
 *   "deployment.ephemeralContainers[0].env"     → "ephemeralContainer"
 */
function extractContainerTypeFromYamlPath(containerPath: string): string {
  if (!containerPath) return 'container';
  if (containerPath.includes('flywayInitContainer')) return 'initContainer';
  if (containerPath.includes('initContainers')) return 'initContainer';
  if (containerPath.includes('ephemeralContainers')) return 'ephemeralContainer';
  return 'container';
}

/**
 * Normalize repo workload types to their Kubernetes equivalents
 * In the repo, workloads are defined as Helm values files with chart templating:
 * - Microservices (Helm chart: interop-eks-microservice-chart) → K8s Deployment
 * - Jobs (Helm chart: interop-eks-cronjob-chart) → K8s CronJob
 */
function normalizeRepoWorkloadType(workloadType: WorkloadType): string {
  if (workloadType === 'microservice') return 'Deployment';
  if (workloadType === 'cronjob') return 'CronJob';
  return workloadType;
}

export interface ComparisonResult {
  timestamp: string;
  environment: string;
  cluster: string;
  secretCentric: SecretCentricComparison;
  workloadCentric: WorkloadCentricComparison;
  summary: ComparisonSummary;
}

export interface SecretComparisonReport {
  timestamp: string;
  environment: string;
  cluster: string;
  secretCentric: SecretCentricComparison;
}

export interface WorkloadComparisonReport {
  timestamp: string;
  environment: string;
  cluster: string;
  workloadCentric: WorkloadCentricComparison;
}

export interface StatsComparisonReport {
  timestamp: string;
  environment: string;
  cluster: string;
  summary: ComparisonSummary;
}

/**
 * Transform raw SecretReferenceRecord from repo inventory into aggregated secret-centric format
 */
export function aggregateRepoDataToSecretCentric(rawRecords: SecretReferenceRecord[]): any[] {
  const secretMap = new Map<string, any>();

  rawRecords.forEach((record) => {
    const key = `${record.secretName}`;
    if (!secretMap.has(key)) {
      secretMap.set(key, {
        secretName: record.secretName,
        secretNamespace: 'repo',
        keyCount: 0,
        keys: new Set<string>(),
        isUnused: false,
        usageCount: 0,
        usageList: new Set<string>(),
      });
    }

    const entry = secretMap.get(key)!;
    if (record.secretKey) {
      entry.keys.add(record.secretKey);
    }
    entry.keyCount = entry.keys.size;

    const ref = `${record.component}.${record.referenceType}`;
    entry.usageList.add(ref);
    entry.usageCount = entry.usageList.size;
  });

  return Array.from(secretMap.values()).map((entry) => ({
    secretName: entry.secretName,
    secretNamespace: entry.secretNamespace,
    keyCount: entry.keyCount,
    keys: Array.from(entry.keys).sort().join('; '),
    isUnused: entry.usageCount === 0,
    usageCount: entry.usageCount,
    usageList: Array.from(entry.usageList).sort().join('\n'),
  }));
}

/**
 * Transform raw SecretReferenceRecord from repo inventory into aggregated workload-centric format
 * Normalizes repo workload types to match K8s equivalents (microservice→Deployment, cronjob→CronJob)
 * Extracts actual container names from YAML paths (including flywayInitContainer)
 */
export function aggregateRepoDataToWorkloadCentric(rawRecords: SecretReferenceRecord[]): any[] {
  return rawRecords.map((record) => {
    const rawContainerName = extractContainerNameFromYamlPath(record.containerPath);
    // For the main container, Helm names the container after the workload (record.component).
    // extractContainerNameFromYamlPath returns the sentinel "container" in that case.
    const containerName = rawContainerName === 'container' ? record.component : rawContainerName;
    const containerType = extractContainerTypeFromYamlPath(record.containerPath);

    return {
      workloadType: normalizeRepoWorkloadType(record.workloadType),
      workloadName: record.component,
      workloadNamespace: record.environment,
      containerName,
      containerType,
      referenceType: record.referenceType,
      secretName: record.secretName,
      secretKey: record.secretKey || null,
    };
  });
}

interface SecretCentricComparison {
  missingInStatic: Array<{
    secretName: string;
    secretNamespace: string;
    keys: string[];
    usageInCluster: number;
  }>;
  missingInDynamic: Array<{
    secretName: string;
    secretNamespace: string;
    keys: string[];
    referencedInRepo: number;
  }>;
  differencesBySecret: Array<{
    secretName: string;
    secretNamespace: string;
    staticUsageCount: number;
    dynamicUsageCount: number;
    staticReferences: string[];
    dynamicReferences: string[];
    newReferencesInCluster: string[];
    missingReferencesInCluster: string[];
  }>;
}

export interface WorkloadCentricComparison {
  missingInStatic: Array<{
    workloadType: string;
    workloadName: string;
    workloadNamespace: string;
    containerName: string;
    containerType: string;
    secretReferences: number;
  }>;
  missingInDynamic: Array<{
    workloadType: string;
    workloadName: string;
    workloadNamespace: string;
    containerName: string;
    containerType: string;
    secretReferences: number;
  }>;
  differencesByWorkload: Array<{
    workloadType: string;
    workloadName: string;
    workloadNamespace: string;
    containerName: string;
    staticRefCount: number;
    dynamicRefCount: number;
    staticSecrets: string[];
    dynamicSecrets: string[];
    newSecretsInCluster: string[];
    missingSecretsInCluster: string[];
  }>;
}

export interface ComparisonSummary {
  secretCentric: {
    totalSecretsStatic: number;
    totalSecretsDynamic: number;
    totalUniqueSecrets: number;
    secretsOnlyInStatic: number;
    secretsOnlyInDynamic: number;
    secretsWithDifferentUsage: number;
    discrepancyPercentage: number;
  };
  workloadCentric: {
    totalWorkloadsStatic: number;
    totalWorkloadsDynamic: number;
    totalUniqueWorkloads: number;
    workloadsOnlyInStatic: number;
    workloadsOnlyInDynamic: number;
    workloadsWithDifferentReferences: number;
  };
}

export function compareSecretInventories(
  staticData: any[],
  dynamicData: any[]
): SecretCentricComparison {
  const staticMap = new Map<string, any>();
  const dynamicMap = new Map<string, any>();

  // Build maps keyed by secretName
  (staticData as any[]).forEach((record: any) => {
    staticMap.set(record.secretName, record);
  });
  (dynamicData as any[]).forEach((record: any) => {
    dynamicMap.set(record.secretName, record);
  });

  const missingInStatic: SecretCentricComparison['missingInStatic'] = [];
  const missingInDynamic: SecretCentricComparison['missingInDynamic'] = [];
  const differencesBySecret: SecretCentricComparison['differencesBySecret'] = [];

  // Find missing in repo (only in cluster)
  dynamicMap.forEach((dynamicRecord: any, secretName: string) => {
    if (!staticMap.has(secretName)) {
      const dynamicReferences = splitListField(dynamicRecord.usageList, '\n');
      missingInStatic.push({
        secretName,
        secretNamespace: dynamicRecord.secretNamespace || 'unknown',
        keys: splitListField(dynamicRecord.keys, ';'),
        usageInCluster: dynamicReferences.length,
      });
    }
  });

  // Find missing in dynamic (only in repo)
  staticMap.forEach((staticRecord: any, secretName: string) => {
    if (!dynamicMap.has(secretName)) {
      const staticReferences = splitListField(staticRecord.usageList, '\n');
      missingInDynamic.push({
        secretName,
        secretNamespace: staticRecord.secretNamespace || 'unknown',
        keys: splitListField(staticRecord.keys, ';'),
        referencedInRepo: staticReferences.length,
      });
    }
  });

  // Find differences in usage
  staticMap.forEach((staticRecord: any, secretName: string) => {
    const dynamicRecord = dynamicMap.get(secretName);
    if (dynamicRecord) {
        // usageList is a string (join-ated with '\n'), so split it back to array
        const staticRefs = splitListField(staticRecord.usageList, '\n');
        const dynamicRefs = splitListField(dynamicRecord.usageList, '\n');

        // Normalize to component name only before comparing:
        //   repo format:     "agreement-process.envFromSecrets" → "agreement-process"
        //   cluster format:  "Deployment/agreement-process:container" → "agreement-process"
        const staticRefSet = new Set(staticRefs.map(normalizeStaticUsageRef));
        const dynamicRefSet = new Set(dynamicRefs.map(normalizeDynamicUsageRef));

        const newInCluster = Array.from(dynamicRefSet).filter((ref) => !staticRefSet.has(ref)) as string[];
        const missingFromCluster = Array.from(staticRefSet).filter((ref) => !dynamicRefSet.has(ref)) as string[];

      if (newInCluster.length > 0 || missingFromCluster.length > 0) {
        // Use cluster namespace when available, fallback to repo namespace
        const namespace = dynamicRecord.secretNamespace !== 'repo' ? dynamicRecord.secretNamespace : (staticRecord.secretNamespace || 'unknown');
        differencesBySecret.push({
          secretName,
          secretNamespace: namespace,
          staticUsageCount: staticRefSet.size,
          dynamicUsageCount: dynamicRefSet.size,
          staticReferences: Array.from(staticRefSet),
          dynamicReferences: Array.from(dynamicRefSet),
          newReferencesInCluster: newInCluster,
          missingReferencesInCluster: missingFromCluster,
        });
      }
    }
  });

  return {
    missingInStatic,
    missingInDynamic,
    differencesBySecret,
  };
}

function splitListField(value: unknown, separator: string): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(separator)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Normalize a repo usageList entry to just the component name.
 * Repo format: "agreement-process.envFromSecrets" → "agreement-process"
 */
function normalizeStaticUsageRef(ref: string): string {
  const dotIndex = ref.indexOf('.');
  return dotIndex !== -1 ? ref.substring(0, dotIndex) : ref;
}

/**
 * Normalize a cluster usageList entry to just the workload name.
 * Cluster format: "Deployment/agreement-process:container" → "agreement-process"
 */
function normalizeDynamicUsageRef(ref: string): string {
  const slashIndex = ref.indexOf('/');
  const colonIndex = ref.indexOf(':');
  if (slashIndex !== -1 && colonIndex !== -1) {
    return ref.substring(slashIndex + 1, colonIndex);
  }
  if (slashIndex !== -1) {
    return ref.substring(slashIndex + 1);
  }
  return ref;
}

export function compareWorkloadInventories(
  staticData: any[],
  dynamicData: any[]
): WorkloadCentricComparison {
  const staticKey = (r: any) =>
    `${r.workloadType}/${r.workloadName}/${r.workloadNamespace}/${r.containerName}/${r.containerType}`;
  const dynamicKey = (r: any) =>
    `${r.workloadType}/${r.workloadName}/${r.workloadNamespace}/${r.containerName}/${r.containerType}`;

  const staticMap = new Map<string, any[]>();
  const dynamicMap = new Map<string, any[]>();

  // Build maps: key -> array of references
  staticData.forEach((record) => {
    const key = staticKey(record);
    if (!staticMap.has(key)) {
      staticMap.set(key, []);
    }
    staticMap.get(key)!.push(record);
  });

  dynamicData.forEach((record) => {
    const key = dynamicKey(record);
    if (!dynamicMap.has(key)) {
      dynamicMap.set(key, []);
    }
    dynamicMap.get(key)!.push(record);
  });

  const missingInStatic: WorkloadCentricComparison['missingInStatic'] = [];
  const missingInDynamic: WorkloadCentricComparison['missingInDynamic'] = [];
  const differencesByWorkload: WorkloadCentricComparison['differencesByWorkload'] = [];

  // Find missing in repo (only in cluster)
  dynamicMap.forEach((records, key) => {
    if (!staticMap.has(key)) {
      const firstRecord = records[0];
      missingInStatic.push({
        workloadType: firstRecord.workloadType,
        workloadName: firstRecord.workloadName,
        workloadNamespace: firstRecord.workloadNamespace,
        containerName: firstRecord.containerName,
        containerType: firstRecord.containerType,
        secretReferences: records.length,
      });
    }
  });

  // Find missing in dynamic (only in repo)
  staticMap.forEach((records, key) => {
    if (!dynamicMap.has(key)) {
      const firstRecord = records[0];
      missingInDynamic.push({
        workloadType: firstRecord.workloadType,
        workloadName: firstRecord.workloadName,
        workloadNamespace: firstRecord.workloadNamespace,
        containerName: firstRecord.containerName,
        containerType: firstRecord.containerType,
        secretReferences: records.length,
      });
    }
  });

  // Find differences in references
  staticMap.forEach((staticRecords, key) => {
    const dynamicRecords = dynamicMap.get(key);
    if (dynamicRecords) {
      const staticSecrets = new Set((staticRecords as any[]).map((r: any) => r.secretName));
      const dynamicSecrets = new Set((dynamicRecords as any[]).map((r: any) => r.secretName));

      const newInCluster = Array.from(dynamicSecrets).filter((s) => !staticSecrets.has(s));
      const missingFromCluster = Array.from(staticSecrets).filter((s) => !dynamicSecrets.has(s));

      if (staticRecords.length !== dynamicRecords.length || newInCluster.length > 0 || missingFromCluster.length > 0) {
        const firstStatic = staticRecords[0];
        differencesByWorkload.push({
          workloadType: (firstStatic as any).workloadType,
          workloadName: (firstStatic as any).workloadName,
          workloadNamespace: (firstStatic as any).workloadNamespace,
          containerName: (firstStatic as any).containerName,
          staticRefCount: staticRecords.length,
          dynamicRefCount: dynamicRecords.length,
          staticSecrets: Array.from(staticSecrets) as string[],
          dynamicSecrets: Array.from(dynamicSecrets) as string[],
          newSecretsInCluster: newInCluster as string[],
          missingSecretsInCluster: missingFromCluster as string[],
        });
      }
    }
  });

  return {
    missingInStatic,
    missingInDynamic,
    differencesByWorkload,
  };
}

export function buildComparisonResult(
  environment: string,
  cluster: string,
  staticSecrets: any[],
  dynamicSecrets: any[],
  staticWorkloads: any[],
  dynamicWorkloads: any[]
): ComparisonResult {
  const secretCentric = compareSecretInventories(staticSecrets, dynamicSecrets);
  const workloadCentric = compareWorkloadInventories(staticWorkloads, dynamicWorkloads);

  // Build summary
  const staticSecretNames = new Set(staticSecrets.map((s) => s.secretName));
  const dynamicSecretNames = new Set(dynamicSecrets.map((s) => s.secretName));
  const allSecretNames = new Set([...staticSecretNames, ...dynamicSecretNames]);

  const staticWorkloadKeys = new Set(
    staticWorkloads.map((w) => `${w.workloadType}/${w.workloadName}/${w.workloadNamespace}/${w.containerName}`)
  );
  const dynamicWorkloadKeys = new Set(
    dynamicWorkloads.map((w) => `${w.workloadType}/${w.workloadName}/${w.workloadNamespace}/${w.containerName}`)
  );
  const allWorkloadKeys = new Set([...staticWorkloadKeys, ...dynamicWorkloadKeys]);

  const secretsOnlyInStatic = Array.from(staticSecretNames).filter((s) => !dynamicSecretNames.has(s)).length;
  const secretsOnlyInDynamic = Array.from(dynamicSecretNames).filter((s) => !staticSecretNames.has(s)).length;

  const summary: ComparisonSummary = {
    secretCentric: {
      totalSecretsStatic: staticSecrets.length,
      totalSecretsDynamic: dynamicSecrets.length,
      totalUniqueSecrets: allSecretNames.size,
      secretsOnlyInStatic: secretsOnlyInStatic,
      secretsOnlyInDynamic: secretsOnlyInDynamic,
      secretsWithDifferentUsage: secretCentric.differencesBySecret.length,
      discrepancyPercentage:
        allSecretNames.size > 0 ? Math.round(((secretsOnlyInStatic + secretsOnlyInDynamic) / allSecretNames.size) * 100) : 0,
    },
    workloadCentric: {
      totalWorkloadsStatic: staticWorkloads.length,
      totalWorkloadsDynamic: dynamicWorkloads.length,
      totalUniqueWorkloads: allWorkloadKeys.size,
      workloadsOnlyInStatic: Array.from(staticWorkloadKeys).filter((k) => !dynamicWorkloadKeys.has(k)).length,
      workloadsOnlyInDynamic: Array.from(dynamicWorkloadKeys).filter((k) => !staticWorkloadKeys.has(k)).length,
      workloadsWithDifferentReferences: workloadCentric.differencesByWorkload.length,
    },
  };

  return {
    timestamp: new Date().toISOString(),
    environment,
    cluster,
    secretCentric,
    workloadCentric,
    summary,
  };
}

export function buildSecretComparisonReport(comparison: ComparisonResult): SecretComparisonReport {
  return {
    timestamp: comparison.timestamp,
    environment: comparison.environment,
    cluster: comparison.cluster,
    secretCentric: comparison.secretCentric,
  };
}

export function buildWorkloadComparisonReport(comparison: ComparisonResult): WorkloadComparisonReport {
  return {
    timestamp: comparison.timestamp,
    environment: comparison.environment,
    cluster: comparison.cluster,
    workloadCentric: comparison.workloadCentric,
  };
}

export function buildStatsComparisonReport(comparison: ComparisonResult): StatsComparisonReport {
  return {
    timestamp: comparison.timestamp,
    environment: comparison.environment,
    cluster: comparison.cluster,
    summary: comparison.summary,
  };
}

/**
 * Escape CSV values: handle quotes and line breaks
 */
function escapeCSV(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return value.replace(/"/g, '""');
  }
  return value;
}

function csvRow(values: Array<string | number>): string {
  return values.map((value) => `"${escapeCSV(String(value))}"`).join(',');
}

export function secretComparisonToCSV(report: SecretComparisonReport): string {
  const lines: string[] = [];

  lines.push(`# Secret Comparison Report`);
  lines.push(`# Environment: ${report.environment}`);
  lines.push(`# Cluster: ${report.cluster}`);
  lines.push(`# Generated: ${report.timestamp}`);
  lines.push('');

  lines.push(`## SECRETS MISSING IN REPO (Found in Cluster but not in Repo)`);
  lines.push(`secretName,secretNamespace,keys,usageInCluster`);
  report.secretCentric.missingInStatic.forEach((secret) => {
    lines.push(csvRow([secret.secretName, secret.secretNamespace, secret.keys.join(';'), secret.usageInCluster]));
  });
  lines.push('');

  lines.push(`## SECRETS MISSING IN CLUSTER (Found in Repo but not in Cluster)`);
  lines.push(`secretName,secretNamespace,keys,referencedInRepo`);
  report.secretCentric.missingInDynamic.forEach((secret) => {
    lines.push(csvRow([secret.secretName, secret.secretNamespace, secret.keys.join(';'), secret.referencedInRepo]));
  });
  lines.push('');

  lines.push(`## SECRETS WITH DIFFERENT USAGE`);
  lines.push(`secretName,secretNamespace,repoUsageCount (how many times the secret is referenced in the repo),clusterUsageCount (how many times the secret is referenced in the cluster),newInClusterCount (new references in cluster that are not in the repo),missingFromClusterCount (references in the repo that are not in the cluster)`);
  report.secretCentric.differencesBySecret.forEach((secret) => {
    lines.push(
      csvRow([
        secret.secretName,
        secret.secretNamespace,
        secret.staticUsageCount,
        secret.dynamicUsageCount,
        secret.newReferencesInCluster.length,
        secret.missingReferencesInCluster.length,
      ])
    );
  });
  lines.push('');

  lines.push(`## NEW REFERENCES IN CLUSTER`);
  lines.push(`secretName,referenceCount,references`);
  report.secretCentric.differencesBySecret.forEach((secret) => {
    if (secret.newReferencesInCluster.length > 0) {
      lines.push(csvRow([secret.secretName, secret.newReferencesInCluster.length, secret.newReferencesInCluster.join('\n')]));
    }
  });
  lines.push('');

  lines.push(`## MISSING REFERENCES IN CLUSTER`);
  lines.push(`secretName,referenceCount,references`);
  report.secretCentric.differencesBySecret.forEach((secret) => {
    if (secret.missingReferencesInCluster.length > 0) {
      lines.push(csvRow([secret.secretName, secret.missingReferencesInCluster.length, secret.missingReferencesInCluster.join('\n')]));
    }
  });

  return lines.join('\n');
}

export function workloadComparisonToCSV(report: WorkloadComparisonReport): string {
  const lines: string[] = [];

  lines.push(`# Workload Comparison Report`);
  lines.push(`# Environment: ${report.environment}`);
  lines.push(`# Cluster: ${report.cluster}`);
  lines.push(`# Generated: ${report.timestamp}`);
  lines.push('');

  lines.push(`## WORKLOADS MISSING IN REPO (Found in Cluster but not in Repo)`);
  lines.push(`workloadType,workloadName,workloadNamespace,containerName,containerType,secretReferences`);
  report.workloadCentric.missingInStatic.forEach((workload) => {
    lines.push(
      csvRow([
        workload.workloadType,
        workload.workloadName,
        workload.workloadNamespace,
        workload.containerName,
        workload.containerType,
        workload.secretReferences,
      ])
    );
  });
  lines.push('');

  lines.push(`## WORKLOADS MISSING IN CLUSTER (Found in Repo but not in Cluster)`);
  lines.push(`workloadType,workloadName,workloadNamespace,containerName,containerType,secretReferences`);
  report.workloadCentric.missingInDynamic.forEach((workload) => {
    lines.push(
      csvRow([
        workload.workloadType,
        workload.workloadName,
        workload.workloadNamespace,
        workload.containerName,
        workload.containerType,
        workload.secretReferences,
      ])
    );
  });
  lines.push('');

  lines.push(`## WORKLOADS WITH DIFFERENT REFERENCES`);
  lines.push(`workloadType,workloadName,workloadNamespace,containerName,staticRefCount,dynamicRefCount,newSecretsInCluster,missingSecretsInCluster`);
  report.workloadCentric.differencesByWorkload.forEach((workload) => {
    lines.push(
      csvRow([
        workload.workloadType,
        workload.workloadName,
        workload.workloadNamespace,
        workload.containerName,
        workload.staticRefCount,
        workload.dynamicRefCount,
        workload.newSecretsInCluster.join(';'),
        workload.missingSecretsInCluster.join(';'),
      ])
    );
  });

  return lines.join('\n');
}

export function statsComparisonToCSV(report: StatsComparisonReport): string {
  const lines: string[] = [];

  lines.push(`# Comparison Statistics Report`);
  lines.push(`# Environment: ${report.environment}`);
  lines.push(`# Cluster: ${report.cluster}`);
  lines.push(`# Generated: ${report.timestamp}`);
  lines.push('');

  lines.push(`section,metric,value`);
  lines.push(csvRow(['secretCentric', 'totalSecretsStatic', report.summary.secretCentric.totalSecretsStatic]));
  lines.push(csvRow(['secretCentric', 'totalSecretsDynamic', report.summary.secretCentric.totalSecretsDynamic]));
  lines.push(csvRow(['secretCentric', 'totalUniqueSecrets', report.summary.secretCentric.totalUniqueSecrets]));
  lines.push(csvRow(['secretCentric', 'secretsOnlyInStatic', report.summary.secretCentric.secretsOnlyInStatic]));
  lines.push(csvRow(['secretCentric', 'secretsOnlyInDynamic', report.summary.secretCentric.secretsOnlyInDynamic]));
  lines.push(csvRow(['secretCentric', 'secretsWithDifferentUsage', report.summary.secretCentric.secretsWithDifferentUsage]));
  lines.push(csvRow(['secretCentric', 'discrepancyPercentage', report.summary.secretCentric.discrepancyPercentage]));
  lines.push(csvRow(['workloadCentric', 'totalWorkloadsStatic', report.summary.workloadCentric.totalWorkloadsStatic]));
  lines.push(csvRow(['workloadCentric', 'totalWorkloadsDynamic', report.summary.workloadCentric.totalWorkloadsDynamic]));
  lines.push(csvRow(['workloadCentric', 'totalUniqueWorkloads', report.summary.workloadCentric.totalUniqueWorkloads]));
  lines.push(csvRow(['workloadCentric', 'workloadsOnlyInStatic', report.summary.workloadCentric.workloadsOnlyInStatic]));
  lines.push(csvRow(['workloadCentric', 'workloadsOnlyInDynamic', report.summary.workloadCentric.workloadsOnlyInDynamic]));
  lines.push(csvRow(['workloadCentric', 'workloadsWithDifferentReferences', report.summary.workloadCentric.workloadsWithDifferentReferences]));

  return lines.join('\n');
}
