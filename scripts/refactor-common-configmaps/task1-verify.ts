import * as fs from "fs";
import * as path from "path";
import { isMap, isScalar, isSeq } from "yaml";
import { readCommonConfigMaps, scalarText, yamlDocument } from "./yaml-source.js";

type WorkloadType = "microservice" | "cronjob";

type CliArgs = {
  env: string;
  root: string;
  outputDir: string;
};

type ConfigMapRecord = {
  name: string;
  keys: Set<string>;
  sourceFile: string;
};

type InventoryStatus = "OK" | "TEMPLATE_REFERENCE" | "INVALID_REFERENCE" | "CONFIGMAP_NOT_FOUND" | "KEY_NOT_FOUND";

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

  return { env, root, outputDir };
}

function loadConfigMaps(root: string, env: string): Map<string, ConfigMapRecord> {
  const index = new Map<string, ConfigMapRecord>();
  for (const configMap of readCommonConfigMaps(root, env).values()) {
    index.set(configMap.name, { name: configMap.name, keys: new Set(configMap.data.keys()), sourceFile: configMap.file });
  }
  return index;
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

function collectEnvFromConfigmapsRefs(
  node: unknown,
  currentPath: string,
  refs: Array<{ section: string; envVar: string; refValue: string }>,
): void {
  if (isSeq(node)) {
    node.items.forEach((item, idx) => {
      const p = currentPath ? `${currentPath}[${idx}]` : `[${idx}]`;
      collectEnvFromConfigmapsRefs(item, p, refs);
    });
    return;
  }

  if (!isMap(node)) {
    return;
  }

  for (const item of node.items) {
    const key = String(isScalar(item.key) ? item.key.value : item.key);
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (key === "envFromConfigmaps" && isMap(item.value)) {
      for (const ref of item.value.items) {
        const envVar = String(isScalar(ref.key) ? ref.key.value : ref.key);
        // Non-string values are kept as empty references so they are reported as INVALID_REFERENCE.
        refs.push({ section: nextPath, envVar, refValue: scalarText(ref.value) ?? "" });
      }
      continue;
    }

    collectEnvFromConfigmapsRefs(item.value, nextPath, refs);
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

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: InventoryRow[]): string {
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

  const configMaps = loadConfigMaps(args.root, args.env);
  const workloads = [
    ...discoverWorkloads(args.root, args.env, "microservice"),
    ...discoverWorkloads(args.root, args.env, "cronjob"),
  ];

  const rows: InventoryRow[] = [];

  for (const wf of workloads) {
    const refs: Array<{ section: string; envVar: string; refValue: string }> = [];
    collectEnvFromConfigmapsRefs(yamlDocument(wf.valuesFileAbs).contents, "", refs);

    for (const ref of refs) {
      rows.push(evaluateRef(args.env, wf, ref.section, ref.envVar, ref.refValue, configMaps));
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
  fs.writeFileSync(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

  const issues = rows.filter((r) => r.status !== "OK");
  const byStatus = new Map<InventoryStatus, number>();
  for (const row of rows) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  }

  console.log(`Environment: ${args.env}`);
  console.log(`ConfigMaps discovered: ${configMaps.size}`);
  console.log(`Workload files scanned: ${workloads.length}`);
  console.log(`envFromConfigmaps references found: ${rows.length}`);
  console.log(`CSV report: ${path.relative(args.root, csvPath)}`);
  console.log(`JSON report: ${path.relative(args.root, jsonPath)}`);

  for (const status of ["OK", "TEMPLATE_REFERENCE", "INVALID_REFERENCE", "CONFIGMAP_NOT_FOUND", "KEY_NOT_FOUND"] as const) {
    console.log(`${status}: ${byStatus.get(status) ?? 0}`);
  }

  const blockingIssues = issues.filter((r) => r.status !== "TEMPLATE_REFERENCE");
  if (blockingIssues.length > 0) {
    console.error("Validation failed: unresolved references detected.");
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
