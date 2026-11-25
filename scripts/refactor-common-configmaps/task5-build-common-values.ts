import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import { csvEscape } from "./csv.js";
import { readJsonRecords, writeJsonReport } from "./json-report.js";
import { scalarText, writeVerifiedYaml } from "./yaml-source.js";
import { readApplicationConfigMaps } from "./migration-assets.js";

type CliArgs = {
  env: string;
  root: string;
  mappingJson: string;
  outputYaml: string;
  outputCoverageCsv: string;
  outputCoverageJson: string;
  outputCoverageMd: string;
};

/** Fields of the TASK 3 mapping JSON. */
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

type MappingRow = {
  environment: string;
  sourceConfigMap: string;
  sourceKey: string;
  targetPath: string;
  targetRef: string;
  classification: string;
  destinationType: string;
  consumerCount: number;
  sourceFile: string;
  note: string;
};

type CoverageRow = {
  environment: string;
  sourceConfigMap: string;
  sourceKey: string;
  classification: string;
  destinationType: string;
  targetPath: string;
  targetRef: string;
  consumerCount: number;
  migrationStatus: "MIGRATED_TO_COMMONS" | "EXCLUDED_FROM_COMMONS";
  exclusionReason: string;
  note: string;
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
  const mappingJson = path.resolve(
    arg.get("mapping-json") ?? path.join(reportsDir, `task-3-common-values-mapping-${env}.json`),
  );
  const outputYaml = path.resolve(
    arg.get("output-yaml") ?? path.join(root, "commons", env, "values-commons.yaml"),
  );
  const outputCoverageCsv = path.resolve(
    arg.get("output-coverage-csv") ?? path.join(reportsDir, `task-5-common-values-coverage-${env}.csv`),
  );
  const outputCoverageJson = path.resolve(
    arg.get("output-coverage-json") ?? path.join(reportsDir, `task-5-common-values-coverage-${env}.json`),
  );
  const outputCoverageMd = path.resolve(
    arg.get("output-coverage-md") ?? path.join(reportsDir, `task-5-common-values-coverage-${env}.md`),
  );

  return { env, root, mappingJson, outputYaml, outputCoverageCsv, outputCoverageJson, outputCoverageMd };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** Coverage records for the JSON report: same fields and order as the CSV. */
function toCoverageJson(rows: CoverageRow[]): object[] {
  return rows.map((row) => ({
    environment: row.environment,
    sourceConfigMap: row.sourceConfigMap,
    sourceKey: row.sourceKey,
    classification: row.classification,
    destinationType: row.destinationType,
    targetPath: row.targetPath,
    consumerCount: row.consumerCount,
    migrationStatus: row.migrationStatus,
    exclusionReason: row.exclusionReason,
    note: row.note,
  }));
}

function exclusionReasonFor(row: MappingRow): string {
  if (row.classification === "WORKLOAD_VALUE") {
    return "Single-consumer or workload-specific value; intentionally left outside commons";
  }

  if (row.classification === "OBSOLETE") {
    return "No active consumers in TASK 1 inventory; excluded from commons";
  }

  if (row.classification === "KEEP_AS_CONFIGMAP") {
    return "Explicitly retained as ConfigMap rather than moved to commons values";
  }

  return "Included in commons";
}

function buildCoverageRows(mappingRows: MappingRow[], env: string): CoverageRow[] {
  return mappingRows
    .filter((row) => row.environment === env)
    .sort(
      (a, b) =>
        a.classification.localeCompare(b.classification) ||
        a.sourceConfigMap.localeCompare(b.sourceConfigMap) ||
        a.sourceKey.localeCompare(b.sourceKey),
    )
    .map((row) => ({
      environment: row.environment,
      sourceConfigMap: row.sourceConfigMap,
      sourceKey: row.sourceKey,
      classification: row.classification,
      destinationType: row.destinationType,
      targetPath: row.targetPath,
      targetRef: row.targetRef,
      consumerCount: row.consumerCount,
      migrationStatus:
        row.classification === "COMMON_VALUE" && row.destinationType === "COMMON_VALUE"
          ? "MIGRATED_TO_COMMONS"
          : "EXCLUDED_FROM_COMMONS",
      exclusionReason: exclusionReasonFor(row),
      note: row.note,
    }));
}

function toCoverageCsv(rows: CoverageRow[]): string {
  const header = [
    "environment",
    "sourceConfigMap",
    "sourceKey",
    "classification",
    "destinationType",
    "targetPath",
    "consumerCount",
    "migrationStatus",
    "exclusionReason",
    "note",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.environment,
        row.sourceConfigMap,
        row.sourceKey,
        row.classification,
        row.destinationType,
        row.targetPath,
        String(row.consumerCount),
        row.migrationStatus,
        row.exclusionReason,
        row.note,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}

function toCoverageMarkdown(rows: CoverageRow[], env: string): string {
  const migrated = rows.filter((row) => row.migrationStatus === "MIGRATED_TO_COMMONS");
  const excluded = rows.filter((row) => row.migrationStatus === "EXCLUDED_FROM_COMMONS");
  const excludedByClassification = new Map<string, number>();

  for (const row of excluded) {
    excludedByClassification.set(row.classification, (excludedByClassification.get(row.classification) ?? 0) + 1);
  }

  const migratedLines = migrated
    .slice(0, 40)
    .map(
      (row) =>
        `| ${row.sourceConfigMap} | ${row.sourceKey} | ${row.targetPath} | ${row.consumerCount} | ${row.note || "-"} |`,
    );

  const excludedLines = excluded
    .slice(0, 80)
    .map(
      (row) =>
        `| ${row.sourceConfigMap} | ${row.sourceKey} | ${row.classification} | ${row.targetPath} | ${row.consumerCount} | ${row.exclusionReason} |`,
    );

  return [
    `# TASK 5 - Common Values Coverage (${env})`,
    "",
    "## Summary",
    "",
    `- Total mapping rows in scope: ${rows.length}`,
    `- Migrated to commons: ${migrated.length}`,
    `- Excluded from commons: ${excluded.length}`,
    ...[...excludedByClassification.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([classification, count]) => `- Excluded ${classification}: ${count}`),
    "",
    "## Migrated to commons",
    "",
    "| Source ConfigMap | Source Key | Target Path | Consumers | Note |",
    "|---|---|---|---:|---|",
    ...(migratedLines.length > 0 ? migratedLines : ["| - | - | - | - | - |"]),
    "",
    "## Excluded from commons",
    "",
    "| Source ConfigMap | Source Key | Classification | Target Path | Consumers | Reason |",
    "|---|---|---|---|---:|---|",
    ...(excludedLines.length > 0 ? excludedLines : ["| - | - | - | - | - | - |"]),
    "",
    "## Notes",
    "",
    "- This report reflects TASK 3 approved mapping categories, not runtime adoption by consumers.",
    `- Rows classified as COMMON_VALUE are the ones materialized into commons/${env}/values-commons.yaml.`,
    "- Rows outside COMMON_VALUE remain intentionally out of commons in TASK 5.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TARGET_PATH_SEGMENT = /^[A-Za-z0-9_]+$/;
const FORBIDDEN_TARGET_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function setNestedString(root: Record<string, unknown>, targetPath: string, value: string): void {
  const parts = targetPath.split(".");
  if (parts.length < 2 || parts[0] !== "commons") {
    throw new Error(`Invalid commons target path: ${targetPath}`);
  }

  // The path comes from the mapping CSV: reject segments that could reach Object.prototype.
  for (const part of parts) {
    if (!TARGET_PATH_SEGMENT.test(part) || FORBIDDEN_TARGET_PATH_SEGMENTS.has(part)) {
      throw new Error(`Invalid commons target path segment '${part}' in ${targetPath}`);
    }
  }

  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];

    if (!Object.hasOwn(cursor, part)) {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
      continue;
    }

    const next = cursor[part];
    if (!isRecord(next)) {
      throw new Error(`Cannot create nested path ${targetPath}: ${part} is not an object`);
    }

    cursor = next;
  }

  const leaf = parts[parts.length - 1];
  if (Object.hasOwn(cursor, leaf)) {
    throw new Error(`Duplicate target path in output: ${targetPath}`);
  }

  cursor[leaf] = value;
}

function collectLeafPaths(node: unknown, currentPath: string, out: string[]): void {
  if (!isRecord(node)) {
    if (currentPath) {
      out.push(currentPath);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    collectLeafPaths(value, nextPath, out);
  }
}

function containsTemplate(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));


  const mappingRows: MappingRow[] = readJsonRecords(args.mappingJson, MAPPING_SCHEMA).filter(
    (row) => row.environment === args.env,
  );

  const coverageRows = buildCoverageRows(mappingRows, args.env);
  const migratedRows = coverageRows
    .filter((row) => row.migrationStatus === "MIGRATED_TO_COMMONS")
    .sort((a, b) => a.targetPath.localeCompare(b.targetPath));

  if (migratedRows.length === 0) {
    throw new Error(`No COMMON_VALUE rows found for environment: ${args.env}`);
  }

  const { configMaps: applicationConfigMaps, excluded: migrationConfigMaps } = readApplicationConfigMaps(args.root, args.env);
  const configMaps = new Map([...applicationConfigMaps].map(([name, configMap]) => [name, configMap.data]));
  const documentRoot: Record<string, unknown> = {};
  const expectedPaths = new Set<string>();
  const expectedValues = new Map<string, string>();

  for (const row of migratedRows) {
    const migrationConfigMap = migrationConfigMaps.get(row.sourceConfigMap);
    if (migrationConfigMap) {
      throw new Error(
        `Migration ConfigMap cannot be materialized in values-commons: ${row.sourceConfigMap}.${row.sourceKey} (${migrationConfigMap.signals.join("; ")})`,
      );
    }

    if (!row.targetPath.startsWith("commons.")) {
      throw new Error(`COMMON_VALUE row does not target commons.*: ${row.targetPath}`);
    }

    if (containsTemplate(row.targetRef)) {
      // Mapping targetRef is templated by design; reject only if targetPath itself is malformed.
    }

    const configMapData = configMaps.get(row.sourceConfigMap);
    if (!configMapData) {
      throw new Error(`Source ConfigMap not found: ${row.sourceConfigMap}`);
    }

    const rawValue = configMapData.get(row.sourceKey);
    if (rawValue === undefined) {
      throw new Error(`Source key not found: ${row.sourceConfigMap}.${row.sourceKey}`);
    }

    if (containsTemplate(rawValue)) {
      throw new Error(`Source value contains template markup: ${row.sourceConfigMap}.${row.sourceKey}`);
    }

    expectedPaths.add(row.targetPath);
    expectedValues.set(row.targetPath, rawValue);
    setNestedString(documentRoot, row.targetPath, rawValue);
  }

  const actualPaths: string[] = [];
  collectLeafPaths(documentRoot, "", actualPaths);
  const actualPathSet = new Set(actualPaths);

  const missingPaths = [...expectedPaths].filter((pathValue) => !actualPathSet.has(pathValue));
  const extraPaths = [...actualPathSet].filter((pathValue) => !expectedPaths.has(pathValue));

  if (missingPaths.length > 0) {
    throw new Error(`Missing output paths: ${missingPaths.join(", ")}`);
  }

  if (extraPaths.length > 0) {
    throw new Error(`Unexpected output paths: ${extraPaths.join(", ")}`);
  }

  ensureDir(path.dirname(args.outputYaml));
  for (const file of [args.outputCoverageCsv, args.outputCoverageJson, args.outputCoverageMd]) {
    ensureDir(path.dirname(file));
  }
  const yamlOutput = YAML.stringify(documentRoot, {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
  });
  writeVerifiedYaml(args.outputYaml, yamlOutput, (document) => {
    const generatedPaths: string[] = [];
    collectLeafPaths(document.toJS(), "", generatedPaths);
    if (generatedPaths.length !== expectedValues.size) {
      throw new Error(`Generated values-commons has ${generatedPaths.length} values, expected ${expectedValues.size}.`);
    }
    for (const [targetPath, value] of expectedValues) {
      if (scalarText(document.getIn(targetPath.split("."), true)) !== value) {
        throw new Error(`Generated values-commons does not preserve the source value of ${targetPath}.`);
      }
    }
  });
  fs.writeFileSync(args.outputCoverageCsv, `${toCoverageCsv(coverageRows)}\n`, "utf8");
  writeJsonReport(args.outputCoverageJson, toCoverageJson(coverageRows));
  fs.writeFileSync(args.outputCoverageMd, `${toCoverageMarkdown(coverageRows, args.env)}\n`, "utf8");

  console.log(`Environment: ${args.env}`);
  console.log(`Input mapping: ${path.relative(args.root, args.mappingJson)}`);
  console.log(`Output YAML: ${path.relative(args.root, args.outputYaml)}`);
  console.log(`Output coverage CSV: ${path.relative(args.root, args.outputCoverageCsv)}`);
  console.log(`Output coverage JSON: ${path.relative(args.root, args.outputCoverageJson)}`);
  console.log(`Output coverage MD: ${path.relative(args.root, args.outputCoverageMd)}`);
  console.log(`COMMON_VALUE rows materialized: ${migratedRows.length}`);
  console.log(`Validated paths: ${actualPaths.length}`);
  console.log(`Excluded from commons: ${coverageRows.filter((row) => row.migrationStatus === "EXCLUDED_FROM_COMMONS").length}`);
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