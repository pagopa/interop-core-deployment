import * as fs from "fs";
import * as path from "path";
import { csvEscape, summaryMetricsToCsv, type SummaryMetric } from "./csv.js";
import { readJsonReport, writeJsonReport } from "./json-report.js";
import { readApplicationConfigMaps, type ExcludedMigrationConfigMap } from "./migration-assets.js";

type CliArgs = {
  env: string;
  root: string;
  inventoryJson: string;
  outputCsv: string;
  outputJson: string;
  outputSummaryCsv: string;
  outputSummaryJson: string;
};

const INVENTORY_FIELDS = [
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
] as const;

type InventoryRow = {
  environment: string;
  workloadType: string;
  workload: string;
  valuesFile: string;
  section: string;
  envVar: string;
  configMap: string;
  key: string;
  sourceFile: string;
  status: string;
};

type ConfigMapKey = {
  configMap: string;
  key: string;
  sourceFile: string;
};

type Classification = "COMMON_VALUE" | "WORKLOAD_VALUE" | "KEEP_AS_CONFIGMAP" | "OBSOLETE";

const CLASSIFICATIONS: Classification[] = ["COMMON_VALUE", "WORKLOAD_VALUE", "KEEP_AS_CONFIGMAP", "OBSOLETE"];

type OutputRow = {
  environment: string;
  configMap: string;
  key: string;
  sourceFile: string;
  workloadType: string;
  workload: string;
  valuesFile: string;
  section: string;
  envVar: string;
  status: string;
  distinctWorkloadCount: number;
  classificationReason: string;
  classification: Classification;
};

/** Rows of the classification report: workloads sharing every other column are merged into one row. */
type GroupedRow = Omit<OutputRow, "workload" | "valuesFile"> & {
  /** References merged into this row (one per workload, section and variable). */
  referenceCount: number;
  /** References of the key across all its rows. */
  keyReferenceCount: number;
  workloads: string[];
  valuesFiles: string[];
};

// Separator of the merged workload and valuesFile cells; both lists keep the same order.
const CELL_SEPARATOR = "\n";

function groupRows(rows: OutputRow[]): GroupedRow[] {
  const groups = new Map<string, GroupedRow>();

  for (const row of rows) {
    const id = JSON.stringify([
      row.environment,
      row.configMap,
      row.key,
      row.sourceFile,
      row.workloadType,
      row.section,
      row.envVar,
      row.status,
      row.distinctWorkloadCount,
      row.classificationReason,
      row.classification,
    ]);
    const { workload, valuesFile, ...shared } = row;
    const group = groups.get(id) ?? { ...shared, referenceCount: 0, keyReferenceCount: 0, workloads: [], valuesFiles: [] };
    groups.set(id, group);

    // Rows without consumers (workloadType "none") describe the key only and are not counted as workloads.
    group.workloads.push(workload);
    group.valuesFiles.push(valuesFile);
    if (row.workloadType !== "none") {
      group.referenceCount += 1;
    }
  }

  const referencesByKey = new Map<string, number>();
  for (const group of groups.values()) {
    const key = `${group.configMap}.${group.key}`;
    referencesByKey.set(key, (referencesByKey.get(key) ?? 0) + group.referenceCount);
  }

  for (const group of groups.values()) {
    group.keyReferenceCount = referencesByKey.get(`${group.configMap}.${group.key}`) ?? 0;
    const order = group.workloads.map((_, index) => index).sort((a, b) => group.workloads[a].localeCompare(group.workloads[b]));
    group.workloads = order.map((index) => group.workloads[index]);
    group.valuesFiles = order.map((index) => group.valuesFiles[index]);
  }

  return [...groups.values()].sort(
    (a, b) =>
      a.configMap.localeCompare(b.configMap) ||
      a.key.localeCompare(b.key) ||
      a.workloadType.localeCompare(b.workloadType) ||
      a.section.localeCompare(b.section) ||
      a.envVar.localeCompare(b.envVar),
  );
}

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
  const reportsDir = path.join(root, "reports", "refactor-common-configmaps");
  const report = (option: string, file: string) => path.resolve(arg.get(option) ?? path.join(reportsDir, file));

  return {
    env,
    root,
    inventoryJson: report("inventory-json", `task-1-inventory-${env}.json`),
    outputCsv: report("output-csv", `task-2-classification-common-configmaps-${env}.csv`),
    outputJson: report("output-json", `task-2-classification-common-configmaps-${env}.json`),
    outputSummaryCsv: report("output-summary-csv", `task-2-classification-summary-${env}.csv`),
    outputSummaryJson: report("output-summary-json", `task-2-classification-summary-${env}.json`),
  };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}


function readConfigMapKeys(root: string, env: string): { keys: ConfigMapKey[]; excluded: Map<string, ExcludedMigrationConfigMap> } {
  const { configMaps, excluded } = readApplicationConfigMaps(root, env);
  const out: ConfigMapKey[] = [];

  for (const configMap of configMaps.values()) {
    for (const key of configMap.data.keys()) {
      out.push({ configMap: configMap.name, key, sourceFile: configMap.file });
    }
  }

  out.sort((a, b) => {
    return a.configMap.localeCompare(b.configMap) || a.key.localeCompare(b.key);
  });

  return { keys: out, excluded };
}

function keyId(configMap: string, key: string): string {
  return `${configMap}::${key}`;
}

function classifyRow(row: InventoryRow, distinctWorkloadCount: number): { classification: Classification; reason: string } {
  if (row.status !== "OK") {
    return {
      classification: "KEEP_AS_CONFIGMAP",
      reason: `Inventory status ${row.status} requires conservative keep-as-configmap handling`,
    };
  }

  if (distinctWorkloadCount <= 1) {
    return {
      classification: "WORKLOAD_VALUE",
      reason: "Referenced by a single consumer",
    };
  }

  return {
    classification: "COMMON_VALUE",
    reason: "Referenced by multiple consumers",
  };
}

function toCsv(rows: GroupedRow[]): string {
  const header = [
    "environment",
    "configMap",
    "key",
    "sourceFile",
    "workloadType",
    "referenceCount",
    "workload",
    "valuesFile",
    "section",
    "envVar",
    "status",
    "distinctWorkloadCount",
    "keyReferenceCount",
    "classificationReason",
    "classification",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.environment,
        row.configMap,
        row.key,
        row.sourceFile,
        row.workloadType,
        String(row.referenceCount),
        row.workloads.join(CELL_SEPARATOR),
        row.valuesFiles.join(CELL_SEPARATOR),
        row.section,
        row.envVar,
        row.status,
        String(row.distinctWorkloadCount),
        String(row.keyReferenceCount),
        row.classificationReason,
        row.classification,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}

/** Classification records for the JSON report: same fields as the CSV, with typed counts and workload lists. */
function toJsonRecords(rows: GroupedRow[]): object[] {
  return rows.map((row) => ({
    environment: row.environment,
    configMap: row.configMap,
    key: row.key,
    sourceFile: row.sourceFile,
    workloadType: row.workloadType,
    referenceCount: row.referenceCount,
    workload: row.workloads,
    valuesFile: row.valuesFiles,
    section: row.section,
    envVar: row.envVar,
    status: row.status,
    distinctWorkloadCount: row.distinctWorkloadCount,
    keyReferenceCount: row.keyReferenceCount,
    classificationReason: row.classificationReason,
    classification: row.classification,
  }));
}

function summaryMetrics(summary: {
  environment: string;
  inventoryJson: string;
  outputCsv: string;
  outputJson: string;
  configMapKeys: number;
  excludedMigrationConfigMaps: number;
  references: number;
  rows: number;
  classificationCounts: Record<string, number>;
  statusCounts: Record<string, number>;
}): SummaryMetric[] {
  const metrics: SummaryMetric[] = [];
  const add = (metric: string, value: string | number, description: string) => metrics.push({ metric, value, description });

  const classificationDescription = (classification: string): string => {
    if (classification === "COMMON_VALUE") {
      return "Rows for keys that should be promoted to shared common values because they are reused by multiple consumers";
    }
    if (classification === "WORKLOAD_VALUE") {
      return "Rows for keys that should remain workload-scoped because they are used by only one consumer";
    }
    if (classification === "KEEP_AS_CONFIGMAP") {
      return "Rows for keys that should stay as ConfigMap entries because automatic classification was not safe or the reference needs explicit manual handling";
    }
    if (classification === "OBSOLETE") {
      return "Rows for keys with no detected consumers in the inventory suggesting they may be removable after validation";
    }
    return `Rows classified as ${classification}`;
  };

  add("environment", summary.environment, "Environment name used for this run");
  add("inventoryJson", summary.inventoryJson, "Input inventory JSON generated by TASK 1");
  add("outputCsv", summary.outputCsv, "Output classification CSV generated by TASK 2");
  add("outputJson", summary.outputJson, "Output classification JSON generated by TASK 2");
  add("configMapKeys", summary.configMapKeys, "Total keys of the ConfigMaps in scope in commons/<env>/configmaps (migration ConfigMaps excluded)");
  add("excludedMigrationConfigMaps", summary.excludedMigrationConfigMaps, "Migration ConfigMaps excluded from the refactoring (owned by the Flyway migrations flow)");
  add("references", summary.references, "Total workload references (one per workload, section and variable) aggregated in the classification output");
  add("rows", summary.rows, "Total rows written in classification output; workloads sharing ConfigMap, key, workload type, section and variable are merged into one row");

  for (const classification of CLASSIFICATIONS) {
    add(`classification.${classification}`, summary.classificationCounts[classification] ?? 0, classificationDescription(classification));
  }

  const statusDescription = (status: string): string => {
    if (status === "OK") {
      return "Row with valid reference: ConfigMap and key exist and were resolved correctly";
    }
    if (status === "NO_CONSUMER") {
      return "ConfigMap key with no consumers detected in TASK 1 inventory";
    }
    if (status === "TEMPLATE_REFERENCE") {
      return "Templated reference (e.g. Helm {{ }}) not statically resolvable during inventory";
    }
    if (status === "INVALID_REFERENCE") {
      return "Invalid reference format (expected ConfigMap.key)";
    }
    if (status === "CONFIGMAP_NOT_FOUND") {
      return "Referenced ConfigMap not found in commons/<env>/configmaps scope";
    }
    if (status === "KEY_NOT_FOUND") {
      return "ConfigMap found but referenced key is missing";
    }
    return `Non-standard status: ${status}`;
  };

  const statusKeys = Object.keys(summary.statusCounts).sort((a, b) => a.localeCompare(b));
  for (const status of statusKeys) {
    add(`status.${status}`, summary.statusCounts[status], statusDescription(status));
  }

  return metrics;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const inventoryRows: InventoryRow[] = readJsonReport(args.inventoryJson, INVENTORY_FIELDS).filter(
    (row) => row.environment === args.env,
  );

  if (inventoryRows.length === 0) {
    throw new Error(`No inventory rows found for environment: ${args.env}`);
  }

  const { keys: cmKeys, excluded: excludedMigrationConfigMaps } = readConfigMapKeys(args.root, args.env);
  if (cmKeys.length === 0) {
    throw new Error(`No ConfigMap keys found in commons/${args.env}/configmaps`);
  }

  const rowsByKey = new Map<string, InventoryRow[]>();
  for (const row of inventoryRows) {
    const id = keyId(row.configMap, row.key);
    const arr = rowsByKey.get(id);
    if (arr) {
      arr.push(row);
    } else {
      rowsByKey.set(id, [row]);
    }
  }

  const outputRows: OutputRow[] = [];

  for (const cmKey of cmKeys) {
    const id = keyId(cmKey.configMap, cmKey.key);
    const refs = rowsByKey.get(id) ?? [];
    const distinctWorkloadCount = new Set(refs.map((ref) => `${ref.workloadType}/${ref.workload}/${ref.valuesFile}`)).size;

    if (refs.length === 0) {
      outputRows.push({
        environment: args.env,
        configMap: cmKey.configMap,
        key: cmKey.key,
        sourceFile: cmKey.sourceFile,
        workloadType: "none",
        workload: "none",
        valuesFile: "",
        section: "",
        envVar: "",
        status: "NO_CONSUMER",
        distinctWorkloadCount: 0,
        classificationReason: "Key has no consumers in task1 inventory",
        classification: "OBSOLETE",
      });
      continue;
    }

    for (const ref of refs) {
      const decision = classifyRow(ref, distinctWorkloadCount);
      outputRows.push({
        environment: args.env,
        configMap: cmKey.configMap,
        key: cmKey.key,
        sourceFile: cmKey.sourceFile,
        workloadType: ref.workloadType,
        workload: ref.workload,
        valuesFile: ref.valuesFile,
        section: ref.section,
        envVar: ref.envVar,
        status: ref.status,
        distinctWorkloadCount,
        classificationReason: decision.reason,
        classification: decision.classification,
      });
    }
  }

  const groupedRows = groupRows(outputRows);

  for (const file of [args.outputCsv, args.outputJson, args.outputSummaryCsv, args.outputSummaryJson]) {
    ensureDir(path.dirname(file));
  }

  fs.writeFileSync(args.outputCsv, `${toCsv(groupedRows)}\n`, "utf8");
  writeJsonReport(args.outputJson, toJsonRecords(groupedRows));

  const summary = {
    environment: args.env,
    inventoryJson: path.relative(args.root, args.inventoryJson),
    outputCsv: path.relative(args.root, args.outputCsv),
    outputJson: path.relative(args.root, args.outputJson),
    configMapKeys: cmKeys.length,
    excludedMigrationConfigMaps: excludedMigrationConfigMaps.size,
    references: outputRows.filter((row) => row.workloadType !== "none").length,
    rows: groupedRows.length,
    classificationCounts: groupedRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.classification] = (acc[row.classification] ?? 0) + 1;
      return acc;
    }, {}),
    statusCounts: groupedRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const metrics = summaryMetrics(summary);
  fs.writeFileSync(args.outputSummaryCsv, `${summaryMetricsToCsv(metrics)}\n`, "utf8");
  writeJsonReport(args.outputSummaryJson, metrics);

  const emptyClassifications = groupedRows.filter((row) => row.classification.trim() === "").length;
  if (emptyClassifications > 0) {
    console.error(`Validation failed: ${emptyClassifications} rows with empty classification`);
    process.exit(1);
  }

  console.log(`Environment: ${args.env}`);
  console.log(`Input inventory: ${path.relative(args.root, args.inventoryJson)}`);
  console.log(`Output classification: ${path.relative(args.root, args.outputCsv)}, ${path.relative(args.root, args.outputJson)}`);
  console.log(`Output summary: ${path.relative(args.root, args.outputSummaryCsv)}, ${path.relative(args.root, args.outputSummaryJson)}`);
  console.log(`ConfigMap keys scanned: ${cmKeys.length}`);
  console.log(`Migration ConfigMaps excluded: ${excludedMigrationConfigMaps.size}`);
  console.log(`Workload references: ${summary.references}`);
  console.log(`Rows generated: ${groupedRows.length}`);

  for (const classification of CLASSIFICATIONS) {
    console.log(`${classification}: ${summary.classificationCounts[classification] ?? 0}`);
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
