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