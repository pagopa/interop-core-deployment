import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isMap, isScalar, parseDocument, type Node as YamlNode } from 'yaml';
import { type YAMLMap } from 'yaml';

export interface Options {
  root: string;
  environment: string;
  prune: boolean;
  help: boolean;
}

export interface Directories {
  commons: string;
  configmaps: string;
  migrations: string;
}

export function fail(message: string): never {
  throw new Error(message);
}

export function parseOptions(args: string[], allowPrune = false): Options {
  const options: Options = { root: '', environment: '', prune: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '-h' || option === '--help') {
      options.help = true;
      return options;
    }
    if (option === '-p' || option === '--prune') {
      if (!allowPrune) fail(`Unknown option '${option}'.`);
      options.prune = true;
      continue;
    }
    if (option !== '-r' && option !== '--root' && option !== '-e' && option !== '--environment') {
      fail(`Unknown option '${option}'.`);
    }
    const value = args[++index];
    if (value === undefined) fail(`Missing value for ${option}.`);
    options[option === '-r' || option === '--root' ? 'root' : 'environment'] = value;
  }
  if (!options.root) fail('Project root is required.');
  if (!isAbsolute(options.root) || !existsSync(options.root) || !statSync(options.root).isDirectory()) {
    fail(`Project root must be an existing absolute directory: ${options.root}`);
  }
  if (!options.environment) fail('Target environment is required.');
  if (options.environment === '.' || options.environment === '..' || options.environment.includes('/')) {
    fail(`Invalid environment: ${options.environment}`);
  }
  options.root = realpathSync(options.root);
  
  return options;
}

// Returns the commons, configmaps, and migrations directories for the given project root and environment.
export function paths(options: Options): Directories {
  const commons = join(options.root, 'commons', options.environment);
  return { commons, configmaps: join(commons, 'configmaps'), migrations: join(commons, 'migrations') };
}

// Returns the list of files in the given directory that match the specified pattern, sorted by name.
export function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => join(directory, entry.name))
    .sort();
}

// Reads and parses a YAML document from the given file, ensuring unique keys and failing on errors.
export function yamlDocument(file: string) {
  const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) fail(`${file}: ${document.errors[0].message}`);
  return document;
}

// Returns true if the given node is a YAML mapping (YAMLMap).
export function mapping(node: unknown): node is YAMLMap {
  return isMap(node);
}

// Returns the text value of the given scalar node, or undefined if the node is not a scalar with a string value.
export function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value;
}

// Returns true if the given node is a scalar with a string value.
export function scalar(node: unknown): node is YamlNode {
  return isScalar(node) && typeof node.value === 'string';
}

// Returns the field with the given name from the given mapping node, or undefined if the node is not a mapping or the field does not exist.
export function field(node: unknown, name: string): YamlNode | undefined {
  return isMap(node) ? node.get(name, true) : undefined;
}

// Returns the list of keys in the given mapping node, sorted by name.
export function keys(node: unknown): string[] {
  return isMap(node)
    ? node.items.map(item => String(isScalar(item.key) ? item.key.value : item.key)).sort()
    : [];
}

/** Migration domains that are knowingly out of scope, with the reason shown in every report. */
export const IGNORED_MIGRATION_DOMAINS = new Map<string, string>([
  [
    'common-db-migrations',
    'MongoDB migration used only by deprecated Scala services authorization-management and notifier.',
  ],
]);

/** Source ConfigMap files: commons/<env>/configmaps/flyway*.yaml|yml. */
export const FLYWAY_SOURCE_FILE = /^flyway.*\.ya?ml$/i;

export type SourceErrorCode = 'INVALID_CONFIGMAP' | 'INVALID_DATA' | 'NO_MIGRATIONS' | 'INVALID_VALUE';

/** Validation error of a single source ConfigMap; `code` lets callers map it to their report status. */
export class SourceConfigMapError extends Error {
  constructor(readonly code: SourceErrorCode, message: string) {
    super(message);
  }
}

export interface SourceConfigMap {
  file: string;
  name: string;
  data: Record<string, string>;
}

/** Reads and validates one Flyway source ConfigMap; throws SourceConfigMapError when it is not usable. */
export function readSourceConfigMap(file: string): SourceConfigMap {
  const document = yamlDocument(file).contents;
  const kind = scalarText(field(document, 'kind')) ?? '';
  const name = scalarText(field(field(document, 'metadata'), 'name')) ?? '';
  const data = field(document, 'data');
  if (kind !== 'ConfigMap') throw new SourceConfigMapError('INVALID_CONFIGMAP', `${file}: expected kind ConfigMap, found '${kind || '<empty>'}'.`);
  if (!name) throw new SourceConfigMapError('INVALID_CONFIGMAP', `${file}: metadata.name is required.`);
  if (name === '.' || name === '..' || name.includes('/')) throw new SourceConfigMapError('INVALID_CONFIGMAP', `${file}: invalid metadata.name '${name}'.`);
  if (!mapping(data)) throw new SourceConfigMapError('INVALID_DATA', `${file}: data must be a YAML mapping.`);
  if (data.items.length === 0) throw new SourceConfigMapError('NO_MIGRATIONS', `${file}: data must contain at least one migration.`);
  const values: Record<string, string> = {};
  for (const key of keys(data)) {
    const value = scalarText(field(data, key));
    if (value === undefined) throw new SourceConfigMapError('INVALID_VALUE', `${file}: data.${key} must be a string.`);
    values[key] = value;
  }
  return { file, name, data: values };
}

/** Lists the Flyway source ConfigMap files of a configmaps directory, sorted by name. */
export function sourceConfigMapFiles(configmapDirectory: string): string[] {
  if (!existsSync(configmapDirectory) || !statSync(configmapDirectory).isDirectory()) fail(`Directory not found: ${configmapDirectory}`);
  return files(configmapDirectory, FLYWAY_SOURCE_FILE);
}

/** Reads every Flyway source ConfigMap of a configmaps directory; fails on the first invalid or duplicate one. */
export function readSourceConfigMaps(configmapDirectory: string): SourceConfigMap[] {
  const result: SourceConfigMap[] = [];
  const seen = new Map<string, string>();
  for (const file of sourceConfigMapFiles(configmapDirectory)) {
    const source = readSourceConfigMap(file);
    const previous = seen.get(source.name);
    if (previous) fail(`Duplicate Flyway ConfigMap metadata.name '${source.name}' in ${previous} and ${file}.`);
    seen.set(source.name, file);
    result.push(source);
  }
  if (result.length === 0) fail(`No flyway*.yaml or flyway*.yml ConfigMaps found in ${configmapDirectory}.`);
  return result;
}
