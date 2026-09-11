/**
 * Kubernetes cluster secret references inventory
 *
 * Extracts secret references from all workloads in a given namespace
 * and builds an inventory of all secrets to identify unused ones.
 *
 * Usage:
 *   npm run secret-references-cluster-inventory -- --cluster prod --namespace dev
 *   npm run secret-references-cluster-inventory -- --cluster prod -n staging --format both
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseK8sArgs } from './lib/k8s-cli.js';
import { initializeK8sClient, verifyClusterAccess, fetchSecretsInventory } from './lib/k8s-client.js';
import { extractSecretReferencesFromCluster } from './lib/k8s-secret-extractor.js';
import {
  buildSecretInventory,
  formatInventoryForOutput,
  formatInventoryWorkloadCentric,
} from './lib/k8s-inventory.js';
import { csvEscape } from './lib/csv.js';
import type { SecretCentricOutputRecord, WorkloadCentricOutputRecord } from './lib/k8s-inventory.js';

interface InventoryOutputRecord {
  secretName: string;
  secretNamespace: string;
  keyCount: number;
  keys: string;
  isUnused: boolean;
  usageCount: number;
  usageList: string;
}

const SECRET_CENTRIC_COLUMNS = [
  'secretName',
  'secretNamespace',
  'keyCount',
  'keys',
  'annotationKeys',
  'hasAwsSecretsManagerSecretId',
  'hasAwsSecretsManagerVersionId',
  'hasUpdatedAt',
  'hasAnyManagedAnnotation',
  'hasNoManagedAnnotations',
  'managedAnnotationStatus',
  'isUnused',
  'usageCount',
  'usageList',
  'referencedWithoutManagedAnnotations',
];
const WORKLOAD_CENTRIC_COLUMNS = [
  'workloadType',
  'workloadName',
  'workloadNamespace',
  'containerName',
  'containerType',
  'referenceType',
  'secretName',
  'secretKey',
  'secretManagedAnnotationStatus',
  'secretHasAwsSecretsManagerSecretId',
  'secretHasNoManagedAnnotations',
  'referencedSecretWithoutManagedAnnotations',
];

/**
 * Main execution
 */
async function main(): Promise<void> {
  try {
    const args = parseK8sArgs(process.argv.slice(2));
    const client = initializeK8sClient(args.cluster, args.namespace);

    
    // Verify cluster access
    const hasAccess = await verifyClusterAccess(client);
    if (!hasAccess) {
      throw new Error(`Cannot access namespace "${args.namespace}". Verify kubeconfig and permissions.`);
    }

    console.log(`Connecting to cluster namespace "${args.namespace}"...`);

    // Fetch all secrets inventory
    console.log('Fetching Secret inventory...');
    const secretsMap = await fetchSecretsInventory(client);
    console.log(`Found ${secretsMap.size} secrets.`);

    // Extract secret references from workloads
    console.log('Extracting secret references from workloads...');
    const references = await extractSecretReferencesFromCluster(client);
    console.log(`Found ${references.length} secret references.`);

    // Build inventory
    const inventory = buildSecretInventory(secretsMap, references);
    const unusedCount = inventory.filter((r) => r.isUnused).length;
    const withAwsSecretIdCount = inventory.filter((r) => r.hasAwsSecretsManagerSecretId).length;
    const withoutManagedAnnotationsCount = inventory.filter((r) => r.hasNoManagedAnnotations).length;
    const referencedWithoutManagedAnnotations = inventory.filter((r) => r.referencedWithoutManagedAnnotations);
    console.log(`Secret inventory built: ${inventory.length} secrets, ${unusedCount} unused.`);
    console.log(`Secrets with ${'infra.interop.pagopa.it/aws-secretsmanager-secret-id'}: ${withAwsSecretIdCount}.`);
    console.log(`Secrets without managed annotations: ${withoutManagedAnnotationsCount}.`);
    console.log(`Referenced secrets without managed annotations: ${referencedWithoutManagedAnnotations.length}.`);

    // Format for outputs
    const secretCentricRecords = formatInventoryForOutput(inventory, args.namespace);
    const workloadCentricRecords = formatInventoryWorkloadCentric(references, args.namespace, inventory);

    // Create output directory
    const outputDir = args.outputDir || 'secret-inventory';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write secret-centric outputs
    if (args.format === 'csv' || args.format === 'both') {
      const csvFile = path.join(outputDir, `secret-inventory-cluster-secrets-${args.namespace}.csv`);
      const csvHeader = SECRET_CENTRIC_COLUMNS.join(',');
      const csvRows = secretCentricRecords.map((record) =>
        SECRET_CENTRIC_COLUMNS.map((col) => csvEscape(String(record[col as keyof SecretCentricOutputRecord] || ''))).join(',')
      );
      const csvContent = [csvHeader, ...csvRows].join('\n');
      fs.writeFileSync(csvFile, csvContent, 'utf-8');
      console.log(`Wrote secret-centric view: ${csvFile}`);
    }

    if (args.format === 'json' || args.format === 'both') {
      const jsonFile = path.join(outputDir, `secret-inventory-cluster-secrets-${args.namespace}.json`);
      fs.writeFileSync(jsonFile, JSON.stringify(secretCentricRecords, null, 2), 'utf-8');
      console.log(`Wrote secret-centric view: ${jsonFile}`);
    }

    // Write workload-centric outputs
    if (args.format === 'csv' || args.format === 'both') {
      const csvFile = path.join(outputDir, `secret-inventory-cluster-workloads-${args.namespace}.csv`);
      const csvHeader = WORKLOAD_CENTRIC_COLUMNS.join(',');
      const csvRows = workloadCentricRecords.map((record) =>
        WORKLOAD_CENTRIC_COLUMNS.map((col) => csvEscape(String(record[col as keyof WorkloadCentricOutputRecord] || ''))).join(',')
      );
      const csvContent = [csvHeader, ...csvRows].join('\n');
      fs.writeFileSync(csvFile, csvContent, 'utf-8');
      console.log(`Wrote workload-centric view: ${csvFile}`);
    }

    if (args.format === 'json' || args.format === 'both') {
      const jsonFile = path.join(outputDir, `secret-inventory-cluster-workloads-${args.namespace}.json`);
      fs.writeFileSync(jsonFile, JSON.stringify(workloadCentricRecords, null, 2), 'utf-8');
      console.log(`Wrote workload-centric view: ${jsonFile}`);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Guard: only execute if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Export for testing
export { main };
