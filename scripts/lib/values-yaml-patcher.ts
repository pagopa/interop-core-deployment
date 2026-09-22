/**
 * YAML patcher for merging ExternalSecrets configuration into values.yaml files
 */

import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml, parseDocument, isMap } from 'yaml';
import type { ContainerExternalSecretsConfig, ValuesMergeResult } from './external-secrets-types.js';
import { getExternalSecretsSectionName } from './external-secrets-sections.js';
import type { WorkloadType } from './types.js';

function inferWorkloadTypeFromPath(valuesPath: string): WorkloadType {
  const normalized = valuesPath.replace(/\\/g, '/');
  if (normalized.includes('/jobs/')) return 'cronjob';
  return 'microservice';
}

function normalizeExternalSecrets(externalSecrets: any): any {
  const normalized = externalSecrets || {};

  if (normalized.container && !normalized.app) {
    normalized.app = deepMerge({}, normalized.container);
  }
  if (normalized.initContainer && !normalized.flywayInitContainer) {
    normalized.flywayInitContainer = deepMerge({}, normalized.initContainer);
  }
  delete normalized.container;
  delete normalized.initContainer;

  return normalized;
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
 * Merge ExternalSecrets config for the main workload container.
 */
export function mergeExternalSecretsContainer(
  values: any,
  config: ContainerExternalSecretsConfig,
  workloadType: WorkloadType = 'microservice'
): boolean {
  if (!values.externalSecrets) {
    values.externalSecrets = {};
  }

  const sectionName = getExternalSecretsSectionName(workloadType, 'container');
  if (!values.externalSecrets[sectionName]) {
    values.externalSecrets[sectionName] = {};
  }

  values.externalSecrets[sectionName] = deepMerge(values.externalSecrets[sectionName], config);
  return true;
}

/**
 * Merge ExternalSecrets config for the workload init container.
 */
export function mergeExternalSecretsInitContainer(
  values: any,
  config: ContainerExternalSecretsConfig,
  workloadType: WorkloadType = 'microservice'
): boolean {
  if (!values.externalSecrets) {
    values.externalSecrets = {};
  }

  const sectionName = getExternalSecretsSectionName(workloadType, 'initContainer');
  if (!values.externalSecrets[sectionName]) {
    values.externalSecrets[sectionName] = {};
  }

  values.externalSecrets[sectionName] = deepMerge(values.externalSecrets[sectionName], config);
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
  containerConfig: ContainerExternalSecretsConfig | undefined,
  initContainerConfig: ContainerExternalSecretsConfig | undefined,
  removeOldRefs: boolean,
  dryRun: boolean = false,
  workloadType?: WorkloadType
): ValuesMergeResult {
  try {
    const originalContent = fs.readFileSync(valuesPath, 'utf-8');
    let doc = parseDocument(originalContent);

    // Build the externalSecrets structure
    const existingValues = parseYaml(originalContent) || {};
    const resolvedWorkloadType = workloadType || inferWorkloadTypeFromPath(valuesPath);
    const externalSecretsValue: any = normalizeExternalSecrets(existingValues.externalSecrets);

    let containerMerged = false;
    let initContainerMerged = false;
    let oldRefsRemoved = false;

    if (containerConfig) {
      const key = getExternalSecretsSectionName(resolvedWorkloadType, 'container');
      if (!externalSecretsValue[key]) externalSecretsValue[key] = {};
      externalSecretsValue[key] = deepMerge(externalSecretsValue[key], containerConfig);
      containerMerged = true;
    }

    if (initContainerConfig) {
      const key = getExternalSecretsSectionName(resolvedWorkloadType, 'initContainer');
      if (!externalSecretsValue[key]) externalSecretsValue[key] = {};
      externalSecretsValue[key] = deepMerge(externalSecretsValue[key], initContainerConfig);
      initContainerMerged = true;
    }

    let modifiedContent = originalContent;

    if (containerMerged || initContainerMerged) {
      // Remove existing externalSecrets section if present
      const externalSecretsPattern = /\nexternalSecrets:[\s\S]*?(?=\n(?:deployment|cronjob|$))/;
      const withoutExisting = modifiedContent.replace(externalSecretsPattern, '');

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
      containerMerged,
      initContainerMerged,
      oldRefsRemoved,
    };
  } catch (error) {
    return {
      workloadPath: valuesPath,
      success: false,
      containerMerged: false,
      initContainerMerged: false,
      oldRefsRemoved: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Initialize externalSecrets section in commons values.yaml with default secretStoreRef
 * This adds the shared secretStoreRef definition that microservices/cronjobs will inherit
 */
export function initializeCommonsExternalSecrets(commonsValuesPath: string, dryRun: boolean = false): { success: boolean; error?: string } {
  try {
    if (!fs.existsSync(commonsValuesPath)) {
      return { success: false, error: `Commons file not found: ${commonsValuesPath}` };
    }

    const content = fs.readFileSync(commonsValuesPath, 'utf-8');
    const doc = parseDocument(content);

    const workloadType = commonsValuesPath.includes('values-cronjob.yaml') ? 'cronjob' : 'microservice';
    const appKey = getExternalSecretsSectionName(workloadType, 'container');
    const flywayKey = getExternalSecretsSectionName(workloadType, 'initContainer');

    // Check if externalSecrets already exists
    const existingExternalSecrets = doc.getIn(['externalSecrets']) as any;

    // Build the complete externalSecrets structure
    let externalSecretsStructure: any = {
      [appKey]: {
        secretStoreRef: {
          name: 'app-secret-store',
          kind: 'SecretStore',
        },
      },
      [flywayKey]: {
        secretStoreRef: {
          name: 'app-secret-store',
          kind: 'SecretStore',
        },
      },
    };

    // Normalize legacy keys before merging defaults.
    const normalizedExisting = normalizeExternalSecrets(existingExternalSecrets);

    if (normalizedExisting && typeof normalizedExisting === 'object') {
      // Merge existing structure with defaults
      // Preserve existing content in each ExternalSecrets section.
      if (normalizedExisting[appKey]) {
        externalSecretsStructure[appKey] = {
          ...normalizedExisting[appKey],
          secretStoreRef: normalizedExisting[appKey].secretStoreRef || {
            name: 'app-secret-store',
            kind: 'SecretStore',
          },
        };
      }
      if (normalizedExisting[flywayKey]) {
        externalSecretsStructure[flywayKey] = {
          ...normalizedExisting[flywayKey],
          secretStoreRef: normalizedExisting[flywayKey].secretStoreRef || {
            name: 'app-secret-store',
            kind: 'SecretStore',
          },
        };
      }
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
