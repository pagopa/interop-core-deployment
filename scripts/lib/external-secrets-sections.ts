import type { WorkloadType } from './types.js';

export type ContainerType = 'container' | 'initContainer';
export type ExternalSecretsSectionName = 'app' | 'flywayInitContainer';

const SECTION_NAMES: Record<WorkloadType, Record<ContainerType, ExternalSecretsSectionName>> = {
  microservice: {
    container: 'app',
    initContainer: 'flywayInitContainer',
  },
  cronjob: {
    container: 'app',
    initContainer: 'flywayInitContainer',
  },
};

export function getExternalSecretsSectionName(
  workloadType: WorkloadType,
  containerType: ContainerType
): ExternalSecretsSectionName {
  return SECTION_NAMES[workloadType][containerType];
}
