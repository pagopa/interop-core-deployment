import * as fs from "fs";
import * as path from "path";

type CliArgs = {
  env: string;
  root: string;
  classificationCsv: string;
  outputYaml: string;
  outputCsv: string;
};

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

  const classificationCsv = path.resolve(
    arg.get("classification-csv") ??
      path.join(root, "reports", "refactor-common-configmaps", `task-2-common-configmaps-classification-${env}.csv`),
  );

  const outputYaml = path.resolve(arg.get("output-yaml") ?? path.join(outDir, `task-3-common-values-mapping-${env}.yaml`));
  const outputCsv = path.resolve(arg.get("output-csv") ?? path.join(outDir, `task-3-common-values-mapping-${env}.csv`));

  return { env, root, classificationCsv, outputYaml, outputCsv };
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

function parseClassificationCsv(content: string): Task2Row[] {
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
    configMap: idx("configMap"),
    key: idx("key"),
    sourceFile: idx("sourceFile"),
    classification: idx("classification"),
    classificationReason: idx("classificationReason"),
    consumerCount: idx("consumerCount"),
  };

  const rows: Task2Row[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]);
    const consumerCount = Number(fields[indices.consumerCount] ?? "0");

    rows.push({
      environment: fields[indices.environment] ?? "",
      configMap: fields[indices.configMap] ?? "",
      key: fields[indices.key] ?? "",
      sourceFile: fields[indices.sourceFile] ?? "",
      classification: fields[indices.classification] ?? "",
      classificationReason: fields[indices.classificationReason] ?? "",
      consumerCount: Number.isFinite(consumerCount) ? consumerCount : 0,
    });
  }

  return rows;
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

  if (row.classification === "MIGRATION_ASSET") {
    return {
      destinationType: "MIGRATION_ASSET",
      targetPath: `migrationAsset.${domain}.${keyCamel}`,
      targetRef: "keep-outside-common-values",
    };
  }

  if (row.classification === "KEEP_AS_CONFIGMAP") {
    return {
      destinationType: "KEEP_AS_CONFIGMAP",
      targetPath: `configMap.${row.sourceConfigMap}.${row.sourceKey}`,
      targetRef: `${row.sourceConfigMap}.${row.sourceKey}`,
    };
  }

  return {
    destinationType: "OBSOLETE",
    targetPath: `obsolete.${domain}.${keyCamel}`,
    targetRef: "candidate-removal",
  };
}

function toYaml(rows: MappingRow[], sourceCsv: string): string {
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.classification] = (acc[row.classification] ?? 0) + 1;
    return acc;
  }, {});

  const yamlRows = rows
    .map((row) => {
      const note = row.classificationReason.replace(/"/g, '\\"');
      return [
        `  - environment: ${row.environment}`,
        `    sourceConfigMap: ${row.sourceConfigMap}`,
        `    sourceKey: ${row.sourceKey}`,
        `    sourceFile: ${row.sourceFile}`,
        `    classification: ${row.classification}`,
        `    destinationType: ${row.destinationType}`,
        `    targetPath: ${row.targetPath}`,
        `    targetRef: \"${row.targetRef}\"`,
        `    consumerCount: ${row.consumerCount}`,
        `    note: \"${note}\"`,
      ].join("\n");
    })
    .join("\n");

  return [
    "version: 1",
    `sourceClassificationFile: ${sourceCsv}`,
    "generatedBy: task-3-build-mapping",
    "summary:",
    `  totalKeys: ${rows.length}`,
    `  commonValueKeys: ${counts.COMMON_VALUE ?? 0}`,
    `  workloadValueKeys: ${counts.WORKLOAD_VALUE ?? 0}`,
    `  migrationAssetKeys: ${counts.MIGRATION_ASSET ?? 0}`,
    `  keepAsConfigMapKeys: ${counts.KEEP_AS_CONFIGMAP ?? 0}`,
    `  obsoleteKeys: ${counts.OBSOLETE ?? 0}`,
    "mappings:",
    yamlRows,
  ].join("\n");
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

  if (!fs.existsSync(args.classificationCsv)) {
    throw new Error(`Classification CSV not found: ${args.classificationCsv}`);
  }

  const classificationRaw = fs.readFileSync(args.classificationCsv, "utf8");
  const classificationRows = parseClassificationCsv(classificationRaw);
  const mappingRows = buildMappingRows(classificationRows, args.env);

  if (mappingRows.length === 0) {
    throw new Error(`No mapping rows generated for environment: ${args.env}`);
  }

  ensureDir(path.dirname(args.outputYaml));
  ensureDir(path.dirname(args.outputCsv));

  fs.writeFileSync(
    args.outputYaml,
    `${toYaml(mappingRows, path.relative(args.root, args.classificationCsv))}\n`,
    "utf8",
  );
  fs.writeFileSync(args.outputCsv, `${toCsv(mappingRows)}\n`, "utf8");

  console.log(`Environment: ${args.env}`);
  console.log(`Input classification: ${path.relative(args.root, args.classificationCsv)}`);
  console.log(`Output YAML: ${path.relative(args.root, args.outputYaml)}`);
  console.log(`Output CSV: ${path.relative(args.root, args.outputCsv)}`);
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
