import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, type Document, type Pair, type ParsedNode, type YAMLMap } from 'yaml';
import { fail, scalarText, yamlDocument } from './common.js';

export const LEGACY_KEY = 'migrationsConfigmap';
export const TARGET_KEY = 'migrationDomain';

export interface WorkloadValuesFile {
  /** Absolute path of <folder>/<name>/<env>/values.yaml. */
  file: string;
  /** Name of the workload folder under microservices/ or jobs/. */
  folder: string;
  section: 'deployment' | 'cronjob';
  workloadType: 'Deployment' | 'CronJob';
}

const WORKLOAD_FOLDERS = [
  ['microservices', 'deployment', 'Deployment'],
  ['jobs', 'cronjob', 'CronJob'],
] as const;

/** Lists microservices/<name>/<env>/values.yaml and jobs/<name>/<env>/values.yaml, sorted by folder name. */
export function workloadValuesFiles(root: string, environment: string): WorkloadValuesFile[] {
  const result: WorkloadValuesFile[] = [];
  for (const [folderName, section, workloadType] of WORKLOAD_FOLDERS) {
    const directory = join(root, folderName);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = join(directory, entry.name, environment, 'values.yaml');
      if (existsSync(file) && statSync(file).isFile()) result.push({ file, folder: entry.name, section, workloadType });
    }
  }
  return result;
}

export type ReferenceState = 'NO_FLYWAY_INIT_CONTAINER' | 'NO_MIGRATION_REFERENCE' | 'REFERENCE';

export interface FlywayReference {
  state: ReferenceState;
  /** `name` declared in values.yaml, or the folder name when missing. */
  workloadName: string;
  document: Document.Parsed<ParsedNode>;
  legacyPair?: Pair;
  targetPair?: Pair;
  /** Value of migrationsConfigmap, when present. */
  legacy?: string;
  /** Value of migrationDomain, when present. */
  target?: string;
  /** Referenced migration domain (= ConfigMap name). */
  domain?: string;
}

/**
 * Reads <section>.flywayInitContainer of a workload values file.
 * Throws when the structure is malformed or migrationsConfigmap and migrationDomain conflict.
 */
export function readFlywayReference(workload: WorkloadValuesFile): FlywayReference {
  const { file, section } = workload;
  const document = yamlDocument(file) as Document.Parsed<ParsedNode>;
  const workloadName = scalarText(document.get('name', true)) ?? workload.folder;
  const base = { workloadName, document };
  const values = document.get(section, true);
  if (values === undefined) return { ...base, state: 'NO_FLYWAY_INIT_CONTAINER' };
  if (!isMap(values)) fail(`${file}: '${section}' must be a mapping.`);
  const flyway = (values as YAMLMap).get('flywayInitContainer', true);
  if (flyway === undefined) return { ...base, state: 'NO_FLYWAY_INIT_CONTAINER' };
  if (!isMap(flyway)) fail(`${file}: '${section}.flywayInitContainer' must be a mapping.`);

  const pair = (key: string) => (flyway as YAMLMap).items.find(item => isScalar(item.key) && item.key.value === key) as Pair | undefined;
  const legacyPair = pair(LEGACY_KEY);
  const targetPair = pair(TARGET_KEY);
  if (!legacyPair && !targetPair) return { ...base, state: 'NO_MIGRATION_REFERENCE' };

  const legacy = legacyPair ? scalarText(legacyPair.value) : undefined;
  const target = targetPair ? scalarText(targetPair.value) : undefined;
  if (legacyPair && !legacy) fail(`${file}: '${LEGACY_KEY}' must be a non-empty string.`);
  if (targetPair && !target) fail(`${file}: '${TARGET_KEY}' must be a non-empty string.`);
  if (legacy && target && legacy !== target) fail(`${file}: ${LEGACY_KEY} '${legacy}' conflicts with ${TARGET_KEY} '${target}'.`);
  return { ...base, state: 'REFERENCE', legacyPair, targetPair, legacy, target, domain: target ?? legacy };
}
