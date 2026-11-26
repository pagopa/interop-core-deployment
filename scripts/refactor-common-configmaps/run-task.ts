import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { summaryMetricsToCsv, type SummaryMetric } from "./csv.js";
import { writeJsonReport } from "./json-report.js";

const [script, outputDir, reportName, ...args] = process.argv.slice(2);
const result = spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8",
  stdio: ["inherit", "inherit", "pipe"],
});

if (result.stderr) {
  process.stderr.write(result.stderr);
}
const exitCode = result.status ?? 1;
const reason = result.error?.message ?? (result.stderr ?? "").trim();
const metrics: SummaryMetric[] = [
  { metric: "status", value: exitCode === 0 ? "SUCCESS" : "FAILED", description: "Task execution outcome" },
  { metric: "exitCode", value: exitCode, description: "Task process exit code" },
  {
    metric: "reason",
    value: exitCode === 0 ? "Task completed successfully." : reason || `Task exited with code ${exitCode}${result.signal ? ` (signal ${result.signal})` : ""}.`,
    description: "Task outcome details",
  },
];
fs.mkdirSync(outputDir, { recursive: true });
writeJsonReport(path.join(outputDir, `${reportName}.json`), metrics);
fs.writeFileSync(path.join(outputDir, `${reportName}.csv`), `${summaryMetricsToCsv(metrics)}\n`, "utf8");
process.exitCode = exitCode;
