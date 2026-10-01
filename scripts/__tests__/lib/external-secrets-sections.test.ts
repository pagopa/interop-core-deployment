import { describe, expect, it } from 'vitest';
import { EXTERNAL_SECRETS_SECTIONS, resolveExternalSecretsSection } from '../../lib/external-secrets-sections.js';

describe('external-secrets-sections', () => {
  it('exposes only the chart sections', () => {
    expect(EXTERNAL_SECRETS_SECTIONS).toEqual(['app', 'flywayInitContainer']);
  });

  it('maps init container references to flywayInitContainer', () => {
    expect(resolveExternalSecretsSection('initContainers[0]')).toBe('flywayInitContainer');
    expect(resolveExternalSecretsSection(undefined, 'deployment.flywayInitContainer.envFromSecrets')).toBe('flywayInitContainer');
  });

  it('maps every other reference to app', () => {
    expect(resolveExternalSecretsSection('containers[0]', 'deployment.envFromSecrets')).toBe('app');
    expect(resolveExternalSecretsSection(undefined, undefined)).toBe('app');
  });
});
