import * as fs from "fs";
import * as path from "path";
import { isMap, isScalar, isSeq } from "yaml";
import { csvEscape } from "./csv.js";
import { readJsonRecords, writeJsonReport } from "./json-report.js";
import { readApplicationConfigMaps } from "./migration-assets.js";
import { yamlDocument } from "./yaml-source.js";

// TASK 6: checks that values-commons.yaml is complete and correct with respect to the ConfigMaps in scope and
// their classification: every COMMON_VALUE key must be present at its target path with the ConfigMap value,
// nothing else may be in the file, and every ConfigMap key must be classified in the mapping.

type CliArgs = {
  env: string;
  root: string;
  mappingJson: string;
  commonValues: string;
  outputCsv: string;
  outputJson: string;
};

type Status = "OK" | "MISSING" | "VALUE_MISMATCH" | "NOT_A_STRING" | "SOURCE_MISSING" | "UNMAPPED_KEY" | "EXTRA";

type ValidationRow = {
  environment: string;
  sourceConfigMap: string;
  sourceKey: string;
  classification: string;
  targetPath: string;
  expectedValue: string;
  actualValue: string;
  status: Status;
  detail: string;
};

const STATUS_DESCRIPTIONS: Record<Status, string> = {
  OK: "COMMON_VALUE key present at its target path with the ConfigMap value",
  MISSING: "COMMON_VALUE key missing from values-commons.yaml",
  VALUE_MISMATCH: "Value in values-commons.yaml differs from the ConfigMap value",
  NOT_A_STRING: "Value in values-commons.yaml is not a YAML string",
  SOURCE_MISSING: "COMMON_VALUE key of the mapping not found in the ConfigMaps in scope: the mapping is outdated",
  UNMAPPED_KEY: "ConfigMap key in scope not classified in the mapping: the classification is outdated",
  EXTRA: "Value in values-commons.yaml that does not correspond to any COMMON_VALUE key",
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
    mappingJson: report("mapping-json", `task-3-mapping-common-values-${env}.json`),
    commonValues: path.resolve(arg.get("common-values") ?? path.join(root, "commons", env, "values-commons.yaml")),
    outputCsv: report("output-csv", `task-6-validate-common-values-${env}.csv`),
    outputJson: report("output-json", `task-6-validate-common-values-${env}.json`),
  };
}

/** Leaf values of the YAML document by dotted path; non-string leaves are returned as undefined. */
function collectLeaves(node: unknown, currentPath: string, out: Map<string, { value: string | undefined; text: string }>): void {
  if (isMap(node) && node.items.length > 0) {
    for (const item of node.items) {
      const key = String(isScalar(item.key) ? item.key.value : item.key);
      collectLeaves(item.value, currentPath ? `${currentPath}.${key}` : key, out);
    }
    return;
  }
  if (isScalar(node) && typeof node.value === "string") {
    out.set(currentPath, { value: node.value, text: node.value });
    return;
  }
  const text = isScalar(node) ? String(node.value) : isSeq(node) ? "<sequence>" : "<empty mapping>";
  out.set(currentPath, { value: undefined, text });
}

function toCsv(rows: ValidationRow[]): string {
  const header: Array<keyof ValidationRow> = [
    "environment",
    "sourceConfigMap",
    "sourceKey",
    "classification",
    "targetPath",
    "expectedValue",
    "actualValue",
    "status",
    "detail",
  ];
  return [header.join(","), ...rows.map((row) => header.map((column) => csvEscape(row[column])).join(","))].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.commonValues)) {
    throw new Error(`Common values file not found: ${args.commonValues}. Run task 5 (build-values) first.`);
  }

  const mappingRows = readJsonRecords(args.mappingJson, MAPPING_SCHEMA).filter((row) => row.environment === args.env);
  if (mappingRows.length === 0) {
    throw new Error(`No mapping rows found for environment ${args.env} in ${args.mappingJson}`);
  }

  const { configMaps, excluded } = readApplicationConfigMaps(args.root, args.env);
  const leaves = new Map<string, { value: string | undefined; text: string }>();
  collectLeaves(yamlDocument(args.commonValues).contents, "", leaves);

  const rows: ValidationRow[] = [];
  const expectedPaths = new Set<string>();
  const base = (row: (typeof mappingRows)[number]) => ({
    environment: args.env,
    sourceConfigMap: row.sourceConfigMap,
    sourceKey: row.sourceKey,
    classification: row.classification,
    targetPath: row.targetPath,
  });

  // 1. Every COMMON_VALUE key of the mapping must be in values-commons.yaml with the ConfigMap value.
  for (const row of mappingRows.filter((mappingRow) => mappingRow.classification === "COMMON_VALUE")) {
    expectedPaths.add(row.targetPath);
    const source = configMaps.get(row.sourceConfigMap)?.data.get(row.sourceKey);
    const leaf = leaves.get(row.targetPath);
    const actualValue = leaf?.text ?? "";

    if (source === undefined) {
      const reason = excluded.has(row.sourceConfigMap)
        ? `${row.sourceConfigMap} is a migration ConfigMap, excluded from the refactoring`
        : `${row.sourceConfigMap}.${row.sourceKey} not found in commons/${args.env}/configmaps`;
      rows.push({ ...base(row), expectedValue: "", actualValue, status: "SOURCE_MISSING", detail: `${reason}; regenerate classification and mapping` });
    } else if (!leaf) {
      rows.push({ ...base(row), expectedValue: source, actualValue: "", status: "MISSING", detail: `${row.targetPath} not found in the common values file` });
    } else if (leaf.value === undefined) {
      rows.push({ ...base(row), expectedValue: source, actualValue, status: "NOT_A_STRING", detail: `${row.targetPath} must be a YAML string` });
    } else if (leaf.value !== source) {
      rows.push({ ...base(row), expectedValue: source, actualValue, status: "VALUE_MISMATCH", detail: `${row.targetPath} differs from ${row.sourceConfigMap}.${row.sourceKey}` });
    } else {
      rows.push({ ...base(row), expectedValue: source, actualValue, status: "OK", detail: "" });
    }
  }

  // 2. Every key of the ConfigMaps in scope must be classified in the mapping.
  const mappedKeys = new Set(mappingRows.map((row) => `${row.sourceConfigMap}.${row.sourceKey}`));
  for (const configMap of configMaps.values()) {
    for (const [key, value] of configMap.data) {
      if (!mappedKeys.has(`${configMap.name}.${key}`)) {
        rows.push({
          environment: args.env,
          sourceConfigMap: configMap.name,
          sourceKey: key,
          classification: "",
          targetPath: "",
          expectedValue: value,
          actualValue: "",
          status: "UNMAPPED_KEY",
          detail: `${configMap.name}.${key} (${configMap.file}) is not in the mapping; regenerate classification and mapping`,
        });
      }
    }
  }

  // 3. values-commons.yaml must not contain anything else.
  const mappedByPath = new Map(mappingRows.map((row) => [row.targetPath, row]));
  for (const [leafPath, leaf] of leaves) {
    if (expectedPaths.has(leafPath)) {
      continue;
    }
    const mapped = mappedByPath.get(leafPath);
    rows.push({
      environment: args.env,
      sourceConfigMap: mapped?.sourceConfigMap ?? "",
      sourceKey: mapped?.sourceKey ?? "",
      classification: mapped?.classification ?? "",
      targetPath: leafPath,
      expectedValue: "",
      actualValue: leaf.text,
      status: "EXTRA",
      detail: mapped ? `classified ${mapped.classification}, not COMMON_VALUE` : "no COMMON_VALUE key of the mapping targets this path",
    });
  }

  for (const file of [args.outputCsv, args.outputJson]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(args.outputCsv, `${toCsv(rows)}\n`, "utf8");
  writeJsonReport(args.outputJson, rows);

  const count = (status: Status) => rows.filter((row) => row.status === status).length;
  console.log(`Environment: ${args.env}`);
  console.log(`Common values file: ${path.relative(args.root, args.commonValues)}`);
  console.log(`Input mapping: ${path.relative(args.root, args.mappingJson)}`);
  console.log(`COMMON_VALUE keys expected: ${expectedPaths.size}`);
  console.log(`Values in the common values file: ${leaves.size}`);
  for (const status of Object.keys(STATUS_DESCRIPTIONS) as Status[]) {
    console.log(`${status}: ${count(status)}`);
  }
  console.log(`Output report: ${path.relative(args.root, args.outputCsv)}, ${path.relative(args.root, args.outputJson)}`);

  const problems = rows.filter((row) => row.status !== "OK");
  if (problems.length > 0) {
    console.error("\nCommon values validation failed:");
    for (const row of problems.slice(0, 25)) {
      console.error(`- ${row.status}: ${row.detail || row.targetPath}`);
    }
    if (problems.length > 25) {
      console.error(`- ... ${problems.length - 25} more`);
    }
    process.exit(1);
  }

  console.log("Common values validation passed.");
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
