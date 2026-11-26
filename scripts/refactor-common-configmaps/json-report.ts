import * as fs from "fs";

export type JsonFieldType = "string" | "number" | "string[]";

type JsonFieldValue<T extends JsonFieldType> = T extends "string" ? string : T extends "number" ? number : string[];

export type JsonRecord<Schema extends Record<string, JsonFieldType>> = { [Field in keyof Schema]: JsonFieldValue<Schema[Field]> };

function matchesType(value: unknown, type: JsonFieldType): boolean {
  if (type === "string") {
    return typeof value === "string";
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Reads a JSON report written by a previous task: an array of objects whose fields match `schema`.
 * Fails on a missing file, invalid JSON or any record that does not match, so incomplete reports are never used.
 */
export function readJsonRecords<Schema extends Record<string, JsonFieldType>>(file: string, schema: Schema): Array<JsonRecord<Schema>> {
  if (!fs.existsSync(file)) {
    throw new Error(`JSON report not found: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON array of records.`);
  }

  return parsed.map((record, index) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`${file}: record ${index} is not an object.`);
    }
    const out: Record<string, unknown> = {};
    for (const [field, type] of Object.entries(schema)) {
      const value = (record as Record<string, unknown>)[field];
      if (!matchesType(value, type)) {
        throw new Error(`${file}: record ${index} has no ${type} field '${field}'.`);
      }
      out[field] = value;
    }
    return out as JsonRecord<Schema>;
  });
}

/** Reads a JSON report whose `fields` are all strings. */
export function readJsonReport<Field extends string>(file: string, fields: readonly Field[]): Array<Record<Field, string>> {
  const schema = Object.fromEntries(fields.map((field) => [field, "string"])) as Record<Field, "string">;
  return readJsonRecords(file, schema) as Array<Record<Field, string>>;
}

export function writeJsonReport(file: string, records: readonly object[]): void {
  fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}
