import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { collectSecretReferencesFromFile } from "./yaml-walker.js";
import type { RecordContext, SecretReferenceRecord, SourceScope, Workload, WorkloadType } from "./types.js";

/**
 * Find workload values files for the exact environment directory requested.
 * Extracts deployment name from values.yaml "name:" key for accurate workload identification.
 */
export function walkWorkloads(root: string, env: string, workloadType: WorkloadType): Workload[] {
  const baseDir = path.join(root, workloadType === "microservice" ? "microservices" : "jobs");
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry): Workload | null => {
      const valuesFile = path.join(baseDir, entry.name, env, "values.yaml");
      if (!fs.existsSync(valuesFile)) {
        return null;
      }

      // Extract deployment name from values.yaml "name:" key
      let deploymentName = entry.name;
      try {
        const valuesContent = fs.readFileSync(valuesFile, 'utf-8');
        const valuesData = parseYaml(valuesContent) as Record<string, any>;
        if (valuesData.name && typeof valuesData.name === 'string') {
          deploymentName = valuesData.name;
        }
      } catch (err) {
        console.warn(`Warning: Could not parse ${valuesFile}, using directory name as component`);
      }

      const commonFileName = workloadType === "microservice" ? "values-microservice.yaml" : "values-cronjob.yaml";
      const commonFile = path.join(root, "commons", env, commonFileName);

      return {
        component: deploymentName,
        workloadType,
        valueFiles: [commonFile, valuesFile].filter((file) => fs.existsSync(file)),
      };
    })
    .filter((workload): workload is Workload => workload !== null);
}

/**
 * Inventory every common and workload-specific values file for one component.
 */
export function inventoryWorkload(workload: Workload, root: string, env: string): SecretReferenceRecord[] {
  return workload.valueFiles.flatMap((file) => {
    const sourceScope: SourceScope = file.includes(`${path.sep}commons${path.sep}`) ? "common" : "workload";

    const ctx: RecordContext = {
      environment: env,
      workloadType: workload.workloadType,
      component: workload.component,
      sourceScope,
      sourceFile: path.relative(root, file),
    };

    return collectSecretReferencesFromFile(file, ctx);
  });
}

/**
 * Remove duplicate records produced by repeated equivalent values.
 */
export function dedupe(records: SecretReferenceRecord[]): SecretReferenceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [
      record.environment,
      record.workloadType,
      record.component,
      record.sourceScope,
      record.sourceFile,
      record.yamlPath,
      record.referenceType,
      record.envVar,
      record.secretName,
      record.secretKey,
    ].join("\u0000");

    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
