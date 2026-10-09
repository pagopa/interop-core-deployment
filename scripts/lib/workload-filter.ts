import * as path from 'path';
import type { Workload, WorkloadType } from './types.js';
import { walkWorkloads } from './workload.js';

export interface WorkloadFilters {
  microservice?: string;
  cronjob?: string;
}

export function hasWorkloadFilters(filters: WorkloadFilters): boolean {
  return Boolean(filters.microservice || filters.cronjob);
}

export function validateWorkloadFilterValue(option: string, value: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`${option} must be a workload folder name, not a path`);
  }
  return value;
}

export function assertScopeNotCombinedWithFilters(
  scopeWasProvided: boolean,
  filters: WorkloadFilters
): void {
  if (scopeWasProvided && hasWorkloadFilters(filters)) {
    throw new Error('--scope cannot be combined with --microservice or --cronjob');
  }
}

export function selectWorkloads(
  root: string,
  env: string,
  filters: WorkloadFilters,
  allowedTypes: WorkloadType[] = ['microservice', 'cronjob']
): Workload[] {
  if (!hasWorkloadFilters(filters)) {
    return allowedTypes.flatMap((type) => walkWorkloads(root, env, type));
  }

  const selected: Workload[] = [];
  const requested: Array<[WorkloadType, string | undefined]> = [
    ['microservice', filters.microservice],
    ['cronjob', filters.cronjob],
  ];

  for (const [type, folderName] of requested) {
    if (!folderName) continue;
    if (!allowedTypes.includes(type)) {
      throw new Error(`The selected ${type} is outside the requested operation scope`);
    }

    const workload = walkWorkloads(root, env, type).find((candidate) => candidate.folderName === folderName);
    if (!workload) {
      const baseDir = type === 'microservice' ? 'microservices' : 'jobs';
      throw new Error(
        `Selected ${type} folder not found for environment "${env}": ${path.join(baseDir, folderName, env, 'values.yaml')}`
      );
    }
    selected.push(workload);
  }

  return selected;
}

export function getWorkloadFilterSuffix(filters: WorkloadFilters): string {
  const parts: string[] = [];
  if (filters.microservice) parts.push(`microservice-${sanitizeSuffixPart(filters.microservice)}`);
  if (filters.cronjob) parts.push(`cronjob-${sanitizeSuffixPart(filters.cronjob)}`);
  return parts.length > 0 ? `-${parts.join('-')}` : '';
}

function sanitizeSuffixPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}