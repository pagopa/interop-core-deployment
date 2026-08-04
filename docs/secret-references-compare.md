# Secret References Comparison Tool

Compares repository secret references with cluster inventory to identify discrepancies, missing annotations, and unused or orphaned secrets.

## 🎯 Overview

This tool combines repository and cluster data to:

1. **Run Inventory Scans**: Executes repo and cluster inventory commands automatically
2. **Aggregate Data**: Transforms raw data into comparable formats
3. **Compare**: Identifies differences between repo expectations and cluster reality
4. **Report Issues**: Highlights missing secrets, orphaned secrets, missing annotations, etc.
5. **Generate Reports**: Produces detailed analysis in JSON and CSV formats

## 📋 Prerequisites

- Node.js ≥ 20.0.0
- `kubectl` configured with access to target cluster
- Current kubeconfig with valid context
- Repository with standard directory structure
- Target namespace in cluster (typically `interop`)

## 🚀 Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build:secret-references
```

## 💻 Usage

### Basic Syntax

```bash
npm run secret-references-compare -- \
  --env <environment> \
  --cluster <context-name> \
  [--namespace <namespace>] \
  [--output-dir <path>]
```

### Command-Line Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--env` | ✅ Yes | - | Environment name (dev, qa, prod, etc.) |
| `--cluster` | ✅ Yes | - | Kubernetes context name |
| `--namespace` | ❌ No | (same as env) | Kubernetes namespace to scan |
| `-n` | ❌ No | (same as env) | Short form for `--namespace` |
| `--output-dir` | ❌ No | `./secret-inventory` | Output directory for reports |

### Examples

#### 1. Basic Comparison

```bash
npm run secret-references-compare -- \
  --env dev \
  --cluster dev-eks-cluster
```

**Output**: 
- `secret-inventory/secret-comparison-dev.json`
- `secret-inventory/secret-comparison-workload-dev.json`
- `secret-inventory/stats-comparison-dev.json`

#### 2. With Custom Namespace

```bash
npm run secret-references-compare -- \
  --env prod \
  --cluster prod-eks \
  --namespace production
```

#### 3. Custom Output Directory

```bash
npm run secret-references-compare -- \
  --env staging \
  --cluster staging-eks \
  --output-dir ./audit/staging
```

## 📊 Output

The tool generates **three complementary reports**:

### 1. Secret Comparison Report

**File**: `secret-comparison-<env>.json`

Compares secrets from repo perspective (what's expected) vs cluster perspective (what exists).

```json
{
  "environment": "dev",
  "totalSecretsInRepo": 18,
  "totalSecretsInCluster": 20,
  "matched": 16,
  "issues": [
    {
      "secretName": "legacy-auth-secret",
      "status": "ORPHANED_IN_CLUSTER",
      "repoExists": false,
      "clusterExists": true,
      "details": "Secret exists in cluster but is not referenced by any workload in repo"
    },
    {
      "secretName": "payment-config",
      "status": "MISSING_IN_CLUSTER",
      "repoExists": true,
      "clusterExists": false,
      "details": "Repository references this secret but it does not exist in cluster"
    },
    {
      "secretName": "rds-secret",
      "status": "MISSING_ANNOTATION",
      "repoExists": true,
      "clusterExists": true,
      "details": "Secret exists but lacks AWS Secrets Manager annotation",
      "missingAnnotations": ["infra.interop.pagopa.it/aws-secretsmanager-secret-id"]
    },
    {
      "secretName": "read-model",
      "status": "OK",
      "repoExists": true,
      "clusterExists": true,
      "details": "Secret is properly configured with all required annotations"
    }
  ]
}
```

#### Status Values

| Status | Meaning | Action Required |
|--------|---------|-----------------|
| `OK` | Secret properly configured | ✓ None, ready for migration |
| `MISSING_IN_CLUSTER` | Referenced in repo but doesn't exist in cluster | ⚠️ Create secret in cluster |
| `ORPHANED_IN_CLUSTER` | Exists in cluster but not used by any workload | ⚠️ Review for cleanup |
| `MISSING_ANNOTATION` | Exists but lacks AWS annotation | ⚠️ Add annotation to secret |
| `MISSING_VERSION_ID` | Has AWS path but missing version ID | ⚠️ Add version annotation |

### 2. Workload-Centric Comparison

**File**: `secret-comparison-workload-<env>.json`

Compares from workload perspective, identifying coverage gaps.

```json
{
  "environment": "dev",
  "workloadComparisons": [
    {
      "workloadType": "microservice",
      "workloadName": "email-digest-dispatcher",
      "repoSecretCount": 3,
      "clusterSecretCount": 3,
      "matched": 3,
      "issues": []
    },
    {
      "workloadType": "cronjob",
      "workloadName": "data-processor",
      "repoSecretCount": 5,
      "clusterSecretCount": 2,
      "matched": 2,
      "issues": [
        {
          "secretName": "external-api-key",
          "status": "MISSING_IN_CLUSTER",
          "details": "Workload references this secret but it doesn't exist in cluster"
        }
      ]
    }
  ],
  "summary": {
    "totalWorkloads": 24,
    "workloadsWithIssues": 2,
    "totalIssues": 3
  }
}
```

### 3. Statistics Comparison

**File**: `stats-comparison-<env>.json`

High-level statistics about the comparison.

```json
{
  "environment": "dev",
  "repository": {
    "totalWorkloads": 24,
    "totalSecretReferences": 145,
    "microservices": 18,
    "cronjobs": 6
  },
  "cluster": {
    "totalSecrets": 20,
    "withAwsAnnotation": 18,
    "withoutAwsAnnotation": 2,
    "unused": 1
  },
  "comparison": {
    "secretsMatched": 16,
    "orphanedInCluster": 2,
    "missingInCluster": 1,
    "missingAnnotations": 1,
    "readyForMigration": 15
  },
  "readinessScore": {
    "percentage": 94,
    "description": "Ready for ExternalSecrets migration"
  }
}
```

## 🔍 Key Insights

### Run Basic Comparison

```bash
npm run secret-references-compare -- --env dev --cluster dev-eks
```

### Identify Critical Issues

```bash
npm run secret-references-compare -- --env prod --cluster prod-eks

# Then analyze the output:
cat secret-inventory/secret-comparison-prod.json | \
  jq '.issues[] | select(.status != "OK")'
```

### Find Orphaned Secrets

```bash
npm run secret-references-compare -- --env dev --cluster dev-eks

cat secret-inventory/secret-comparison-dev.json | \
  jq '.issues[] | select(.status == "ORPHANED_IN_CLUSTER")'
```

### Readiness Assessment

```bash
npm run secret-references-compare -- --env staging --cluster staging-eks

cat secret-inventory/stats-comparison-staging.json | \
  jq '.readinessScore'
```

## 📋 Pre-Migration Checklist

Use comparison reports to validate readiness:

```bash
npm run secret-references-compare -- --env dev --cluster dev-eks
```

**Verify**:
- [ ] All comparison status values are `OK` or `MISSING_VERSION_ID` (acceptable)
- [ ] No `MISSING_IN_CLUSTER` issues (all secrets exist in cluster)
- [ ] No `MISSING_ANNOTATION` issues (all secrets have AWS annotation)
- [ ] No unexpected `ORPHANED_IN_CLUSTER` secrets
- [ ] Readiness score ≥ 90%

If issues exist, resolve them before running the generator:

1. **MISSING_IN_CLUSTER**: Create secret in cluster
   ```bash
   kubectl create secret generic payment-config --from-literal=key=value -n interop
   ```

2. **MISSING_ANNOTATION**: Add AWS annotation
   ```bash
   kubectl patch secret rds-secret -n interop -p \
     '{"metadata":{"annotations":{"infra.interop.pagopa.it/aws-secretsmanager-secret-id":"path/to/secret"}}}'
   ```

3. **ORPHANED_IN_CLUSTER**: Review and cleanup
   ```bash
   kubectl delete secret legacy-auth-secret -n interop
   ```

## 🏗️ Architecture

### Comparison Process

```
┌──────────────────────┐
│  Repository Scan     │
│  (1. Collect refs)   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Cluster Scan        │
│  (2. Collect secrets)│
└──────────┬───────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
Repo Data      Cluster Data
    │             │
    └──────┬──────┘
           │
           ▼
      Transform to
      Comparable Format
           │
    ┌──────┴──────┐
    ▼             ▼
Secret-Centric  Workload-Centric
    │             │
    ├─ Compare    ├─ Compare
    ├─ Match      ├─ Match
    └─ Identify   └─ Identify
      Issues        Issues
           │
    ┌──────┴──────┐
    ▼             ▼
  Generate     Generate
   Reports      Stats
```

## 🧪 Testing

### Full Workflow Example

```bash
# 1. Run comparison
npm run secret-references-compare -- --env dev --cluster dev-eks

# 2. Check readiness score
cat secret-inventory/stats-comparison-dev.json | jq '.readinessScore.percentage'

# 3. If ready (score ≥ 90%), proceed with migration
npm run secret-references-external-secrets-generator -- --env dev --dry-run

# 4. If dry-run looks good, apply
npm run secret-references-external-secrets-generator -- --env dev
```

## 🔍 Typical Issues and Solutions

### Issue: "Missing Annotation"

**Symptom**: Status `MISSING_ANNOTATION`

**Cause**: Secret exists but lacks AWS Secrets Manager metadata

**Solution**:
```bash
kubectl patch secret my-secret -n interop -p \
  '{"metadata":{"annotations":{"infra.interop.pagopa.it/aws-secretsmanager-secret-id":"aws/path/to/secret"}}}'
```

### Issue: "Orphaned Secret"

**Symptom**: Status `ORPHANED_IN_CLUSTER`

**Cause**: Secret exists in cluster but no workload references it

**Solution**:
```bash
# Review if secret is still needed
kubectl get secret orphaned-secret -n interop -o yaml

# If not needed, delete it
kubectl delete secret orphaned-secret -n interop
```

### Issue: "Missing Secret"

**Symptom**: Status `MISSING_IN_CLUSTER`

**Cause**: Repository references a secret that doesn't exist in cluster

**Solution**:
1. Create the secret in cluster
2. Add AWS annotation
3. Re-run comparison to verify

## 📝 Related Commands

- **Repository Inventory**: `npm run secret-references-repo-inventory`
- **Cluster Inventory**: `npm run secret-references-cluster-inventory`
- **Generate ExternalSecrets**: `npm run secret-references-external-secrets-generator`
- **Validate Migration**: `npm run secret-references-external-secrets-validator`
