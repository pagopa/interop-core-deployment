/**
 * Extract secret references from Kubernetes workload manifests
 * Supports: Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod
 */

import type { K8sSecretReference, WorkloadKind } from './k8s-types.js';
import type { K8sClusterClient } from './k8s-client.js';

/**
 * Extract secret references from all workload types in namespace
 */
export async function extractSecretReferencesFromCluster(
  client: K8sClusterClient
): Promise<K8sSecretReference[]> {
  const references: K8sSecretReference[] = [];

  // Fetch from Deployments
  try {
    const deployments = await client.appsApi.listNamespacedDeployment({ namespace: client.namespace });
    deployments.items.forEach((dep: any) => {
      const refs = extractFromPodSpecInternal(
        dep.metadata?.name || 'unknown',
        'Deployment',
        client.namespace,
        dep.spec?.template?.spec
      );
      references.push(...refs);
    });
  } catch (err) {
    console.error(`Failed to fetch Deployments: ${err}`);
  }

  // Fetch from StatefulSets
  try {
    const statefulSets = await client.appsApi.listNamespacedStatefulSet({ namespace: client.namespace });
    statefulSets.items.forEach((sts: any) => {
      const refs = extractFromPodSpecInternal(
        sts.metadata?.name || 'unknown',
        'StatefulSet',
        client.namespace,
        sts.spec?.template?.spec
      );
      references.push(...refs);
    });
  } catch (err) {
    console.error(`Failed to fetch StatefulSets: ${err}`);
  }

  // Fetch from DaemonSets
  try {
    const daemonSets = await client.appsApi.listNamespacedDaemonSet({ namespace: client.namespace });
    daemonSets.items.forEach((ds: any) => {
      const refs = extractFromPodSpecInternal(
        ds.metadata?.name || 'unknown',
        'DaemonSet',
        client.namespace,
        ds.spec?.template?.spec
      );
      references.push(...refs);
    });
  } catch (err) {
    console.error(`Failed to fetch DaemonSets: ${err}`);
  }

  // Fetch from Jobs
  try {
    const jobs = await client.batchApi.listNamespacedJob({ namespace: client.namespace });
    jobs.items.forEach((job: any) => {
      const refs = extractFromPodSpecInternal(
        job.metadata?.name || 'unknown',
        'Job',
        client.namespace,
        job.spec?.template?.spec
      );
      references.push(...refs);
    });
  } catch (err) {
    console.error(`Failed to fetch Jobs: ${err}`);
  }

  // Fetch from CronJobs
  try {
    const cronJobs = await client.batchApi.listNamespacedCronJob({ namespace: client.namespace });
    cronJobs.items.forEach((cronJob: any) => {
      const refs = extractFromPodSpecInternal(
        cronJob.metadata?.name || 'unknown',
        'CronJob',
        client.namespace,
        cronJob.spec?.jobTemplate?.spec?.template?.spec
      );
      references.push(...refs);
    });
  } catch (err) {
    console.error(`Failed to fetch CronJobs: ${err}`);
  }

  // Fetch from Pods (standalone, not owned by higher-level workload)
  try {
    const pods = await client.coreApi.listNamespacedPod({ namespace: client.namespace });
    pods.items.forEach((pod: any) => {
      // Only process pods without owner references (standalone)
      if (!pod.metadata?.ownerReferences || pod.metadata.ownerReferences.length === 0) {
        const refs = extractFromPodSpecInternal(
          pod.metadata?.name || 'unknown',
          'Pod',
          client.namespace,
          pod.spec
        );
        references.push(...refs);
      }
    });
  } catch (err) {
    console.error(`Failed to fetch Pods: ${err}`);
  }

  return references;
}

/**
 * Extract secret references from a PodSpec
 * Handles: env[].valueFrom.secretKeyRef, envFrom[].secretRef, volumes[].secret
 * Exported for testing
 */
export function extractFromPodSpecInternal(
  workloadName: string,
  workloadType: WorkloadKind,
  namespace: string,
  podSpec?: any
): K8sSecretReference[] {
  if (!podSpec) return [];

  const references: K8sSecretReference[] = [];

  // Process regular containers
  if (podSpec.containers) {
    podSpec.containers.forEach((container: any) => {
      references.push(...extractFromContainer(workloadName, workloadType, namespace, container, 'container'));
    });
  }

  // Process init containers
  if (podSpec.initContainers) {
    podSpec.initContainers.forEach((container: any) => {
      references.push(...extractFromContainer(workloadName, workloadType, namespace, container, 'initContainer'));
    });
  }

  // Process ephemeral containers
  if (podSpec.ephemeralContainers) {
    podSpec.ephemeralContainers.forEach((container: any) => {
      references.push(...extractFromContainer(workloadName, workloadType, namespace, container, 'ephemeralContainer'));
    });
  }

  // Extract from volumes (global pod spec level)
  if (podSpec.volumes) {
    podSpec.volumes.forEach((volume: any) => {
      if (volume.secret?.secretName) {
        references.push({
          workloadType,
          workloadName,
          workloadNamespace: namespace,
          containerName: 'pod-volume',
          containerType: 'pod-volume',
          referenceType: 'volumes.secret',
          secretName: volume.secret.secretName,
        });
      }
    });
  }

  return references;
}

/**
 * Extract secret references from a Container spec
 * Exported for testing
 */
export function extractFromContainer(
  workloadName: string,
  workloadType: WorkloadKind,
  namespace: string,
  container: any,
  containerType: 'container' | 'initContainer' | 'ephemeralContainer'
): K8sSecretReference[] {
  const references: K8sSecretReference[] = [];
  const containerName = container.name || 'unnamed';

  // env[].valueFrom.secretKeyRef
  if (container.env) {
    container.env.forEach((envVar: any) => {
      if (envVar.valueFrom?.secretKeyRef) {
        references.push({
          workloadType,
          workloadName,
          workloadNamespace: namespace,
          containerName,
          containerType,
          referenceType: 'env.secretKeyRef',
          secretName: envVar.valueFrom.secretKeyRef.name,
          secretKey: envVar.valueFrom.secretKeyRef.key,
        });
      }
    });
  }

  // envFrom[].secretRef
  if (container.envFrom) {
    container.envFrom.forEach((envFrom: any) => {
      if (envFrom.secretRef?.name) {
        references.push({
          workloadType,
          workloadName,
          workloadNamespace: namespace,
          containerName,
          containerType,
          referenceType: 'envFrom.secretRef',
          secretName: envFrom.secretRef.name,
        });
      }
    });
  }

  return references;
}
