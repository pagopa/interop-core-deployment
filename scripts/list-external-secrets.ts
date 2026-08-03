/**
 * Scan all workload values.yaml files for a given environment and report
 * the status of each ExternalSecret remoteRef against the live AWS Secrets Manager version.
 *
 * Usage:
 *   npm run list-external-secrets -- --env dev
 *   npm run list-external-secrets -- --env dev --root /path/to/repo --output-dir external-secrets-analysis
 */

import * as fs from "fs";
import * as path from "path";
import { parseDocument } from "yaml";
import { parse as parseYaml } from "yaml";
import { createAwsClient, fetchLatestSecretVersion } from "./lib/aws-secrets-manager.js";
import type { AwsSecretVersion } from "./lib/aws-secrets-manager.js";
import { walkWorkloads } from "./lib/workload.js";
import type { WorkloadType } from "./lib/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const AWS_SM_LABELS = ["AWSCURRENT", "AWSPREVIOUS"] as const;
const DEFAULT_OUTPUT_DIR = "external-secrets-analysis";

interface CliArgs {
  env: string;
  root: string;
  outputDir: string;
}

interface ExternalSecretEntry {
  file: string;
  component: string;
  workloadType: WorkloadType;
  containerType: "container" | "initContainer";
  secretKey: string;
  key: string;
  property: string;
  /** Configured version ID (uuid/ prefix stripped). Falls back to AWSCURRENT when absent. */
  configuredVersion: string;
  misconfigured: boolean;
  latestVersion?: string;
  versionStages?: string[];
  upToDate?: boolean;
  hasError: boolean;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CliArgs {
  let env: string | null = null;
  let root = process.cwd();
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--env" || arg === "-e") {
      if (!next) throw new Error(`${arg} requires a value`);
      env = next;
      i += 1;
    } else if (arg === "--root" || arg === "-r") {
      if (!next) throw new Error(`${arg} requires a value`);
      root = next;
      i += 1;
    } else if (arg === "--output-dir" || arg === "-o") {
      if (!next) throw new Error(`${arg} requires a value`);
      outputDir = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!env) throw new Error("--env is required");

  return { env, root: path.resolve(root), outputDir };
}

function printHelp(): void {
  console.log(`
Usage: list-external-secrets [options]

Options:
  --env,        -e  <env>   Environment to scan (required)
  --root,       -r  <path>  Repository root (default: cwd)
  --output-dir, -o  <dir>   Output directory (default: ${DEFAULT_OUTPUT_DIR})
  --help,       -h           Show this help
`.trim());
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

type ContainerType = "container" | "initContainer";

interface RawExternalSecretRef {
  secretKey?: string;
  remoteRef?: {
    key?: string;
    property?: string;
    version?: string;
  };
}

interface RawContainerConfig {
  create?: boolean;
  data?: RawExternalSecretRef[];
}

function extractEntries(
  file: string,
  component: string,
  workloadType: WorkloadType
): ExternalSecretEntry[] {
  const content = fs.readFileSync(file, "utf-8");
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error parsing YAML ${file}: ${msg}`);
    return [];
  }

  const record = data as Record<string, unknown> | null;
  const externalSecrets = record?.externalSecrets as Record<string, RawContainerConfig> | undefined;
  if (!externalSecrets) return [];

  const containerTypes: ContainerType[] = ["container", "initContainer"];

  return containerTypes.flatMap((containerType) => {
    const refs = externalSecrets[containerType]?.data;
    if (!Array.isArray(refs) || refs.length === 0) return [];

    return refs.flatMap((ref) => {
      if (!ref.remoteRef) return [];
      const rawVersion = ref.remoteRef.version;
      // Strip "uuid/" prefix added by the tooling
      const configuredVersion = rawVersion
        ? rawVersion.substring(rawVersion.indexOf("/") + 1)
        : "AWSCURRENT";
      return [
        {
          file,
          component,
          workloadType,
          containerType,
          secretKey: ref.secretKey ?? "N/A",
          key: ref.remoteRef.key ?? "N/A",
          property: ref.remoteRef.property ?? "N/A",
          configuredVersion,
          misconfigured: (AWS_SM_LABELS as readonly string[]).includes(configuredVersion),
          hasError: false,
        },
      ];
    });
  });
}

// ---------------------------------------------------------------------------
// AWS enrichment
// ---------------------------------------------------------------------------

async function enrichEntry(
  entry: ExternalSecretEntry,
  awsVersion: AwsSecretVersion | null
): Promise<ExternalSecretEntry> {
  if (!awsVersion) {
    return { ...entry, hasError: true };
  }

  const enriched: ExternalSecretEntry = {
    ...entry,
    latestVersion: awsVersion.versionId,
    versionStages: awsVersion.versionStages,
  };

  if (awsVersion.value.type === "json") {
    if (!awsVersion.value.parsed?.[entry.property]) {
      console.warn(`  ⚠️  Property "${entry.property}" not found in latest version of secret ${entry.key}`);
      enriched.hasError = true;
    }
  } else if (awsVersion.value.type === "text") {
    if (awsVersion.value.raw !== entry.property) {
      console.warn(`  ⚠️  Property "${entry.property}" does not match the latest value of secret ${entry.key}`);
      enriched.hasError = true;
    }
  }

  if (!enriched.hasError) {
    enriched.upToDate = enriched.latestVersion === entry.configuredVersion;
    if (!enriched.upToDate) {
      console.warn(`  ⚠️  Secret ${entry.key}: configured ${entry.configuredVersion}, latest ${enriched.latestVersion}`);
    } else {
      console.log(`  ✅ Secret ${entry.key} is up-to-date (${enriched.latestVersion})`);
    }
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function writeCsv(entries: ExternalSecretEntry[], outputDir: string, env: string): void {
  const headers = [
    "component",
    "workloadType",
    "containerType",
    "file",
    "secretKey",
    "key",
    "property",
    "configuredVersion",
    "latestVersion",
    "versionStages",
    "upToDate",
    "misconfigured",
    "hasError",
  ];

  const rows = entries.map((e) =>
    [
      e.component,
      e.workloadType,
      e.containerType,
      e.file,
      e.secretKey,
      e.key,
      e.property,
      e.configuredVersion,
      e.latestVersion ?? "",
      (e.versionStages ?? []).join("|"),
      e.upToDate ?? "",
      e.misconfigured,
      e.hasError,
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
  );

  const csv = [headers.join(","), ...rows].join("\n");
  const csvPath = path.join(outputDir, `external-secrets-${env}.csv`);
  fs.writeFileSync(csvPath, `${csv}\n`);
  console.log(`✅ CSV exported to: ${csvPath}`);
}

function writeJsonReports(entries: ExternalSecretEntry[], outputDir: string, env: string): void {
  type GroupedReport = Record<string, ExternalSecretEntry[]>;

  function groupByFile(subset: ExternalSecretEntry[]): GroupedReport {
    return subset.reduce<GroupedReport>((acc, e) => {
      acc[e.file] ??= [];
      acc[e.file].push(e);
      return acc;
    }, {});
  }

  const reports: Array<[string, GroupedReport]> = [
    [`external-secrets-report-all-${env}.json`, groupByFile(entries)],
    [`external-secrets-report-outdated-${env}.json`, groupByFile(entries.filter((e) => e.upToDate === false))],
    [`external-secrets-report-misconfigured-${env}.json`, groupByFile(entries.filter((e) => e.misconfigured))],
    [`external-secrets-report-error-${env}.json`, groupByFile(entries.filter((e) => e.hasError))],
  ];

  const written = reports.map(([name, report]) => {
    const reportPath = path.join(outputDir, name);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return reportPath;
  });

  console.log(`✅ JSON reports exported to:\n${written.map((p) => `  ⬩ ${p}`).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Version patching
// ---------------------------------------------------------------------------

type YamlItem = { get: (k: string) => unknown; getIn: (p: string[]) => unknown; setIn: (p: string[], v: unknown) => void };

function patchValuesFile(file: string, entries: ExternalSecretEntry[]): void {
  const content = fs.readFileSync(file, "utf-8");
  const doc = parseDocument(content);
  let changed = false;

  for (const containerType of ["container", "initContainer"] as const) {
    const data = doc.getIn(["externalSecrets", containerType, "data"]) as { items: unknown[] } | undefined;
    if (!data?.items) continue;

    for (const item of data.items as YamlItem[]) {
      const secretKey = item.get("secretKey") as string | undefined;
      const key = item.getIn(["remoteRef", "key"]) as string | undefined;
      const property = item.getIn(["remoteRef", "property"]) as string | undefined;

      const match = entries.find(
        (e) =>
          !e.hasError &&
          e.latestVersion &&
          e.containerType === containerType &&
          e.secretKey === secretKey &&
          e.key === key &&
          e.property === property
      );

      if (match?.latestVersion) {
        item.setIn(["remoteRef", "version"], `uuid/${match.latestVersion}`);
        changed = true;
      }
    }
  }

  if (changed) {
    fs.writeFileSync(file, doc.toString());
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { env, root, outputDir } = args;
  const resolvedOutputDir = path.isAbsolute(outputDir) ? outputDir : path.join(root, outputDir);

  console.log(`\n🧐 Scanning External Secrets for environment: ${env}\n`);
  console.log(`  Repository root: ${root}`);
  console.log(`  Output path:     ${resolvedOutputDir}\n`);

  if (!process.env.AWS_PROFILE) {
    console.warn("⚠️  AWS_PROFILE is not set. Using the default AWS credential chain.");
  }

  if (!fs.existsSync(root)) throw new Error(`Repository root does not exist: ${root}`);

  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const workloads = [
    ...walkWorkloads(root, env, "microservice"),
    ...walkWorkloads(root, env, "cronjob"),
  ];

  // Only workload-specific values.yaml files (exclude commons/)
  const valueFiles = workloads.flatMap((w) =>
    w.valueFiles
      .filter((f) => !f.includes(`${path.sep}commons${path.sep}`))
      .map((f) => ({ file: f, component: w.component, workloadType: w.workloadType }))
  );

  if (valueFiles.length === 0) {
    console.log(`⚠️  No values.yaml files found for environment "${env}". Exiting.`);
    return;
  }

  console.log(`👀 Found ${valueFiles.length} values.yaml files\n`);

  const allEntries: ExternalSecretEntry[] = [];
  const client = createAwsClient();

  for (const { file, component, workloadType } of valueFiles) {
    const rawEntries = extractEntries(file, component, workloadType);
    if (rawEntries.length === 0) continue;

    console.log(`\n${"=".repeat(100)}`);
    console.log(`🔐 ${rawEntries.length} external secret(s) in: ${component} [${workloadType}]`);
    console.log(`   File: ${path.relative(root, file)}\n`);

    for (const [i, entry] of rawEntries.entries()) {
      console.log(`\n🔑 Secret ${i + 1} of ${rawEntries.length}`);
      if (entry.misconfigured) {
        console.log(`  ❌ version "${entry.configuredVersion}" is a label – specify an explicit version ID`);
      }
      console.log(` . key:      ${entry.key}`);
      console.log(` . property: ${entry.property}`);
      console.log(` . version:  ${entry.configuredVersion}`);

      const awsVersion = await fetchLatestSecretVersion(client, entry.key);
      const enriched = await enrichEntry(entry, awsVersion);
      allEntries.push(enriched);
    }
  }

  console.log(`\n${"=".repeat(120)}\n`);

  const summary = {
    "Total files scanned": valueFiles.length,
    "Total secrets found": allEntries.length,
    "Up-to-date": allEntries.filter((e) => e.upToDate === true).length,
    Outdated: allEntries.filter((e) => e.upToDate === false).length,
    Misconfigured: allEntries.filter((e) => e.misconfigured).length,
    "With errors": allEntries.filter((e) => e.hasError).length,
  };
  console.log("\t\t📝 Summary");
  console.table(summary);

  if (allEntries.length === 0) return;

  writeCsv(allEntries, resolvedOutputDir, env);
  writeJsonReports(allEntries, resolvedOutputDir, env);

  // Patch outdated or misconfigured entries back into their values.yaml files
  const filesToPatch = [
    ...new Set(
      allEntries
        .filter((e) => !e.hasError && (e.upToDate === false || e.misconfigured))
        .map((e) => e.file)
    ),
  ];

  for (const file of filesToPatch) {
    const fileEntries = allEntries.filter((e) => e.file === file);
    patchValuesFile(file, fileEntries);
  }
}

main().catch((err) => {
  console.error(`❌ Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
