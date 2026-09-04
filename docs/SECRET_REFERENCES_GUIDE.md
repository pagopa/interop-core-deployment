# Secret References Command Suite

Comprehensive toolkit for migrating Kubernetes Secrets to External Secrets Operator (ESO) with AWS Secrets Manager backend.

## 📚 Commands Overview

| Command | Purpose | Use Case |
|---------|---------|----------|
| **Repository Inventory** | Scan repository for all secret references in values.yaml files | Identify what secrets are used by which workloads |
| **Cluster Inventory** | Query Kubernetes cluster for secrets and usage patterns | Verify what secrets exist in cluster and their status |
| **Compare** | Compare repository expectations vs cluster reality | Identify mismatches, missing secrets, orphaned resources |
| **Generator** | Generate ExternalSecrets YAML blocks for all workloads | Migrate secrets from static K8s Secrets to ESO |
| **Validator** | Validate generated ExternalSecrets blocks | Ensure migration is complete and correct before production |

## 🚀 Quick Start

### Migration Workflow

```bash
# Step 1: Understand repository secret usage
npm run secret-references-repo-inventory -- --env dev

# Step 2: Check cluster current state  
npm run secret-references-cluster-inventory -- --cluster dev-eks --namespace interop

# Step 3: Identify discrepancies
npm run secret-references-compare -- --env dev --cluster dev-eks

# Step 4: Generate ExternalSecrets blocks
npm run secret-references-external-secrets-generator -- --env dev --dry-run
npm run secret-references-external-secrets-generator -- --env dev  # Apply changes

# Step 5: Validate migration
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks \
  --strict

# Step 6: Deploy (after validation passes)
git commit -am "Add ExternalSecrets for dev"
git push
# ArgoCD deploys changes automatically
```

## 📖 Detailed Documentation

### 1. [Repository Inventory](./secret-references-repo-inventory.md)

Analyzes values.yaml files to extract all secret references.

**When to use**:
- Generate baseline of what secrets are needed
- Audit secret usage across workloads
- Identify unused or orphaned secrets

**Output**: 
- CSV and JSON reports of all secret references
- Includes environment variables, secret names, and source locations

**Example**:
```bash
npm run secret-references-repo-inventory -- --env dev --format json
```

---

### 2. [Cluster Inventory](./secret-references-cluster-inventory.md)

Connects to Kubernetes cluster to extract secret metadata and usage.

**When to use**:
- Verify what secrets exist in cluster
- Check AWS Secrets Manager annotations
- Identify cluster state before migration

**Output**:
- Secret-centric view (all secrets + usage)
- Workload-centric view (workloads + their secret refs)

**Example**:
```bash
npm run secret-references-cluster-inventory -- \
  --cluster dev-eks \
  --namespace interop
```

---

### 3. [Compare](./secret-references-compare.md)

Compares repository expectations with cluster reality.

**When to use**:
- Validate cluster readiness for migration
- Identify missing or orphaned secrets
- Pre-flight check before generator runs

**Output**:
- Issues report (missing annotations, orphaned secrets, etc.)
- Workload-by-workload comparison
- Readiness score

**Example**:
```bash
npm run secret-references-compare -- --env dev --cluster dev-eks
```

---

### 4. [Generator](./external-secrets-values-generator.md)

Generates ExternalSecrets blocks and patches values.yaml files.

**When to use**:
- Migrate from static Secrets to ExternalSecrets Operator
- Automate YAML generation for all workloads
- Update existing ExternalSecrets blocks

**Output**:
- Modified values.yaml files with externalSecrets blocks
- Positioned before `deployment:` or `cronjob:` keys
- Preserves all formatting and comments

**Key Features**:
- ✅ Correct envVar → secretKey → remoteRef mapping
- ✅ AWS Secrets Manager path parsing
- ✅ Version ID tracking
- ✅ Dry-run mode for preview

**Example**:
```bash
# Preview changes
npm run secret-references-external-secrets-generator -- --env dev --dry-run

# Apply changes
npm run secret-references-external-secrets-generator -- --env dev
```

---

### 5. [Validator](./secret-references-external-secrets-validator.md)

Validates generated ExternalSecrets blocks for completeness and correctness.

**When to use**:
- Verify migration completeness
- Ensure all secret mappings are correct
- Pre-production validation

**Validation Checks**:
- ✅ ExternalSecrets block exists
- ✅ All repository secrets are covered
- ✅ Data mapping is correct (envVar preserved)
- ✅ Referenced secrets exist in cluster

**Example**:
```bash
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks \
  --strict
```

---

## 🔄 Data Flow Architecture

```
Repository                           Cluster
   │                                    │
   ├─ microservices/*/dev/values.yaml  ├─ K8s Secrets
   ├─ jobs/*/dev/values.yaml           ├─ AWS Annotations
   └─ commons/dev/values-*.yaml        └─ Workload References
        │                                 │
        ▼                                 ▼
   [1. Repo Inventory]             [2. Cluster Inventory]
   Extract all refs                 Extract all secrets
        │                                 │
        └─────────────┬────────────────┘
                      │
                      ▼
              [3. Compare]
              Identify issues
                      │
              ┌───────┴───────┐
              │               │
          Issues         Readiness
          Report         Score
              │
              ▼ (if ready)
        [4. Generator]
        Create ExternalSecrets
              │
              ▼
        Modified values.yaml
        (with externalSecrets)
              │
              ▼
        [5. Validator]
        Verify generation
              │
        ┌─────┴──────┐
        │            │
       ✓OK      ✗Issues
        │            │
        ▼            ▼
      Deploy      Remediate
```

## 📊 Example Workflow Output

### Readiness Assessment

```json
// From secret-references-compare
{
  "readinessScore": {
    "percentage": 95,
    "description": "Ready for ExternalSecrets migration"
  }
}
```

### Migration Success

```json
// From secret-references-external-secrets-validator
{
  "summary": {
    "totalWorkloads": 24,
    "validWorkloads": 24,
    "workloadsWithErrors": 0,
    "allChecksPassed": true,
    "readyForProduction": true
  }
}
```

## ⚙️ Key Concepts

### Environment Variable Preservation

**Critical Bug Fix**: The toolchain now preserves environment variable names throughout the migration.

**Example**:
```yaml
# Repository Secret Reference
containers:
  - env:
    - name: READMODEL_DB_USERNAME      # ← Environment variable name
      valueFrom:
        secretKeyRef:
          name: read-model              # ← Secret name
          key: READONLY_USR             # ← Remote secret key

# Generated ExternalSecrets
externalSecrets:
  data:
    - secretKey: READMODEL_DB_USERNAME  # ← Preserves env var name
      remoteRef:
        key: read-model/path            # ← AWS path
        property: READONLY_USR          # ← Remote property
```

### Insertion Positioning

ExternalSecrets blocks are inserted at optimal positions:
- **Microservices**: Before `deployment:` key
- **Cronjobs**: Before `cronjob:` key
- **Spacing**: Blank line before and after block

### AWS Secrets Manager Integration

Each secret reference maps to AWS Secrets Manager:
- Secret path from cluster annotation
- Version ID tracking
- Property-level access (specific keys within secrets)

## 🔐 Security & Compliance

- ✅ Never reads or stores actual secret values
- ✅ Reads-only operations on cluster
- ✅ All analysis performed locally
- ✅ Safe to commit output (contains only paths, not secrets)
- ✅ RBAC aware (validates required permissions)

## 📝 Common Use Cases

### Pre-Migration Readiness

```bash
# Check if cluster is ready
npm run secret-references-compare -- --env prod --cluster prod-eks

# If score < 90%, address issues then re-run
```

### Audit Secret Usage

```bash
# Generate reports across all environments
for env in dev qa staging prod; do
  npm run secret-references-repo-inventory -- --env $env
done
```

### Validate Migration Completeness

```bash
# Full validation pipeline
npm run secret-references-external-secrets-validator -- \
  --env prod \
  --cluster prod-eks \
  --strict
```

### Troubleshooting Workload Issues

```bash
# Find what secrets a workload uses
npm run secret-references-repo-inventory -- --env dev --format json | \
  jq '.[] | select(.component == "email-digest-dispatcher")'

# Check cluster has those secrets
npm run secret-references-cluster-inventory -- \
  --cluster dev-eks \
  --namespace interop \
  --format json | jq '.[] | select(.secretName == "rds-secret")'
```

## 🧪 Testing & Validation

### Full Workflow Test

```bash
#!/bin/bash
ENV="dev"
CLUSTER="dev-eks"
NS="interop"

# 1. Baseline inventory
npm run secret-references-repo-inventory -- --env $ENV
npm run secret-references-cluster-inventory -- --cluster $CLUSTER --namespace $NS

# 2. Pre-migration check
npm run secret-references-compare -- --env $ENV --cluster $CLUSTER

# 3. Generate and validate
npm run secret-references-external-secrets-generator -- --env $ENV --dry-run
npm run secret-references-external-secrets-validator -- \
  --env $ENV --cluster $CLUSTER --strict

# 4. If all valid, apply
if [ $? -eq 0 ]; then
  npm run secret-references-external-secrets-generator -- --env $ENV
  echo "✓ ExternalSecrets migration complete"
else
  echo "✗ Validation failed - fix issues before proceeding"
fi
```

## 📚 File Reference

| File | Purpose |
|------|---------|
| [secret-references-repo-inventory.md](./secret-references-repo-inventory.md) | Repository secret scanning |
| [secret-references-cluster-inventory.md](./secret-references-cluster-inventory.md) | Cluster secret inventory |
| [secret-references-compare.md](./secret-references-compare.md) | Pre-migration comparison |
| [external-secrets-values-generator.md](./external-secrets-values-generator.md) | ExternalSecrets generation |
| [secret-references-external-secrets-validator.md](./secret-references-external-secrets-validator.md) | Migration validation |

## 🔗 Related Topics

- [External Secrets Operator Documentation](https://external-secrets.io/)
- [AWS Secrets Manager Integration](https://external-secrets.io/latest/provider/aws-secrets-manager/)
- [Kubernetes Secrets Management Best Practices](https://kubernetes.io/docs/concepts/configuration/secret/)
