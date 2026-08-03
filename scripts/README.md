# Scripts — Operations Guide

This guide describes all scripts in `scripts/` and the sequential workflows to run them successfully.

---

## Prerequisites

| Tool | Minimum version | Check |
|---|---|---|
| Node.js | 20 | `node --version` |
| npm | 10 | `npm --version` |
| AWS CLI / credentials | — | `aws sts get-caller-identity` |
| `kubectl` + kubeconfig | — | `kubectl cluster-info` |
| `yq` | 4 | `yq --version` |

```bash
# Install Node.js dependencies
npm install

# Compile all TypeScript scripts
npm run build:secret-references
```

---

## Script overview

| npm script | Source file | Purpose |
|---|---|---|
| `secret-references-repo-inventory` | `scripts/secret-references-repo-inventory.ts` | Inventory of secret references in the repo |
| `secret-references-cluster-inventory` | `scripts/secret-references-cluster-inventory.ts` | Inventory of secrets present in the K8s cluster |
| `secret-references-compare` | `scripts/secret-references-compare.ts` | Compare repo vs cluster |
| `secret-references-external-secrets-generator` | `scripts/secret-references-external-secrets-generator.ts` | Generate `externalSecrets` configuration in `values.yaml` files |
| `secret-references-external-secrets-validator` | `scripts/secret-references-external-secrets-validator.ts` | Validate the generated migration |
| `list-external-secrets` | `scripts/list-external-secrets.ts` | Check and update AWS SM versions in `externalSecrets` |

---

## Workflow 1 — ExternalSecrets migration

Run **once** to generate the `externalSecrets` configuration in the `values.yaml` files for an environment.

```
[repo]                                        [K8s cluster]
  │                                                │
  ▼                                                ▼
Step 1: repo-inventory              Step 2: cluster-inventory
  │                                                │
  └──────────────┬─────────────────────────────────┘
                 ▼
         Step 3: compare  (optional, consistency check)
                 │
                 ▼
         Step 4: external-secrets-generator
                 │
                 ▼
         Step 5: external-secrets-validator
```

### Step 1 — Repo secret references inventory

Scans all `values.yaml` files and produces an inventory of K8s Secret references (`secretKeyRef`, `envFrom`, `volumes`).

```bash
npm run secret-references-repo-inventory -- \
  --env <env> \
  [--root <path>] \
  [--output-dir secret-inventory] \
  [--format csv|json|both]
```

**Output:** `secret-inventory/secret-references-repo-<env>.csv|json`

**Example:**
```bash
npm run secret-references-repo-inventory -- --env dev
```

---

### Step 2 — K8s cluster secret inventory

Connects to the cluster and builds an inventory of all Secrets present in the namespace.

```bash
npm run secret-references-cluster-inventory -- \
  --cluster <context-or-arn> \
  --namespace <namespace> \
  [--format csv|json|both] \
  [--output-dir secret-inventory]
```

**Output:** `secret-inventory/secret-inventory-cluster-secrets-<namespace>.csv|json`

**Example:**
```bash
npm run secret-references-cluster-inventory -- \
  --cluster arn:aws:eks:eu-south-1:123456789:cluster/interop-eks-dev \
  --namespace dev
```

> **Note:** requires `kubectl` configured with access to the target cluster.

---

### Step 3 — Repo vs cluster comparison _(optional)_

Compares the secret references found in the repo with the secrets actually present in the cluster, highlighting any discrepancies.

```bash
npm run secret-references-compare -- \
  --env <env> \
  --cluster <context-or-arn> \
  [--output-dir secret-inventory]
```

**Output:**
```
secret-inventory/
  secret-references-compare-secrets-<env>.csv|json
  secret-references-compare-workloads-<env>.csv|json
  secret-references-compare-stats-<env>.csv|json
```

**Example:**
```bash
npm run secret-references-compare -- \
  --env dev \
  --cluster arn:aws:eks:eu-south-1:123456789:cluster/interop-eks-dev
```

---

### Step 4 — ExternalSecrets configuration generator

Reads secret references from the repo, fetches AWS SM annotations from the live cluster, and writes the `externalSecrets` section into each workload's `values.yaml`.

```bash
npm run secret-references-external-secrets-generator -- \
  --env <env> \
  --cluster <context-or-arn> \
  --namespace <namespace> \
  [--scope microservice|cronjob|both] \
  [--keep-old-refs true|false] \
  [--validate-helm true|false] \
  [--dry-run]
```

| Option | Default | Description |
|---|---|---|
| `--scope` | `both` | Restrict to microservices, cronjobs, or both |
| `--keep-old-refs` | `false` | Keep existing K8s Secret references |
| `--validate-helm` | `true` | Validate Helm charts after modification |
| `--dry-run` | — | Show changes without applying them |

**Output:** patches `values.yaml` files in-place and produces `secret-inventory/external-secrets-migration-<env>.json`

**Example:**
```bash
# Dry-run first to preview changes
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster arn:aws:eks:eu-south-1:123456789:cluster/interop-eks-dev \
  --namespace dev \
  --dry-run

# Actual run
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --cluster arn:aws:eks:eu-south-1:123456789:cluster/interop-eks-dev \
  --namespace dev \
  --scope both
```

---

### Step 5 — Migration validator

Verifies that the generated `externalSecrets` configuration is consistent with the repo and cluster inventories.

```bash
npm run secret-references-external-secrets-validator -- \
  --env <env> \
  [--scope microservice|cronjob|both] \
  [--migration-report <path>] \
  [--repo-inventory <path>] \
  [--cluster-inventory <path>]
```

**Checks:**
1. **YAML presence** — the `externalSecrets` section exists in every migrated `values.yaml`
2. **Key coverage** — every `(secretName, secretKey)` pair from the repo inventory appears in the generated ExternalSecret
3. **Cluster coherence** — every `secretKey` from the repo inventory is present in the corresponding cluster secret
4. **Workload coverage** — no workload with secret references was silently omitted from the migration

**Example:**
```bash
npm run secret-references-external-secrets-validator -- --env dev
```

---

## Workflow 2 — AWS SM version maintenance

Run **periodically** to keep the secret versions in `values.yaml` in sync with the live versions in AWS Secrets Manager.

```
AWS Secrets Manager
        │
        ▼
list-external-secrets  ──►  patches versions in values.yaml
        │
        ▼
  CSV + JSON reports
```

### list-external-secrets

Scans all `values.yaml` files, compares the version configured in `externalSecrets.container/initContainer.data[].remoteRef.version` with the live version on AWS SM, and automatically updates any that are outdated.

```bash
npm run list-external-secrets -- \
  --env <env> \
  [--root <path>] \
  [--output-dir external-secrets-analysis]
```

**Prerequisite:** AWS credentials with `secretsmanager:GetSecretValue` permission.

**Output:**
```
external-secrets-analysis/
  external-secrets-<env>.csv
  external-secrets-report-all-<env>.json
  external-secrets-report-outdated-<env>.json
  external-secrets-report-misconfigured-<env>.json
  external-secrets-report-error-<env>.json
```

**Example:**
```bash
export AWS_PROFILE=interop-dev
npm run list-external-secrets -- --env dev
```

For full documentation on this script see [LIST_EXTERNAL_SECRETS_README.md](../LIST_EXTERNAL_SECRETS_README.md).

---

## Output structure

```
secret-inventory/                                   # output from steps 1-5
  secret-references-repo-<env>.csv|json
  secret-inventory-cluster-secrets-<namespace>.csv|json
  secret-inventory-cluster-workloads-<namespace>.csv|json
  secret-references-compare-secrets-<env>.csv|json
  secret-references-compare-workloads-<env>.csv|json
  secret-references-compare-stats-<env>.csv|json
  external-secrets-migration-<env>.json

external-secrets-analysis/                          # output from list-external-secrets
  external-secrets-<env>.csv
  external-secrets-report-all-<env>.json
  external-secrets-report-outdated-<env>.json
  external-secrets-report-misconfigured-<env>.json
  external-secrets-report-error-<env>.json
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `No workload values found` | Environment does not exist or name is wrong | Check directories under `microservices/` and `jobs/` |
| `Total secrets found: 0` | `externalSecrets` missing or unexpected YAML structure | Verify `values.yaml` files use `externalSecrets.container.data` |
| AWS `UnrecognizedClientException` | Invalid or expired credentials | Run `aws sts get-caller-identity` to verify |
| K8s `Unauthorized` | Kubeconfig not configured for the target cluster | `kubectl config use-context <context>` |
| `Parser YAML non disponibile` | `yq` not installed | `brew install yq` on macOS |
