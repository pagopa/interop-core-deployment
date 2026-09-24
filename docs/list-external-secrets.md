# list-external-secrets

TypeScript script that scans workload `values.yaml` files, compares configured `externalSecrets` versions with AWS Secrets Manager, and updates outdated pinned versions.

## Prerequisites

- Node.js >= 20
- AWS credentials with `secretsmanager:GetSecretValue` permission
- Repository dependencies installed with `npm install`

The script uses the AWS SDK default credential chain. Set `AWS_PROFILE` when a named profile is required:

```bash
export AWS_PROFILE=<profile>
```

## Usage

```bash
npm run list-external-secrets -- \
  --env <env> \
  [--microservice <folder>] \
  [--cronjob <folder>] \
  [--root <path>] \
  [--output-dir <dir>] \
  [-h|--help]
```

### Options

| Option | Alias | Default | Description |
|---|---|---|---|
| `--env` | `-e` | required | Environment to scan, for example `dev` |
| `--microservice` | - | - | Scan only one folder under `microservices/` |
| `--cronjob` | - | - | Scan only one folder under `jobs/` |
| `--root` | `-r` | current directory | Repository root |
| `--output-dir` | `-o` | `external-secrets-analysis` | Directory for reports |
| `-h`, `--help` | - | - | Show usage and exit |

The workload filters are optional and may be combined. They accept folder names, not Kubernetes workload names. Filtered reports include the selected folders in their filenames and therefore do not overwrite the global reports.

## Examples

```bash
# Scan all workloads in dev
npm run list-external-secrets -- --env dev

# Scan selected workloads
npm run list-external-secrets -- --env dev \
  --microservice api-gateway \
  --cronjob readmodel-checker

# Use an explicit repository and report directory
npm run list-external-secrets -- \
  --env dev \
  --root /path/to/interop-core-deployment \
  --output-dir /tmp/reports
```

## What the script does

1. Finds workload values files under `microservices/<workload>/<env>/` and `jobs/<workload>/<env>/`.
2. Reads `externalSecrets` data for the workload container and init container sections.
3. Treats a missing version as `AWSCURRENT` and reports AWS labels such as `AWSCURRENT` and `AWSPREVIOUS` as misconfigured for version-pinned maintenance.
4. Queries AWS Secrets Manager for the current version and validates the referenced property.
5. Updates outdated or misconfigured entries to `uuid/<versionId>` when the AWS lookup succeeds.
6. Leaves entries with lookup or property errors unchanged.
7. Writes CSV and JSON reports.

The script reads secret metadata and values needed for property validation; it does not print secret values in the reports.

## Expected YAML structure

The script processes the workload-specific sections resolved by the chart conventions. A typical values file contains entries such as:

```yaml
externalSecrets:
  app:
    create: true
    data:
      - secretKey: MY_ENV_VAR
        remoteRef:
          key: app/backend/my-secret
          property: my-property
          version: uuid/6e4e8f69-be18-4c6e-832a-248bfb462151
  flywayInitContainer:
    create: true
    data:
      - secretKey: FLYWAY_USER
        remoteRef:
          key: app/backend/db-secret
          property: POSTGRES_USR
          version: uuid/6e4e8f69-be18-4c6e-832a-248bfb462151
```

Both microservices and cronjobs are handled using the section names resolved by the script's workload/container mapping. Legacy and current section names are supported by the same mapping used by the generator and validator.

## Output

Default directory: `external-secrets-analysis/`

```text
external-secrets-<env><filter-suffix>.csv
external-secrets-report-all-<env><filter-suffix>.json
external-secrets-report-outdated-<env><filter-suffix>.json
external-secrets-report-misconfigured-<env><filter-suffix>.json
external-secrets-report-error-<env><filter-suffix>.json
```

The suffix is omitted for an unfiltered run. Filtered runs use suffixes such as `-microservice-api-gateway`, `-cronjob-readmodel-checker`, or both when both filters are supplied.

CSV columns:

`component`, `workloadType`, `containerType`, `file`, `secretKey`, `key`, `property`, `configuredVersion`, `latestVersion`, `versionStages`, `upToDate`, `misconfigured`, `hasError`

## Operational notes

- Run from the repository root when relative report paths are desired.
- This command is intended for version-pinned `remoteRef` entries. Entries generated with `--omit-version` are interpreted as `AWSCURRENT` and may be written back with an explicit version ID.
- Review the reports before committing the automatic updates.

## Related docs

- [../scripts/README.md](../scripts/README.md)
- [SECRET_REFERENCES_GUIDE.md](SECRET_REFERENCES_GUIDE.md)
- [external-secrets-values-generator.md](external-secrets-values-generator.md)
