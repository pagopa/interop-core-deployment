# list-external-secrets

TypeScript script that scans all `values.yaml` files across microservices and jobs, checks the configured `externalSecrets` versions against AWS Secrets Manager, and automatically updates any that are outdated.

## Prerequisites

- Node.js ≥ 20
- Active AWS credentials with Secrets Manager access (IAM profile or role)
- `yq` installed (used by the repo structure validation script)

```bash
export AWS_PROFILE=<profile>  # or rely on the default credential chain
```

## Usage

```bash
npm run list-external-secrets -- --env <env> [--root <path>] [--output-dir <dir>]
```

### Options

| Option | Alias | Default | Description |
|---|---|---|---|
| `--env` | `-e` | _(required)_ | Environment name to scan (e.g. `dev`) |
| `--root` | `-r` | `cwd` | Repository root path |
| `--output-dir` | `-o` | `external-secrets-analysis` | Directory where reports are saved |

### Examples

```bash
# dev environment, current directory as root
npm run list-external-secrets -- --env dev

# dev environment, explicit root
npm run list-external-secrets -- --env dev --root /path/to/interop-core-deployment

# Custom output directory
npm run list-external-secrets -- --env dev --output-dir /tmp/reports
```

## Expected YAML structure

The script looks for `values.yaml` files with this structure:

```yaml
externalSecrets:
  container:
    create: true
    data:
      - secretKey: MY_ENV_VAR
        remoteRef:
          key: app/backend/my-secret
          property: my-property
          version: uuid/6e4e8f69-be18-4c6e-832a-248bfb462151
  initContainer:
    create: true
    data:
      - secretKey: FLYWAY_USER
        remoteRef:
          key: app/backend/db-secret
          property: POSTGRES_USR
          version: uuid/6e4e8f69-be18-4c6e-832a-248bfb462151
```

Both `container.data` and `initContainer.data` are processed.

## What the script does

1. **Finds** all `values.yaml` files under `microservices/<workload>/<env>/` and `jobs/<workload>/<env>/`
2. **Extracts** every entry in `externalSecrets.container.data[]` and `externalSecrets.initContainer.data[]`
3. **Checks** that the configured version is not an AWS label (`AWSCURRENT` / `AWSPREVIOUS`) — those are reported as **misconfigured**
4. **Queries** AWS Secrets Manager to retrieve the current version of each secret
5. **Compares** the configured version with the live one
6. **Patches** outdated or misconfigured versions in the `values.yaml` files (writes `uuid/<versionId>`)
7. **Exports** CSV and JSON reports to the output directory

## Output

```
external-secrets-analysis/
  external-secrets-<env>.csv                          # all secrets found
  external-secrets-report-all-<env>.json              # full report
  external-secrets-report-outdated-<env>.json         # secrets with an outdated version
  external-secrets-report-misconfigured-<env>.json    # secrets using a label instead of a version ID
  external-secrets-report-error-<env>.json            # secrets unreachable on AWS SM
```

### CSV columns

`component`, `workloadType`, `containerType`, `file`, `secretKey`, `key`, `property`, `configuredVersion`, `latestVersion`, `versionStages`, `upToDate`, `misconfigured`, `hasError`

## Notes

- If `AWS_PROFILE` is not set, the AWS SDK default credential chain is used
- Secrets with `hasError = true` are not modified in the `values.yaml` files
- Run from the repository root to get correct relative paths in the reports
