import * as fs from "fs";
import * as path from "path";
import { isDeepStrictEqual } from "util";
import { isMap, isScalar, isSeq, parseDocument, type Pair, type YAMLMap } from "yaml";
import { csvEscape } from "./csv.js";
import { readJsonRecords, writeJsonReport } from "./json-report.js";
import { fail, scalarText, writeVerifiedYaml } from "./yaml-source.js";

// TASK 7 (optional): replaces COMMON_VALUE ConfigMap references with {{.Values.commons.*}}
// reference of the TASK 3 mapping. Files are edited as text (only the affected lines change) and every result is
// parsed back and compared with the expected transformation; nothing is written unless every file is valid.

type WorkloadType = "microservice" | "cronjob";

type CliArgs = {
  env: string;
  root: string;
  mappingJson: string;
  outputCsv: string;
  outputJson: string;
  apply: boolean;
  workloads?: Set<string>;
};

type Status = "MIGRATE" | "MIGRATED" | "SKIPPED_DEPENDENT_ENV" | "SKIPPED_NOT_COMMON_VALUE" | "ERROR";

type ReportRow = {
  environment: string;
  workloadType: string;
  workload: string;
  valuesFile: string;
  section: string;
  envVar: string;
  sourceConfigMap: string;
  sourceKey: string;
  classification: string;
  targetRef: string;
  status: Status;
  detail: string;
};

type MappingEntry = { classification: string; targetRef: string };

type Edit = { start: number; end: number; text: string };

type WorkloadFile = { workloadType: WorkloadType; workload: string; file: string; valuesFile: string };

type FilePlan = {
  workload: WorkloadFile;
  rows: ReportRow[];
  original: string;
  output: string;
  expected: unknown;
};

const MAPPING_SCHEMA = {
  environment: "string",
  sourceConfigMap: "string",
  sourceKey: "string",
  targetPath: "string",
  targetRef: "string",
  classification: "string",
  destinationType: "string",
  consumerCount: "number",
  sourceFile: "string",
  note: "string",
} as const;

const TARGET_REF = /^\{\{\.Values\.commons(\.[A-Za-z0-9_]+)+\}\}$/;
const DEPENDENT_VARIABLE = /(?<!\$)\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g;

const STATUS_DESCRIPTIONS: Record<Status, string> = {
  MIGRATE: "Would be replaced with a common values reference (plan; rerun with --apply)",
  MIGRATED: "Replaced with a common values reference; file written and verified",
  SKIPPED_DEPENDENT_ENV: "Left unchanged: another variable of the same container uses $(VAR) on it; migrate manually",
  SKIPPED_NOT_COMMON_VALUE: "Left unchanged: the key is not classified COMMON_VALUE",
  ERROR: "File not migrated because of an error; no file was written",
};

function parseArgs(argv: string[]): CliArgs {
  const arg = new Map<string, string>();
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    if (token === "--apply") {
      apply = true;
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
  const workloads = arg.get("workloads");

  return {
    env,
    root,
    apply,
    mappingJson: report("mapping-json", `task-3-common-values-mapping-${env}.json`),
    outputCsv: report("output-csv", `task-7-workload-migration-${env}.csv`),
    outputJson: report("output-json", `task-7-workload-migration-${env}.json`),
    workloads: workloads ? new Set(workloads.split(",").map((name) => name.trim()).filter(Boolean)) : undefined,
  };
}

function discoverWorkloads(root: string, env: string): WorkloadFile[] {
  const out: WorkloadFile[] = [];
  for (const [folder, workloadType] of [["microservices", "microservice"], ["jobs", "cronjob"]] as const) {
    const directory = path.join(root, folder);
    if (!fs.existsSync(directory)) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name, env, "values.yaml");
      if (entry.isDirectory() && fs.existsSync(file)) {
        out.push({ workloadType, workload: entry.name, file, valuesFile: path.relative(root, file) });
      }
    }
  }
  return out;
}

function readMapping(file: string, env: string): Map<string, MappingEntry> {
  const mapping = new Map<string, MappingEntry>();
  for (const row of readJsonRecords(file, MAPPING_SCHEMA)) {
    if (row.environment === env) {
      mapping.set(`${row.sourceConfigMap}.${row.sourceKey}`, { classification: row.classification, targetRef: row.targetRef });
    }
  }
  if (mapping.size === 0) {
    throw new Error(`No mapping rows found for environment ${env} in ${file}`);
  }
  return mapping;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const newline = text.indexOf("\n", offset);
  return newline < 0 ? text.length : newline + 1;
}

function keyText(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

function nodeRange(node: unknown, label: string): [number, number, number] {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (!range) {
    fail(`${label}: cannot locate the node in the original YAML text.`);
  }
  return range;
}

/** Lines of a single-line `KEY: value` item; any other layout is rejected so no content is lost. */
function itemLines(text: string, pair: Pair, label: string): [number, number] {
  const keyStart = nodeRange(pair.key, label)[0];
  const valueEnd = nodeRange(pair.value, label)[1];
  const start = lineStart(text, keyStart);
  const end = lineEnd(text, valueEnd);
  if (text.slice(start, keyStart).trim() !== "" || text.slice(keyStart, valueEnd).includes("\n") || text.slice(valueEnd, end).trim() !== "") {
    fail(`${label}: unsupported layout (expected a single-line "KEY: value" item without comments).`);
  }
  return [start, end];
}

/** Line of a block mapping key such as `envFromConfigmaps:` whose items are on the following lines. */
function keyLine(text: string, pair: Pair, label: string): { start: number; end: number; indent: string } {
  const [keyStart, keyEnd] = nodeRange(pair.key, label);
  const start = lineStart(text, keyStart);
  const end = lineEnd(text, keyEnd);
  if (text.slice(start, keyStart).trim() !== "" || !/^\s*:\s*$/.test(text.slice(keyEnd, end))) {
    fail(`${label}: unsupported layout (expected "${keyText(pair)}:" alone on its line).`);
  }
  return { start, end, indent: text.slice(start, keyStart) };
}

function itemIndent(text: string, map: YAMLMap, label: string): string {
  const keyStart = nodeRange(map.items[0].key, label)[0];
  return text.slice(lineStart(text, keyStart), keyStart);
}

function blockMap(node: unknown, label: string): YAMLMap {
  if (!isMap(node) || node.flow || node.items.length === 0) {
    fail(`${label}: unsupported layout (expected a non-empty block mapping).`);
  }
  return node;
}

function applyEdits(text: string, edits: Edit[], label: string): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let limit = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > limit) {
      fail(`${label}: overlapping edits.`);
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    limit = edit.start;
  }
  return out;
}

type Container = { path: Array<string | number>; section: string; node: YAMLMap; frontend?: boolean };

function findContainers(node: unknown, pathParts: Array<string | number>, label: string, out: Container[]): void {
  if (isSeq(node)) {
    node.items.forEach((item, index) => findContainers(item, [...pathParts, index], `${label}[${index}]`, out));
    return;
  }
  if (!isMap(node)) {
    return;
  }
  if (label === "frontend.env.js.window.pagopa_env" && node.has("fromConfigmaps")) {
    out.push({ path: pathParts, section: `${label}.fromConfigmaps`, node, frontend: true });
  }
  if (node.has("envFromConfigmaps")) {
    out.push({ path: pathParts, section: label ? `${label}.envFromConfigmaps` : "envFromConfigmaps", node });
  }
  for (const item of node.items) {
    const key = keyText(item);
    findContainers(item.value, [...pathParts, key], label ? `${label}.${key}` : key, out);
  }
}

function getIn(value: unknown, pathParts: Array<string | number>): Record<string, unknown> {
  let cursor = value as Record<string | number, unknown>;
  for (const part of pathParts) {
    cursor = cursor[part] as Record<string | number, unknown>;
  }
  return cursor as Record<string, unknown>;
}

function planFile(workload: WorkloadFile, env: string, mapping: Map<string, MappingEntry>, apply: boolean): FilePlan {
  const label = workload.valuesFile;
  const original = fs.readFileSync(workload.file, "utf8");
  const document = parseDocument(original, { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(`${label}: ${document.errors[0].message}`);
  }

  const expected = document.toJS() as unknown;
  const containers: Container[] = [];
  findContainers(document.contents, [], "", containers);

  const rows: ReportRow[] = [];
  const edits: Edit[] = [];

  for (const container of containers) {
    const sectionLabel = `${label}: ${container.section}`;
    const referenceKey = container.frontend ? "fromConfigmaps" : "envFromConfigmaps";
    const efcPair = container.node.items.find((item) => keyText(item) === referenceKey)!;
    const efc = blockMap(efcPair.value, sectionLabel);
    const envPair = !container.frontend && container.node.items.find((item) => keyText(item) === "env");
    const envMap = envPair ? blockMap(envPair.value, `${label}: ${container.section.replace(/envFromConfigmaps$/, "env")}`) : undefined;

    const candidates: Array<{ pair: Pair; envVar: string; mappingEntry: MappingEntry }> = [];
    for (const pair of efc.items) {
      const envVar = keyText(pair);
      const ref = scalarText(pair.value) ?? "";
      const dot = ref.indexOf(".");
      const mappingEntry = dot > 0 ? mapping.get(ref) : undefined;
      if (!mappingEntry) {
        continue;
      }
      const base = {
        environment: env,
        workloadType: workload.workloadType,
        workload: workload.workload,
        valuesFile: workload.valuesFile,
        section: container.section,
        envVar,
        sourceConfigMap: ref.slice(0, dot),
        sourceKey: ref.slice(dot + 1),
        classification: mappingEntry.classification,
        targetRef: mappingEntry.classification === "COMMON_VALUE" ? mappingEntry.targetRef : "",
      };
      if (mappingEntry.classification !== "COMMON_VALUE") {
        rows.push({ ...base, status: "SKIPPED_NOT_COMMON_VALUE", detail: `${mappingEntry.classification} keys stay on ${referenceKey}` });
        continue;
      }
      if (!TARGET_REF.test(mappingEntry.targetRef)) {
        fail(`${sectionLabel}: invalid targetRef '${mappingEntry.targetRef}' for ${ref} in the mapping.`);
      }
      rows.push({ ...base, status: apply ? "MIGRATED" : "MIGRATE", detail: `${envVar}: "${ref}" -> ${container.frontend ? "" : "env."}${envVar}: "${mappingEntry.targetRef}"` });
      candidates.push({ pair, envVar, mappingEntry });
    }

    if (candidates.length === 0) {
      continue;
    }

    // Kubernetes expands $(VAR) only for variables defined earlier in the container: moving VAR to env may change that order.
    const names = new Set(candidates.map((candidate) => candidate.envVar));
    const dependencies: string[] = [];
    for (const item of envMap?.items ?? []) {
      for (const match of (scalarText(item.value) ?? "").matchAll(DEPENDENT_VARIABLE)) {
        if (names.has(match[1])) {
          dependencies.push(`${keyText(item)} uses $(${match[1]})`);
        }
      }
    }
    if (dependencies.length > 0) {
      const sectionRows = rows.filter((row) => row.section === container.section && (row.status === "MIGRATE" || row.status === "MIGRATED"));
      for (const row of sectionRows) {
        row.status = "SKIPPED_DEPENDENT_ENV";
        row.detail = `${dependencies.join(", ")}; whole container left unchanged`;
      }
      continue;
    }

    for (const candidate of candidates) {
      if ((container.frontend ? container.node : envMap)?.has(candidate.envVar)) {
        fail(`${sectionLabel}: ${candidate.envVar} is already defined at the destination.`);
      }
    }

    // Remove the migrated references and insert direct Helm values at the destination.
    for (const candidate of candidates) {
      const [start, end] = itemLines(original, candidate.pair, sectionLabel);
      edits.push({ start, end, text: "" });
    }
    const allMigrated = candidates.length === efc.items.length;
    const efcKeyLine = keyLine(original, efcPair, sectionLabel);
    if (allMigrated) {
      edits.push({ start: efcKeyLine.start, end: efcKeyLine.end, text: "" });
    }

    const newLines = (indent: string) =>
      candidates.map((candidate) => `${indent}${container.frontend ? JSON.stringify(candidate.envVar) : candidate.envVar}: ${JSON.stringify(candidate.mappingEntry.targetRef)}\n`).join("");
    if (container.frontend) {
      edits.push({ start: efcKeyLine.start, end: efcKeyLine.start, text: newLines(efcKeyLine.indent) });
    } else if (envMap) {
      let lastContent = nodeRange(envMap, sectionLabel)[1];
      while (lastContent > 0 && /\s/.test(original[lastContent - 1])) {
        lastContent -= 1;
      }
      const offset = lineEnd(original, lastContent);
      const prefix = offset === original.length && !original.endsWith("\n") ? "\n" : "";
      edits.push({ start: offset, end: offset, text: prefix + newLines(itemIndent(original, envMap, sectionLabel)) });
    } else {
      const text = `${efcKeyLine.indent}env:\n${newLines(itemIndent(original, efc, sectionLabel))}`;
      edits.push({ start: efcKeyLine.start, end: efcKeyLine.start, text });
    }

    // Expected result, used to verify the text edits.
    const target = getIn(expected, container.path);
    const efcValues = target[referenceKey] as Record<string, unknown>;
    const envValues = container.frontend ? target : (target.env as Record<string, unknown> | undefined) ?? {};
    for (const candidate of candidates) {
      delete efcValues[candidate.envVar];
      envValues[candidate.envVar] = candidate.mappingEntry.targetRef;
    }
    if (allMigrated) {
      delete target[referenceKey];
    }
    if (!container.frontend) {
      target.env = envValues;
    }
  }

  const output = edits.length > 0 ? applyEdits(original, edits, label) : original;
  verifyOutput(output, expected, label);
  return { workload, rows, original, output, expected };
}

function verifyOutput(output: string, expected: unknown, label: string): void {
  const document = parseDocument(output, { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(`${label}: migrated YAML is invalid: ${document.errors[0].message}`);
  }
  if (!isDeepStrictEqual(document.toJS(), expected)) {
    fail(`${label}: migrated YAML does not match the expected transformation.`);
  }
}

function toCsv(rows: ReportRow[]): string {
  const header: Array<keyof ReportRow> = [
    "environment",
    "workloadType",
    "workload",
    "valuesFile",
    "section",
    "envVar",
    "sourceConfigMap",
    "sourceKey",
    "classification",
    "targetRef",
    "status",
    "detail",
  ];
  return [header.join(","), ...rows.map((row) => header.map((column) => csvEscape(row[column])).join(","))].join("\n");
}

function writeReports(args: CliArgs, rows: ReportRow[]): void {
  for (const file of [args.outputCsv, args.outputJson]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(args.outputCsv, `${toCsv(rows)}\n`, "utf8");
  writeJsonReport(args.outputJson, rows);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const mapping = readMapping(args.mappingJson, args.env);

  let workloads = discoverWorkloads(args.root, args.env);
  if (args.workloads) {
    const known = new Set(workloads.map((workload) => workload.workload));
    const unknown = [...args.workloads].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`Unknown workload(s) for environment ${args.env}: ${unknown.join(", ")}`);
    }
    workloads = workloads.filter((workload) => args.workloads!.has(workload.workload));
  }

  const plans: FilePlan[] = [];
  const errors: string[] = [];
  const rows: ReportRow[] = [];
  for (const workload of workloads) {
    try {
      const plan = planFile(workload, args.env, mapping, args.apply);
      plans.push(plan);
      rows.push(...plan.rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      rows.push({
        environment: args.env,
        workloadType: workload.workloadType,
        workload: workload.workload,
        valuesFile: workload.valuesFile,
        section: "",
        envVar: "",
        sourceConfigMap: "",
        sourceKey: "",
        classification: "",
        targetRef: "",
        status: "ERROR",
        detail: message,
      });
    }
  }

  if (errors.length > 0) {
    // All or nothing: a single invalid file blocks every write.
    for (const row of rows) {
      if (row.status === "MIGRATED") {
        row.status = "MIGRATE";
      }
    }
    writeReports(args, rows);
    console.error(`Migration failed; no values file was changed:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }

  const changed = plans.filter((plan) => plan.output !== plan.original);
  if (args.apply) {
    for (const plan of changed) {
      writeVerifiedYaml(plan.workload.file, plan.output, (document) => {
        if (!isDeepStrictEqual(document.toJS(), plan.expected)) {
          fail(`${plan.workload.valuesFile}: migrated YAML does not match the expected transformation.`);
        }
      });
    }
  }
  writeReports(args, rows);

  const count = (status: Status) => rows.filter((row) => row.status === status).length;
  console.log(`Environment: ${args.env}`);
  console.log(`Mode: ${args.apply ? "apply" : "plan (no file changed; rerun with --apply)"}`);
  console.log(`Input mapping: ${path.relative(args.root, args.mappingJson)}`);
  console.log(`Workload files scanned: ${workloads.length}`);
  console.log(`Workload files ${args.apply ? "changed" : "to change"}: ${changed.length}`);
  for (const status of Object.keys(STATUS_DESCRIPTIONS) as Status[]) {
    console.log(`${status}: ${count(status)}`);
  }
  console.log(`Output report: ${path.relative(args.root, args.outputCsv)}, ${path.relative(args.root, args.outputJson)}`);
  if (count("SKIPPED_DEPENDENT_ENV") > 0) {
    console.log(`Some containers were left unchanged because of $(VAR) dependencies: see SKIPPED_DEPENDENT_ENV rows and migrate them manually.`);
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
