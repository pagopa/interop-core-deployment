/**
 * Comparison script: repo vs cluster secret extraction
 *
 * Usage:
 *   npm run secret-references-compare -- --env dev --cluster <cluster-arn>
 *   npm run secret-references-compare -- -e staging -c arn:aws:eks:region:account:cluster/name --output-dir /tmp/reports
 *
 * Process:
 * 1. Run repo inventory (repo analysis) -> produces raw secret-references-repo-{env}.json
 * 2. Run cluster inventory (cluster analysis) -> produces aggregated secret-inventory-cluster-{secrets|workloads}-{namespace}.json
 * 3. Transform repo raw data to aggregated format
 * 4. Compare aggregated data
 * 5. Generate JSON and CSV reports
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  aggregateRepoDataToSecretCentric,
  aggregateRepoDataToWorkloadCentric,
  buildComparisonResult,
  buildSecretComparisonReport,
  buildWorkloadComparisonReport,
  buildStatsComparisonReport,
  secretComparisonToCSV,
  workloadComparisonToCSV,
  statsComparisonToCSV,
} from './lib/secret-references-compare.js';
import type { SecretReferenceRecord } from './lib/types.js';

interface ComparisonArgs {
  env: string;
  cluster: string;
  outputDir: string;
}

function parseComparisonArgs(args: string[]): ComparisonArgs {
  const result: Partial<ComparisonArgs> = {
    env: undefined,
    cluster: undefined,
    outputDir: 'secret-inventory',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--env' || arg === '-e') {
      result.env = args[++i];
    } else if (arg === '--cluster' || arg === '-c') {
      result.cluster = args[++i];
    } else if (arg === '--output-dir' || arg === '-o') {
      result.outputDir = args[++i];
    }
  }

  if (!result.env) {
    throw new Error('Missing required parameter: --env/-e');
  }
  if (!result.cluster) {
    throw new Error('Missing required parameter: --cluster/-c');
  }

  return result as ComparisonArgs;
}

async function main(): Promise<void> {
  const args = parseComparisonArgs(process.argv.slice(2));

  console.log(`\n Starting Secret References Comparison`);
  console.log(`   Environment: ${args.env}`);
  console.log(`   Cluster: ${args.cluster}`);
  console.log(`   Output Directory: ${args.outputDir}\n`);

  const outputDir = path.isAbsolute(args.outputDir) ? args.outputDir : path.join(process.cwd(), args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  // Run repo inventory (repo analysis)
  console.log(' Running repo inventory (repo analysis)...');
  try {
    execSync(`npm run secret-references-repo-inventory -- --env ${args.env} --format json --output-dir "${outputDir}"`, {
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error(`Repo inventory failed: ${error}`);
  }

  // Load repo raw data
  const repoFile = path.join(outputDir, `secret-references-repo-${args.env}.json`);
  if (!fs.existsSync(repoFile)) {
    throw new Error(`Repo inventory output not found: ${repoFile}`);
  }
  const repoRawData = JSON.parse(fs.readFileSync(repoFile, 'utf-8')) as SecretReferenceRecord[];
  console.log(`✓ Loaded ${repoRawData.length} repo records (raw)`);

  // Transform repo data to aggregated format
  console.log(' Transforming repo data to aggregated format...');
  const repoSecretCentric = aggregateRepoDataToSecretCentric(repoRawData);
  const repoWorkloadCentric = aggregateRepoDataToWorkloadCentric(repoRawData);
  console.log(`✓ Aggregated to ${repoSecretCentric.length} secrets and ${repoWorkloadCentric.length} workload references`);

  // Run cluster inventory (cluster analysis)
  console.log('\n Running cluster inventory (cluster analysis)...');
  try {
    execSync(`npm run secret-references-cluster-inventory -- --cluster "${args.cluster}" --namespace ${args.env} --format json --output-dir "${outputDir}"`, {
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error(`Cluster inventory failed: ${error}`);
  }

  // Load cluster aggregated data
  const clusterSecretsFile = path.join(outputDir, `secret-inventory-cluster-secrets-${args.env}.json`);
  const clusterWorkloadsFile = path.join(outputDir, `secret-inventory-cluster-workloads-${args.env}.json`);

  if (!fs.existsSync(clusterSecretsFile) || !fs.existsSync(clusterWorkloadsFile)) {
    throw new Error(`Cluster inventory output files not found at ${clusterSecretsFile} or ${clusterWorkloadsFile}`);
  }

  const clusterSecretCentric = JSON.parse(fs.readFileSync(clusterSecretsFile, 'utf-8'));
  const clusterWorkloadCentric = JSON.parse(fs.readFileSync(clusterWorkloadsFile, 'utf-8'));
  console.log(`✓ Loaded ${clusterSecretCentric.length} cluster secrets and ${clusterWorkloadCentric.length} cluster workload references`);

  // Compare aggregated data
  console.log('\n Comparing aggregated data...');

  // Build detailed comparison result
  const result = buildComparisonResult(
    args.env,
    args.cluster,
    repoSecretCentric,
    clusterSecretCentric,
    repoWorkloadCentric,
    clusterWorkloadCentric
  );
  console.log(`✓ Comparison complete`);

  // Write outputs
  console.log('\n Writing reports...');
  const clusterName = path.basename(args.cluster);
  const secretReport = buildSecretComparisonReport(result);
  const workloadReport = buildWorkloadComparisonReport(result);
  const statsReport = buildStatsComparisonReport(result);

  const reports = [
    {
      name: 'secrets',
      json: secretReport,
      csv: secretComparisonToCSV(secretReport),
    },
    {
      name: 'workloads',
      json: workloadReport,
      csv: workloadComparisonToCSV(workloadReport),
    },
    {
      name: 'stats',
      json: statsReport,
      csv: statsComparisonToCSV(statsReport),
    },
  ];

  reports.forEach((report) => {
    const jsonReportFile = path.join(outputDir, `secret-inventory-compare-${report.name}-${args.env}-${clusterName}.json`);
    fs.writeFileSync(jsonReportFile, JSON.stringify(report.json, null, 2), 'utf-8');
    console.log(`✓ Wrote ${report.name} JSON report: ${jsonReportFile}`);

    const csvReportFile = path.join(outputDir, `secret-inventory-compare-${report.name}-${args.env}-${clusterName}.csv`);
    fs.writeFileSync(csvReportFile, report.csv, 'utf-8');
    console.log(`✓ Wrote ${report.name} CSV report: ${csvReportFile}`);
  });

  // Print summary
  console.log('\nSummary:');
  console.log(`   Secrets missing in repo (only in cluster): ${result.summary.secretCentric.secretsOnlyInStatic}`);
  console.log(`   Secrets missing in cluster (only in repo): ${result.summary.secretCentric.secretsOnlyInDynamic}`);
  console.log(`   Secrets with different usage: ${result.summary.secretCentric.secretsWithDifferentUsage}`);
  console.log(`\n   Workloads missing in repo (Found in Cluster but not in Repo): ${result.summary.workloadCentric.workloadsOnlyInStatic}`);
  console.log(`   Workloads missing in cluster (Found in Repo but not in Cluster): ${result.summary.workloadCentric.workloadsOnlyInDynamic}`);
  console.log(`   Workloads with different references (Found in both Cluster and Repo but with different references): ${result.summary.workloadCentric.workloadsWithDifferentReferences}`);

}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  });
}
