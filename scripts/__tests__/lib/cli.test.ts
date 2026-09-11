import { describe, expect, it } from "vitest";
import { parseArgs, parseOutputFormat } from "../../lib/cli";

// ---------------------------------------------------------------------------
// parseOutputFormat
// ---------------------------------------------------------------------------

describe("parseOutputFormat", () => {
  it.each(["csv", "json", "both"])("accepts valid format '%s'", (format) => {
    expect(parseOutputFormat(format)).toBe(format);
  });

  it("throws for an unknown format", () => {
    expect(() => parseOutputFormat("xml")).toThrow("--format must be one of: csv, json, both");
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses the --env flag", () => {
    expect(parseArgs(["--env", "dev"]).env).toBe("dev");
  });

  it("accepts the -e short form", () => {
    expect(parseArgs(["-e", "qa"]).env).toBe("qa");
  });

  it("applies default values for outputDir and format", () => {
    const args = parseArgs(["--env", "dev"]);
    expect(args.outputDir).toBe("secret-inventory");
    expect(args.format).toBe("csv");
  });

  it("throws when --env is missing", () => {
    expect(() => parseArgs([])).toThrow("--env is required");
  });

  it("throws when --env contains a forward slash", () => {
    expect(() => parseArgs(["--env", "path/to/env"])).toThrow("--env must be an environment name, not a path");
  });

  it("throws when --env contains a back slash", () => {
    expect(() => parseArgs(["--env", "path\\env"])).toThrow("--env must be an environment name, not a path");
  });

  it("parses --format", () => {
    expect(parseArgs(["--env", "dev", "--format", "json"]).format).toBe("json");
  });

  it("parses --output-dir", () => {
    expect(parseArgs(["--env", "dev", "--output-dir", "reports"]).outputDir).toBe("reports");
  });

  it("throws for unknown arguments", () => {
    expect(() => parseArgs(["--env", "dev", "--unknown"])).toThrow("Unknown argument: --unknown");
  });
});
