import * as fs from "fs";
import * as path from "path";
import { isMap, isScalar, isSeq } from "yaml";
import { csvEscape, summaryMetricsToCsv, type SummaryMetric } from "./csv.js";
import { writeJsonReport } from "./json-report.js";
import { readApplicationConfigMaps } from "./migration-assets.js";
import { scalarText, yamlDocument } from "./yaml-source.js";

type WorkloadType = "microservice" | "cronjob";

type CliArgs = {
  env: string;
  root: string;
  outputDir: string;
  outputSummaryCsv: string;
  outputSummaryJson: string;
};

type ConfigMapRecord = {
  name: string;
  keys: Set<string>;
  sourceFile: string;
};

const INVENTORY_STATUSES = [
  "OK",
  "TEMPLATE_REFERENCE",
  "INVALID_REFERENCE",
  "MIGRATION_CONFIGMAP",
  "CONFIGMAP_NOT_FOUND",
  "KEY_NOT_FOUND",
] as const;

type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

const STATUS_DESCRIPTIONS: Record<InventoryStatus, string> = {
  OK: "References resolved to an existing key of a ConfigMap in scope",
  TEMPLATE_REFERENCE: "Templated references (e.g. {{.Values.name}}.KEY, the chart-local ConfigMap) not statically resolvable; reported only",
  INVALID_REFERENCE: "References not in the ConfigMap.key format, or not a string; blocking",
  MIGRATION_CONFIGMAP: "References to a migration ConfigMap, which is excluded from the refactoring; blocking",
  CONFIGMAP_NOT_FOUND: "References to a ConfigMap not found in commons/<env>/configmaps; blocking",
  KEY_NOT_FOUND: "References to a key missing from an existing ConfigMap; blocking",
};

/** Statuses reported without failing the inventory. */
const NON_BLOCKING_STATUSES = new Set<InventoryStatus>(["OK", "TEMPLATE_REFERENCE"]);

type InventoryRow = {
  environment: string;
  workloadType: WorkloadType;
  workload: string;
  valuesFile: string;
  section: string;
  envVar: string;
  configMap: string;
  key: string;
  sourceFile: string;
  status: InventoryStatus;
};

type CollectedReference = {
  section: string;
  envVar: string;
  refValue: string;
  usedByEnv: string[];
};

type WorkloadFile = {
  workloadType: WorkloadType;
  workload: string;
  valuesFileAbs: string;
  valuesFileRel: string;
};

function parseArgs(argv: string[]): CliArgs {
  const arg = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    arg.set(key, next);
    i += 1;
  }

  const env = arg.get("env");
  if (!env) {
    throw new Error("Missing required argument --env <environment>");
  }

  const root = path.resolve(arg.get("root") ?? process.cwd());
  const outputDir = path.resolve(arg.get("output-dir") ?? path.join(root, "reports", "refactor-common-configmaps"));
  const outputSummaryCsv = path.resolve(
    arg.get("output-summary-csv") ?? path.join(outputDir, `task-1-inventory-summary-${env}.csv`),
  );

  const outputSummaryJson = path.resolve(
    arg.get("output-summary-json") ?? path.join(outputDir, `task-1-inventory-summary-${env}.json`),
  );

  return { env, root, outputDir, outputSummaryCsv, outputSummaryJson };
}

function loadConfigMaps(root: string, env: string): { index: Map<string, ConfigMapRecord>; migrationConfigMaps: Map<string, string> } {
  const { configMaps, excluded } = readApplicationConfigMaps(root, env);
  const index = new Map<string, ConfigMapRecord>();
  for (const configMap of configMaps.values()) {
    index.set(configMap.name, { name: configMap.name, keys: new Set(configMap.data.keys()), sourceFile: configMap.file });
  }
  const migrationConfigMaps = new Map([...excluded].map(([name, migration]) => [name, migration.file]));
  return { index, migrationConfigMaps };
}

function discoverWorkloads(root: string, env: string, workloadType: WorkloadType): WorkloadFile[] {
  const baseDir = path.join(root, workloadType === "microservice" ? "microservices" : "jobs");
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const out: WorkloadFile[] = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workload = entry.name;
    const valuesFileAbs = path.join(baseDir, workload, env, "values.yaml");
    if (!fs.existsSync(valuesFileAbs)) {
      continue;
    }
    out.push({
      workloadType,
      workload,
      valuesFileAbs,
      valuesFileRel: path.relative(root, valuesFileAbs),
    });
  }

  return out;
}

function collectConfigMapRefs(
  node: unknown,
  currentPath: string,
  refs: CollectedReference[],
): void {
  if (isSeq(node)) {
    node.items.forEach((item, idx) => {
      const p = currentPath ? `${currentPath}[${idx}]` : `[${idx}]`;
      collectConfigMapRefs(item, p, refs);
    });
    return;
  }

  if (!isMap(node)) {
    return;
  }

  for (const item of node.items) {
    const key = String(isScalar(item.key) ? item.key.value : item.key);
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    const isReferenceSection = key === "envFromConfigmaps" || nextPath === "frontend.env.js.window.pagopa_env.fromConfigmaps";
    if (isReferenceSection && isMap(item.value)) {
      const env = key === "envFromConfigmaps" ? node.get("env", true) : undefined;
      const usedBy = new Map<string, Set<string>>();
      if (isMap(env)) {
        for (const variable of env.items) {
          const name = String(isScalar(variable.key) ? variable.key.value : variable.key);
          for (const match of (scalarText(variable.value) ?? "").matchAll(/\$\$|\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
            const dependency = match[1];
            if (dependency) {
              const consumers = usedBy.get(dependency) ?? new Set<string>();
              consumers.add(name);
              usedBy.set(dependency, consumers);
            }
          }
        }
      }
      for (const ref of item.value.items) {
        const envVar = String(isScalar(ref.key) ? ref.key.value : ref.key);
        // Non-string values are kept as empty references so they are reported as INVALID_REFERENCE.
        refs.push({ section: nextPath, envVar, refValue: scalarText(ref.value) ?? "", usedByEnv: [...(usedBy.get(envVar) ?? [])].sort() });
      }
      continue;
    }

    collectConfigMapRefs(item.value, nextPath, refs);
  }
}

function parseConfigMapRef(value: string): { configMap: string; key: string } | null {
  const firstDot = value.indexOf(".");
  if (firstDot <= 0 || firstDot === value.length - 1) {
    return null;
  }

  const configMap = value.slice(0, firstDot).trim();
  const key = value.slice(firstDot + 1).trim();
  if (!configMap || !key) {
    return null;
  }
  return { configMap, key };
}

function isTemplateReference(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

function evaluateRef(
  env: string,
  wf: WorkloadFile,
  section: string,
  envVar: string,
  refValue: string,
  configMaps: Map<string, ConfigMapRecord>,
  migrationConfigMaps: Map<string, string>,
): InventoryRow {
  if (isTemplateReference(refValue)) {
    return {
      environment: env,
      workloadType: wf.workloadType,
      workload: wf.workload,
      valuesFile: wf.valuesFileRel,
      section,
      envVar,
      configMap: "",
      key: refValue,
      sourceFile: "",
      status: "TEMPLATE_REFERENCE",
    };
  }

  const parsed = parseConfigMapRef(refValue);

  if (!parsed) {
    return {
      environment: env,
      workloadType: wf.workloadType,
      workload: wf.workload,
      valuesFile: wf.valuesFileRel,
      section,
      envVar,
      configMap: "",
      key: "",
      sourceFile: "",
      status: "INVALID_REFERENCE",
    };
  }

  const migrationSourceFile = migrationConfigMaps.get(parsed.configMap);
  if (migrationSourceFile !== undefined) {
    return {
      environment: env,
      workloadType: wf.workloadType,
      workload: wf.workload,
      valuesFile: wf.valuesFileRel,
      section,
      envVar,
      configMap: parsed.configMap,
      key: parsed.key,
      sourceFile: migrationSourceFile,
      status: "MIGRATION_CONFIGMAP",
    };
  }

  const cm = configMaps.get(parsed.configMap);
  if (!cm) {
    return {
      environment: env,
      workloadType: wf.workloadType,
      workload: wf.workload,
      valuesFile: wf.valuesFileRel,
      section,
      envVar,
      configMap: parsed.configMap,
      key: parsed.key,
      sourceFile: "",
      status: "CONFIGMAP_NOT_FOUND",
    };
  }

  if (!cm.keys.has(parsed.key)) {
    return {
      environment: env,
      workloadType: wf.workloadType,
      workload: wf.workload,
      valuesFile: wf.valuesFileRel,
      section,
      envVar,
      configMap: parsed.configMap,
      key: parsed.key,
      sourceFile: cm.sourceFile,
      status: "KEY_NOT_FOUND",
    };
  }

  return {
    environment: env,
    workloadType: wf.workloadType,
    workload: wf.workload,
    valuesFile: wf.valuesFileRel,
    section,
    envVar,
    configMap: parsed.configMap,
    key: parsed.key,
    sourceFile: cm.sourceFile,
    status: "OK",
  };
}

type InventorySummary = {
  environment: string;
  outputCsv: string;
  outputJson: string;
  configMapsInScope: number;
  configMapKeysInScope: number;
  excludedMigrationConfigMaps: number;
  microserviceFiles: number;
  cronjobFiles: number;
  workloadsWithReferences: number;
  references: number;
  configMapsReferenced: number;
  configMapKeysReferenced: number;
  blockingReferences: number;
  statusCounts: Map<InventoryStatus, number>;
};

function summaryMetrics(summary: InventorySummary): SummaryMetric[] {
  const metrics: Array<[string, string | number, string]> = [
    ["environment", summary.environment, "Environment name used for this run"],
    ["outputCsv", summary.outputCsv, "Inventory CSV generated by TASK 1"],
    ["outputJson", summary.outputJson, "Inventory JSON generated by TASK 1"],
    ["configMapsInScope", summary.configMapsInScope, "ConfigMaps of commons/<env>/configmaps in scope (migration ConfigMaps excluded)"],
    ["configMapKeysInScope", summary.configMapKeysInScope, "Keys of the ConfigMaps in scope"],
    ["excludedMigrationConfigMaps", summary.excludedMigrationConfigMaps, "Migration ConfigMaps excluded from the refactoring (owned by the Flyway migrations flow)"],
    ["workloadFiles", summary.microserviceFiles + summary.cronjobFiles, "Workload values files scanned (microservices/<name>/<env>/values.yaml and jobs/<name>/<env>/values.yaml)"],
    ["workloadFiles.microservice", summary.microserviceFiles, "Microservice values files scanned"],
    ["workloadFiles.cronjob", summary.cronjobFiles, "Cronjob values files scanned"],
    ["workloadsWithReferences", summary.workloadsWithReferences, "Workload values files with at least one envFromConfigmaps reference"],
    ["references", summary.references, "envFromConfigmaps references found (one per workload, section and variable)"],
    ["configMapsReferenced", summary.configMapsReferenced, "ConfigMaps in scope referenced by at least one workload (status OK)"],
    ["configMapKeysReferenced", summary.configMapKeysReferenced, "ConfigMap keys in scope referenced by at least one workload (status OK)"],
    ["configMapKeysUnreferenced", summary.configMapKeysInScope - summary.configMapKeysReferenced, "ConfigMap keys in scope without any envFromConfigmaps reference (classified OBSOLETE by TASK 2)"],
    ["blockingReferences", summary.blockingReferences, "References with a blocking status; TASK 1 fails when greater than zero"],
  ];

  for (const status of INVENTORY_STATUSES) {
    metrics.push([`status.${status}`, summary.statusCounts.get(status) ?? 0, STATUS_DESCRIPTIONS[status]]);
  }
  return metrics.map(([metric, value, description]) => ({ metric, value, description }));
}

function toCsv(rows: Array<InventoryRow & { usedByEnv: string[] }>): string {
  const header = [
    "environment",
    "workloadType",
    "workload",
    "valuesFile",
    "section",
    "envVar",
    "configMap",
    "key",
    "sourceFile",
    "status",
    "usedByEnv",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.environment,
        row.workloadType,
        row.workload,
        row.valuesFile,
        row.section,
        row.envVar,
        row.configMap,
        row.key,
        row.sourceFile,
        row.status,
        row.usedByEnv.join("\n"),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const { index: configMaps, migrationConfigMaps } = loadConfigMaps(args.root, args.env);
  const workloads = [
    ...discoverWorkloads(args.root, args.env, "microservice"),
    ...discoverWorkloads(args.root, args.env, "cronjob"),
  ];

  const rows: Array<InventoryRow & { usedByEnv: string[] }> = [];

  for (const wf of workloads) {
    const refs: CollectedReference[] = [];
    collectConfigMapRefs(yamlDocument(wf.valuesFileAbs).contents, "", refs);

    for (const ref of refs) {
      rows.push({
        ...evaluateRef(args.env, wf, ref.section, ref.envVar, ref.refValue, configMaps, migrationConfigMaps),
        usedByEnv: ref.usedByEnv,
      });
    }
  }

  rows.sort((a, b) => {
    return (
      a.workloadType.localeCompare(b.workloadType) ||
      a.workload.localeCompare(b.workload) ||
      a.valuesFile.localeCompare(b.valuesFile) ||
      a.section.localeCompare(b.section) ||
      a.envVar.localeCompare(b.envVar)
    );
  });

  ensureDir(args.outputDir);
  const csvPath = path.join(args.outputDir, `task-1-inventory-${args.env}.csv`);
  const jsonPath = path.join(args.outputDir, `task-1-inventory-${args.env}.json`);

  fs.writeFileSync(csvPath, `${toCsv(rows)}\n`, "utf8");
  writeJsonReport(jsonPath, rows);

  const byStatus = new Map<InventoryStatus, number>();
  for (const row of rows) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  }
  const blockingIssues = rows.filter((r) => !NON_BLOCKING_STATUSES.has(r.status));
  const blockingDetails = INVENTORY_STATUSES
    .filter((status) => !NON_BLOCKING_STATUSES.has(status) && byStatus.has(status))
    .map((status) => `${status}: ${byStatus.get(status)}`)
    .join(", ");
  const reason = blockingIssues.length > 0
    ? `Blocking ConfigMap references (${blockingDetails}).`
    : "No blocking ConfigMap references found.";
  const resolvedRows = rows.filter((r) => r.status === "OK");

  // Written before the validation outcome so the summary is available also when blocking references are found.
  const metrics = summaryMetrics({
      environment: args.env,
      outputCsv: path.relative(args.root, csvPath),
      outputJson: path.relative(args.root, jsonPath),
      configMapsInScope: configMaps.size,
      configMapKeysInScope: [...configMaps.values()].reduce((total, configMap) => total + configMap.keys.size, 0),
      excludedMigrationConfigMaps: migrationConfigMaps.size,
      microserviceFiles: workloads.filter((wf) => wf.workloadType === "microservice").length,
      cronjobFiles: workloads.filter((wf) => wf.workloadType === "cronjob").length,
      workloadsWithReferences: new Set(rows.map((r) => r.valuesFile)).size,
      references: rows.length,
      configMapsReferenced: new Set(resolvedRows.map((r) => r.configMap)).size,
      configMapKeysReferenced: new Set(resolvedRows.map((r) => `${r.configMap}.${r.key}`)).size,
      blockingReferences: blockingIssues.length,
      statusCounts: byStatus,
  });
  const attention = rows.filter((row) => row.usedByEnv.length > 0);
  metrics.push(
    { metric: "referencesRequiringEnvOrderReview", value: attention.length, description: "ConfigMap references used by a sibling env value via $(VAR)" },
    { metric: "workloadsRequiringEnvOrderReview", value: new Set(attention.map((row) => row.valuesFile)).size, description: "Workload values files with order-sensitive ConfigMap references" },
  );
  console.log(`ConfigMap references requiring env order review: ${attention.length}. See usedByEnv in the inventory.`);
  metrics.unshift(
    { metric: "status", value: blockingIssues.length > 0 ? "FAILED" : "SUCCESS", description: "Inventory validation outcome" },
    { metric: "reason", value: reason, description: "Inventory validation details" },
  );
  ensureDir(path.dirname(args.outputSummaryCsv));
  ensureDir(path.dirname(args.outputSummaryJson));
  fs.writeFileSync(args.outputSummaryCsv, `${summaryMetricsToCsv(metrics)}\n`, "utf8");
  writeJsonReport(args.outputSummaryJson, metrics);

  console.log(`Environment: ${args.env}`);
  console.log(`ConfigMaps in scope: ${configMaps.size}`);
  console.log(`Migration ConfigMaps excluded: ${migrationConfigMaps.size}`);
  console.log(`Workload files scanned: ${workloads.length}`);
  console.log(`envFromConfigmaps references found: ${rows.length}`);
  console.log(`CSV report: ${path.relative(args.root, csvPath)}`);
  console.log(`JSON report: ${path.relative(args.root, jsonPath)}`);
  console.log(`Summary report: ${path.relative(args.root, args.outputSummaryCsv)}`);
  console.log(`Summary JSON report: ${path.relative(args.root, args.outputSummaryJson)}`);

  for (const status of INVENTORY_STATUSES) {
    console.log(`${status}: ${byStatus.get(status) ?? 0}`);
  }

  if (blockingIssues.length > 0) {
    console.error(reason);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
