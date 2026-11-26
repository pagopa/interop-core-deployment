import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { csvEscape } from "./csv.js";
import { readJsonRecords, writeJsonReport } from "./json-report.js";

const INVENTORY_SCHEMA = {
  configMap: "string", key: "string", workloadType: "string", workload: "string",
  valuesFile: "string", sourceFile: "string", section: "string", envVar: "string", status: "string",
} as const;
const CLASSIFICATION_SCHEMA = {
  configMap: "string", key: "string", sourceFile: "string", classification: "string",
  distinctWorkloadCount: "number",
} as const;

function writeReports(directory: string, name: string, rows: Record<string, unknown>[]): void {
  writeJsonReport(path.join(directory, `${name}.json`), rows);
  const columns = Object.keys(rows[0]);
  const records = rows.map((row) => columns.map((column) => {
    const value = row[column];
    return csvEscape(Array.isArray(value) ? JSON.stringify(value) : String(value));
  }).join(","));
  fs.writeFileSync(path.join(directory, `${name}.csv`), [columns.join(","), ...records].join("\n") + "\n");
}

function main(): void {
  const { values } = parseArgs({ options: { root: { type: "string" }, "output-dir": { type: "string" } } });
  const root = path.resolve(values.root ?? process.cwd());
  const output = path.resolve(root, values["output-dir"] ?? "reports/refactor-common-configmaps");
  const commons = path.join(root, "commons");
  const environments = fs.readdirSync(commons, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(commons, entry.name, "configmaps")))
    .map((entry) => entry.name).sort();
  if (environments.length === 0) {
    throw new Error(`No environments with ConfigMaps found in ${commons}`);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "compare-configmaps-"));
  const keys = new Map<string, { configMap: string; key: string }>();
  const snapshots = [];
  try {
    for (const environment of environments) {
      const run = (task: string, args: string[]) => execFileSync(process.execPath, [
        path.join(import.meta.dirname, `${task}.js`), "--root", root, "--env", environment, ...args,
      ], { stdio: "inherit" });
      const inventoryFile = path.join(scratch, `task-1-inventory-${environment}.json`);
      const classificationFile = path.join(scratch, `task-2-classification-common-configmaps-${environment}.json`);
      run("task1-verify", ["--output-dir", scratch]);
      run("task2-classify", [
        "--inventory-json", inventoryFile,
        "--output-json", classificationFile,
        "--output-csv", path.join(scratch, "classification.csv"),
        "--output-summary-csv", path.join(scratch, "classification-summary.csv"),
        "--output-summary-json", path.join(scratch, "classification-summary.json"),
      ]);

      const inventory = readJsonRecords(inventoryFile, INVENTORY_SCHEMA);
      const classificationRows = readJsonRecords(classificationFile, CLASSIFICATION_SCHEMA);
      const classifications = new Map<string, (typeof classificationRows)[number]>();
      for (const row of classificationRows) {
        const id = JSON.stringify([row.configMap, row.key]);
        keys.set(id, { configMap: row.configMap, key: row.key });
        classifications.set(id, row);
      }
      const references = new Map<string, typeof inventory>();
      for (const row of inventory) {
        const id = JSON.stringify([row.configMap, row.key]);
        const rows = references.get(id) ?? [];
        rows.push(row);
        references.set(id, rows);
      }
      snapshots.push({ environment, classifications, references, inventory });
    }

    const details: Array<{
      configMap: string;
      key: string;
      environment: string;
      classification: string;
      classificationDiffers: boolean;
      definedIn: string[];
      sourceFile: string;
      distinctWorkloadCount: number;
      referenceCount: number;
      references: ReturnType<typeof readJsonRecords<typeof INVENTORY_SCHEMA>>;
    }> = [];
    for (const id of [...keys.keys()].sort()) {
      const key = keys.get(id)!;
      const states = snapshots.map(({ classifications }) => classifications.get(id)?.classification ?? "ABSENT");
      const classificationDiffers = new Set(states.filter((state) => state !== "ABSENT")).size > 1;
      const definedIn = environments.filter((_, index) => states[index] !== "ABSENT");
      for (const [index, snapshot] of snapshots.entries()) {
        const classification = snapshot.classifications.get(id);
        const references = snapshot.references.get(id) ?? [];
        details.push({
          ...key, environment: snapshot.environment, classification: states[index], classificationDiffers, definedIn,
          sourceFile: classification?.sourceFile ?? "", distinctWorkloadCount: classification?.distinctWorkloadCount ?? 0,
          referenceCount: references.length, references,
        });
      }
    }
    const inventory = snapshots.flatMap((snapshot) => snapshot.inventory.map((row) => ({
      environment: snapshot.environment, ...row,
    })));
    const summary = snapshots.map(({ environment }) => {
      const rows = details.filter((row) => row.environment === environment);
      return {
        environment,
        inventoryReferences: inventory.filter((row) => row.environment === environment).length,
        commonValueKeys: rows.filter((row) => row.classification === "COMMON_VALUE").length,
        workloadValueKeys: rows.filter((row) => row.classification === "WORKLOAD_VALUE").length,
        obsoleteKeys: rows.filter((row) => row.classification === "OBSOLETE").length,
        keepAsConfigMapKeys: rows.filter((row) => row.classification === "KEEP_AS_CONFIGMAP").length,
        absentKeys: rows.filter((row) => row.classification === "ABSENT").length,
        keysDefinedOnlyHere: rows.filter((row) => row.definedIn.length === 1 && row.definedIn.includes(environment)).length,
        keysWithDifferentClassification: rows.filter((row) => row.classificationDiffers && row.classification !== "ABSENT").length,
      };
    });

    fs.mkdirSync(output, { recursive: true });
    writeReports(output, "task-0-cross-environment-classification", details);
    writeReports(output, "task-0-cross-environment-inventory", inventory);
    writeReports(output, "task-0-cross-environment-summary", summary);
    console.log(`Compared ${environments.length} environments and ${keys.size} ConfigMap keys. Reports: ${output}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
