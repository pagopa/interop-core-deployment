import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import YAML from "yaml";

type CliArgs = {
  env: string;
  root: string;
  inventoryCsv: string;
  baselineCsv: string;
  outputTargetCsv: string;
  outputComparisonCsv: string;
  commonValuesFile?: string;
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
  section: string;
  envVar: string;
  expectedValue: string;
};

type TargetValue = {
  actualValue: string;
  source: "value" | "configMapRef";
  sourceRef: string;
};

type TargetRow = {
  environment: string;
  workloadType: string;
  workload: string;
  section: string;
  envVar: string;
  actualValue: string;
  source: string;
  sourceRef: string;
};

type ComparisonRow = {
  environment: string;
  workloadType: string;
  workload: string;
  section: string;
  envVar: string;
  expectedValue: string;
  actualValue: string;
  status: "MATCH" | "MISMATCH" | "MISSING_TARGET";
};

type RenderContext = {
  commonsConfigMaps: Map<string, Map<string, string>>;
  renderedConfigMaps: Map<string, Map<string, string>>;
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

  const inventoryCsv = path.resolve(
    arg.get("inventory-csv") ?? path.join(reportsDir, `task-1-inventory-${env}.csv`),
  );
  const baselineCsv = path.resolve(
    arg.get("baseline-csv") ?? path.join(reportsDir, `task-4-baseline-${env}.csv`),
  );
  const outputTargetCsv = path.resolve(
    arg.get("output-target-csv") ?? path.join(reportsDir, `task-4-target-${env}.csv`),
  );
  const outputComparisonCsv = path.resolve(
    arg.get("output-comparison-csv") ?? path.join(reportsDir, `task-4-equivalence-${env}.csv`),
  );

  const commonValuesCandidate = arg.get("common-values")
    ? path.resolve(arg.get("common-values") as string)
    : path.join(root, "commons", env, "values-commons.yaml");

  const commonValuesFile = fs.existsSync(commonValuesCandidate) ? commonValuesCandidate : undefined;

  return {
    env,
    root,
    inventoryCsv,
    baselineCsv,
    outputTargetCsv,
    outputComparisonCsv,
    commonValuesFile,
  };
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

function parseCsvRows(content: string): { header: string[]; rows: string[][] } {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { header: [], rows: [] };
  }

  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { header, rows };
}

function idx(header: string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) {
    throw new Error(`Missing expected CSV header column: ${name}`);
  }
  return index;
}

function parseInventoryCsv(content: string): InventoryRow[] {
  const { header, rows } = parseCsvRows(content);
  if (header.length === 0) {
    return [];
  }

  const indices = {
    environment: idx(header, "environment"),
    workloadType: idx(header, "workloadType"),
    workload: idx(header, "workload"),
    valuesFile: idx(header, "valuesFile"),
    section: idx(header, "section"),
    envVar: idx(header, "envVar"),
    configMap: idx(header, "configMap"),
    key: idx(header, "key"),
    sourceFile: idx(header, "sourceFile"),
    status: idx(header, "status"),
  };

  return rows.map((fields) => ({
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
  }));
}

function parseBaselineCsv(content: string): BaselineRow[] {
  const { header, rows } = parseCsvRows(content);
  if (header.length === 0) {
    return [];
  }

  const indices = {
    environment: idx(header, "environment"),
    workloadType: idx(header, "workloadType"),
    workload: idx(header, "workload"),
    section: idx(header, "section"),
    envVar: idx(header, "envVar"),
    expectedValue: idx(header, "expectedValue"),
  };

  return rows.map((fields) => ({
    environment: fields[indices.environment] ?? "",
    workloadType: fields[indices.workloadType] ?? "",
    workload: fields[indices.workload] ?? "",
    section: fields[indices.section] ?? "",
    envVar: fields[indices.envVar] ?? "",
    expectedValue: fields[indices.expectedValue] ?? "",
  }));
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

function readConfigMapDataFromDocs(docs: Array<Record<string, unknown> | null>): Map<string, Map<string, string>> {
  const mapByName = new Map<string, Map<string, string>>();

  for (const parsed of docs) {
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

  return mapByName;
}

function readConfigMapData(root: string, env: string): Map<string, Map<string, string>> {
  const configmapsDir = path.join(root, "commons", env, "configmaps");
  const files = listYamlFiles(configmapsDir);
  const docs: Array<Record<string, unknown> | null> = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsedDocs = YAML.parseAllDocuments(raw).map(
      (doc) => doc.toJSON() as Record<string, unknown> | null,
    );
    docs.push(...parsedDocs);
  }

  return readConfigMapDataFromDocs(docs);
}

function keyForRow(row: {
  environment: string;
  workloadType: string;
  workload: string;
  section: string;
  envVar: string;
}): string {
  return `${row.environment}|${row.workloadType}|${row.workload}|${row.section}|${row.envVar}`;
}

function chartPathFor(workloadType: string): string {
  if (workloadType === "microservice") {
    return "charts/interop-eks-microservice-chart";
  }
  if (workloadType === "cronjob") {
    return "charts/interop-eks-cronjob-chart";
  }
  throw new Error(`Unsupported workloadType: ${workloadType}`);
}

function baseValuesFileFor(root: string, env: string, workloadType: string): string {
  if (workloadType === "microservice") {
    return path.join(root, "commons", env, "values-microservice.yaml");
  }
  if (workloadType === "cronjob") {
    return path.join(root, "commons", env, "values-cronjob.yaml");
  }
  throw new Error(`Unsupported workloadType: ${workloadType}`);
}

function renderWorkload(
  args: CliArgs,
  workloadType: string,
  workload: string,
  workloadValuesFile: string,
): Array<Record<string, unknown> | null> {
  const chartPath = chartPathFor(workloadType);
  const baseValues = baseValuesFileFor(args.root, args.env, workloadType);
  const imagesValues = path.join(args.root, "commons", args.env, "images.yaml");

  const valuesFiles = [baseValues, imagesValues, workloadValuesFile];
  if (args.commonValuesFile) {
    valuesFiles.splice(1, 0, args.commonValuesFile);
  }

  for (const file of valuesFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required values file not found for render: ${path.relative(args.root, file)}`);
    }
  }

  const templateArgs = ["template", workload, chartPath];
  for (const file of valuesFiles) {
    templateArgs.push("-f", file);
  }

  const result = spawnSync("helm", templateArgs, {
    cwd: args.root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      [
        `helm template failed for ${workloadType}/${workload}`,
        `command: helm ${templateArgs.join(" ")}`,
        stderr ? `stderr: ${stderr}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("\n"),
    );
  }

  return YAML.parseAllDocuments(result.stdout).map(
    (doc) => doc.toJSON() as Record<string, unknown> | null,
  );
}

function getMainContainerEnv(doc: Record<string, unknown>, workloadType: string): unknown[] {
  if (workloadType === "microservice") {
    const containers = (((doc.spec as Record<string, unknown>)?.template as Record<string, unknown>)
      ?.spec as Record<string, unknown>)?.containers as unknown[] | undefined;
    return Array.isArray(containers) && containers.length > 0
      ? ((((containers[0] as Record<string, unknown>)?.env as unknown[]) ?? []) as unknown[])
      : [];
  }

  const containers = (((((doc.spec as Record<string, unknown>)?.jobTemplate as Record<string, unknown>)
    ?.spec as Record<string, unknown>)?.template as Record<string, unknown>)
    ?.spec as Record<string, unknown>)?.containers as unknown[] | undefined;
  return Array.isArray(containers) && containers.length > 0
    ? ((((containers[0] as Record<string, unknown>)?.env as unknown[]) ?? []) as unknown[])
    : [];
}

function getInitContainerEnv(doc: Record<string, unknown>, workloadType: string): unknown[] {
  if (workloadType === "microservice") {
    const initContainers = (((doc.spec as Record<string, unknown>)?.template as Record<string, unknown>)
      ?.spec as Record<string, unknown>)?.initContainers as unknown[] | undefined;
    if (!Array.isArray(initContainers)) {
      return [];
    }

    const migrateDb = initContainers.find(
      (entry) =>
        typeof (entry as Record<string, unknown>)?.name === "string" &&
        (entry as Record<string, unknown>).name === "migrate-db",
    ) as Record<string, unknown> | undefined;

    if (migrateDb?.env && Array.isArray(migrateDb.env)) {
      return migrateDb.env as unknown[];
    }

    if (initContainers.length > 0) {
      const first = initContainers[0] as Record<string, unknown>;
      return Array.isArray(first.env) ? (first.env as unknown[]) : [];
    }

    return [];
  }

  const initContainers = (((((doc.spec as Record<string, unknown>)?.jobTemplate as Record<string, unknown>)
    ?.spec as Record<string, unknown>)?.template as Record<string, unknown>)
    ?.spec as Record<string, unknown>)?.initContainers as unknown[] | undefined;

  if (!Array.isArray(initContainers) || initContainers.length === 0) {
    return [];
  }

  const first = initContainers[0] as Record<string, unknown>;
  return Array.isArray(first.env) ? (first.env as unknown[]) : [];
}

function resolveFromConfigMapRef(
  configMapName: string,
  key: string,
  context: RenderContext,
): string | undefined {
  const rendered = context.renderedConfigMaps.get(configMapName);
  if (rendered && rendered.has(key)) {
    return rendered.get(key);
  }

  const commons = context.commonsConfigMaps.get(configMapName);
  if (commons && commons.has(key)) {
    return commons.get(key);
  }

  return undefined;
}

function extractEnvValues(
  envEntries: unknown[],
  context: RenderContext,
): Map<string, TargetValue> {
  const out = new Map<string, TargetValue>();

  for (const entry of envEntries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const envObj = entry as Record<string, unknown>;
    const name = typeof envObj.name === "string" ? envObj.name : "";
    if (!name) {
      continue;
    }

    if (typeof envObj.value === "string") {
      out.set(name, {
        actualValue: envObj.value,
        source: "value",
        sourceRef: "env.value",
      });
      continue;
    }

    const valueFrom = envObj.valueFrom as Record<string, unknown> | undefined;
    const configMapKeyRef = (valueFrom?.configMapKeyRef ?? {}) as Record<string, unknown>;
    const configMapName =
      typeof configMapKeyRef.name === "string" ? configMapKeyRef.name : "";
    const configMapKey = typeof configMapKeyRef.key === "string" ? configMapKeyRef.key : "";

    if (configMapName && configMapKey) {
      const resolved = resolveFromConfigMapRef(configMapName, configMapKey, context);
      if (resolved !== undefined) {
        out.set(name, {
          actualValue: resolved,
          source: "configMapRef",
          sourceRef: `${configMapName}.${configMapKey}`,
        });
      }
    }
  }

  return out;
}

function findWorkloadDoc(
  docs: Array<Record<string, unknown> | null>,
  workloadType: string,
): Record<string, unknown> {
  const expectedKind = workloadType === "microservice" ? "Deployment" : "CronJob";
  const doc = docs.find((parsed) => parsed?.kind === expectedKind);
  if (!doc) {
    throw new Error(`Rendered manifest does not contain kind ${expectedKind}`);
  }

  return doc;
}

function renderAndExtractForWorkload(
  args: CliArgs,
  workloadType: string,
  workload: string,
  workloadValuesFile: string,
  commonsConfigMaps: Map<string, Map<string, string>>,
): {
  main: Map<string, TargetValue>;
  init: Map<string, TargetValue>;
} {
  const docs = renderWorkload(args, workloadType, workload, workloadValuesFile);
  const workloadDoc = findWorkloadDoc(docs, workloadType);
  const renderedConfigMaps = readConfigMapDataFromDocs(docs);
  const context: RenderContext = { commonsConfigMaps, renderedConfigMaps };

  const mainEnv = getMainContainerEnv(workloadDoc, workloadType);
  const initEnv = getInitContainerEnv(workloadDoc, workloadType);

  return {
    main: extractEnvValues(mainEnv, context),
    init: extractEnvValues(initEnv, context),
  };
}

function chooseEnvMapForSection(
  section: string,
  extracted: { main: Map<string, TargetValue>; init: Map<string, TargetValue> },
): Map<string, TargetValue> {
  return section.includes("flywayInitContainer") ? extracted.init : extracted.main;
}

function toTargetCsv(rows: TargetRow[]): string {
  const header = [
    "environment",
    "workloadType",
    "workload",
    "section",
    "envVar",
    "actualValue",
    "source",
    "sourceRef",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.environment,
        row.workloadType,
        row.workload,
        row.section,
        row.envVar,
        row.actualValue,
        row.source,
        row.sourceRef,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}

function toComparisonCsv(rows: ComparisonRow[]): string {
  const header = [
    "environment",
    "workloadType",
    "workload",
    "section",
    "envVar",
    "expectedValue",
    "actualValue",
    "status",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.environment,
        row.workloadType,
        row.workload,
        row.section,
        row.envVar,
        row.expectedValue,
        row.actualValue,
        row.status,
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
  if (!fs.existsSync(args.baselineCsv)) {
    throw new Error(
      `Baseline CSV not found: ${args.baselineCsv}. Run task4-build-baseline first.`,
    );
  }

  const inventoryRows = parseInventoryCsv(fs.readFileSync(args.inventoryCsv, "utf8")).filter(
    (row) => row.environment === args.env && row.status === "OK",
  );

  if (inventoryRows.length === 0) {
    throw new Error(`No inventory rows found for environment: ${args.env}`);
  }

  const baselineRows = parseBaselineCsv(fs.readFileSync(args.baselineCsv, "utf8")).filter(
    (row) => row.environment === args.env,
  );
  if (baselineRows.length === 0) {
    throw new Error(`No baseline rows found for environment: ${args.env}`);
  }

  const baselineByKey = new Map<string, BaselineRow>();
  for (const row of baselineRows) {
    baselineByKey.set(keyForRow(row), row);
  }

  const commonsConfigMaps = readConfigMapData(args.root, args.env);

  const groups = new Map<string, { workloadType: string; workload: string; valuesFile: string }>();
  for (const row of inventoryRows) {
    const groupKey = `${row.workloadType}|${row.workload}|${row.valuesFile}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        workloadType: row.workloadType,
        workload: row.workload,
        valuesFile: row.valuesFile,
      });
    }
  }

  const extractedByWorkload = new Map<string, { main: Map<string, TargetValue>; init: Map<string, TargetValue> }>();
  for (const group of groups.values()) {
    const absoluteValuesFile = path.resolve(args.root, group.valuesFile);
    if (!fs.existsSync(absoluteValuesFile)) {
      throw new Error(`Workload values file not found: ${group.valuesFile}`);
    }

    const extracted = renderAndExtractForWorkload(
      args,
      group.workloadType,
      group.workload,
      absoluteValuesFile,
      commonsConfigMaps,
    );

    extractedByWorkload.set(`${group.workloadType}|${group.workload}`, extracted);
  }

  const targetRows: TargetRow[] = [];
  const comparisonRows: ComparisonRow[] = [];
  const errors: string[] = [];

  for (const row of inventoryRows) {
    const workloadKey = `${row.workloadType}|${row.workload}`;
    const extracted = extractedByWorkload.get(workloadKey);
    if (!extracted) {
      throw new Error(`Missing extracted env data for ${workloadKey}`);
    }

    const envMap = chooseEnvMapForSection(row.section, extracted);
    const targetValue = envMap.get(row.envVar);

    if (targetValue) {
      targetRows.push({
        environment: row.environment,
        workloadType: row.workloadType,
        workload: row.workload,
        section: row.section,
        envVar: row.envVar,
        actualValue: targetValue.actualValue,
        source: targetValue.source,
        sourceRef: targetValue.sourceRef,
      });
    }

    const baseline = baselineByKey.get(keyForRow(row));
    if (!baseline) {
      errors.push(
        `Missing baseline row for ${row.environment}/${row.workload} ${row.section}.${row.envVar}`,
      );
      continue;
    }

    if (!targetValue) {
      comparisonRows.push({
        environment: row.environment,
        workloadType: row.workloadType,
        workload: row.workload,
        section: row.section,
        envVar: row.envVar,
        expectedValue: baseline.expectedValue,
        actualValue: "",
        status: "MISSING_TARGET",
      });
      errors.push(
        `${row.environment}/${row.workload}: ${row.envVar} missing in rendered target (${row.section})`,
      );
      continue;
    }

    if (targetValue.actualValue !== baseline.expectedValue) {
      comparisonRows.push({
        environment: row.environment,
        workloadType: row.workloadType,
        workload: row.workload,
        section: row.section,
        envVar: row.envVar,
        expectedValue: baseline.expectedValue,
        actualValue: targetValue.actualValue,
        status: "MISMATCH",
      });
      errors.push(
        `${row.environment}/${row.workload}: ${row.envVar} expected="${baseline.expectedValue}" actual="${targetValue.actualValue}"`,
      );
      continue;
    }

    comparisonRows.push({
      environment: row.environment,
      workloadType: row.workloadType,
      workload: row.workload,
      section: row.section,
      envVar: row.envVar,
      expectedValue: baseline.expectedValue,
      actualValue: targetValue.actualValue,
      status: "MATCH",
    });
  }

  targetRows.sort(
    (a, b) =>
      a.workloadType.localeCompare(b.workloadType) ||
      a.workload.localeCompare(b.workload) ||
      a.section.localeCompare(b.section) ||
      a.envVar.localeCompare(b.envVar),
  );
  comparisonRows.sort(
    (a, b) =>
      a.workloadType.localeCompare(b.workloadType) ||
      a.workload.localeCompare(b.workload) ||
      a.section.localeCompare(b.section) ||
      a.envVar.localeCompare(b.envVar),
  );

  ensureDir(path.dirname(args.outputTargetCsv));
  ensureDir(path.dirname(args.outputComparisonCsv));
  fs.writeFileSync(args.outputTargetCsv, `${toTargetCsv(targetRows)}\n`, "utf8");
  fs.writeFileSync(args.outputComparisonCsv, `${toComparisonCsv(comparisonRows)}\n`, "utf8");

  const matches = comparisonRows.filter((row) => row.status === "MATCH").length;
  const mismatches = comparisonRows.filter((row) => row.status === "MISMATCH").length;
  const missing = comparisonRows.filter((row) => row.status === "MISSING_TARGET").length;

  console.log(`Environment: ${args.env}`);
  console.log(`Inventory rows in scope: ${inventoryRows.length}`);
  console.log(`Target rows extracted: ${targetRows.length}`);
  console.log(`Comparison rows: ${comparisonRows.length}`);
  console.log(`MATCH: ${matches}, MISMATCH: ${mismatches}, MISSING_TARGET: ${missing}`);
  console.log(`Output target CSV: ${path.relative(args.root, args.outputTargetCsv)}`);
  console.log(`Output comparison CSV: ${path.relative(args.root, args.outputComparisonCsv)}`);
  console.log(
    `Common values file used: ${args.commonValuesFile ? path.relative(args.root, args.commonValuesFile) : "<not provided / not found>"}`,
  );

  if (errors.length > 0) {
    console.error("\nEquivalence check failed. First mismatches:");
    for (const line of errors.slice(0, 25)) {
      console.error(`- ${line}`);
    }
    if (errors.length > 25) {
      console.error(`- ... ${errors.length - 25} more`);
    }
    process.exit(1);
  }

  console.log("Equivalence check passed.");
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
