export const EXTERNAL_SECRETS_SECTIONS = ['app', 'flywayInitContainer'] as const;
export type ExternalSecretsSection = (typeof EXTERNAL_SECRETS_SECTIONS)[number];

/**
 * Map a repo secret reference to its externalSecrets section:
 * references inside the Flyway init container go to `flywayInitContainer`, all others to `app`.
 */
export function resolveExternalSecretsSection(...paths: Array<string | undefined>): ExternalSecretsSection {
  return paths.some((p) => p?.toLowerCase().includes('initcontainer')) ? 'flywayInitContainer' : 'app';
}
