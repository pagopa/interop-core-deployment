import * as path from "path";
import type { CliArgs, OutputFormat, PartialCliArgs } from "./types.js";

const DEFAULT_OUTPUT_DIR = "secret-inventory";
const OUTPUT_FORMATS: OutputFormat[] = ["csv", "json", "both"];

/**
 * Parse and validate CLI arguments.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: PartialCliArgs = {
    env: null,
    root: process.cwd(),
    outputDir: DEFAULT_OUTPUT_DIR,
    format: "csv",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--env" || arg === "-e") {
      args.env = requireValue(arg, next);
      i += 1;
    } else if (arg === "--root" || arg === "-r") {
      args.root = requireValue(arg, next);
      i += 1;
    } else if (arg === "--output-dir" || arg === "-o") {
      args.outputDir = requireValue(arg, next);
      i += 1;
    } else if (arg === "--format" || arg === "-f") {
      args.format = parseOutputFormat(requireValue(arg, next));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.root = path.resolve(args.root);
  if (!args.env) {
    throw new Error("--env is required");
  }
  if (args.env.includes("/") || args.env.includes("\\")) {
    throw new Error("--env must be an environment name, not a path");
  }

  return {
    env: args.env,
    root: args.root,
    outputDir: args.outputDir,
    format: args.format,
  };
}

/**
 * Read the value that must follow a CLI option.
 */
function requireValue(arg: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

/**
 * Parse and validate the requested output format.
 */
export function parseOutputFormat(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
    throw new Error("--format must be one of: csv, json, both");
  }
  return value as OutputFormat;
}

/**
 * Print command usage and examples.
 */
function printHelp(): void {
  console.log(`Usage:
  node scripts/secret-references-repo-inventory.js --env dev [options]
  npm run secret-references-repo-inventory -- --env dev [options]

Options:
  -e, --env <name>          Environment directory to scan exactly. Required
  -r, --root <path>         Repository root. Default: current directory
  -o, --output-dir <path>   Output directory, relative to root unless absolute. Default: secret-inventory
  -f, --format <format>     csv, json, or both. Default: csv

Examples:
  node scripts/secret-references-repo-inventory.js --env dev
  npm run secret-references-repo-inventory -- --env qa --format both --output-dir reports/secrets
`);
}
