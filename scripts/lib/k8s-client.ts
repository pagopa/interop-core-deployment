/**
 * Kubernetes client initialization with kubeconfig support
 */

import { CoreV1Api, AppsV1Api, BatchV1Api, KubeConfig } from '@kubernetes/client-node';

export interface K8sClusterClient {
  coreApi: CoreV1Api;
  appsApi: AppsV1Api;
  batchApi: BatchV1Api;
  namespace: string;
}

/**
 * Load kubeconfig from default locations and create API clients
 */
export function initializeK8sClient(cluster: string, namespace: string): K8sClusterClient {
  const kc = new KubeConfig();
  
  try {
    kc.loadFromDefault();
  } catch (err) {
    throw new Error(`Failed to load kubeconfig: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    kc.setCurrentContext(cluster);
  } catch (err) {
    throw new Error(`Failed to set current context to '${cluster}': ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    coreApi: kc.makeApiClient(CoreV1Api),
    appsApi: kc.makeApiClient(AppsV1Api),
    batchApi: kc.makeApiClient(BatchV1Api),
    namespace,
  };
}

/**
 * Verify cluster connectivity and namespace access
 */
export async function verifyClusterAccess(client: K8sClusterClient): Promise<boolean> {
  try {
    await client.coreApi.readNamespace({ name: client.namespace });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Fetch all Secrets in the namespace (names and keys only, NOT values)
 */
export async function fetchSecretsInventory(
  client: K8sClusterClient
): Promise<Map<string, string[]>> {
  try {
    const response = await client.coreApi.listNamespacedSecret({ namespace: client.namespace });
    const secretMap = new Map<string, string[]>();

    response.items.forEach((secret: any) => {
      if (secret.metadata?.name && secret.data) {
        const keys = Object.keys(secret.data);
        secretMap.set(secret.metadata.name, keys);
      }
    });

    return secretMap;
  } catch (err) {
    throw new Error(`Failed to fetch secrets: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Helper to get container name from owner reference
 */
export function getContainerName(obj: any, containerIndex: number = 0): string {
  // For workloads, get from pod template spec
  const podSpec = obj.spec?.template?.spec || obj.spec;
  if (podSpec?.containers?.[containerIndex]?.name) {
    return podSpec.containers[containerIndex].name;
  }
  return `container-${containerIndex}`;
}
