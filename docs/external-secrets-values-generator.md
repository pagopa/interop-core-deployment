# External Secrets Generator

This script builds the `externalSecrets` section for workload Helm values and patches the relevant `values.yaml` files.

## Purpose

It combines:

1. the repository inventory of Secret references
2. the live Kubernetes inventory of Secrets and AWS annotation metadata
3. the workload context used to insert or update the generated YAML section

The result is the `externalSecrets` block used by the charts in place of the old static Secret references.

## Required parameters

```bash
npm run secret-references-external-secrets-generator -- \
  --env <environment> \
  --cluster <context-or-arn> \
  --namespace <namespace> \
  [--microservice <folder>] \
  [--cronjob <folder>] \
  [--scope microservice|cronjob|both] \
  [--dry-run] \
  [--omit-version] \
  [--keep-old-refs true|false] \
  [--validate-helm true|false] \
  [-h|--help]
```

- `--cluster` and `--namespace` are required even when a kubeconfig context is already active.
- `--scope` cannot be combined with `--microservice` or `--cronjob`.
- The workload filters accept folder names, not Kubernetes workload names.
- Without a filter, all workloads in the selected environment are processed.

## Common examples

### Dry run

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster "$current_cluster" \
  --namespace dev \
  --dry-run
```

### One microservice

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster "$current_cluster" \
  --namespace dev \
  --microservice api-gateway
```

### One cronjob

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster "$current_cluster" \
  --namespace dev \
  --cronjob readmodel-checker
```

### Omit `remoteRef.version`

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster "$current_cluster" \
  --namespace dev \
  --omit-version
```

With `--omit-version`, generated entries contain `remoteRef.key` and `remoteRef.property` but no version pin. Without the flag, the generator preserves its existing behavior and copies the version ID from the Kubernetes Secret annotation when available.

## Generated mapping

The generator preserves the repository environment variable name as `secretKey`. It builds the remote reference from the AWS metadata associated with the Kubernetes Secret.

```yaml
# Repository reference
env:
  - name: READMODEL_DB_USERNAME
    valueFrom:
      secretKeyRef:
        name: read-model
        key: READONLY_USR

# Generated entry
data:
  - secretKey: READMODEL_DB_USERNAME
    remoteRef:
      key: rds/.../readmodel
      property: READONLY_USR
      version: <resolved-version-or-omitted>
```

The mapping is therefore:

- `secretKey`: the environment variable name
- `remoteRef.key`: the AWS Secrets Manager path from the cluster annotation
- `remoteRef.property`: the key within the AWS secret
- `remoteRef.version`: the annotated version ID, unless `--omit-version` is used

## YAML placement and compatibility

The generated section is inserted before the main workload section:

- microservices: before `deployment:`
- cronjobs: before `cronjob:`

The generator supports the current and legacy externalSecrets section names through the same workload/container mapping used by the validator and `list-external-secrets` script.

## Reports and safety

- `--dry-run` previews changes without modifying files.
- Normal runs patch the selected `values.yaml` files and write a migration report under `external-secrets-analysis/`.
- The generator does not read or store secret values; it uses repository references and cluster metadata.
- Run the validator after generation before committing the changes.

## Related docs

- [../scripts/README.md](../scripts/README.md)
- [SECRET_REFERENCES_GUIDE.md](SECRET_REFERENCES_GUIDE.md)
- [list-external-secrets.md](list-external-secrets.md)
- [secret-references-external-secrets-validator.md](secret-references-external-secrets-validator.md)
