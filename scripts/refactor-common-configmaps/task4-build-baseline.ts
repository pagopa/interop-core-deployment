import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";

type CliArgs = {
  env: string;
  root: string;
  inventoryCsv: string;
  outputCsv: string;
};

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
  const inventoryCsv = path.resolve(
    arg.get("inventory-csv") ??
      path.join(root, "reports", "refactor-common-configmaps", `task-1-inventory-${env}.csv`),
  );
  const outputCsv = path.resolve(
    arg.get("output-csv") ??
      path.join(root, "reports", "refactor-common-configmaps", `task-4-baseline-${env}.csv`),
  );

  return { env, root, inventoryCsv, outputCsv };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseInventoryCsv(content: string): InventoryRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const idx = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`Missing expected CSV header column: ${name}`);
    }
    return index;
  };

  const indices = {
    environment: idx("environment"),
    workloadType: idx("workloadType"),
    workload: idx("workload"),
    valuesFile: idx("valuesFile"),
    section: idx("section"),
    envVar: idx("envVar"),
    configMap: idx("configMap"),
    key: idx("key"),
    sourceFile: idx("sourceFile"),
    status: idx("status"),
  };

  const rows: InventoryRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]);
    rows.push({
      environment: fields[indices.environment] ?? "",
      workloadType: fields[indices.workloadType] ?? "",
      workload: fields[indices.workload] ?? "",
      valuesFile: fields[indices.valuesFile] ?? "",
      section: fields[indices.section] ?? "",
      envVar: fields[indices.envVar] ?? "",
      configMap: fields[indices.configMap] ?? "",
      key: fields[indices.key] ?? "",
      sourceFile: fields[indices.sourceFile] ?? "",
      status: fields[indices.status] ?? "",
    });
  }

  return rows;
}

function listYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listYamlFiles(abs));
      continue;
    }
    if (/\.ya?ml$/i.test(entry.name)) {
      out.push(abs);
    }
  }

  return out;
}

function readConfigMapData(root: string, env: string): Map<string, Map<string, string>> {
  const configmapsDir = path.join(root, "commons", env, "configmaps");
  const files = listYamlFiles(configmapsDir);
  const mapByName = new Map<string, Map<string, string>>();

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const docs = YAML.parseAllDocuments(raw);

    for (const doc of docs) {
      const parsed = doc.toJSON() as Record<string, unknown> | null;
      if (!parsed || parsed.kind !== "ConfigMap") {
        continue;
      }

      const metadata = (parsed.metadata ?? {}) as Record<string, unknown>;
      const name = typeof metadata.name === "string" ? metadata.name : "";
      if (!name) {
        continue;
      }

      const data = (parsed.data ?? {}) as Record<string, unknown>;
      const values = new Map<string, string>();

      for (const [key, value] of Object.entries(data)) {
        values.set(key, value === undefined || value === null ? "" : String(value));
      }

      mapByName.set(name, values);
    }
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

  if (!fs.existsSync(args.inventoryCsv)) {
    throw new Error(`Inventory CSV not found: ${args.inventoryCsv}`);
  }

  const inventoryRaw = fs.readFileSync(args.inventoryCsv, "utf8");
  const inventoryRows = parseInventoryCsv(inventoryRaw);
  const configMapValues = readConfigMapData(args.root, args.env);
  const baselineRows = buildBaselineRows(inventoryRows, args.env, configMapValues);

  if (baselineRows.length === 0) {
    throw new Error(`No baseline rows generated for environment: ${args.env}`);
  }

  ensureDir(path.dirname(args.outputCsv));
  fs.writeFileSync(args.outputCsv, `${toCsv(baselineRows)}\n`, "utf8");

  console.log(`Environment: ${args.env}`);
  console.log(`Input inventory: ${path.relative(args.root, args.inventoryCsv)}`);
  console.log(`Output baseline CSV: ${path.relative(args.root, args.outputCsv)}`);
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