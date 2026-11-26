import * as fs from "fs";
import * as path from "path";
import { isMap, isScalar, parseAllDocuments, parseDocument, type Document, type Node as YamlNode, type YAMLMap } from "yaml";

// Same YAML handling as the Flyway migrations toolset (scripts/migrations/flyway/common.ts, PR #871):
// - sources are parsed with unique keys and any parse error is fatal;
// - values are read from the YAML AST and accepted only when they are string scalars, never coerced;
// - generated files are verified by parsing them back before and after writing.

export function fail(message: string): never {
  throw new Error(message);
}

function checkErrors(document: Document, label: string): void {
  if (document.errors.length > 0) {
    fail(`${label}: ${document.errors[0].message}`);
  }
}

/** Parses a single-document YAML file with unique keys; fails on any parse error. */
export function yamlDocument(file: string): Document.Parsed {
  const document = parseDocument(fs.readFileSync(file, "utf8"), { uniqueKeys: true });
  checkErrors(document, file);
  return document;
}

/** Parses YAML text that may contain several documents (for example `helm template` output). */
export function yamlDocuments(text: string, label: string): Document.Parsed[] {
  // An empty stream is returned as an empty array-like value without documents.
  const documents = Array.from(parseAllDocuments(text, { uniqueKeys: true })) as Document.Parsed[];
  for (const document of documents) {
    checkErrors(document, label);
  }
  return documents;
}

export function mapping(node: unknown): node is YAMLMap {
  return isMap(node);
}

/** Text of a string scalar; undefined for any other node, so values are never coerced. */
export function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || typeof node.value !== "string") {
    return undefined;
  }
  return node.value;
}

export function field(node: unknown, name: string): YamlNode | undefined {
  return isMap(node) ? (node.get(name, true) as YamlNode | undefined) : undefined;
}

export function keys(node: unknown): string[] {
  return isMap(node) ? node.items.map((item) => String(isScalar(item.key) ? item.key.value : item.key)) : [];
}

export type ConfigMapSource = {
  name: string;
  /** Path relative to the repository root. */
  file: string;
  data: Map<string, string>;
};

/** Reads `data` of a ConfigMap document; fails when a value is not a string. */
export function configMapFromDocument(document: Document, label: string): { name: string; data: Map<string, string> } | undefined {
  const contents = document.contents;
  if (scalarText(field(contents, "kind")) !== "ConfigMap") {
    return undefined;
  }

  const name = scalarText(field(field(contents, "metadata"), "name"));
  if (!name) {
    fail(`${label}: metadata.name is required.`);
  }

  const data = new Map<string, string>();
  const dataNode = field(contents, "data");
  if (dataNode !== undefined && !(isScalar(dataNode) && dataNode.value === null)) {
    if (!mapping(dataNode)) {
      fail(`${label}: data must be a YAML mapping.`);
    }
    for (const key of keys(dataNode)) {
      const value = scalarText(field(dataNode, key));
      if (value === undefined) {
        fail(`${label}: data.${key} must be a string.`);
      }
      data.set(key, value);
    }
  }

  return { name, data };
}

/** ConfigMaps of commons/<env>/configmaps (top level, *.yaml|yml), indexed by metadata.name. */
export function readCommonConfigMaps(root: string, env: string): Map<string, ConfigMapSource> {
  const directory = path.join(root, "commons", env, "configmaps");
  const configMaps = new Map<string, ConfigMapSource>();
  if (!fs.existsSync(directory)) {
    return configMaps;
  }

  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();

  for (const file of files) {
    const relative = path.relative(root, file);
    const configMap = configMapFromDocument(yamlDocument(file), relative);
    if (!configMap) {
      continue;
    }
    const previous = configMaps.get(configMap.name);
    if (previous) {
      fail(`Duplicate ConfigMap metadata.name '${configMap.name}' in ${previous.file} and ${relative}.`);
    }
    configMaps.set(configMap.name, { ...configMap, file: relative });
  }

  return configMaps;
}

/**
 * Writes generated content only after `verify` accepts it once parsed, then reads the file back
 * to make sure the written bytes are exactly the generated ones.
 */
export function writeVerifiedYaml(file: string, content: string, verify: (document: Document.Parsed) => void): void {
  const document = parseDocument(content, { uniqueKeys: true });
  checkErrors(document, `${file} (generated)`);
  verify(document);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  if (fs.readFileSync(file, "utf8") !== content) {
    fail(`${file}: content read back after writing differs from the generated content.`);
  }
}
