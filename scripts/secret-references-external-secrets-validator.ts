/**
 * External Secrets Migration Validator
 *
 * Validates the output of secret-references-external-secrets-generator by verifying:
 *
 * 1. YAML PRESENCE      – externalSecrets.container / initContainer section exists in every
 *                          target values.yaml that was reported as migrated
 * 2. KEY COVERAGE       – every (secretName, secretKey) pair from the original repo inventory
 *                          appears as a secretKey in the generated ExternalSecret data
 * 3. CLUSTER COHERENCE  – every secretKey referenced in the repo inventory is actually present
 *                          in the cluster secret's known keys (from the cluster inventory)
 * 4. WORKLOAD COVERAGE  – no workload with secret references in the repo inventory was silently
 *                          omitted from the migration (neither generated nor skipped)
 *
 * Usage:
 *   npm run secret-references-external-secrets-validator -- --env dev
 *   npm run secret-references-external-secrets-validator -- --env dev --scope microservice
 *   npm run secret-references-external-secrets-validator -- --env dev \
 *     --migration-report ./secret-inventory/external-secrets-migration-dev.json \
 *     --repo-inventory ./secret-inventory/secret-references-repo-dev.json \
 *     --cluster-inventory ./secret-inventory/secret-inventory-cluster-secrets-dev.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { csvEscape } from './lib/csv.js';
import type { GeneratedExternalSecret, MigrationReport, SkippedSecret } from './lib/external-secrets-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContainerType = 'container' | 'initContainer';
type CheckType =
  | 'yaml-presence'
  | 'key-coverage'
  | 'cluster-coherence'
  | 'workload-coverage';
type Severity = 'error' | 'warning' | 'info';

interface ValidationIssue {
  workloadType: string;
  workloadName: string;
  containerType: ContainerType | 'n/a';
  checkType: CheckType;
  severity: Severity;
  message: string;
  details?: string;
}

interface WorkloadCheckResult {
  workloadType: string;
  workloadName: string;
  containerType: ContainerType;
  status: 'PASSED' | 'ERROR' | 'WARNING';
  message?: string;
}

interface ValidationReport {
  environment: string;
  scope: string;
  totalWorkloadsChecked: number;
  totalChecks: number;
  passed: number;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  workloadResults: WorkloadCheckResult[];
}

// Repo inventory record (from secret-references-repo-{env}.json)
interface RepoRecord {
  environment: string;
  workloadType: string;
  component: string;
  sourceFile: string;
  yamlPath: string;
  containerPath: string;
  referenceType: string;
  envVar: string;
  secretName: string;
  secretKey: string;
}

// Cluster secret record (from secret-inventory-cluster-secrets-{env}.json)
interface ClusterSecretRecord {
  secretName: string;
  keys: string; // semicolon-delimited
  hasAwsSecretsManagerSecretId: boolean;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ValidatorArgs {
  env: string;
  scope: 'microservice' | 'cronjob' | 'both';
  migrationReportPath: string;
  repoInventoryPath: string;
  clusterInventoryPath: string;
  outputDir: string;
  rootDir: string;
}

function parseArgs(argv: string[]): ValidatorArgs {
  let env = '';
  let scope: ValidatorArgs['scope'] = 'both';
  let migrationReportPath = '';
  let repoInventoryPath = '';
  let clusterInventoryPath = '';
  let outputDir = '';

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--env':
        env = argv[++i];
        break;
      case '--scope':
        scope = argv[++i] as ValidatorArgs['scope'];
        break;
      case '--migration-report':
        migrationReportPath = argv[++i];
        break;
      case '--repo-inventory':
        repoInventoryPath = argv[++i];
        break;
      case '--cluster-inventory':
        clusterInventoryPath = argv[++i];
        break;
      case '--output-dir':
        outputDir = argv[++i];
        break;
    }
  }

  if (!env) {
    throw new Error('Missing required parameter: --env');
  }

  const rootDir = process.cwd();
  const inventoryDir = path.join(rootDir, 'secret-inventory');

  return {
    env,
    scope,
    migrationReportPath: migrationReportPath || path.join(inventoryDir, `external-secrets-migration-${env}.json`),
    repoInventoryPath: repoInventoryPath || path.join(inventoryDir, `secret-references-repo-${env}.json`),
    clusterInventoryPath: clusterInventoryPath || path.join(inventoryDir, `secret-inventory-cluster-secrets-${env}.json`),
    outputDir: outputDir || inventoryDir,
    rootDir,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive container type the same way the generator does */
function deriveContainerType(record: RepoRecord): ContainerType {
  const lower = (record.containerPath ?? record.yamlPath ?? '').toLowerCase();
  return lower.includes('initcontainer') ? 'initContainer' : 'container';
}

/** Group repo records by (workloadName, containerType) */
function groupRepoRecords(
  records: RepoRecord[],
  scope: ValidatorArgs['scope']
): Map<string, { workloadType: string; workloadName: string; containerType: ContainerType; sourceFile: string; secretKeys: Map<string, Set<string>> }> {
  const map = new Map<string, ReturnType<typeof groupRepoRecords> extends Map<string, infer V> ? V : never>();

  for (const record of records) {
    if (!record.secretKey) continue; // envFromSecrets with no resolved key – skip
    if (scope !== 'both' && record.workloadType !== scope) continue;

    const containerType = deriveContainerType(record);
    const groupKey = `${record.workloadType}/${record.component}/${containerType}`;

    if (!map.has(groupKey)) {
      map.set(groupKey, {
        workloadType: record.workloadType,
        workloadName: record.component,
        containerType,
        sourceFile: record.sourceFile,
        secretKeys: new Map(),
      });
    }

    const group = map.get(groupKey)!;
    if (!group.secretKeys.has(record.secretName)) {
      group.secretKeys.set(record.secretName, new Set());
    }
    group.secretKeys.get(record.secretName)!.add(record.secretKey);
  }

  return map;
}

/** Read values.yaml and extract the externalSecrets section */
function readExternalSecretsFromFile(
  filePath: string
): { container?: any; initContainer?: any } | null {
  if (!fs.existsSync(filePath)) return null;
  const values = parseYaml(fs.readFileSync(filePath, 'utf-8')) as any;
  return values?.externalSecrets ?? null;
}

/** Get all secretKeys from an ExternalSecrets config data array */
function getDataSecretKeys(config: GeneratedExternalSecret['externalSecretsConfig'] | null): Set<string> {
  if (!config?.data) return new Set();
  return new Set(config.data.map((d) => d.secretKey));
}

// ---------------------------------------------------------------------------
// Validation checks
// ---------------------------------------------------------------------------

function checkYamlPresence(
  gen: GeneratedExternalSecret,
  rootDir: string
): ValidationIssue | null {
  const absPath = path.join(rootDir, gen.workloadPath);
  const externalSecrets = readExternalSecretsFromFile(absPath);

  if (externalSecrets === null) {
    return {
      workloadType: gen.workloadType,
      workloadName: gen.workloadName,
      containerType: gen.containerType,
      checkType: 'yaml-presence',
      severity: 'error',
      message: `externalSecrets section is missing in ${gen.workloadPath}`,
      details: `File may not have been written (dry-run?) or path is wrong`,
    };
  }

  const section = gen.containerType === 'container' ? externalSecrets.container : externalSecrets.initContainer;
  if (!section) {
    return {
      workloadType: gen.workloadType,
      workloadName: gen.workloadName,
      containerType: gen.containerType,
      checkType: 'yaml-presence',
      severity: 'error',
      message: `externalSecrets.${gen.containerType} section is missing in ${gen.workloadPath}`,
    };
  }

  if (!Array.isArray(section.data) || section.data.length === 0) {
    return {
      workloadType: gen.workloadType,
      workloadName: gen.workloadName,
      containerType: gen.containerType,
      checkType: 'yaml-presence',
      severity: 'error',
      message: `externalSecrets.${gen.containerType}.data is empty in ${gen.workloadPath}`,
    };
  }

  return null; // pass
}

function checkKeyCoverage(
  workloadType: string,
  workloadName: string,
  containerType: ContainerType,
  expectedSecretKeys: Map<string, Set<string>>, // secretName → secretKeys
  actualDataKeys: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [secretName, keys] of expectedSecretKeys) {
    for (const key of keys) {
      if (!actualDataKeys.has(key)) {
        issues.push({
          workloadType,
          workloadName,
          containerType,
          checkType: 'key-coverage',
          severity: 'error',
          message: `Secret key "${key}" from K8s secret "${secretName}" is not covered in externalSecrets.${containerType}.data`,
          details: `Expected secretKey "${key}" to appear in ExternalSecret data entries`,
        });
      }
    }
  }

  return issues;
}

function checkClusterCoherence(
  workloadType: string,
  workloadName: string,
  containerType: ContainerType,
  expectedSecretKeys: Map<string, Set<string>>, // secretName → secretKeys
  clusterSecretsMap: Map<string, Set<string>>   // secretName → available keys in cluster
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [secretName, keys] of expectedSecretKeys) {
    const clusterKeys = clusterSecretsMap.get(secretName);

    if (!clusterKeys) {
      issues.push({
        workloadType,
        workloadName,
        containerType,
        checkType: 'cluster-coherence',
        severity: 'warning',
        message: `K8s secret "${secretName}" not found in cluster inventory`,
        details: `Cannot verify key existence without cluster data for secret "${secretName}"`,
      });
      continue;
    }

    for (const key of keys) {
      if (!clusterKeys.has(key)) {
        issues.push({
          workloadType,
          workloadName,
          containerType,
          checkType: 'cluster-coherence',
          severity: 'warning',
          message: `Key "${key}" from repo reference to secret "${secretName}" is not in cluster secret keys`,
          details: `Cluster secret "${secretName}" has keys: ${Array.from(clusterKeys).join(', ')}`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const CSV_COLUMNS_ISSUES = [
  'workloadType',
  'workloadName',
  'containerType',
  'checkType',
  'severity',
  'message',
  'details',
] as const;

const CSV_COLUMNS_SUMMARY = [
  'workloadType',
  'workloadName',
  'containerType',
  'status',
  'message',
] as const;

function writeReports(report: ValidationReport, outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = `external-secrets-validation-${report.environment}`;

  // JSON
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`   Saved JSON : ${jsonPath}`);

  // CSV (if issues exist, show issues; otherwise show summary of all workloads)
  const csvPath = path.join(outputDir, `${baseName}.csv`);
  let csvContent: string;

  if (report.issues.length > 0) {
    // Issues mode: detailed issues
    const header = CSV_COLUMNS_ISSUES.join(',');
    const rows = report.issues.map((issue) =>
      CSV_COLUMNS_ISSUES.map((col) => csvEscape(String((issue as any)[col] ?? ''))).join(',')
    );
    csvContent = [header, ...rows].join('\n');
  } else {
    // Success mode: summary of all workloads
    const header = CSV_COLUMNS_SUMMARY.join(',');
    const rows = report.workloadResults.map((result) =>
      CSV_COLUMNS_SUMMARY.map((col) => csvEscape(String((result as any)[col] ?? ''))).join(',')
    );
    csvContent = [header, ...rows].join('\n');
  }

  fs.writeFileSync(csvPath, csvContent);
  console.log(`   Saved CSV  : ${csvPath} (${csvContent.split('\n').length - 1} data rows)`);
}

function printSummary(report: ValidationReport, issues: ValidationIssue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  console.log(`\n${'='.repeat(60)}`);
  console.log('📋 VALIDATION SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`   Environment   : ${report.environment}`);
  console.log(`   Scope         : ${report.scope}`);
  console.log(`   Workloads     : ${report.totalWorkloadsChecked}`);
  console.log(`   Total checks  : ${report.totalChecks}`);
  console.log(`   ✅ Passed      : ${report.passed}`);
  console.log(`   ❌ Errors      : ${report.errors}`);
  console.log(`   ⚠️  Warnings    : ${report.warnings}`);

  if (errors.length > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('❌ ERRORS:');
    for (const e of errors) {
      console.log(`\n  [${e.workloadType}/${e.workloadName}] (${e.containerType}) — ${e.checkType}`);
      console.log(`    ${e.message}`);
      if (e.details) console.log(`    → ${e.details}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log('⚠️  WARNINGS:');
    for (const w of warnings) {
      console.log(`\n  [${w.workloadType}/${w.workloadName}] (${w.containerType}) — ${w.checkType}`);
      console.log(`    ${w.message}`);
      if (w.details) console.log(`    → ${w.details}`);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n✨ All checks passed!');
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🔍 External Secrets Migration Validator\n');

  const args = parseArgs(process.argv.slice(2));

  // ── Load inputs ────────────────────────────────────────────────────────────

  console.log('📂 Loading input files...');

  if (!fs.existsSync(args.migrationReportPath)) {
    throw new Error(`Migration report not found: ${args.migrationReportPath}\nRun secret-references-external-secrets-generator first.`);
  }
  if (!fs.existsSync(args.repoInventoryPath)) {
    throw new Error(`Repo inventory not found: ${args.repoInventoryPath}\nRun secret-references-repo-inventory first.`);
  }
  if (!fs.existsSync(args.clusterInventoryPath)) {
    throw new Error(`Cluster inventory not found: ${args.clusterInventoryPath}\nRun secret-references-cluster-inventory first.`);
  }

  const migrationReport: MigrationReport = JSON.parse(fs.readFileSync(args.migrationReportPath, 'utf-8'));
  const repoRecords: RepoRecord[] = JSON.parse(fs.readFileSync(args.repoInventoryPath, 'utf-8'));
  const clusterSecretRecords: ClusterSecretRecord[] = JSON.parse(fs.readFileSync(args.clusterInventoryPath, 'utf-8'));

  console.log(`   Migration report  : ${migrationReport.generatedExternalSecrets.length} generated ExternalSecrets`);
  console.log(`   Repo inventory    : ${repoRecords.length} secret references`);
  console.log(`   Cluster inventory : ${clusterSecretRecords.length} secrets\n`);

  // ── Build lookup maps ──────────────────────────────────────────────────────

  // generated ExternalSecrets indexed by (workloadName, containerType)
  const generatedMap = new Map<string, GeneratedExternalSecret>();
  for (const gen of migrationReport.generatedExternalSecrets) {
    const key = `${gen.workloadType}/${gen.workloadName}/${gen.containerType}`;
    generatedMap.set(key, gen);
  }

  // skipped secrets indexed by workload key
  const skippedWorkloads = new Set<string>();
  for (const skip of (migrationReport.skippedSecrets ?? [])) {
    skippedWorkloads.add(`${skip.workloadType}/${skip.workloadName}`);
  }

  // cluster secrets: secretName → Set<key>
  const clusterSecretsMap = new Map<string, Set<string>>();
  for (const rec of clusterSecretRecords) {
    if (rec.keys) {
      clusterSecretsMap.set(rec.secretName, new Set(rec.keys.split(';').filter(Boolean)));
    }
  }

  // repo records grouped by (workloadName, containerType)
  const effectiveScope = args.scope !== 'both' ? args.scope : migrationReport.scope as ValidatorArgs['scope'];
  const repoGroups = groupRepoRecords(repoRecords, effectiveScope !== 'both' ? effectiveScope : 'both');

  // ── Run validations ────────────────────────────────────────────────────────

  console.log('🔎 Running validation checks...\n');

  const allIssues: ValidationIssue[] = [];
  const workloadResults: WorkloadCheckResult[] = [];
  let totalChecks = 0;
  const checkedWorkloads = new Set<string>();

  for (const [groupKey, group] of repoGroups) {
    const { workloadType, workloadName, containerType, secretKeys } = group;
    checkedWorkloads.add(`${workloadType}/${workloadName}/${containerType}`);
    const gen = generatedMap.get(groupKey);

    let workloadStatus: 'PASSED' | 'ERROR' | 'WARNING' = 'PASSED';
    let workloadMessage = '';

    // ── Check 4: workload coverage ──────────────────────────────────────────
    totalChecks++;
    if (!gen) {
      const workloadKey = `${workloadType}/${workloadName}`;
      const inSkipped = skippedWorkloads.has(workloadKey);
      workloadStatus = inSkipped ? 'WARNING' : 'ERROR';
      workloadMessage = inSkipped
        ? `Workload was not migrated (in skipped list)`
        : `Workload has ${[...secretKeys.values()].reduce((s, ks) => s + ks.size, 0)} repo secret references but no ExternalSecret was generated`;
      allIssues.push({
        workloadType,
        workloadName,
        containerType,
        checkType: 'workload-coverage',
        severity: inSkipped ? 'info' : 'error',
        message: workloadMessage,
      });
      workloadResults.push({ workloadType, workloadName, containerType, status: workloadStatus, message: workloadMessage });
      continue;
    }

    // ── Check 1: values.yaml presence ──────────────────────────────────────
    totalChecks++;
    const presenceIssue = checkYamlPresence(gen, args.rootDir);
    if (presenceIssue) {
      allIssues.push(presenceIssue);
      workloadStatus = 'ERROR';
      workloadMessage = presenceIssue.message;
    }

    // Get actual keys from values.yaml on disk (authoritative source)
    const absPath = path.join(args.rootDir, gen.workloadPath);
    const externalSecrets = readExternalSecretsFromFile(absPath);
    const actualSection = externalSecrets?.[gen.containerType];
    const actualKeys = actualSection?.data
      ? new Set<string>(actualSection.data.map((d: any) => String(d.secretKey)))
      : getDataSecretKeys(gen.externalSecretsConfig);

    // ── Check 2: key coverage ──────────────────────────────────────────────
    totalChecks++;
    const coverageIssues = checkKeyCoverage(workloadType, workloadName, containerType, secretKeys, actualKeys);
    allIssues.push(...coverageIssues);
    if (coverageIssues.length > 0) {
      workloadStatus = 'ERROR';
      if (!workloadMessage) workloadMessage = coverageIssues[0].message;
    }

    // ── Check 3: cluster coherence ─────────────────────────────────────────
    totalChecks++;
    const coherenceIssues = checkClusterCoherence(workloadType, workloadName, containerType, secretKeys, clusterSecretsMap);
    allIssues.push(...coherenceIssues);
    if (coherenceIssues.length > 0) {
      workloadStatus = 'ERROR';
      if (!workloadMessage) workloadMessage = coherenceIssues[0].message;
    }

    // Record workload result
    workloadResults.push({ workloadType, workloadName, containerType, status: workloadStatus, message: workloadMessage });
  }

  // ── Build report ───────────────────────────────────────────────────────────

  const errorCount = allIssues.filter((i) => i.severity === 'error').length;
  const warningCount = allIssues.filter((i) => i.severity === 'warning').length;
  const passedCount = totalChecks - allIssues.filter((i) => i.severity !== 'info').length;

  const report: ValidationReport = {
    environment: args.env,
    scope: migrationReport.scope,
    totalWorkloadsChecked: checkedWorkloads.size,
    totalChecks,
    passed: Math.max(0, passedCount),
    errors: errorCount,
    warnings: warningCount,
    issues: allIssues,
    workloadResults,
  };

  // ── Output ─────────────────────────────────────────────────────────────────

  printSummary(report, allIssues);
  writeReports(report, args.outputDir);

  if (errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
