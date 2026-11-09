import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';

export interface StatusDefinition {
  severity: Severity;
  description: string;
}

/** `detail` is mandatory: it states the concrete fact for that row, while `description` explains the status in general. */
export type ReportRow = { status: string; detail: string } & Record<string, unknown>;

export interface PhaseReportInput {
  phase: string;
  environment: string;
  root: string;
  definitions: Record<string, StatusDefinition>;
  columns: string[];
  rows: ReportRow[];
  parameters?: Record<string, unknown>;
}

/** Generic status used by every phase when the execution aborts with an unexpected error. */
export const FATAL_ERROR: StatusDefinition = { severity: 'critical', description: 'The phase aborted with an error before completing; see detail.' };

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info', 'ok'];

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Writes <reportDir>/<stem>.json and <stem>.csv. Every row carries a status code plus the severity and
 * description defined for that code. The phase succeeds when no row has severity `critical`.
 * Returns the success flag so callers can set the exit code after the report is safely on disk.
 */
export function writePhaseReport(reportDir: string | undefined, stem: string, input: PhaseReportInput): boolean {
  const resolve = (text: string) => text.replaceAll('<env>', input.environment);
  const definitions: Record<string, StatusDefinition> = Object.fromEntries(Object.entries({ FATAL_ERROR, ...input.definitions })
    .map(([status, definition]) => [status, { ...definition, description: resolve(definition.description) }]));
  const items = input.rows.map(row => {
    const definition = definitions[row.status];
    if (!definition) throw new Error(`Undefined report status '${row.status}' in phase '${input.phase}'.`);
    if (!row.detail) throw new Error(`Missing detail for status '${row.status}' in phase '${input.phase}'.`);
    return { ...row, severity: definition.severity, description: definition.description };
  });
  const success = !items.some(item => item.severity === 'critical');
  if (!reportDir) return success;

  const count = (predicate: (item: typeof items[number]) => boolean) => items.filter(predicate).length;
  const summary = {
    total: items.length,
    bySeverity: Object.fromEntries(SEVERITY_ORDER.map(severity => [severity, count(item => item.severity === severity)])),
    byStatus: Object.fromEntries([...new Set(items.map(item => item.status))].sort().map(status => [status, count(item => item.status === status)])),
  };
  const usedDefinitions = Object.fromEntries(Object.entries(definitions).filter(([status]) => status in summary.byStatus));
  const report = {
    schemaVersion: 1,
    phase: input.phase,
    environment: input.environment,
    root: input.root,
    generatedAt: new Date().toISOString(),
    parameters: input.parameters ?? {},
    success,
    summary,
    statusDefinitions: usedDefinitions,
    items,
  };

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const header = ['status', 'severity', ...input.columns, 'detail', 'description'];
  const lines = [header, ...items.map(item => header.map(column => (item as Record<string, unknown>)[column]))];
  writeFileSync(join(reportDir, `${stem}.csv`), `${lines.map(line => line.map(csvCell).join(',')).join('\n')}\n`);
  console.log(`REPORT - ${join(reportDir, `${stem}.{json,csv}`)} (${success ? 'success' : 'failed'}: ${summary.bySeverity.critical} critical, ${summary.bySeverity.warning} warning).`);
  return success;
}

/** Extracts `--report-dir <dir>` from the arguments, returning the remaining arguments untouched. */
export function extractReportDir(args: string[]): { reportDir?: string; args: string[] } {
  const rest: string[] = [];
  let reportDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--report-dir') {
      reportDir = args[++index];
      if (!reportDir) throw new Error('Missing value for --report-dir.');
    } else {
      rest.push(args[index]);
    }
  }
  return { reportDir, args: rest };
}
