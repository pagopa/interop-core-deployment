import { describe, expect, it } from "vitest";
import { csvEscape, toCsv } from "../../lib/csv";
import type { SecretReferenceRecord } from "../../lib/types";

// ---------------------------------------------------------------------------
// csvEscape
// ---------------------------------------------------------------------------

describe("csvEscape", () => {
  it("returns plain strings unchanged", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  it("wraps in double-quotes when the value contains a comma", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("escapes inner double-quotes by doubling them", () => {
    expect(csvEscape('say "hello"')).toBe('"say ""hello"""');
  });

  it("wraps in double-quotes when the value contains a newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("converts numbers to string", () => {
    expect(csvEscape(42)).toBe("42");
  });

  it("returns empty string unchanged", () => {
    expect(csvEscape("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// toCsv
// ---------------------------------------------------------------------------

describe("toCsv", () => {
  it("produces the correct header row", () => {
    const header = toCsv([]).split("\n")[0];
    expect(header).toBe(
      "environment,workloadType,component,sourceScope,sourceFile,line,yamlPath,containerPath,referenceType,envVar,secretName,secretKey,rawReference",
    );
  });

  it("produces one data row per record in column order", () => {
    const record: SecretReferenceRecord = {
      environment: "dev",
      workloadType: "microservice",
      component: "svc",
      sourceScope: "workload",
      sourceFile: "f.yaml",
      line: 10,
      yamlPath: "envFromSecrets",
      containerPath: "envFromSecrets",
      referenceType: "envFromSecrets",
      envVar: "MY_VAR",
      secretName: "my-secret",
      secretKey: "key",
      rawReference: "my-secret.key",
    };
    const lines = toCsv([record]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "dev,microservice,svc,workload,f.yaml,10,envFromSecrets,envFromSecrets,envFromSecrets,MY_VAR,my-secret,key,my-secret.key",
    );
  });

  it("escapes fields that contain commas", () => {
    const record: SecretReferenceRecord = {
      environment: "dev",
      workloadType: "microservice",
      component: "svc",
      sourceScope: "workload",
      sourceFile: "path/to,file.yaml",
      line: 1,
      yamlPath: ".",
      containerPath: ".",
      referenceType: "envFromSecrets",
      envVar: "V",
      secretName: "s",
      secretKey: "",
      rawReference: "s",
    };
    expect(toCsv([record])).toContain('"path/to,file.yaml"');
  });
});
