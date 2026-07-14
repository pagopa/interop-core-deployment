/**
 * YAML patcher for merging ExternalSecrets configuration into values.yaml files
 */

import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml, parseDocument, isMap } from 'yaml';
import type { ContainerExternalSecretsConfig, ValuesMergeResult } from './external-secrets-types.js';

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
 * Merge ExternalSecrets config into values object at externalSecrets.container path
 */
export function mergeExternalSecretsContainer(
  values: any,
  config: ContainerExternalSecretsConfig
): boolean {
  if (!values.externalSecrets) {
    values.externalSecrets = {};
  }

  if (!values.externalSecrets.container) {
    values.externalSecrets.container = {};
  }

  values.externalSecrets.container = deepMerge(values.externalSecrets.container, config);
  return true;
}

/**
 * Merge ExternalSecrets config into values object at externalSecrets.initContainer path
 */
export function mergeExternalSecretsInitContainer(
  values: any,
  config: ContainerExternalSecretsConfig
): boolean {
  if (!values.externalSecrets) {
    values.externalSecrets = {};
  }

  if (!values.externalSecrets.initContainer) {
    values.externalSecrets.initContainer = {};
  }

  values.externalSecrets.initContainer = deepMerge(values.externalSecrets.initContainer, config);
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
 * Uses parseDocument to preserve original formatting (quotes, comments, etc.)
 * and only patches the externalSecrets section via doc.setIn().
 */
export function applyExternalSecretsToWorkload(
  valuesPath: string,
  containerConfig: ContainerExternalSecretsConfig | undefined,
  initContainerConfig: ContainerExternalSecretsConfig | undefined,
  removeOldRefs: boolean,
  dryRun: boolean = false
): ValuesMergeResult {
  try {
    // Parse as Document to preserve original formatting (double-quoted strings, etc.)
    const originalContent = fs.readFileSync(valuesPath, 'utf-8');
    const doc = parseDocument(originalContent);

    // Build the externalSecrets plain-object value using existing deepMerge logic
    const existingValues = parseYaml(originalContent) || {};
    const externalSecretsValue: any = existingValues.externalSecrets || {};

    let containerMerged = false;
    let initContainerMerged = false;
    let oldRefsRemoved = false;

    if (containerConfig) {
      if (!externalSecretsValue.container) externalSecretsValue.container = {};
      externalSecretsValue.container = deepMerge(externalSecretsValue.container, containerConfig);
      containerMerged = true;
    }

    if (initContainerConfig) {
      if (!externalSecretsValue.initContainer) externalSecretsValue.initContainer = {};
      externalSecretsValue.initContainer = deepMerge(externalSecretsValue.initContainer, initContainerConfig);
      initContainerMerged = true;
    }

    if (containerMerged || initContainerMerged) {
      // Set only the externalSecrets key in the Document; all other keys retain original formatting
      doc.setIn(['externalSecrets'], externalSecretsValue);
    }

    if (removeOldRefs) {
      // Remove root-level envFromSecrets (array form)
      if (doc.has('envFromSecrets')) {
        doc.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
      // Remove deployment.envFromSecrets (map form used in real values.yaml)
      const deploymentNode = doc.getIn(['deployment'], true);
      if (deploymentNode && isMap(deploymentNode) && deploymentNode.has('envFromSecrets')) {
        deploymentNode.delete('envFromSecrets');
        oldRefsRemoved = true;
      }
    }

    if (!dryRun) {
      // doc.toString() reproduces the file with all original formatting preserved
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

    // Define default secretStoreRef
    const defaultExternalSecrets = {
      container: {
        secretStoreRef: {
          name: 'app-secret-store',
          kind: 'SecretStore',
        },
      },
      initContainer: {
        secretStoreRef: {
          name: 'app-secret-store',
          kind: 'SecretStore',
        },
      },
    };

    // Check if externalSecrets already exists
    const existingExternalSecrets = doc.getIn(['externalSecrets']) as any;

    // Build the complete externalSecrets structure
    let externalSecretsStructure = {
      container: {
        secretStoreRef: {
          name: 'app-secret-store',
          kind: 'SecretStore',
        },
      },
      initContainer: {
        secretStoreRef: {
          name: 'app-secret-store',
          kind: 'SecretStore',
        },
      },
    };

    if (existingExternalSecrets && typeof existingExternalSecrets === 'object') {
      // Merge existing structure with defaults
      // Preserve existing content in container/initContainer if it exists
      if (existingExternalSecrets.container) {
        externalSecretsStructure.container = {
          ...existingExternalSecrets.container,
          secretStoreRef: existingExternalSecrets.container.secretStoreRef || {
            name: 'app-secret-store',
            kind: 'SecretStore',
          },
        };
      }
      if (existingExternalSecrets.initContainer) {
        externalSecretsStructure.initContainer = {
          ...existingExternalSecrets.initContainer,
          secretStoreRef: existingExternalSecrets.initContainer.secretStoreRef || {
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
