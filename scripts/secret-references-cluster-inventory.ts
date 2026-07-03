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
  deduplicateReferences,
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

const SECRET_CENTRIC_COLUMNS = ['secretName', 'secretNamespace', 'keyCount', 'keys', 'isUnused', 'usageCount', 'usageList'];
const WORKLOAD_CENTRIC_COLUMNS = ['workloadType', 'workloadName', 'workloadNamespace', 'containerName', 'containerType', 'referenceType', 'secretName', 'secretKey'];

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
    const rawReferences = await extractSecretReferencesFromCluster(client);
    console.log(`Found ${rawReferences.length} secret references (before dedup).`);

    // Deduplicate
    const references = deduplicateReferences(rawReferences);
    console.log(`Found ${references.length} unique secret references.`);

    // Build inventory
    const inventory = buildSecretInventory(secretsMap, references);
    const unusedCount = inventory.filter((r) => r.isUnused).length;
    console.log(`Secret inventory built: ${inventory.length} secrets, ${unusedCount} unused.`);

    // Format for outputs
    const secretCentricRecords = formatInventoryForOutput(inventory, args.namespace);
    const workloadCentricRecords = formatInventoryWorkloadCentric(references, args.namespace);

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
