import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";

// Same criteria as the Flyway migrations toolset (scripts/migrations/flyway, PR #871):
// FLYWAY_SOURCE_FILE and IGNORED_MIGRATION_DOMAINS mirror common.ts, LEGACY_KEY/TARGET_KEY and the
// reference lookup mirror workloads.ts. Keep them aligned when that toolset changes.

/** Flyway source ConfigMap files: commons/<env>/configmaps/flyway*.yaml|yml (top level only). */
export const FLYWAY_SOURCE_FILE = /^flyway.*\.ya?ml$/i;

export const LEGACY_KEY = "migrationsConfigmap";
export const TARGET_KEY = "migrationDomain";

export type MigrationReferenceKey = typeof LEGACY_KEY | typeof TARGET_KEY;

/** Migration domains that the Flyway toolset knowingly leaves out of scope. */
export const IGNORED_MIGRATION_DOMAINS = new Map<string, string>([
  [
    "common-db-migrations",
    "MongoDB migration used only by deprecated Scala services authorization-management and notifier.",
  ],
]);

const WORKLOAD_FOLDERS = [
  { folder: "microservices", section: "deployment", workloadType: "microservice" },
  { folder: "jobs", section: "cronjob", workloadType: "cronjob" },
] as const;

export type MigrationReference = {
  workloadType: "microservice" | "cronjob";
  workload: string;
  valuesFile: string;
  section: string;
  referenceKey: MigrationReferenceKey;
  /** Referenced migration domain, i.e. the source ConfigMap metadata.name. */
  domain: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** metadata.name of every Flyway source ConfigMap, mapped to its file path relative to root. */
export function readFlywaySourceConfigMaps(root: string, env: string): Map<string, string> {
  const directory = path.join(root, "commons", env, "configmaps");
  const sources = new Map<string, string>();
  if (!fs.existsSync(directory)) {
    return sources;
  }

  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && FLYWAY_SOURCE_FILE.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();

  for (const file of files) {
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as { kind?: unknown; metadata?: { name?: unknown } } | null;
    const name = doc?.metadata?.name;
    if (doc?.kind === "ConfigMap" && typeof name === "string" && name.length > 0) {
      sources.set(name, path.relative(root, file));
    }
  }

  return sources;
}

/**
 * References declared in <section>.flywayInitContainer of microservices|jobs/<name>/<env>/values.yaml.
 * Throws, like the Flyway toolset, on empty values or when migrationsConfigmap and migrationDomain conflict.
 */
export function readMigrationReferences(root: string, env: string): MigrationReference[] {
  const references: MigrationReference[] = [];

  for (const { folder, section, workloadType } of WORKLOAD_FOLDERS) {
    const directory = path.join(root, folder);
    if (!fs.existsSync(directory)) {
      continue;
    }

    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const file = path.join(directory, entry.name, env, "values.yaml");
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        continue;
      }

      const valuesFile = path.relative(root, file);
      const doc = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
      const values = isRecord(doc) ? doc[section] : undefined;
      if (values === undefined || values === null) {
        continue;
      }
      if (!isRecord(values)) {
        throw new Error(`${valuesFile}: '${section}' must be a mapping.`);
      }

      const flyway = values.flywayInitContainer;
      if (flyway === undefined || flyway === null) {
        continue;
      }
      if (!isRecord(flyway)) {
        throw new Error(`${valuesFile}: '${section}.flywayInitContainer' must be a mapping.`);
      }

      const hasLegacy = Object.prototype.hasOwnProperty.call(flyway, LEGACY_KEY);
      const hasTarget = Object.prototype.hasOwnProperty.call(flyway, TARGET_KEY);
      if (!hasLegacy && !hasTarget) {
        continue;
      }

      const legacy = typeof flyway[LEGACY_KEY] === "string" ? (flyway[LEGACY_KEY] as string) : "";
      const target = typeof flyway[TARGET_KEY] === "string" ? (flyway[TARGET_KEY] as string) : "";
      if (hasLegacy && !legacy) {
        throw new Error(`${valuesFile}: '${LEGACY_KEY}' must be a non-empty string.`);
      }
      if (hasTarget && !target) {
        throw new Error(`${valuesFile}: '${TARGET_KEY}' must be a non-empty string.`);
      }
      if (legacy && target && legacy !== target) {
        throw new Error(`${valuesFile}: ${LEGACY_KEY} '${legacy}' conflicts with ${TARGET_KEY} '${target}'.`);
      }

      const referenceKey: MigrationReferenceKey = target ? TARGET_KEY : LEGACY_KEY;
      references.push({
        workloadType,
        workload: entry.name,
        valuesFile,
        section: `${section}.flywayInitContainer.${referenceKey}`,
        referenceKey,
        domain: target || legacy,
      });
    }
  }

  return references;
}

/** Reasons why a ConfigMap is a migration asset; empty when it is not. */
export function migrationAssetSignals(input: {
  configMap: string;
  flywaySourceConfigMaps: Map<string, string>;
  referencedByWorkloads: boolean;
}): string[] {
  const signals: string[] = [];
  if (input.flywaySourceConfigMaps.has(input.configMap)) {
    signals.push("Flyway source ConfigMap (flyway*.yaml)");
  }
  if (input.referencedByWorkloads) {
    signals.push(`referenced by flywayInitContainer.${LEGACY_KEY}/${TARGET_KEY}`);
  }
  const ignoredReason = IGNORED_MIGRATION_DOMAINS.get(input.configMap);
  if (ignoredReason) {
    signals.push(`migration domain ignored by the Flyway toolset: ${ignoredReason}`);
  }
  return signals;
}
