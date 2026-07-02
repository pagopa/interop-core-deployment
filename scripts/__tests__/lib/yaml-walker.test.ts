import * as path from "path";
import { describe, expect, it } from "vitest";
import { collectSecretReferencesFromFile, parseSecretAddress, yamlPathToString } from "../../lib/yaml-walker";
import type { RecordContext } from "../../lib/types";

const FIXTURES_DIR = path.join(process.cwd(), "scripts", "__tests__", "fixtures");

const TEST_CTX: RecordContext = {
  environment: "test",
  workloadType: "microservice",
  component: "my-service",
  sourceScope: "workload",
  sourceFile: "microservices/my-service/test/values.yaml",
};

// ---------------------------------------------------------------------------
// parseSecretAddress
// ---------------------------------------------------------------------------

describe("parseSecretAddress", () => {
  it("splits name and key on the first dot", () => {
    expect(parseSecretAddress("my-secret.my-key")).toEqual({ secretName: "my-secret", secretKey: "my-key" });
  });

  it("uses only the first dot as separator when multiple dots are present", () => {
    expect(parseSecretAddress("my-secret.sub.key")).toEqual({ secretName: "my-secret", secretKey: "sub.key" });
  });

  it("returns empty secretKey when no dot is present", () => {
    expect(parseSecretAddress("only-secret-name")).toEqual({ secretName: "only-secret-name", secretKey: "" });
  });
});

// ---------------------------------------------------------------------------
// yamlPathToString
// ---------------------------------------------------------------------------

describe("yamlPathToString", () => {
  it("joins parts with dots", () => {
    expect(yamlPathToString(["a", "b", "c"])).toBe("a.b.c");
  });

  it("removes the dot before array brackets", () => {
    expect(yamlPathToString(["items", "[0]", "name"])).toBe("items[0].name");
  });

  it("returns empty string for an empty array", () => {
    expect(yamlPathToString([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// collectSecretReferencesFromFile
// ---------------------------------------------------------------------------

describe("collectSecretReferencesFromFile", () => {
  describe("envFromSecrets", () => {
    it("collects entries that include a secretKey", () => {
      const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "env-from-secrets.yaml"), TEST_CTX);
      const record = records.find((r) => r.envVar === "MY_VAR");
      expect(record).toBeDefined();
      expect(record?.referenceType).toBe("envFromSecrets");
      expect(record?.secretName).toBe("my-secret");
      expect(record?.secretKey).toBe("my-key");
      expect(record?.rawReference).toBe("my-secret.my-key");
    });

    it("collects entries without a secretKey", () => {
      const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "env-from-secrets.yaml"), TEST_CTX);
      const record = records.find((r) => r.envVar === "OTHER_VAR");
      expect(record?.secretName).toBe("other-secret");
      expect(record?.secretKey).toBe("");
    });
  });

  describe("secretKeyRef", () => {
    it("collects entries and resolves envVar from the nearest name ancestor", () => {
      const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "secret-key-ref.yaml"), TEST_CTX);
      expect(records).toHaveLength(1);
      expect(records[0].referenceType).toBe("secretKeyRef");
      expect(records[0].envVar).toBe("DB_PASSWORD");
      expect(records[0].secretName).toBe("db-credentials");
      expect(records[0].secretKey).toBe("password");
    });
  });

  describe("secretRef", () => {
    it("collects entries with empty envVar and secretKey", () => {
      const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "secret-ref.yaml"), TEST_CTX);
      expect(records).toHaveLength(1);
      expect(records[0].referenceType).toBe("secretRef");
      expect(records[0].envVar).toBe("");
      expect(records[0].secretName).toBe("app-secrets");
      expect(records[0].secretKey).toBe("");
    });
  });

  describe("volumeSecret", () => {
    it("collects volume secret entries", () => {
      const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "volume-secret.yaml"), TEST_CTX);
      expect(records).toHaveLength(1);
      expect(records[0].referenceType).toBe("volumeSecret");
      expect(records[0].secretName).toBe("tls-secret");
      expect(records[0].secretKey).toBe("");
      expect(records[0].envVar).toBe("");
    });
  });

  describe("mixed", () => {
    it("collects all four reference types from a single file", () => {
      const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "mixed.yaml"), TEST_CTX);
      const types = records.map((r) => r.referenceType);
      expect(types).toContain("envFromSecrets");
      expect(types).toContain("secretKeyRef");
      expect(types).toContain("secretRef");
      expect(types).toContain("volumeSecret");
    });
  });

  it("propagates RecordContext fields to every record", () => {
    const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "env-from-secrets.yaml"), TEST_CTX);
    records.forEach((record) => {
      expect(record.environment).toBe(TEST_CTX.environment);
      expect(record.workloadType).toBe(TEST_CTX.workloadType);
      expect(record.component).toBe(TEST_CTX.component);
      expect(record.sourceScope).toBe(TEST_CTX.sourceScope);
      expect(record.sourceFile).toBe(TEST_CTX.sourceFile);
    });
  });

  it("records include a positive line number", () => {
    const records = collectSecretReferencesFromFile(path.join(FIXTURES_DIR, "env-from-secrets.yaml"), TEST_CTX);
    records.forEach((record) => {
      expect(typeof record.line).toBe("number");
      expect(record.line as number).toBeGreaterThan(0);
    });
  });
});
