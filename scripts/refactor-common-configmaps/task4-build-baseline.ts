import * as fs from "fs";
import * as path from "path";
import { csvEscape } from "./csv.js";
import { readJsonReport, writeJsonReport } from "./json-report.js";
import { readApplicationConfigMaps } from "./migration-assets.js";

type CliArgs = {
  env: string;
  root: string;
  inventoryJson: string;
  outputCsv: string;
  outputJson: string;
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

type BaselineRow = {
  environment: string;
  workloadType: string;
  workload: string;
  valuesFile: string;
  section: string;
  envVar: string;
  sourceConfigMap: string;
  sourceKey: string;
  expectedValue: string;
  sourceFile: string;
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
  const reportsDir = path.join(root, "reports", "refactor-common-configmaps");
  const inventoryJson = path.resolve(arg.get("inventory-json") ?? path.join(reportsDir, `task-1-inventory-${env}.json`));
  const outputCsv = path.resolve(arg.get("output-csv") ?? path.join(reportsDir, `task-4-baseline-${env}.csv`));
  const outputJson = path.resolve(arg.get("output-json") ?? path.join(reportsDir, `task-4-baseline-${env}.json`));

  return { env, root, inventoryJson, outputCsv, outputJson };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readConfigMapData(root: string, env: string): Map<string, Map<string, string>> {
  const mapByName = new Map<string, Map<string, string>>();
  for (const configMap of readApplicationConfigMaps(root, env).configMaps.values()) {
    mapByName.set(configMap.name, configMap.data);
  }
  return mapByName;
}

function buildBaselineRows(inventory: InventoryRow[], env: string, configMaps: Map<string, Map<string, string>>): BaselineRow[] {
  const out: BaselineRow[] = [];

  for (const row of inventory) {
    if (row.environment !== env) {
      continue;
    }

    if (row.status !== "OK") {
      continue;
    }

    if (!row.envVar || !row.configMap || !row.key) {
      continue;
    }

    const configMapData = configMaps.get(row.configMap);
    if (!configMapData) {
      throw new Error(
        `ConfigMap not found for baseline extraction: ${row.configMap} (workload=${row.workload}, envVar=${row.envVar})`,
      );
    }

    if (!configMapData.has(row.key)) {
      throw new Error(
        `ConfigMap key not found for baseline extraction: ${row.configMap}.${row.key} (workload=${row.workload}, envVar=${row.envVar})`,
      );
    }

    out.push({
      environment: row.environment,
      workloadType: row.workloadType,
      workload: row.workload,
      valuesFile: row.valuesFile,
      section: row.section,
      envVar: row.envVar,
      sourceConfigMap: row.configMap,
      sourceKey: row.key,
      expectedValue: configMapData.get(row.key) ?? "",
      sourceFile: row.sourceFile,
    });
  }

  out.sort(
    (a, b) =>
      a.workloadType.localeCompare(b.workloadType) ||
      a.workload.localeCompare(b.workload) ||
      a.envVar.localeCompare(b.envVar),
  );

  return out;
}

function toCsv(rows: BaselineRow[]): string {
  const header = [
    "environment",
    "workloadType",
    "workload",
    "valuesFile",
    "section",
    "envVar",
    "sourceConfigMap",
    "sourceKey",
    "expectedValue",
    "sourceFile",
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
        row.sourceConfigMap,
        row.sourceKey,
        row.expectedValue,
        row.sourceFile,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const inventoryRows: InventoryRow[] = readJsonReport(args.inventoryJson, INVENTORY_FIELDS);
  const configMapValues = readConfigMapData(args.root, args.env);
  const baselineRows = buildBaselineRows(inventoryRows, args.env, configMapValues);

  if (baselineRows.length === 0) {
    throw new Error(`No baseline rows generated for environment: ${args.env}`);
  }

  ensureDir(path.dirname(args.outputCsv));
  ensureDir(path.dirname(args.outputJson));
  fs.writeFileSync(args.outputCsv, `${toCsv(baselineRows)}\n`, "utf8");
  writeJsonReport(args.outputJson, baselineRows);

  console.log(`Environment: ${args.env}`);
  console.log(`Input inventory: ${path.relative(args.root, args.inventoryJson)}`);
  console.log(`Output baseline CSV: ${path.relative(args.root, args.outputCsv)}`);
  console.log(`Output baseline JSON: ${path.relative(args.root, args.outputJson)}`);
  console.log(`Rows generated: ${baselineRows.length}`);
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