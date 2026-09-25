# External Secrets Validator

The validator checks that the generated `externalSecrets` sections cover the repository Secret references and preserve the expected `envVar -> secretKey -> remoteRef` mapping.

## Checks performed

- ExternalSecrets presence in each selected workload values file
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

`--env` is required. The validator reads the generated migration report, repository inventory, and cluster inventory from `secret-inventory/` by default. Use the explicit path options when those reports are stored elsewhere.

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
validator-results-<env><filter-suffix>.json
validator-coverage-<env><filter-suffix>.json
```

The filter suffix is omitted for an unfiltered run and identifies selected microservices or cronjobs for filtered runs.

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
- Run the generator before validating a migration report.
- If an inventory report is missing, pass the correct path or regenerate it.
- Use `-h` or `--help` to inspect the current CLI contract.

## Related docs

- [../scripts/README.md](../scripts/README.md)
- [SECRET_REFERENCES_GUIDE.md](SECRET_REFERENCES_GUIDE.md)
- [external-secrets-values-generator.md](external-secrets-values-generator.md)
- [list-external-secrets.md](list-external-secrets.md)
