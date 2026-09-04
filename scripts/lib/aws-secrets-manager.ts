import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type SecretValueType = "json" | "text" | "binary" | "empty";

export interface ParsedSecretValue {
  raw: string | Uint8Array | undefined;
  parsed: Record<string, unknown> | null;
  type: SecretValueType;
}

export interface AwsSecretVersion {
  versionId: string;
  versionStages: string[];
  value: ParsedSecretValue;
}

export function createAwsClient(): SecretsManagerClient {
  return new SecretsManagerClient({});
}

function parseSecretValue(
  raw: string | Uint8Array | undefined,
  isString: boolean
): ParsedSecretValue {
  if (!raw) {
    return { raw, parsed: null, type: "empty" };
  }
  if (!isString) {
    return { raw, parsed: null, type: "binary" };
  }
  try {
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    return { raw, parsed, type: "json" };
  } catch {
    return { raw, parsed: null, type: "text" };
  }
}

export async function fetchLatestSecretVersion(
  client: SecretsManagerClient,
  secretId: string
): Promise<AwsSecretVersion | null> {
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const isString = !!response.SecretString;
    const raw = response.SecretString ?? response.SecretBinary;
    console.log(`\n ➜ Fetched secret metadata for ${secretId}, version: ${response.VersionId}\n`);
    return {
      versionId: response.VersionId!,
      versionStages: response.VersionStages ?? [],
      value: parseSecretValue(raw, isString),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ❌ Error fetching latest version for secret ${secretId}: ${message}\n`);
    return null;
  }
}
