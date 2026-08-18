import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";

type CliArgs = {
  env: string;
  root: string;
  inventoryCsv: string;
  outputCsv: string;
  outputSummaryCsv: string;
};

type WorkloadFile = {
  workloadType: "microservice" | "cronjob";
  workload: string;
  valuesFileAbs: string;
  valuesFileRel: string;
};

type MigrationConfigMapRef = {
  workloadType: "microservice" | "cronjob";
  workload: string;
  valuesFile: string;
  section: string;
  configMap: string;
};

function resolveInventoryCsv(root: string, env: string, cliValue?: string): string {
  if (cliValue) {
    return path.resolve(cliValue);
  }

  return path.join(root, "reports", "refactor-common-configmaps", `task-1-inventory-${env}.csv`);
}

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

type Classification = "COMMON_VALUE" | "WORKLOAD_VALUE" | "MIGRATION_ASSET" | "KEEP_AS_CONFIGMAP" | "OBSOLETE";

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
  consumerCount: number;
  classificationReason: string;
  classification: Classification;
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
  const inventoryCsv = resolveInventoryCsv(root, env, arg.get("inventory-csv"));
  const outputCsv = path.resolve(
    arg.get("output-csv") ??
      path.join(root, "reports", "refactor-common-configmaps", `task-2-common-configmaps-classification-${env}.csv`),
  );
  const outputSummaryCsv = path.resolve(
    arg.get("output-summary-csv") ??
      path.join(root, "reports", "refactor-common-configmaps", `task-2-classification-summary-${env}.csv`),
  );

  return { env, root, inventoryCsv, outputCsv, outputSummaryCsv };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function parseCsv(content: string): InventoryRow[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoverWorkloads(root: string, env: string, workloadType: "microservice" | "cronjob"): WorkloadFile[] {
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

function collectMigrationConfigMapRefs(
  node: unknown,
  currentPath: string,
  refs: Array<{ section: string; configMap: string }>,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, idx) => {
      const nextPath = currentPath ? `${currentPath}[${idx}]` : `[${idx}]`;
      collectMigrationConfigMapRefs(item, nextPath, refs);
    });
    return;
  }

  if (!isRecord(node)) {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (key === "migrationsConfigmap" && typeof value === "string" && value.trim().length > 0) {
      refs.push({ section: nextPath, configMap: value.trim() });
      continue;
    }

    collectMigrationConfigMapRefs(value, nextPath, refs);
  }
}

function discoverMigrationConfigMapRefs(root: string, env: string): MigrationConfigMapRef[] {
  const workloadFiles = [
    ...discoverWorkloads(root, env, "microservice"),
    ...discoverWorkloads(root, env, "cronjob"),
  ];

  const refs: MigrationConfigMapRef[] = [];

  for (const workloadFile of workloadFiles) {
    const raw = fs.readFileSync(workloadFile.valuesFileAbs, "utf8");
    const doc = YAML.parse(raw);
    const localRefs: Array<{ section: string; configMap: string }> = [];
    collectMigrationConfigMapRefs(doc, "", localRefs);

    for (const ref of localRefs) {
      refs.push({
        workloadType: workloadFile.workloadType,
        workload: workloadFile.workload,
        valuesFile: workloadFile.valuesFileRel,
        section: ref.section,
        configMap: ref.configMap,
      });
    }
  }

  return refs;
}

function readConfigMapKeys(root: string, env: string): ConfigMapKey[] {
  const configMapsDir = path.join(root, "commons", env, "configmaps");
  const files = listYamlFiles(configMapsDir);
  const out: ConfigMapKey[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const doc = YAML.parse(raw) as {
      kind?: string;
      metadata?: { name?: string };
      data?: Record<string, unknown>;
    };

    if (!doc || doc.kind !== "ConfigMap") {
      continue;
    }

    const configMap = doc.metadata?.name;
    if (!configMap) {
      continue;
    }

    const relPath = path.relative(root, file);
    for (const key of Object.keys(doc.data ?? {})) {
      out.push({ configMap, key, sourceFile: relPath });
    }
  }

  out.sort((a, b) => {
    return a.configMap.localeCompare(b.configMap) || a.key.localeCompare(b.key);
  });

  return out;
}

function keyId(configMap: string, key: string): string {
  return `${configMap}::${key}`;
}

function classifyRow(row: InventoryRow, consumerCount: number): { classification: Classification; reason: string } {
  if (row.status !== "OK") {
    return {
      classification: "KEEP_AS_CONFIGMAP",
      reason: `Inventory status ${row.status} requires conservative keep-as-configmap handling`,
    };
  }

  const sensitiveRegex = /password|passwd|secret|private.?key|api.?key|token/i;
  if (sensitiveRegex.test(row.envVar) || sensitiveRegex.test(row.key) || sensitiveRegex.test(row.configMap)) {
    return {
      classification: "WORKLOAD_VALUE",
      reason: "Sensitive-like naming pattern, kept workload-scoped pending owner review",
    };
  }

  if (consumerCount <= 1) {
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

function migrationAssetReason(configMap: string, consumerCount: number): string {
  return `Referenced by ${consumerCount} workload(s) via migrationsConfigmap mount; keep as migration asset outside commons values (${configMap})`;
}

function toCsv(rows: OutputRow[]): string {
  const header = [
    "environment",
    "configMap",
    "key",
    "sourceFile",
    "workloadType",
    "workload",
    "valuesFile",
    "section",
    "envVar",
    "status",
    "consumerCount",
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
        row.workload,
        row.valuesFile,
        row.section,
        row.envVar,
        row.status,
        String(row.consumerCount),
        row.classificationReason,
        row.classification,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}

function toSummaryCsv(summary: {
  environment: string;
  inventoryCsv: string;
  outputCsv: string;
  configMapKeys: number;
  rows: number;
  classificationCounts: Record<string, number>;
  statusCounts: Record<string, number>;
}): string {
  const lines: string[] = ["metric,value,description"];

  const classificationDescription = (classification: string): string => {
    if (classification === "COMMON_VALUE") {
      return "Rows for keys that should be promoted to shared common values because they are reused by multiple consumers and do not look sensitive";
    }
    if (classification === "WORKLOAD_VALUE") {
      return "Rows for keys that should remain workload-scoped, typically because they are used by only one consumer or their naming suggests sensitive or context-specific usage";
    }
    if (classification === "MIGRATION_ASSET") {
      return "Rows for keys that are temporary migration support assets and should be tracked separately from steady-state configuration";
    }
    if (classification === "KEEP_AS_CONFIGMAP") {
      return "Rows for keys that should stay as ConfigMap entries because automatic classification was not safe or the reference needs explicit manual handling";
    }
    if (classification === "OBSOLETE") {
      return "Rows for keys with no detected consumers in the inventory suggesting they may be removable after validation";
    }
    return `Rows classified as ${classification}`;
  };

  lines.push(`environment,${csvEscape(summary.environment)},${csvEscape("Environment name used for this run")}`);
  lines.push(`inventoryCsv,${csvEscape(summary.inventoryCsv)},${csvEscape("Input inventory file generated by TASK 1")}`);
  lines.push(`outputCsv,${csvEscape(summary.outputCsv)},${csvEscape("Output classification file generated by TASK 2")}`);
  lines.push(`configMapKeys,${summary.configMapKeys},${csvEscape("Total ConfigMap keys scanned in commons/<env>/configmaps")}`);
  lines.push(`rows,${summary.rows},${csvEscape("Total rows written in classification output")}`);

  for (const classification of ["COMMON_VALUE", "WORKLOAD_VALUE", "MIGRATION_ASSET", "KEEP_AS_CONFIGMAP", "OBSOLETE"]) {
    lines.push(
      `classification.${classification},${summary.classificationCounts[classification] ?? 0},${csvEscape(
        classificationDescription(classification),
      )}`,
    );
  }

  const statusDescription = (status: string): string => {
    if (status === "OK") {
      return "Row with valid reference: ConfigMap and key exist and were resolved correctly";
    }
    if (status === "MIGRATION_CONFIGMAP_REF") {
      return "ConfigMap mounted through migrationsConfigmap and tracked as migration asset";
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
    lines.push(`status.${status},${summary.statusCounts[status]},${csvEscape(statusDescription(status))}`);
  }

  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.inventoryCsv)) {
    throw new Error(`Inventory CSV not found: ${args.inventoryCsv}`);
  }

  const inventoryRaw = fs.readFileSync(args.inventoryCsv, "utf8");
  const inventoryRows = parseCsv(inventoryRaw).filter((row) => row.environment === args.env);

  if (inventoryRows.length === 0) {
    throw new Error(`No inventory rows found for environment: ${args.env}`);
  }

  const cmKeys = readConfigMapKeys(args.root, args.env);
  if (cmKeys.length === 0) {
    throw new Error(`No ConfigMap keys found in commons/${args.env}/configmaps`);
  }

  const migrationRefs = discoverMigrationConfigMapRefs(args.root, args.env);
  const migrationRefsByConfigMap = new Map<string, MigrationConfigMapRef[]>();
  for (const ref of migrationRefs) {
    const existing = migrationRefsByConfigMap.get(ref.configMap);
    if (existing) {
      existing.push(ref);
    } else {
      migrationRefsByConfigMap.set(ref.configMap, [ref]);
    }
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
    const consumerCount = new Set(refs.map((ref) => `${ref.workloadType}/${ref.workload}/${ref.valuesFile}`)).size;
    const migrationConsumers = migrationRefsByConfigMap.get(cmKey.configMap) ?? [];
    const migrationConsumerCount = new Set(
      migrationConsumers.map((ref) => `${ref.workloadType}/${ref.workload}/${ref.valuesFile}`),
    ).size;

    if (refs.length === 0) {
      if (migrationConsumers.length > 0) {
        for (const migrationRef of migrationConsumers) {
          outputRows.push({
            environment: args.env,
            configMap: cmKey.configMap,
            key: cmKey.key,
            sourceFile: cmKey.sourceFile,
            workloadType: migrationRef.workloadType,
            workload: migrationRef.workload,
            valuesFile: migrationRef.valuesFile,
            section: migrationRef.section,
            envVar: "migrationsConfigmap",
            status: "MIGRATION_CONFIGMAP_REF",
            consumerCount: migrationConsumerCount,
            classificationReason: migrationAssetReason(cmKey.configMap, migrationConsumerCount),
            classification: "MIGRATION_ASSET",
          });
        }
        continue;
      }

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
        consumerCount: 0,
        classificationReason: "Key has no consumers in task1 inventory",
        classification: "OBSOLETE",
      });
      continue;
    }

    for (const ref of refs) {
      const decision = classifyRow(ref, consumerCount);
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
        consumerCount,
        classificationReason: decision.reason,
        classification: decision.classification,
      });
    }
  }

  outputRows.sort((a, b) => {
    return (
      a.configMap.localeCompare(b.configMap) ||
      a.key.localeCompare(b.key) ||
      a.workloadType.localeCompare(b.workloadType) ||
      a.workload.localeCompare(b.workload) ||
      a.envVar.localeCompare(b.envVar)
    );
  });

  ensureDir(path.dirname(args.outputCsv));
  ensureDir(path.dirname(args.outputSummaryCsv));

  fs.writeFileSync(args.outputCsv, `${toCsv(outputRows)}\n`, "utf8");

  const summary = {
    environment: args.env,
    inventoryCsv: path.relative(args.root, args.inventoryCsv),
    outputCsv: path.relative(args.root, args.outputCsv),
    configMapKeys: cmKeys.length,
    rows: outputRows.length,
    classificationCounts: outputRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.classification] = (acc[row.classification] ?? 0) + 1;
      return acc;
    }, {}),
    statusCounts: outputRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {}),
  };

  fs.writeFileSync(args.outputSummaryCsv, `${toSummaryCsv(summary)}\n`, "utf8");

  const emptyClassifications = outputRows.filter((row) => row.classification.trim() === "").length;
  if (emptyClassifications > 0) {
    console.error(`Validation failed: ${emptyClassifications} rows with empty classification`);
    process.exit(1);
  }

  console.log(`Environment: ${args.env}`);
  console.log(`Input inventory: ${path.relative(args.root, args.inventoryCsv)}`);
  console.log(`Output classification: ${path.relative(args.root, args.outputCsv)}`);
  console.log(`Output summary: ${path.relative(args.root, args.outputSummaryCsv)}`);
  console.log(`ConfigMap keys scanned: ${cmKeys.length}`);
  console.log(`Rows generated: ${outputRows.length}`);

  for (const classification of ["COMMON_VALUE", "WORKLOAD_VALUE", "MIGRATION_ASSET", "KEEP_AS_CONFIGMAP", "OBSOLETE"]) {
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
