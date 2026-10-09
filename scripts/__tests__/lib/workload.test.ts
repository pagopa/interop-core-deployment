import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dedupe, walkWorkloads } from "../../lib/workload";
import type { SecretReferenceRecord } from "../../lib/types";

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

describe("dedupe", () => {
  const makeRecord = (overrides: Partial<SecretReferenceRecord> = {}): SecretReferenceRecord => ({
    environment: "dev",
    workloadType: "microservice",
    component: "svc",
    sourceScope: "workload",
    sourceFile: "f.yaml",
    line: 1,
    yamlPath: "envFromSecrets",
    containerPath: "envFromSecrets",
    referenceType: "envFromSecrets",
    envVar: "MY_VAR",
    secretName: "my-secret",
    secretKey: "key",
    rawReference: "my-secret.key",
    ...overrides,
  });

  it("removes exact duplicate records", () => {
    expect(dedupe([makeRecord(), makeRecord()])).toHaveLength(1);
  });

  it("keeps records that differ by envVar", () => {
    expect(dedupe([makeRecord({ envVar: "A" }), makeRecord({ envVar: "B" })])).toHaveLength(2);
  });

  it("treats records with different line numbers as duplicates (line is not in the key)", () => {
    expect(dedupe([makeRecord({ line: 1 }), makeRecord({ line: 99 })])).toHaveLength(1);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupe([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// walkWorkloads
// ---------------------------------------------------------------------------

describe("walkWorkloads", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "interop-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds a microservice workload with a matching env directory", () => {
    const svcDir = path.join(tmpDir, "microservices", "my-service", "dev");
    fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, "values.yaml"), "foo: bar\n");

    const workloads = walkWorkloads(tmpDir, "dev", "microservice");
    expect(workloads).toHaveLength(1);
    expect(workloads[0].component).toBe("my-service");
    expect(workloads[0].workloadType).toBe("microservice");
  });

  it("returns an empty array when the base directory does not exist", () => {
    expect(walkWorkloads(tmpDir, "dev", "microservice")).toEqual([]);
  });

  it("skips components that lack the requested env directory", () => {
    const svcDir = path.join(tmpDir, "microservices", "my-service", "prod");
    fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, "values.yaml"), "foo: bar\n");

    expect(walkWorkloads(tmpDir, "dev", "microservice")).toEqual([]);
  });

  it("includes the common values file when it exists", () => {
    const svcDir = path.join(tmpDir, "microservices", "my-service", "dev");
    fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, "values.yaml"), "foo: bar\n");

    const commonDir = path.join(tmpDir, "commons", "dev");
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, "values-microservice.yaml"), "common: true\n");

    const workloads = walkWorkloads(tmpDir, "dev", "microservice");
    expect(workloads[0].valueFiles).toHaveLength(2);
    expect(workloads[0].valueFiles[0]).toContain("values-microservice.yaml");
    expect(workloads[0].valueFiles[1]).toContain("values.yaml");
  });

  it("omits the common values file when it does not exist", () => {
    const svcDir = path.join(tmpDir, "microservices", "my-service", "dev");
    fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, "values.yaml"), "foo: bar\n");

    const workloads = walkWorkloads(tmpDir, "dev", "microservice");
    expect(workloads[0].valueFiles).toHaveLength(1);
    expect(workloads[0].valueFiles[0]).toContain("values.yaml");
  });

  it("finds cronjob workloads from the jobs directory", () => {
    const jobDir = path.join(tmpDir, "jobs", "my-job", "dev");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "values.yaml"), "schedule: '*/5 * * * *'\n");

    const workloads = walkWorkloads(tmpDir, "dev", "cronjob");
    expect(workloads).toHaveLength(1);
    expect(workloads[0].component).toBe("my-job");
    expect(workloads[0].workloadType).toBe("cronjob");
  });
});
