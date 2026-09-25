# Secret References Guide

This directory documents the workflow for migrating Kubernetes Secret references in Helm values to External Secrets Operator (ESO) entries backed by AWS Secrets Manager.

## Canonical entry point

The authoritative workflow is in [scripts/README.md](../scripts/README.md). Use that file as the source of truth for:

- the required command parameters
- the supported help flags
- the workflow order
- the workload filters and scope rules
- the examples used in day-to-day operations

This page is intentionally a short guide and index, not a duplicate of the operational manual.

## Workflow overview

```text
repo inventory -> cluster inventory -> compare -> generate externalSecrets -> validate
```

| Command | Purpose | Detailed reference |
|---|---|---|
| `secret-references-repo-inventory` | Extract Secret references from repository values files | [scripts/README.md](../scripts/README.md) |
| `secret-references-cluster-inventory` | Inventory Kubernetes Secrets and annotations | [secret-references-cluster-inventory.md](secret-references-cluster-inventory.md) |
| `secret-references-compare` | Compare repository references with cluster state | [secret-references-compare.md](secret-references-compare.md) |
| `secret-references-external-secrets-generator` | Generate and patch `externalSecrets` sections | [external-secrets-values-generator.md](external-secrets-values-generator.md) |
| `secret-references-external-secrets-validator` | Validate generated mappings and coverage | [secret-references-external-secrets-validator.md](secret-references-external-secrets-validator.md) |
| `list-external-secrets` | Check and update AWS secret versions | [list-external-secrets.md](list-external-secrets.md) |

## Recommended sequence

```bash
# 1) inventory the repo
npm run secret-references-repo-inventory -- --env dev

# 2) inventory the cluster
npm run secret-references-cluster-inventory -- \
  --cluster "$current_cluster" \
  --namespace dev

# 3) compare repo and cluster expectations
npm run secret-references-compare -- --env dev --cluster "$current_cluster"

# 4) generate externalSecrets blocks
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster "$current_cluster" \
  --namespace dev \
  --dry-run

# 5) validate the generated result
npm run secret-references-external-secrets-validator -- --env dev
```

## Shared conventions

All scripts in this family support `-h` and `--help`. Workload filters use folder names:

```bash
--microservice api-gateway
--cronjob readmodel-checker
```

The filters may be combined where supported. They cannot be combined with `--scope`. Cluster-based commands require the explicit `--cluster` value and, where applicable, `--namespace`.

The generator supports `--omit-version` to create `remoteRef` entries without a version pin. The version-maintenance command `list-external-secrets` is intended for pinned entries and may add an explicit version when a version is missing.

## Related references

- [scripts/README.md](../scripts/README.md)
- [secret-references-repo-inventory.md](secret-references-repo-inventory.md)
- [secret-references-cluster-inventory.md](secret-references-cluster-inventory.md)
- [secret-references-compare.md](secret-references-compare.md)
- [external-secrets-values-generator.md](external-secrets-values-generator.md)
- [secret-references-external-secrets-validator.md](secret-references-external-secrets-validator.md)
- [list-external-secrets.md](list-external-secrets.md)
