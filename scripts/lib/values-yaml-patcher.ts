/**
 * YAML patcher for merging ExternalSecrets configuration into values.yaml files
 */

import * as fs from 'fs';
import { isDeepStrictEqual } from 'util';
import { parse as parseYaml, stringify as stringifyYaml, parseDocument, isMap, isScalar } from 'yaml';
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
 * Locate a top-level YAML block: the `<key>:` line plus all following indented or empty lines.
 * Stops at the next top-level key or boundary comment, skipping comments inside the block.
 * Returns the [start, end) line range, or null when the key is missing.
 */
function findTopLevelBlock(lines: string[], key: string): { start: number; end: number } | null {
  // Match only an unindented key so nested blocks are not matched.
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;

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
  return { start, end };
}

/**
 * Remove a top-level YAML block (see findTopLevelBlock).
 */
function removeTopLevelBlock(content: string, key: string): string {
  const lines = content.split('\n');
  const block = findTopLevelBlock(lines, key);
  if (!block) return content;

  // Remove the selected block while leaving the boundary line and remaining content intact.
  lines.splice(block.start, block.end - block.start);
  return lines.join('\n');
}

/**
 * Remove the given nested keys (e.g. ['deployment', 'envFromSecrets']) by deleting their lines from
 * the original text, together with the blank lines right above them. The rest of the file is kept
 * byte-identical: re-serializing the document would reformat it (folded scalars, comments, flow
 * sequences, whitespace).
 */
function removeNestedKeys(content: string, keyPaths: string[][]): { content: string; removed: boolean } {
  const doc = parseDocument(content);
  const lines = content.split('\n');
  const lineOf = (offset: number) => content.slice(0, offset).split('\n').length - 1;
  const ranges: Array<{ start: number; end: number }> = [];

  for (const keyPath of keyPaths) {
    const parentPath = keyPath.slice(0, -1);
    const parent = parentPath.length > 0 ? doc.getIn(parentPath, true) : doc.contents;
    if (!isMap(parent)) continue;

    const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === keyPath[keyPath.length - 1]);
    if (!pair || !isScalar(pair.key) || !pair.key.range) continue;

    const keyStart = pair.key.range[0];
    const valueEnd = (pair.value as { range?: [number, number, number] } | null)?.range?.[1] ?? pair.key.range[1];
    let start = lineOf(keyStart);
    const end = lineOf(Math.max(keyStart, valueEnd - 1));
    while (start > 0 && lines[start - 1].trim() === '') start--;
    ranges.push({ start, end });
  }

  if (ranges.length === 0) return { content, removed: false };

  for (const { start, end } of ranges.sort((a, b) => b.start - a.start)) {
    lines.splice(start, end - start + 1);
  }
  return { content: lines.join('\n'), removed: true };
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

      // Generate YAML for externalSecrets (indented sequences, as in the repository values files)
      const externalSecretsYaml = stringifyYaml({ externalSecrets: externalSecretsValue }, {
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
    }

    if (removeOldRefs) {
      const result = removeNestedKeys(modifiedContent, [
        ['envFromSecrets'],
        ['deployment', 'envFromSecrets'],
        ['deployment', 'flywayInitContainer', 'envFromSecrets'],
        ['cronjob', 'envFromSecrets'],
        ['cronjob', 'flywayInitContainer', 'envFromSecrets'],
      ]);
      modifiedContent = result.content;
      oldRefsRemoved = result.removed;
    }

    if (!dryRun && modifiedContent !== originalContent) {
      fs.writeFileSync(valuesPath, modifiedContent);
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
    const existingValues: any = parseYaml(content);

    const existing: any = normalizeExternalSecrets(existingValues?.externalSecrets);

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

    // Nothing to do when commons already has the expected structure: keep the file untouched
    if (isDeepStrictEqual(existingValues?.externalSecrets, externalSecretsStructure)) {
      return { success: true };
    }

    // Replace (or append) only the externalSecrets block, leaving the rest of the file byte-identical
    const blockLines = stringifyYaml({ externalSecrets: externalSecretsStructure }, { lineWidth: 0 })
      .trimEnd()
      .split('\n');
    const lines = content.split('\n');
    const block = findTopLevelBlock(lines, 'externalSecrets');
    let newContent: string;
    if (block) {
      // Keep the blank lines that separate the block from what follows
      let end = block.end;
      while (end > block.start + 1 && lines[end - 1].trim() === '') end--;
      lines.splice(block.start, end - block.start, ...blockLines);
      newContent = lines.join('\n');
    } else {
      const separator = content === '' || content.endsWith('\n') ? '' : '\n';
      newContent = `${content}${separator}${blockLines.join('\n')}\n`;
    }

    if (!dryRun) {
      fs.writeFileSync(commonsValuesPath, newContent);
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
