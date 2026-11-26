// RFC 4180 CSV writer helpers: quoted fields may contain commas, double quotes and line breaks.

/** Row of a summary report; the CSV has the columns metric,value,description and the JSON the same fields. */
export type SummaryMetric = { metric: string; value: string | number; description: string };

export function summaryMetricsToCsv(metrics: readonly SummaryMetric[]): string {
  return ["metric,value,description", ...metrics.map((m) => [m.metric, String(m.value), m.description].map(csvEscape).join(","))].join("\n");
}

export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
