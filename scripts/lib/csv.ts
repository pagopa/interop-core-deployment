import type { SecretReferenceRecord } from './types.js';

export const CSV_COLUMNS: Array<keyof SecretReferenceRecord> = [
  "environment",
  "workloadType",
  "component",
  "sourceScope",
  "sourceFile",
  "line",
  "yamlPath",
  "containerPath",
  "referenceType",
  "envVar",
  "secretName",
  "secretKey",
  "rawReference",
];

/**
 * Convert inventory records to CSV.
 */
export function toCsv(records: SecretReferenceRecord[]): string {
  return [
    CSV_COLUMNS.join(","),
    ...records.map((record) => CSV_COLUMNS.map((column) => csvEscape(record[column])).join(",")),
  ].join("\n");
}

/**
 * Escape one field according to CSV quoting rules.
 */
export function csvEscape(value: string | number): string {
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}
