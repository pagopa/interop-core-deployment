import { describe, expect, it } from 'vitest';
import { getExternalSecretsSectionName } from '../../lib/external-secrets-sections.js';

describe('getExternalSecretsSectionName', () => {
  it('uses the microservice chart sections for Deployment containers', () => {
    expect(getExternalSecretsSectionName('microservice', 'container')).toBe('app');
    expect(getExternalSecretsSectionName('microservice', 'initContainer')).toBe('flywayInitContainer');
  });

  it('uses the same sections for CronJob containers', () => {
    expect(getExternalSecretsSectionName('cronjob', 'container')).toBe('app');
    expect(getExternalSecretsSectionName('cronjob', 'initContainer')).toBe('flywayInitContainer');
  });
});
