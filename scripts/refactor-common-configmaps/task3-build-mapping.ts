import * as fs from "fs";
import * as path from "path";
import { csvEscape } from "./csv.js";
import { readJsonRecords, writeJsonReport } from "./json-report.js";

type CliArgs = {
  env: string;
  root: string;
  classificationJson: string;
  outputCsv: string;
  outputJson: string;
};

/** Fields of the TASK 2 classification JSON used to build the mapping. */
const CLASSIFICATION_SCHEMA = {
  environment: "string",
  configMap: "string",
  key: "string",
  sourceFile: "string",
  classification: "string",
  classificationReason: "string",
  distinctWorkloadCount: "number",
} as const;

type Task2Row = {
  environment: string;
  configMap: string;
  key: string;
  sourceFile: string;
  classification: string;
  classificationReason: string;
  consumerCount: number;
};

type MappingRow = {
  environment: string;
  sourceConfigMap: string;
  sourceKey: string;
  sourceFile: string;
  classification: string;
  classificationReason: string;
  consumerCount: number;
  destinationType: string;
  targetPath: string;
  targetRef: string;
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
  const outDir = path.resolve(arg.get("output-dir") ?? path.join(root, "reports", "refactor-common-configmaps"));

  const classificationJson = path.resolve(
    arg.get("classification-json") ??
      path.join(root, "reports", "refactor-common-configmaps", `task-2-classify-common-configmaps-${env}.json`),
  );

  const outputCsv = path.resolve(arg.get("output-csv") ?? path.join(outDir, `task-3-mapping-common-values-${env}.csv`));
  const outputJson = path.resolve(arg.get("output-json") ?? path.join(outDir, `task-3-mapping-common-values-${env}.json`));

  return { env, root, classificationJson, outputCsv, outputJson };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readClassification(file: string): Task2Row[] {
  return readJsonRecords(file, CLASSIFICATION_SCHEMA).map((record) => ({
    environment: record.environment,
    configMap: record.configMap,
    key: record.key,
    sourceFile: record.sourceFile,
    classification: record.classification,
    classificationReason: record.classificationReason,
    consumerCount: record.distinctWorkloadCount,
  }));
}

/** Mapping records for the JSON report: same fields and order as the CSV. */
function toJsonRecords(rows: MappingRow[]): object[] {
  return rows.map((row) => ({
    environment: row.environment,
    sourceConfigMap: row.sourceConfigMap,
    sourceKey: row.sourceKey,
    targetPath: row.targetPath,
    targetRef: row.targetRef,
    classification: row.classification,
    destinationType: row.destinationType,
    consumerCount: row.consumerCount,
    sourceFile: row.sourceFile,
    note: row.classificationReason,
  }));
}

function toCamel(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (clean.length === 0) {
    return "";
  }

  const parts = clean.split(/\s+/);
  return parts
    .map((part, index) => {
      if (index === 0) {
        return part;
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join("");
}

function buildTarget(row: MappingRow): { destinationType: string; targetPath: string; targetRef: string } {
  const domain = toCamel(row.sourceConfigMap.replace(/^common-/, ""));
  const keyCamel = toCamel(row.sourceKey);

  if (row.classification === "COMMON_VALUE") {
    const targetPath = `commons.${domain}.${keyCamel}`;
    return {
      destinationType: "COMMON_VALUE",
      targetPath,
      targetRef: `{{.Values.${targetPath}}}`,
    };
  }

  if (row.classification === "WORKLOAD_VALUE") {
    return {
      destinationType: "WORKLOAD_VALUE",
      targetPath: `workload.${domain}.${keyCamel}`,
      targetRef: "workload-values-only",
    };
  }

  if (row.classification === "KEEP_AS_CONFIGMAP") {
    return {
      destinationType: "KEEP_AS_CONFIGMAP",
      targetPath: `configMap.${row.sourceConfigMap}.${row.sourceKey}`,
      targetRef: `${row.sourceConfigMap}.${row.sourceKey}`,
    };
  }

  if (row.classification === "OBSOLETE") {
    return {
      destinationType: "OBSOLETE",
      targetPath: `obsolete.${domain}.${keyCamel}`,
      targetRef: "candidate-removal",
    };
  }

  // An unknown value (for example MIGRATION_ASSET from an old classification report) must never become a removal candidate.
  throw new Error(
    `Unsupported classification '${row.classification}' for ${row.sourceConfigMap}.${row.sourceKey}; regenerate the classification report with task 2.`,
  );
}

function toCsv(rows: MappingRow[]): string {
  const header = [
    "environment",
    "sourceConfigMap",
    "sourceKey",
    "targetPath",
    "targetRef",
    "classification",
    "destinationType",
    "consumerCount",
    "sourceFile",
    "note",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.environment,
        row.sourceConfigMap,
        row.sourceKey,
        row.targetPath,
        row.targetRef,
        row.classification,
        row.destinationType,
        String(row.consumerCount),
        row.sourceFile,
        row.classificationReason,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}

function buildMappingRows(classificationRows: Task2Row[], env: string): MappingRow[] {
  const unique = new Map<string, MappingRow>();

  for (const row of classificationRows) {
    if (row.environment !== env) {
      continue;
    }

    if (row.configMap.length === 0 || row.key.length === 0 || row.classification.length === 0) {
      continue;
    }

    const id = `${row.environment}::${row.configMap}::${row.key}`;
    const existing = unique.get(id);

    if (!existing) {
      unique.set(id, {
        environment: row.environment,
        sourceConfigMap: row.configMap,
        sourceKey: row.key,
        sourceFile: row.sourceFile,
        classification: row.classification,
        classificationReason: row.classificationReason,
        consumerCount: row.consumerCount,
        destinationType: "",
        targetPath: "",
        targetRef: "",
      });
      continue;
    }

    if (row.classification !== existing.classification) {
      throw new Error(
        `Conflicting classifications for ${env}/${row.configMap}.${row.key}: ` +
        [existing.classification, row.classification].sort().join(", "),
      );
    }

    if (row.consumerCount > existing.consumerCount) {
      existing.consumerCount = row.consumerCount;
    }
  }

  const rows = [...unique.values()].sort(
    (a, b) =>
      a.environment.localeCompare(b.environment) ||
      a.sourceConfigMap.localeCompare(b.sourceConfigMap) ||
      a.sourceKey.localeCompare(b.sourceKey),
  );

  for (const row of rows) {
    const target = buildTarget(row);
    row.destinationType = target.destinationType;
    row.targetPath = target.targetPath;
    row.targetRef = target.targetRef;
  }

  // Prevent ambiguous path collisions by suffixing later duplicates.
  const ownerByPath = new Map<string, string>();
  for (const row of rows) {
    const owner = `${row.sourceConfigMap}.${row.sourceKey}`;
    const previousOwner = ownerByPath.get(row.targetPath);

    if (!previousOwner) {
      ownerByPath.set(row.targetPath, owner);
      continue;
    }

    if (previousOwner === owner) {
      continue;
    }

    row.targetPath = `${row.targetPath}__${toCamel(row.sourceConfigMap)}_${toCamel(row.sourceKey)}`;
    if (row.classification === "COMMON_VALUE") {
      row.targetRef = `{{.Values.${row.targetPath}}}`;
    }
  }

  return rows;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const classificationRows = readClassification(args.classificationJson);
  const mappingRows = buildMappingRows(classificationRows, args.env);

  if (mappingRows.length === 0) {
    throw new Error(`No mapping rows generated for environment: ${args.env}`);
  }

  for (const file of [args.outputCsv, args.outputJson]) {
    ensureDir(path.dirname(file));
  }

  fs.writeFileSync(args.outputCsv, `${toCsv(mappingRows)}\n`, "utf8");
  writeJsonReport(args.outputJson, toJsonRecords(mappingRows));

  console.log(`Environment: ${args.env}`);
  console.log(`Input classification: ${path.relative(args.root, args.classificationJson)}`);
  console.log(`Output CSV: ${path.relative(args.root, args.outputCsv)}`);
  console.log(`Output JSON: ${path.relative(args.root, args.outputJson)}`);
  console.log(`Rows generated: ${mappingRows.length}`);
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
