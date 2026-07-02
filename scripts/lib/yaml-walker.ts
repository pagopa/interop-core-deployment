import * as fs from "fs";
import type * as Yaml from "yaml";
import type { RecordContext, SecretAddress, SecretReferenceRecord } from "./types";

type YamlParser = typeof Yaml;
type YamlNode = Yaml.Node | null | undefined;
type YamlLineCounter = InstanceType<YamlParser["LineCounter"]>;
type YamlMapNode = Yaml.YAMLMap<unknown, unknown>;

let yamlParser: YamlParser | undefined;

/**
 * Load the yaml dependency lazily so argument validation and help do not need node_modules.
 */
export function loadYamlParser(): YamlParser {
  if (yamlParser) {
    return yamlParser;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    yamlParser = require("yaml") as YamlParser;
    return yamlParser;
  } catch (_error) {
    throw new Error('Missing dependency "yaml". Run "npm install" or "npm ci" before using this script.');
  }
}

/**
 * Parse one values file with yaml and collect supported Kubernetes Secret references.
 */
export function collectSecretReferencesFromFile(file: string, ctx: RecordContext): SecretReferenceRecord[] {
  const { LineCounter, parseDocument } = loadYamlParser();
  const content = fs.readFileSync(file, "utf8");
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter });

  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join("; ");
    throw new Error(`Unable to parse YAML file ${file}: ${message}`);
  }

  const records: SecretReferenceRecord[] = [];
  walkYamlNode(document.contents as YamlNode, [], [], ctx, lineCounter, records);

  return records.filter((record) => record.secretName);
}

/**
 * Recursively visit YAML AST nodes and dispatch supported Secret reference shapes.
 */
function walkYamlNode(
  node: YamlNode,
  yamlPath: string[],
  ancestors: YamlMapNode[],
  ctx: RecordContext,
  lineCounter: YamlLineCounter,
  records: SecretReferenceRecord[],
): void {
  const { isMap, isSeq } = loadYamlParser();

  if (isMap(node)) {
    node.items.forEach((pair) => {
      // key is like "envFromSecrets", "secretKeyRef", "secretRef", or "secret" and value is a map of properties
      const key = scalarValue(pair.key as YamlNode);
      const value = pair.value as YamlNode;
      // childPath is the path to this key in the YAML document, e.g. "spec.template.spec.containers[0].env[2].valueFrom.secretKeyRef"
      const childPath = [...yamlPath, key];
      const pathText = yamlPathToString(childPath);

      if (key === "envFromSecrets" && isMap(value)) {
        /**
         * This is a chart-specific extension that maps env var names to secret addresses like "secret-name.secret-key"
         * For example, a values.yaml file might contain:
         * envFromSecrets:
         *   DB_PASSWORD: my-db-secret.password
         *   API_KEY: my-api-secret.key
         *
         * This will produce two records, one for each env var and secret reference.
         */
        collectEnvFromSecrets(value, pathText, ctx, lineCounter, records);
      } else if (key === "secretKeyRef" && isMap(value)) {
        /**
         * This is a standard Kubernetes Secret reference in an env var definition.
         * For example, a values.yaml file might contain:
         * env:
         *   - name: DB_PASSWORD
         *     valueFrom:
         *       secretKeyRef:
         *         name: my-db-secret
         *         key: password
         *
         * This will produce one record for the env var and secret reference.
         */
        records.push({
          ...ctx,
          line: nodeLine((pair.key || value) as YamlNode, lineCounter),
          yamlPath: pathText || ".",
          referenceType: "secretKeyRef",
          containerPath: pathText,
          envVar: findNameInAncestors(ancestors),
          secretName: mapScalar(value, "name"),
          secretKey: mapScalar(value, "key"),
          rawReference: mapToRawReference(value),
        });
      } else if (key === "secretRef" && isMap(value)) {
        /**
         * This is a standard Kubernetes Secret reference in a volume definition.
         * For example, a values.yaml file might contain:
         * volumes:
         *   - name: my-volume
         *     secretRef:
         *       name: my-secret
         *
         * This will produce one record for the volume and secret reference.
         */
        records.push({
          ...ctx,
          line: nodeLine((pair.key || value) as YamlNode, lineCounter),
          yamlPath: pathText || ".",
          referenceType: "secretRef",
          containerPath: pathText,
          envVar: "",
          secretName: mapScalar(value, "name"),
          secretKey: "",
          rawReference: mapToRawReference(value),
        });
      } else if (
        key === "secret" &&
        isMap(value) &&
        mapScalar(value, "secretName") &&
        yamlPath.some((segment) => /olumes$/i.test(segment))
      ) {
        /**
         * This is a standard Kubernetes Secret reference in a volume definition
         * (SecretVolumeSource). The guard on yamlPath ensures we are inside a
         * volumes array (volumes, extraVolumes, additionalVolumes, initVolumes) and not
         * inside an unrelated custom field that happens to have the same shape.
         *
         * For example, a values.yaml file might contain:
         * deployment:
         *   volumes:
         *     - name: my-volume
         *       secret:
         *         secretName: my-secret
         *
         * This will produce one record for the volume and secret reference.
         */
        records.push({
          ...ctx,
          line: nodeLine((pair.key || value) as YamlNode, lineCounter),
          yamlPath: pathText || ".",
          referenceType: "volumeSecret",
          containerPath: pathText,
          envVar: "",
          secretName: mapScalar(value, "secretName"),
          secretKey: "",
          rawReference: mapToRawReference(value),
        });
      }

      walkYamlNode(value, childPath, [...ancestors, node as YamlMapNode], ctx, lineCounter, records);
    });
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => {
      walkYamlNode(item as YamlNode, [...yamlPath, `[${index}]`], ancestors, ctx, lineCounter, records);
    });
  }
}

/**
 * Collect chart-specific envFromSecrets entries from a YAML map.
 */
function collectEnvFromSecrets(
  envFromSecretsMap: YamlMapNode,
  yamlPath: string,
  ctx: RecordContext,
  lineCounter: YamlLineCounter,
  records: SecretReferenceRecord[],
): void {
  envFromSecretsMap.items.forEach((pair) => {
    const envVar = scalarValue(pair.key as YamlNode);
    const secretAddress = scalarValue(pair.value as YamlNode);
    if (!envVar || !secretAddress) {
      return;
    }

    const parsed = parseSecretAddress(secretAddress);
    records.push({
      ...ctx,
      line: nodeLine((pair.key || pair.value) as YamlNode, lineCounter),
      yamlPath: yamlPath || ".",
      referenceType: "envFromSecrets",
      containerPath: yamlPath,
      envVar,
      secretName: parsed.secretName,
      secretKey: parsed.secretKey,
      rawReference: secretAddress,
    });
  });
}

/**
 * Split a chart secret address like secret-name.secret-key.
 */
export function parseSecretAddress(secretAddress: string): SecretAddress {
  const dotIndex = secretAddress.indexOf(".");
  if (dotIndex === -1) {
    return { secretName: secretAddress, secretKey: "" };
  }

  return {
    secretName: secretAddress.slice(0, dotIndex),
    secretKey: secretAddress.slice(dotIndex + 1),
  };
}

/**
 * Convert a scalar YAML node into a string.
 */
function scalarValue(node: YamlNode): string {
  const { isScalar } = loadYamlParser();

  if (!isScalar(node) || node.value === null || node.value === undefined) {
    return "";
  }
  return String(node.value);
}

/**
 * Read a scalar property from a YAML map.
 */
function mapScalar(map: YamlMapNode, key: string): string {
  return scalarValue(map.get(key, true) as YamlNode);
}

/**
 * Resolve the 1-based source line for a YAML AST node.
 */
function nodeLine(node: YamlNode, lineCounter: YamlLineCounter): number | "" {
  if (!node || !node.range) {
    return "";
  }
  return lineCounter.linePos(node.range[0]).line;
}

/**
 * Convert YAML path parts into a readable dot/bracket path.
 * For example:
 * ["spec", "template", "spec", "containers[0]", "env[2]", "valueFrom", "secretKeyRef"] => "spec.template.spec.containers[0].env[2].valueFrom.secretKeyRef"
 */
export function yamlPathToString(parts: string[]): string {
  return parts.join(".").replace(/\.\[/g, "[");
}

/**
 * Look up the nearest ancestor map containing a name property.
 */
function findNameInAncestors(ancestors: YamlMapNode[]): string {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const name = mapScalar(ancestors[index], "name");
    if (name) {
      return name;
    }
  }
  return "";
}

/**
 * Serialize a small YAML map into a compact raw reference string.
 */
function mapToRawReference(value: YamlMapNode): string {
  return value.items.map((pair) => `${scalarValue(pair.key as YamlNode)}=${scalarValue(pair.value as YamlNode)}`).join(";");
}
