/**
 * YAML patcher for merging ExternalSecrets configuration into values.yaml files
 */

import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml, parseDocument, isMap } from 'yaml';
import type { ContainerExternalSecretsConfig, ValuesMergeResult } from './external-secrets-types.js';
import { EXTERNAL_SECRETS_SECTIONS, type ExternalSecretsSection } from './external-secrets-sections.js';

/**
 * Normalize externalSecrets to the chart layout: only `app` and `flywayInitContainer` are kept
 * (chart schema has additionalProperties: false). Legacy keys are migrated and removed:
 * `container` -> `app`, `initContainer` -> `flywayInitContainer`.
 * Values already under the new sections take precedence; any other key is dropped.
 */
function normalizeExternalSecrets(externalSecrets: any): any {
  const source = externalSecrets && typeof externalSecrets === 'object' ? externalSecrets : {};

  const normalized: any = {};
  const app = deepMerge(deepMerge({}, source.container || {}), source.app || {});
  const flyway = deepMerge(deepMerge({}, source.initContainer || {}), source.flywayInitContainer || {});
  if (Object.keys(app).length > 0) normalized.app = app;
  if (Object.keys(flyway).length > 0) normalized.flywayInitContainer = flyway;

  return normalized;
}

/**
 * Remove a top-level YAML block: the `<key>:` line plus all following indented or empty lines.
 * Stops at the next top-level key or boundary comment, skipping comments inside the block.
 */
function removeTopLevelBlock(content: string, key: string): string {
  const lines = content.split('\n');
  // Match only an unindented key so nested blocks are not removed.
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return content;

  const isInsideBlock = (line: string) => line === '' || line.startsWith(' ') || line.startsWith('\t');

  let end = start + 1;
  while (end < lines.length) {
    if (!isInsideBlock(lines[end])) {
      // A top-level non-comment line starts the next block.
      if (!lines[end].startsWith('#')) break;
      // Skip blank lines and comments to determine whether nested content resumes.
      const nextContent = lines.slice(end + 1).find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
      // Keep boundary comments when followed by a top-level key or the end of the file.
      if (!nextContent || !isInsideBlock(nextContent)) break;
    }
    end++;
  }

  // Remove the selected block while leaving the boundary line and remaining content intact.
  lines.splice(start, end - start);
  return lines.join('\n');
}

/**
 * Determine the anchor point key where externalSecrets should be inserted before
 * For microservices: "deployment"
 * For cronjobs: "cronjob"
 */
function getAnchorPoint(content: string): string | null {
  if (content.includes('\ndeployment:')) {
    return 'deployment';
  }
  if (content.includes('\ncronjob:')) {
    return 'cronjob';
  }
  return null;
}

/**
 * Rebuild YAML document with externalSecrets inserted before anchor point
 * Preserves all formatting and handles proper spacing
 */
function insertExternalSecretsBeforeAnchor(
  originalContent: string,
  externalSecretsYaml: string,
  anchorPoint: string
): string {
  // Find the position of the anchor point
  const anchorPattern = `\n${anchorPoint}:`;
  const anchorIndex = originalContent.indexOf(anchorPattern);

  if (anchorIndex === -1) {
    // Anchor point not found, append at end
    return originalContent + '\n' + externalSecretsYaml;
  }

  // Insert externalSecrets before the anchor point with proper spacing
  const beforeAnchor = originalContent.substring(0, anchorIndex);
  const afterAnchor = originalContent.substring(anchorIndex);

  // Ensure beforeAnchor ends without trailing newlines (they'll be added back)
  const beforeTrimmed = beforeAnchor.trimEnd();

  // Build the new content with proper spacing
  // Format: ...previous content + empty line + externalSecrets + empty line + deployment/cronjob...
  return beforeTrimmed + '\n\n' + externalSecretsYaml.trim() + '\n\n' + afterAnchor.substring(1); // substring(1) removes the leading \n
}

/**
 * Read and parse a values.yaml file as a plain JS object
 */
export function readValuesFile(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseYaml(content) || {};
}

/**
 * Write a plain JS object to a YAML file.
 * NOTE: used for test setup and utility purposes.
 * For production writes from applyExternalSecretsToWorkload, the Document API is used instead.
 */
export function writeValuesFile(filePath: string, values: any): void {
  const yaml = stringifyYaml(values, {
    indentSeq: false,
    lineWidth: 0,
  });
  fs.writeFileSync(filePath, yaml);
}

/**
 * Deep merge objects, preserving original structure
 */
function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') {
    return source;
  }

  if (!target || typeof target !== 'object') {
    target = {};
  }

  for (const key of Object.keys(source)) {
    if (Array.isArray(source[key])) {
      target[key] = source[key];
    } else if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      target[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }

  return target;
}

/**
 * Merge ExternalSecrets config into the given section (`app` or `flywayInitContainer`).
 */
export function mergeExternalSecretsSection(
  values: any,
  section: ExternalSecretsSection,
  config: ContainerExternalSecretsConfig
): boolean {
  if (!values.externalSecrets) {
    values.externalSecrets = {};
  }

  values.externalSecrets[section] = deepMerge(values.externalSecrets[section] || {}, config);
  return true;
}

/**
 * Remove old envFromSecrets references from values object
 */
export function removeEnvFromSecretsReferences(values: any): boolean {
  let removed = false;

  // Check if envFromSecrets array exists
  if (Array.isArray(values.envFromSecrets)) {
    delete values.envFromSecrets;
    removed = true;
  }

  // Also check in common container/initContainer structures
  if (values.container?.env?.fromSecrets) {
    delete values.container.env.fromSecrets;
    removed = true;
  }

  if (values.initContainer?.env?.fromSecrets) {
    delete values.initContainer.env.fromSecrets;
    removed = true;
  }

  return removed;
}

/**
 * Apply ExternalSecrets configuration to a workload's values.yaml.
 * Inserts externalSecrets before 'deployment' (microservices) or 'cronjob' (jobs)
 * with blank lines before and after.
 */
export function applyExternalSecretsToWorkload(
  valuesPath: string,
  appConfig: ContainerExternalSecretsConfig | undefined,
  flywayInitContainerConfig: ContainerExternalSecretsConfig | undefined,
  removeOldRefs: boolean,
  dryRun: boolean = false
): ValuesMergeResult {
  try {
    const originalContent = fs.readFileSync(valuesPath, 'utf-8');
    let doc = parseDocument(originalContent);

    // Build the externalSecrets structure
    const existingValues = parseYaml(originalContent) || {};
    const externalSecretsValue: any = normalizeExternalSecrets(existingValues.externalSecrets);

    let appMerged = false;
    let flywayInitContainerMerged = false;
    let oldRefsRemoved = false;

    if (appConfig) {
      mergeExternalSecretsSection({ externalSecrets: externalSecretsValue }, 'app', appConfig);
      appMerged = true;
    }

    if (flywayInitContainerConfig) {
      mergeExternalSecretsSection({ externalSecrets: externalSecretsValue }, 'flywayInitContainer', flywayInitContainerConfig);
      flywayInitContainerMerged = true;
    }

    let modifiedContent = originalContent;

    if (appMerged || flywayInitContainerMerged) {
      const withoutExisting = removeTopLevelBlock(modifiedContent, 'externalSecrets');

      // Generate YAML for externalSecrets
      const externalSecretsYaml = stringifyYaml({ externalSecrets: externalSecretsValue }, {
        indentSeq: false,
        lineWidth: 0,
      }).trim();

      // Find anchor point and insert
      const anchorPoint = getAnchorPoint(withoutExisting);
      if (anchorPoint) {
        modifiedContent = insertExternalSecretsBeforeAnchor(withoutExisting, externalSecretsYaml, anchorPoint);
      } else {
        // No anchor point found, append at end
        modifiedContent = withoutExisting + '\n' + externalSecretsYaml;
      }

      // Reparse the modified content
      doc = parseDocument(modifiedContent);
    }

    if (removeOldRefs) {
      // Remove root-level envFromSecrets
      if (doc.has('envFromSecrets')) {
        doc.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
      // Remove deployment.envFromSecrets or cronjob.envFromSecrets
      const deploymentNode = doc.getIn(['deployment'], true);
      if (deploymentNode && isMap(deploymentNode) && deploymentNode.has('envFromSecrets')) {
        deploymentNode.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
      const deploymentFlywayNode = doc.getIn(['deployment', 'flywayInitContainer'], true);
      if (deploymentFlywayNode && isMap(deploymentFlywayNode) && deploymentFlywayNode.has('envFromSecrets')) {
        deploymentFlywayNode.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
      const cronjobNode = doc.getIn(['cronjob'], true);
      if (cronjobNode && isMap(cronjobNode) && cronjobNode.has('envFromSecrets')) {
        cronjobNode.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
      const cronjobFlywayNode = doc.getIn(['cronjob', 'flywayInitContainer'], true);
      if (cronjobFlywayNode && isMap(cronjobFlywayNode) && cronjobFlywayNode.has('envFromSecrets')) {
        cronjobFlywayNode.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
    }

    if (!dryRun) {
      fs.writeFileSync(valuesPath, doc.toString({ lineWidth: 0 }));
    }

    return {
      workloadPath: valuesPath,
      success: true,
      appMerged,
      flywayInitContainerMerged,
      oldRefsRemoved,
    };
  } catch (error) {
    return {
      workloadPath: valuesPath,
      success: false,
      appMerged: false,
      flywayInitContainerMerged: false,
      oldRefsRemoved: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Initialize externalSecrets section in commons values.yaml with the shared secretStoreRef
 * that microservices/cronjobs will inherit.
 * The store name comes from `secretStoreName` or from an existing secretStoreRef in commons;
 * fails if neither is available or if they disagree.
 */
export function initializeCommonsExternalSecrets(
  commonsValuesPath: string,
  dryRun: boolean = false,
  secretStoreName?: string
): { success: boolean; error?: string } {
  try {
    if (!fs.existsSync(commonsValuesPath)) {
      return { success: false, error: `Commons file not found: ${commonsValuesPath}` };
    }

    const content = fs.readFileSync(commonsValuesPath, 'utf-8');
    const doc = parseDocument(content);

    const existing: any = normalizeExternalSecrets((doc.toJS() as any)?.externalSecrets);

    const externalSecretsStructure: any = {};
    for (const key of EXTERNAL_SECRETS_SECTIONS) {
      const section = existing[key] && typeof existing[key] === 'object' ? existing[key] : {};
      const existingRef = section.secretStoreRef;
      const existingName: string | undefined = existingRef?.name;

      if (secretStoreName && existingName && existingName !== secretStoreName) {
        return {
          success: false,
          error: `Conflicting secretStoreRef in ${commonsValuesPath} (externalSecrets.${key}): commons has "${existingName}", --secret-store is "${secretStoreName}"`,
        };
      }
      if (!secretStoreName && !existingName) {
        return {
          success: false,
          error: `Missing secretStoreRef in ${commonsValuesPath} (externalSecrets.${key}): pass --secret-store <name>`,
        };
      }

      externalSecretsStructure[key] = {
        ...section,
        secretStoreRef: existingName ? existingRef : { name: secretStoreName, kind: 'SecretStore' },
      };
    }

    // Set the complete structure back to the document
    doc.setIn(['externalSecrets'], externalSecretsStructure);

    if (!dryRun) {
      fs.writeFileSync(commonsValuesPath, doc.toString({ lineWidth: 0 }));
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a backup of values.yaml before modification
 */
export function createBackup(valuesPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${valuesPath}.backup.${timestamp}`;
  const content = fs.readFileSync(valuesPath, 'utf-8');
  fs.writeFileSync(backupPath, content);
  return backupPath;
}

/**
 * List all envFromSecrets references in a values object (for reporting)
 */
export function listEnvFromSecretsReferences(values: any): string[] {
  const refs: string[] = [];

  if (Array.isArray(values.envFromSecrets)) {
    values.envFromSecrets.forEach((ref: any) => {
      if (typeof ref === 'string') {
        refs.push(ref);
      } else if (ref?.name) {
        refs.push(ref.name);
      }
    });
  }

  return refs;
}
