/**
 * External Secrets Values Generator
 * 
 * Generates externalSecrets configuration for microservices and cronjobs by:
 * 1. Scanning repo values.yaml files for secret references
 * 2. Fetching AWS Secrets Manager annotations from live cluster
 * 3. Merging externalSecrets config into workload values.yaml files
 * 
 * Usage:
 *   npm run secret-references-external-secrets-generator -- \
 *     --env <environment> \
 *     --cluster <context> \
 *     --namespace <ns> \
 *     [--scope microservice|cronjob|both] \
 *     [--keep-old-refs true|false] \
 *     [--validate-helm true|false] \
 *     [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';
import { initializeK8sClient, verifyClusterAccess, fetchSecretsInventory } from './lib/k8s-client.js';
import { buildSecretInventory, formatInventoryForOutput } from './lib/k8s-inventory.js';
import { walkWorkloads, inventoryWorkload } from './lib/workload.js';
import { extractSecretReferencesFromCluster } from './lib/k8s-secret-extractor.js';
import {
  generateExternalSecretsFromWorkloads,
  buildClusterSecretsMap,
} from './lib/external-secrets-generator.js';
import { applyExternalSecretsToWorkload, createBackup } from './lib/values-yaml-patcher.js';
import type { ExternalSecretsGeneratorConfig, MigrationReport } from './lib/external-secrets-types.js';

/**
 * Parse command-line arguments
 */
function parseArgs(args: string[]): ExternalSecretsGeneratorConfig {
  const config: ExternalSecretsGeneratorConfig = {
    env: '',
    cluster: '',
    namespace: '',
    scope: 'both',
    keepOldRefs: false,
    validateHelm: true,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--env' && args[i + 1]) {
      config.env = args[++i];
    } else if (arg === '--cluster' && args[i + 1]) {
      config.cluster = args[++i];
    } else if (arg === '--namespace' && args[i + 1]) {
      config.namespace = args[++i];
    } else if (arg === '--scope' && args[i + 1]) {
      const scope = args[++i];
      if (scope === 'microservice' || scope === 'cronjob' || scope === 'both') {
        config.scope = scope;
      } else {
        throw new Error(`Invalid --scope value: ${scope}. Must be microservice|cronjob|both`);
      }
    } else if (arg === '--keep-old-refs' && args[i + 1]) {
      config.keepOldRefs = args[++i].toLowerCase() === 'true';
    } else if (arg === '--validate-helm' && args[i + 1]) {
      config.validateHelm = args[++i].toLowerCase() === 'true';
    } else if (arg === '--dry-run') {
      config.dryRun = true;
    } else if (arg === '--output-dir' && args[i + 1]) {
      config.outputDir = args[++i];
    }
  }

  if (!config.env) {
    throw new Error('Missing required argument: --env <environment>');
  }
  if (!config.cluster) {
    throw new Error('Missing required argument: --cluster <context>');
  }
  if (!config.namespace) {
    throw new Error('Missing required argument: --namespace <namespace>');
  }

  return config;
}

/**
 * Get cluster context from provided arguments
 */
function getClusterContext(cluster: string, namespace: string): { cluster: string; namespace: string } {
  return {
    cluster,
    namespace,
  };
}

/**
 * Load repo inventory for given environment and scope
 */
function loadRepoInventory(
  rootDir: string,
  env: string,
  scope: 'microservice' | 'cronjob' | 'both'
): Array<{ workload: any; component: string; records: any[] }> {
  const workloads = [];

  if (scope === 'microservice' || scope === 'both') {
    workloads.push(...walkWorkloads(rootDir, env, 'microservice'));
  }

  if (scope === 'cronjob' || scope === 'both') {
    workloads.push(...walkWorkloads(rootDir, env, 'cronjob'));
  }

  if (workloads.length === 0) {
    throw new Error(`No workloads found for environment "${env}" and scope "${scope}"`);
  }

  return workloads.map((workload) => ({
    workload,
    component: workload.component,
    records: inventoryWorkload(workload, rootDir, env),
  }));
}

/**
 * Extract K8s references from cluster and build inventory
 */
async function loadClusterInventory(clusterContext: string, namespace: string): Promise<any[]> {
  const client = initializeK8sClient(clusterContext, namespace);

  const isAccessible = await verifyClusterAccess(client);
  if (!isAccessible) {
    throw new Error(`Cannot access cluster context "${clusterContext}" namespace "${namespace}". Verify kubeconfig.`);
  }

  // Fetch secrets with their annotations
  const secretsMap = await fetchSecretsInventory(client);
  console.log(`   Fetched ${secretsMap.size} secrets from cluster`);

  // Extract secret references from workloads to understand which secrets are actually used
  const references = await extractSecretReferencesFromCluster(client);
  console.log(`   Found ${references.length} secret references from workloads`);

  // Build inventory with annotations and reference information
  const secretInventory = buildSecretInventory(secretsMap, references);
  
  // Debug: Log first few secrets to verify annotations are present
  if (secretInventory.length > 0) {
    const firstSecret = secretInventory[0];
    console.log(`   Sample secret "${firstSecret.secretName}": hasAwsSecretsManagerSecretId=${firstSecret.hasAwsSecretsManagerSecretId}, annotationCount=${Object.keys(firstSecret.annotations).length}`);
  }

  return secretInventory;
}

/**
 * Generate report for skipped secrets
 */
function generateSkippedSecretsReport(skipped: any[]): string {
  if (skipped.length === 0) {
    return '';
  }

  const grouped = new Map<string, any[]>();
  for (const item of skipped) {
    const key = `${item.workloadType}/${item.workloadName}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(item);
  }

  let report = '\n=== SKIPPED SECRETS (requiring manual review) ===\n';
  for (const [key, items] of grouped.entries()) {
    report += `\n${key}:\n`;
    for (const item of items) {
      report += `  - Secret: ${item.secretName}\n`;
      report += `    Reason: ${item.reason}\n`;
      report += `    Details: ${item.details}\n`;
    }
  }

  return report;
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  try {
    console.log('🚀 Starting External Secrets Values Generator...\n');

    const config = parseArgs(process.argv.slice(2));
    const rootDir = process.cwd();

    console.log(`📋 Configuration:`);
    console.log(`   Environment: ${config.env}`);
    console.log(`   Cluster: ${config.cluster || 'current-context'}`);
    console.log(`   Namespace: ${config.namespace || 'interop'}`);
    console.log(`   Scope: ${config.scope}`);
    console.log(`   Keep old refs: ${config.keepOldRefs}`);
    console.log(`   Validate Helm: ${config.validateHelm}`);
    console.log(`   Dry run: ${config.dryRun}\n`);

    // Load repo inventory
    console.log('📂 Scanning repository for secret references...');
    const repoInventoryData = loadRepoInventory(rootDir, config.env, config.scope);
    const allRepoRecords = repoInventoryData.flatMap((item) => item.records);
    console.log(`   Found ${allRepoRecords.length} secret references across ${repoInventoryData.length} workloads\n`);

    // Load cluster inventory
    console.log('🔗 Connecting to Kubernetes cluster...');
    const clusterContext = getClusterContext(config.cluster, config.namespace);
    const clusterInventory = await loadClusterInventory(clusterContext.cluster, clusterContext.namespace);
    console.log(`   Found ${clusterInventory.length} secrets in cluster\n`);

    // Generate externalSecrets configuration
    console.log('⚙️  Generating ExternalSecrets configuration...');
    const clusterSecretsMap = buildClusterSecretsMap(clusterInventory);
    console.log(`   Built cluster secrets map with ${clusterSecretsMap.size} entries`);
    
    // Debug: Count how many have AWS annotations
    let secretsWithAwsAnnotation = 0;
    for (const secret of clusterSecretsMap.values()) {
      if (secret.hasAwsSecretsManagerSecretId) {
        secretsWithAwsAnnotation++;
      }
    }
    console.log(`   Secrets with AWS annotation: ${secretsWithAwsAnnotation}/${clusterSecretsMap.size}`);
    
    const { generated, skipped } = generateExternalSecretsFromWorkloads(allRepoRecords, clusterSecretsMap);
    console.log(`   Generated ${generated.length} ExternalSecrets configurations`);
    console.log(`   Skipped ${skipped.length} secret references\n`);

    // Initialize externalSecrets in commons values files
    console.log('🔧 Initializing commons externalSecrets section...');
    const { initializeCommonsExternalSecrets } = await import('./lib/values-yaml-patcher.js');
    const commonsEnvPath = path.join(rootDir, 'commons', config.env);
    
    if (config.scope === 'microservice' || config.scope === 'both') {
      const microserviceCommonsPath = path.join(commonsEnvPath, 'values-microservice.yaml');
      const result = initializeCommonsExternalSecrets(microserviceCommonsPath, config.dryRun);
      if (result.success) {
        console.log(`   ✅ Initialized microservice commons`);
      } else {
        console.log(`   ⚠️  Could not initialize microservice commons: ${result.error}`);
      }
    }

    if (config.scope === 'cronjob' || config.scope === 'both') {
      const cronjobCommonsPath = path.join(commonsEnvPath, 'values-cronjob.yaml');
      const result = initializeCommonsExternalSecrets(cronjobCommonsPath, config.dryRun);
      if (result.success) {
        console.log(`   ✅ Initialized cronjob commons`);
      } else {
        console.log(`   ⚠️  Could not initialize cronjob commons: ${result.error}`);
      }
    }
    console.log('');

    // Apply configurations to values files
    console.log('💾 Applying configurations to values.yaml files...');
    const results = [];
    const errors = [];

    for (const externalSecret of generated) {
      try {
        // Find the corresponding workload
        const workloadItem = repoInventoryData.find(
          (item) => item.component === externalSecret.workloadName && item.workload.workloadType === externalSecret.workloadType
        );

        if (!workloadItem) {
          console.warn(
            `   ⚠️  Cannot find workload for ${externalSecret.workloadType}/${externalSecret.workloadName}`
          );
          continue;
        }

        // Determine which values file to update (prefer workload-specific)
        const valuesPath = workloadItem.workload.valueFiles.find((f: string) => !f.includes('commons')) || workloadItem.workload.valueFiles[0];

        if (!valuesPath) {
          console.warn(`   ⚠️  No values.yaml found for ${externalSecret.workloadName}`);
          continue;
        }

        // Create backup
        if (!config.dryRun) {
          createBackup(valuesPath);
        }

        // Determine container configs
        const containerConfig = externalSecret.containerType === 'container' ? externalSecret.externalSecretsConfig : undefined;
        const initContainerConfig = externalSecret.containerType === 'initContainer' ? externalSecret.externalSecretsConfig : undefined;

        // Apply to file
        const result = applyExternalSecretsToWorkload(
          valuesPath,
          containerConfig,
          initContainerConfig,
          !config.keepOldRefs, // keepOldRefs=true means do NOT remove; removeOldRefs is the inverse
          config.dryRun
        );

        if (result.success) {
          console.log(
            `   ✅ ${externalSecret.workloadType}/${externalSecret.workloadName} (${externalSecret.containerType})`
          );
        } else {
          console.log(
            `   ❌ ${externalSecret.workloadType}/${externalSecret.workloadName}: ${result.error}`
          );
          errors.push({
            workload: `${externalSecret.workloadType}/${externalSecret.workloadName}`,
            message: result.error || 'Unknown error',
          });
        }

        results.push(result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`   ❌ ${externalSecret.workloadName}: ${errMsg}`);
        errors.push({
          workload: externalSecret.workloadName,
          message: errMsg,
        });
      }
    }

    console.log('');

    // Generate report
    const report: MigrationReport = {
      environment: config.env,
      scope: config.scope,
      totalWorkloads: repoInventoryData.length,
      migratedWorkloads: results.filter((r) => r.success).length,
      skippedWorkloads: results.filter((r) => !r.success).length,
      totalSecretsProcessed: allRepoRecords.length,
      successfulMigrations: generated.length,
      skippedSecrets: skipped,
      errors,
      generatedExternalSecrets: generated,
    };

    // Print summary
    console.log('📊 Migration Summary:');
    console.log(`   Total workloads: ${report.totalWorkloads}`);
    console.log(`   Migrated: ${report.migratedWorkloads}`);
    console.log(`   Failed: ${report.skippedWorkloads}`);
    console.log(`   Total secret references: ${report.totalSecretsProcessed}`);
    console.log(`   ExternalSecrets created: ${report.successfulMigrations}`);
    console.log(`   Skipped secrets: ${skipped.length}`);

    if (skipped.length > 0) {
      console.log(generateSkippedSecretsReport(skipped));
    }

    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.forEach((err) => {
        console.log(`   ${err.workload}: ${err.message}`);
      });
    }

    // Save report
    if (!config.dryRun) {
      const reportPath = config.outputDir
        ? path.join(config.outputDir, `external-secrets-migration-${config.env}.json`)
        : path.join(rootDir, 'secret-inventory', `external-secrets-migration-${config.env}.json`);

      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\n💾 Report saved to: ${reportPath}`);
    }

    if (config.dryRun) {
      console.log('\n⚠️  DRY RUN MODE - No files were modified');
    }

    console.log('\n✨ External Secrets generation complete!');
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
