import * as fs from "fs";
import * as path from "path";
import { configMapFromDocument, fail, field, mapping, readCommonConfigMaps, scalarText, yamlDocument, type ConfigMapSource } from "./yaml-source.js";

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
    const relative = path.relative(root, file);
    const configMap = configMapFromDocument(yamlDocument(file), relative);
    if (!configMap) {
      continue;
    }
    const previous = sources.get(configMap.name);
    if (previous) {
      fail(`Duplicate Flyway ConfigMap metadata.name '${configMap.name}' in ${previous} and ${relative}.`);
    }
    sources.set(configMap.name, relative);
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
      const values = field(yamlDocument(file).contents, section);
      if (values === undefined) {
        continue;
      }
      if (!mapping(values)) {
        fail(`${valuesFile}: '${section}' must be a mapping.`);
      }

      const flyway = field(values, "flywayInitContainer");
      if (flyway === undefined) {
        continue;
      }
      if (!mapping(flyway)) {
        fail(`${valuesFile}: '${section}.flywayInitContainer' must be a mapping.`);
      }

      const hasLegacy = flyway.has(LEGACY_KEY);
      const hasTarget = flyway.has(TARGET_KEY);
      if (!hasLegacy && !hasTarget) {
        continue;
      }

      const legacy = scalarText(field(flyway, LEGACY_KEY)) ?? "";
      const target = scalarText(field(flyway, TARGET_KEY)) ?? "";
      if (hasLegacy && !legacy) {
        fail(`${valuesFile}: '${LEGACY_KEY}' must be a non-empty string.`);
      }
      if (hasTarget && !target) {
        fail(`${valuesFile}: '${TARGET_KEY}' must be a non-empty string.`);
      }
      if (legacy && target && legacy !== target) {
        fail(`${valuesFile}: ${LEGACY_KEY} '${legacy}' conflicts with ${TARGET_KEY} '${target}'.`);
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

export type ExcludedMigrationConfigMap = {
  file: string;
  signals: string[];
};

/**
 * Common ConfigMaps in scope for the refactoring: every ConfigMap of commons/<env>/configmaps except the
 * migration ones, which belong to the Flyway migrations flow and are never inventoried, classified or migrated.
 */
export function readApplicationConfigMaps(
  root: string,
  env: string,
): { configMaps: Map<string, ConfigMapSource>; excluded: Map<string, ExcludedMigrationConfigMap> } {
  const flywaySourceConfigMaps = readFlywaySourceConfigMaps(root, env);
  const referencedDomains = new Set(readMigrationReferences(root, env).map((reference) => reference.domain));
  const configMaps = new Map<string, ConfigMapSource>();
  const excluded = new Map<string, ExcludedMigrationConfigMap>();

  for (const [name, configMap] of readCommonConfigMaps(root, env)) {
    const signals = migrationAssetSignals({
      configMap: name,
      flywaySourceConfigMaps,
      referencedByWorkloads: referencedDomains.has(name),
    });
    if (signals.length > 0) {
      excluded.set(name, { file: configMap.file, signals });
    } else {
      configMaps.set(name, configMap);
    }
  }

  return { configMaps, excluded };
}
