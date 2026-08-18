import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";

type CliArgs = {
  env: string;
  root: string;
  mappingCsv: string;
  outputYaml: string;
  outputCoverageCsv: string;
  outputCoverageMd: string;
};

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
  const mappingCsv = path.resolve(
    arg.get("mapping-csv") ?? path.join(reportsDir, `task-3-common-values-mapping-${env}.csv`),
  );
  const outputYaml = path.resolve(
    arg.get("output-yaml") ?? path.join(root, "commons", env, "values-commons.yaml"),
  );
  const outputCoverageCsv = path.resolve(
    arg.get("output-coverage-csv") ?? path.join(reportsDir, `task-5-migration-coverage-${env}.csv`),
  );
  const outputCoverageMd = path.resolve(
    arg.get("output-coverage-md") ?? path.join(reportsDir, `task-5-migration-coverage-${env}.md`),
  );

  return { env, root, mappingCsv, outputYaml, outputCoverageCsv, outputCoverageMd };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
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

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function idx(header: string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) {
    throw new Error(`Missing expected CSV header column: ${name}`);
  }
  return index;
}

function parseMappingCsv(content: string): MappingRow[] {
  const { header, rows } = parseCsvRows(content);
  if (header.length === 0) {
    return [];
  }

  const indices = {
    environment: idx(header, "environment"),
    sourceConfigMap: idx(header, "sourceConfigMap"),
    sourceKey: idx(header, "sourceKey"),
    targetPath: idx(header, "targetPath"),
    targetRef: idx(header, "targetRef"),
    classification: idx(header, "classification"),
    destinationType: idx(header, "destinationType"),
    consumerCount: idx(header, "consumerCount"),
    sourceFile: idx(header, "sourceFile"),
    note: idx(header, "note"),
  };

  return rows.map((fields) => ({
    environment: fields[indices.environment] ?? "",
    sourceConfigMap: fields[indices.sourceConfigMap] ?? "",
    sourceKey: fields[indices.sourceKey] ?? "",
    targetPath: fields[indices.targetPath] ?? "",
    targetRef: fields[indices.targetRef] ?? "",
    classification: fields[indices.classification] ?? "",
    destinationType: fields[indices.destinationType] ?? "",
    sourceFile: fields[indices.sourceFile] ?? "",
    consumerCount: Number(fields[indices.consumerCount] ?? "0"),
    note: fields[indices.note] ?? "",
  }));
}

function exclusionReasonFor(row: MappingRow): string {
  if (row.classification === "WORKLOAD_VALUE") {
    return "Single-consumer or workload-specific value; intentionally left outside commons";
  }

  if (row.classification === "OBSOLETE") {
    return "No active consumers in TASK 1 inventory; excluded from commons";
  }

  if (row.classification === "MIGRATION_ASSET") {
    return "Migration asset; intentionally kept outside runtime commons values";
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
    `# TASK 5 - Migration Coverage (${env})`,
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
    "- Rows classified as COMMON_VALUE are the ones materialized into commons/dev/values-commons.yaml.",
    "- Rows outside COMMON_VALUE remain intentionally out of commons in TASK 5.",
  ].join("\n");
}

function readConfigMapData(root: string, env: string): Map<string, Map<string, string>> {
  const configmapsDir = path.join(root, "commons", env, "configmaps");
  const files = listYamlFiles(configmapsDir);
  const out = new Map<string, Map<string, string>>();

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const docs = YAML.parseAllDocuments(raw);

    for (const doc of docs) {
      const parsed = doc.toJSON() as
        | {
            kind?: string;
            metadata?: { name?: string };
            data?: Record<string, unknown>;
          }
        | null;

      if (!parsed || parsed.kind !== "ConfigMap") {
        continue;
      }

      const name = parsed.metadata?.name;
      if (!name) {
        continue;
      }

      const current = out.get(name) ?? new Map<string, string>();
      for (const [key, value] of Object.entries(parsed.data ?? {})) {
        current.set(key, value == null ? "" : String(value));
      }
      out.set(name, current);
    }
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setNestedString(root: Record<string, unknown>, targetPath: string, value: string): void {
  const parts = targetPath.split(".");
  if (parts.length < 2 || parts[0] !== "commons") {
    throw new Error(`Invalid commons target path: ${targetPath}`);
  }

  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = cursor[part];

    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
      continue;
    }

    if (!isRecord(next)) {
      throw new Error(`Cannot create nested path ${targetPath}: ${part} is not an object`);
    }

    cursor = next;
  }

  const leaf = parts[parts.length - 1];
  if (cursor[leaf] !== undefined) {
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

function isSensitiveName(value: string): boolean {
  return /(password|passwd|secret|private.?key|client.?secret|access.?key|bearer|credential)/i.test(value);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.mappingCsv)) {
    throw new Error(`Mapping CSV not found: ${args.mappingCsv}`);
  }

  const mappingRows = parseMappingCsv(fs.readFileSync(args.mappingCsv, "utf8"))
    .filter((row) => row.environment === args.env);

  const coverageRows = buildCoverageRows(mappingRows, args.env);
  const migratedRows = coverageRows
    .filter((row) => row.migrationStatus === "MIGRATED_TO_COMMONS")
    .sort((a, b) => a.targetPath.localeCompare(b.targetPath));

  if (migratedRows.length === 0) {
    throw new Error(`No COMMON_VALUE rows found for environment: ${args.env}`);
  }

  const configMaps = readConfigMapData(args.root, args.env);
  const documentRoot: Record<string, unknown> = {};
  const expectedPaths = new Set<string>();

  for (const row of migratedRows) {
    if (!row.targetPath.startsWith("commons.")) {
      throw new Error(`COMMON_VALUE row does not target commons.*: ${row.targetPath}`);
    }

    if (containsTemplate(row.targetRef)) {
      // Mapping targetRef is templated by design; reject only if targetPath itself is malformed.
    }

    if (isSensitiveName(row.sourceKey) || isSensitiveName(row.targetPath)) {
      throw new Error(`Sensitive-like key cannot be materialized in values-commons: ${row.sourceConfigMap}.${row.sourceKey}`);
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
  ensureDir(path.dirname(args.outputCoverageCsv));
  ensureDir(path.dirname(args.outputCoverageMd));
  const yamlOutput = YAML.stringify(documentRoot, {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
  });
  fs.writeFileSync(args.outputYaml, yamlOutput, "utf8");
  fs.writeFileSync(args.outputCoverageCsv, `${toCoverageCsv(coverageRows)}\n`, "utf8");
  fs.writeFileSync(args.outputCoverageMd, `${toCoverageMarkdown(coverageRows, args.env)}\n`, "utf8");

  console.log(`Environment: ${args.env}`);
  console.log(`Input mapping: ${path.relative(args.root, args.mappingCsv)}`);
  console.log(`Output YAML: ${path.relative(args.root, args.outputYaml)}`);
  console.log(`Output coverage CSV: ${path.relative(args.root, args.outputCoverageCsv)}`);
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