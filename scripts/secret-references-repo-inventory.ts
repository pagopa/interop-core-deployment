import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "./lib/cli.js";
import { toCsv } from "./lib/csv.js";
import type { CliArgs, SecretReferenceRecord } from "./lib/types.js";
import { dedupe, inventoryWorkload, walkWorkloads } from "./lib/workload.js";

// Re-export public API so external consumers can import from a single entry point.
export type { OutputFormat, ReferenceType, RecordContext, SecretReferenceRecord, SourceScope, WorkloadType } from "./lib/types.js";
export { parseArgs, parseOutputFormat } from "./lib/cli.js";
export { CSV_COLUMNS, csvEscape, toCsv } from "./lib/csv.js";
export { collectSecretReferencesFromFile, parseSecretAddress, yamlPathToString } from "./lib/yaml-walker.js";
export { dedupe, inventoryWorkload, walkWorkloads } from "./lib/workload.js";

/**
 * Write the selected output formats to disk.
 */
function writeOutputs(records: SecretReferenceRecord[], args: CliArgs): string[] {
  const outputDir = path.isAbsolute(args.outputDir) ? args.outputDir : path.join(args.root, args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = `secret-references-repo-${args.env}`;
  const written: string[] = [];

  if (args.format === "csv" || args.format === "both") {
    const csvPath = path.join(outputDir, `${baseName}.csv`);
    fs.writeFileSync(csvPath, `${toCsv(records)}\n`);
    written.push(csvPath);
  }

  if (args.format === "json" || args.format === "both") {
    const jsonPath = path.join(outputDir, `${baseName}.json`);
    fs.writeFileSync(jsonPath, `${JSON.stringify(records, null, 2)}\n`);
    written.push(jsonPath);
  }

  return written;
}

/**
 * Run the repository inventory from CLI arguments to output files.
 */
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.root)) {
    throw new Error(`Repository root does not exist: ${args.root}`);
  }

  const commonEnvDir = path.join(args.root, "commons", args.env);
  if (!fs.existsSync(commonEnvDir)) {
    throw new Error(`Common values directory not found for environment "${args.env}": ${path.relative(args.root, commonEnvDir)}`);
  }

  const workloads = [
    ...walkWorkloads(args.root, args.env, "microservice"),
    ...walkWorkloads(args.root, args.env, "cronjob"),
  ];

  if (workloads.length === 0) {
    throw new Error(`No workload values found for exact environment "${args.env}"`);
  }

  const records = dedupe(workloads.flatMap((workload) => inventoryWorkload(workload, args.root, args.env))).sort((a, b) =>
    [
      a.workloadType.localeCompare(b.workloadType),
      a.component.localeCompare(b.component),
      a.sourceScope.localeCompare(b.sourceScope),
      a.yamlPath.localeCompare(b.yamlPath),
      a.envVar.localeCompare(b.envVar),
    ].find((result) => result !== 0) || 0,
  );

  const written = writeOutputs(records, args);

  console.log(`Scanned ${workloads.length} workloads for exact environment "${args.env}".`);
  console.log(`Found ${records.length} secret references.`);
  written.forEach((file) => console.log(`Wrote ${path.relative(args.root, file)}`));
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
