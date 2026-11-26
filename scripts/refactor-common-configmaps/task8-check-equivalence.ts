import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { Document } from "yaml";
import { csvEscape } from "./csv.js";
import { readJsonReport, writeJsonReport } from "./json-report.js";
import { readApplicationConfigMaps } from "./migration-assets.js";
import { configMapFromDocument, scalarText, yamlDocument, yamlDocuments } from "./yaml-source.js";

type CliArgs = {
  env: string;
  root: string;
  inventoryJson: string;
  baselineJson: string;
  outputTargetCsv: string;
  outputTargetJson: string;
  outputComparisonCsv: string;
  outputComparisonJson: string;
  commonValuesFile: string;
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

const BASELINE_FIELDS = ["environment", "workloadType", "workload", "section", "envVar", "expectedValue"] as const;

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

  const inventoryJson = path.resolve(
    arg.get("inventory-json") ?? path.join(reportsDir, `task-1-inventory-${env}.json`),
  );
  const baselineJson = path.resolve(
    arg.get("baseline-json") ?? path.join(reportsDir, `task-4-baseline-${env}.json`),
  );
  const outputTargetCsv = path.resolve(
    arg.get("output-target-csv") ?? path.join(reportsDir, `task-8-equivalence-target-${env}.csv`),
  );
  const outputComparisonCsv = path.resolve(
    arg.get("output-comparison-csv") ?? path.join(reportsDir, `task-8-equivalence-${env}.csv`),
  );
  const outputTargetJson = path.resolve(
    arg.get("output-target-json") ?? path.join(reportsDir, `task-8-equivalence-target-${env}.json`),
  );
  const outputComparisonJson = path.resolve(
    arg.get("output-comparison-json") ?? path.join(reportsDir, `task-8-equivalence-${env}.json`),
  );

  const commonValuesFile = arg.get("common-values")
    ? path.resolve(arg.get("common-values") as string)
    : path.join(root, "commons", env, "values-commons.yaml");

  return {
    env,
    root,
    inventoryJson,
    baselineJson,
    outputTargetCsv,
    outputTargetJson,
    outputComparisonCsv,
    outputComparisonJson,
    commonValuesFile,
  };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readConfigMapDataFromDocs(docs: Document.Parsed[], label: string): Map<string, Map<string, string>> {
  const mapByName = new Map<string, Map<string, string>>();
  for (const doc of docs) {
    const configMap = configMapFromDocument(doc, label);
    if (configMap) {
      mapByName.set(configMap.name, configMap.data);
    }
  }
  return mapByName;
}

function readConfigMapData(root: string, env: string): Map<string, Map<string, string>> {
  const mapByName = new Map<string, Map<string, string>>();
  for (const configMap of readApplicationConfigMaps(root, env).configMaps.values()) {
    mapByName.set(configMap.name, configMap.data);
  }
  return mapByName;
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
  offlineFrontend: boolean,
): Document.Parsed[] {
  const chartPath = chartPathFor(workloadType);
  const baseValues = baseValuesFileFor(args.root, args.env, workloadType);
  const imagesValues = path.join(args.root, "commons", args.env, "images.yaml");

  const valuesFiles = [args.commonValuesFile, baseValues, workloadValuesFile, imagesValues];

  for (const file of valuesFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required values file not found for render: ${path.relative(args.root, file)}`);
    }
  }

  const templateArgs = ["template", workload, chartPath];
  for (const file of valuesFiles) {
    templateArgs.push("-f", file);
  }

  if (offlineFrontend) {
    templateArgs.push("--set", "enableLookup=false");
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

  return yamlDocuments(result.stdout, `helm template ${workloadType}/${workload}`);
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

// Kubernetes expands $(VAR) only when VAR is defined earlier in the same container env list; moving a
// variable between env sections can change that order without changing any value.
function findDependentEnvIssues(envEntries: unknown[], container: string): string[] {
  const names = envEntries.map((entry) =>
    entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string"
      ? ((entry as Record<string, unknown>).name as string)
      : "",
  );
  const issues: string[] = [];

  envEntries.forEach((entry, index) => {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>).value : undefined;
    if (typeof value !== "string") {
      return;
    }

    for (const match of value.matchAll(/(?<!\$)\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
      const dependency = match[1];
      const dependencyIndex = names.indexOf(dependency);
      if (dependencyIndex < 0) {
        issues.push(`${container}: ${names[index]} references $(${dependency}), which is not defined in the container env`);
      } else if (dependencyIndex > index) {
        issues.push(
          `${container}: ${names[index]} references $(${dependency}), which is defined after it and will not be expanded`,
        );
      }
    }
  });

  return issues;
}

const FRONTEND_PATH = ["frontend", "env.js", "window.pagopa_env"];
const FRONTEND_SECTION = [...FRONTEND_PATH, "fromConfigmaps"].join(".");

function extractFrontendValues(
  renderedConfigMaps: Map<string, Map<string, string>>,
  workloadValuesFile: string,
  context: RenderContext,
  rows: InventoryRow[],
): Map<string, TargetValue> {
  const out = new Map<string, TargetValue>();
  if (rows.length === 0) {
    return out;
  }

  const scripts = [...renderedConfigMaps.values()].flatMap((data) => {
    const script = data.get("env.js");
    const match = script?.match(/^window\.pagopa_env\s*=\s*(\{[\s\S]*?^\s*\})/m);
    return match ? [match[1]] : [];
  });
  if (scripts.length !== 1) {
    throw new Error(`Expected exactly one rendered window.pagopa_env object for ${workloadValuesFile}`);
  }
  const values = JSON.parse(scripts[0]) as Record<string, unknown>;
  const workloadValues = yamlDocument(workloadValuesFile);
  for (const row of rows) {
    const value = Object.hasOwn(values, row.envVar) ? values[row.envVar] : undefined;
    if (typeof value !== "string") {
      continue;
    }
    const ref = scalarText(workloadValues.getIn([...FRONTEND_PATH, "fromConfigmaps", row.envVar], true));
    if (ref && value === "LOOKUP_PLACEHOLDER") {
      const dot = ref.indexOf(".");
      const actualValue = dot > 0 ? resolveFromConfigMapRef(ref.slice(0, dot), ref.slice(dot + 1), context) : undefined;
      if (actualValue !== undefined) {
        out.set(row.envVar, { actualValue, source: "configMapRef", sourceRef: ref });
      }
    } else {
      out.set(row.envVar, { actualValue: value, source: "value", sourceRef: "env.js" });
    }
  }
  return out;
}

function renderAndExtractForWorkload(
  args: CliArgs,
  workloadType: string,
  workload: string,
  workloadValuesFile: string,
  commonsConfigMaps: Map<string, Map<string, string>>,
  frontendRows: InventoryRow[],
): {
  frontend: Map<string, TargetValue>;
  main: Map<string, TargetValue>;
  init: Map<string, TargetValue>;
  dependencyIssues: string[];
} {
  const docs = renderWorkload(args, workloadType, workload, workloadValuesFile, frontendRows.length > 0);
  const workloadDoc = findWorkloadDoc(
    docs.map((doc) => doc.toJSON() as Record<string, unknown> | null),
    workloadType,
  );
  const renderedConfigMaps = readConfigMapDataFromDocs(docs, `helm template ${workloadType}/${workload}`);
  const context: RenderContext = { commonsConfigMaps, renderedConfigMaps };

  const mainEnv = getMainContainerEnv(workloadDoc, workloadType);
  const initEnv = getInitContainerEnv(workloadDoc, workloadType);

  return {
    frontend: extractFrontendValues(renderedConfigMaps, workloadValuesFile, context, frontendRows),
    main: extractEnvValues(mainEnv, context),
    init: extractEnvValues(initEnv, context),
    dependencyIssues: [
      ...findDependentEnvIssues(mainEnv, "container"),
      ...findDependentEnvIssues(initEnv, "initContainer"),
    ],
  };
}

function chooseEnvMapForSection(
  section: string,
  extracted: { frontend: Map<string, TargetValue>; main: Map<string, TargetValue>; init: Map<string, TargetValue> },
): Map<string, TargetValue> {
  if (section === FRONTEND_SECTION) {
    return extracted.frontend;
  }
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

  if (!fs.existsSync(args.baselineJson)) {
    throw new Error(`Baseline JSON not found: ${args.baselineJson}. Run task4-build-baseline first.`);
  }

  const inventoryRows = (readJsonReport(args.inventoryJson, INVENTORY_FIELDS) as InventoryRow[]).filter(
    (row) => row.environment === args.env && row.status === "OK" &&
      (row.section === FRONTEND_SECTION || /(?:^|\.)envFromConfigmaps$/.test(row.section)),
  );

  if (inventoryRows.length === 0) {
    throw new Error(`No inventory rows found for environment: ${args.env}`);
  }

  const baselineRows = (readJsonReport(args.baselineJson, BASELINE_FIELDS) as BaselineRow[]).filter(
    (row) => row.environment === args.env,
  );
  if (baselineRows.length === 0) {
    throw new Error(`No baseline rows found for environment: ${args.env}`);
  }

  const baselineByKey = new Map<string, BaselineRow>();
  for (const row of baselineRows) {
    baselineByKey.set(keyForRow(row), row);
  }

  const groups = new Map<string, InventoryRow[]>();
  for (const row of inventoryRows) {
    const groupKey = `${row.workloadType}|${row.workload}|${row.valuesFile}`;
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  const hasMigratedReference = [...groups.values()].some((rows) => {
    const document = yamlDocument(path.resolve(args.root, rows[0].valuesFile));
    return rows.some((row) => {
      const section = row.section.replace(/envFromConfigmaps$/, "env");
      const segments = row.section === FRONTEND_SECTION ? FRONTEND_PATH : section.split(".").flatMap((segment) => {
        const [key, ...indexes] = segment.split("[");
        return [...(key ? [key] : []), ...indexes.map((index) => Number.parseInt(index, 10))];
      });
      const value = scalarText(document.getIn([...segments, row.envVar], true));
      return /^\{\{\s*\.Values\.commons(?:\.[A-Za-z0-9_]+)+\s*\}\}$/.test(value ?? "");
    });
  });
  if (!hasMigratedReference) {
    throw new Error("No migrated common values references found in the inventoried workloads. Run task 7 (migrate) first.");
  }

  const commonsConfigMaps = readConfigMapData(args.root, args.env);

  const extractedByWorkload = new Map<string, ReturnType<typeof renderAndExtractForWorkload>>();
  const errors: string[] = [];
  for (const rows of groups.values()) {
    const [group] = rows;
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
      rows.filter((row) => row.section === FRONTEND_SECTION),
    );

    extractedByWorkload.set(`${group.workloadType}|${group.workload}`, extracted);
    for (const issue of extracted.dependencyIssues) {
      errors.push(`${args.env}/${group.workload}: ${issue}`);
    }
  }

  const targetRows: TargetRow[] = [];
  const comparisonRows: ComparisonRow[] = [];

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

  for (const file of [args.outputTargetCsv, args.outputTargetJson, args.outputComparisonCsv, args.outputComparisonJson]) {
    ensureDir(path.dirname(file));
  }
  fs.writeFileSync(args.outputTargetCsv, `${toTargetCsv(targetRows)}\n`, "utf8");
  writeJsonReport(args.outputTargetJson, targetRows);
  fs.writeFileSync(args.outputComparisonCsv, `${toComparisonCsv(comparisonRows)}\n`, "utf8");
  writeJsonReport(args.outputComparisonJson, comparisonRows);

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
  console.log(`Output target JSON: ${path.relative(args.root, args.outputTargetJson)}`);
  console.log(`Output comparison JSON: ${path.relative(args.root, args.outputComparisonJson)}`);
  console.log(
    `Common values file used: ${path.relative(args.root, args.commonValuesFile)}`,
  );

  const migratedVariables = targetRows.filter((row) => row.source === "value").length;
  console.log(`Migrated variables (value rendered from the workload values): ${migratedVariables}`);

  if (migratedVariables === 0) {
    // Without migrated references every value is read from the same ConfigMaps as the baseline: the check would be meaningless.
    console.error(
      "\nNo migrated variable found in the rendered workloads: run the workload migration (task 7) first. " +
        "Without it the check only compares the current configuration with itself.",
    );
    process.exit(1);
  }

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
