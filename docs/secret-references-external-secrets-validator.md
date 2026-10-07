# External Secrets Validator

The validator checks that the generated `externalSecrets` sections cover the repository Secret references and preserve the expected `envVar -> secretKey -> remoteRef` mapping.

## Checks performed

- ExternalSecrets presence in each selected workload values file (`externalSecrets.app` for the main container, `externalSecrets.flywayInitContainer` for the Flyway init container)

Issues and per-workload results report the checked section in the `section` field (`app` or `flywayInitContainer`).
- Coverage of repository Secret references
- Mapping correctness between repository environment variables and generated `secretKey` entries
- Coherence with the cluster inventory and AWS annotation metadata
- Validation report with errors and warnings

## Usage

```bash
npm run secret-references-external-secrets-validator -- \
  --env <environment> \
  [--microservice <folder>] \
  [--cronjob <folder>] \
  [--scope microservice|cronjob|both] \
  [--migration-report <path>] \
  [--repo-inventory <path>] \
  [--cluster-inventory <path>] \
  [--output-dir <path>] \
  [-h|--help]
```

`--env` is required. The validator requires three JSON inputs: the migration report, repository inventory, and secret-centric cluster inventory. By default it reads them from `secret-inventory/`. Generate repository and cluster inventories using `--format json`; the inventory commands default to CSV. A generator dry-run does not write a migration report and therefore cannot be validated. Use the explicit path options when the reports are stored elsewhere.

`--scope` cannot be combined with `--microservice` or `--cronjob`. The filters select workload folders, not Kubernetes workload names, and use the same suffix convention as the generator and inventory scripts.

## Examples

### Validate the default reports

```bash
npm run secret-references-external-secrets-validator -- --env dev
```

### Validate one workload

```bash
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --microservice api-gateway
```

### Validate custom reports

```bash
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --migration-report ./secret-inventory/external-secrets-migration-dev.json \
  --repo-inventory ./secret-inventory/secret-references-repo-dev.json \
  --cluster-inventory ./secret-inventory/secret-inventory-cluster-secrets-dev.json \
  --output-dir ./validation-audit
```

## Default reports

The validator writes its results to `secret-inventory/`:

```text
external-secrets-validation-<env><filter-suffix>.json
external-secrets-validation-<env><filter-suffix>.csv
```

The filter suffix is omitted for an unfiltered run and identifies selected microservices or cronjobs for filtered runs. The JSON contains the summary, per-workload results, and issues. The CSV contains issue details, or workload summaries when no issues exist. Errors cause a non-zero exit code; warnings are reported for review.

## Mapping contract

For a repository reference such as:

```yaml
env:
  - name: READMODEL_DB_USERNAME
    valueFrom:
      secretKeyRef:
        name: read-model
        key: READONLY_USR
```

the generated data entry must preserve the environment variable name as `secretKey` and map the remote location separately:

```yaml
data:
  - secretKey: READMODEL_DB_USERNAME
    remoteRef:
      key: rds/.../readmodel
      property: READONLY_USR
```

The validator compares the repository `envVar` with the generated `secretKey`; it does not require the original Kubernetes Secret key and the generated `secretKey` to have the same value.

## Prerequisites and troubleshooting

- Run the repository and cluster inventory commands before validation.
- Pass `--format json` to both inventory commands; their default output format is CSV.
- Run the generator before validating a migration report.
- Run the generator without `--dry-run` so its migration report is created.
- If an inventory report is missing, pass the correct path or regenerate it.
- Keep workload filters consistent across generator and validator, or pass the report paths explicitly.
- Use `-h` or `--help` to inspect the current CLI contract.

## Related docs

- [../scripts/README.md](../scripts/README.md)
- [SECRET_REFERENCES_GUIDE.md](SECRET_REFERENCES_GUIDE.md)
- [external-secrets-values-generator.md](external-secrets-values-generator.md)
- [list-external-secrets.md](list-external-secrets.md)
