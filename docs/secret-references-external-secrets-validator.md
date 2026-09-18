# External Secrets Validator

Validates the output of the ExternalSecrets generator by verifying completeness, correctness, and cluster coherence. Ensures all workload secrets are properly migrated.

## 🎯 Overview

This tool validates ExternalSecrets migration by:

1. **Verify Presence**: Ensures ExternalSecrets YAML exists for all workloads
2. **Check Coverage**: Validates all repository secret references are in ExternalSecrets
3. **Verify Correctness**: Confirms data mapping (envVar→secretKey→remoteRef)
4. **Cluster Coherence**: Ensures referenced secrets exist in cluster with proper annotations
5. **Generate Reports**: Produces detailed validation results and issue lists

## 📋 Prerequisites

- Node.js ≥ 20.0.0
- `kubectl` configured with access to target cluster
- Current kubeconfig with valid context
- Generated values.yaml files with externalSecrets blocks
- Executed repository and cluster inventory scans

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
npm run secret-references-external-secrets-validator -- \
  --env <environment> \
  --cluster <context-name> \
  [--namespace <namespace>] \
  [--output-dir <path>] \
  [--strict]
```

### Command-Line Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--env` | ✅ Yes | - | Environment name (dev, qa, prod, etc.) |
| `--cluster` | ✅ Yes | - | Kubernetes context name |
| `--namespace` | ❌ No | (same as env) | Kubernetes namespace to scan |
| `-n` | ❌ No | (same as env) | Short form for `--namespace` |
| `--output-dir` | ❌ No | `./secret-inventory` | Output directory for reports |
| `--strict` | ❌ No | false | Fail on warnings (not just errors) |

### Examples

#### 1. Basic Validation

```bash
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks-cluster
```

**Output**: 
- `secret-inventory/validator-results-dev.json`
- `secret-inventory/validator-coverage-dev.json`

#### 2. Strict Mode (Warnings = Failures)

```bash
npm run secret-references-external-secrets-validator -- \
  --env prod \
  --cluster prod-eks \
  --strict
```

Useful in CI/CD to prevent partial migrations.

#### 3. Custom Output Directory

```bash
npm run secret-references-external-secrets-validator -- \
  --env staging \
  --cluster staging-eks \
  --output-dir ./validation-audit
```

## 📊 Output

### 1. Validation Results Report

**File**: `validator-results-<env>.json`

Comprehensive validation of all workloads and their secrets.

```json
{
  "environment": "dev",
  "validationTime": "2026-02-15T10:30:00Z",
  "summary": {
    "totalWorkloads": 24,
    "validWorkloads": 22,
    "workloadsWithErrors": 1,
    "workloadsWithWarnings": 1,
    "allChecksPassed": false,
    "readyForProduction": false
  },
  "validations": [
    {
      "workloadType": "microservice",
      "workloadName": "email-digest-dispatcher",
      "status": "VALID",
      "checks": {
        "externalSecretsPresent": {
          "passed": true,
          "details": "ExternalSecrets block found in values.yaml"
        },
        "secretCoverage": {
          "passed": true,
          "details": "All 3 repository secret references covered",
          "repoCount": 3,
          "externalSecretsCount": 3
        },
        "dataMapping": {
          "passed": true,
          "details": "All envVar→secretKey→remoteRef mappings are correct",
          "mappings": [
            {
              "envVar": "DB_PASSWORD",
              "secretKey": "DB_PASSWORD",
              "remoteRef": "rds-secret:password"
            }
          ]
        },
        "clusterCoherence": {
          "passed": true,
          "details": "All referenced secrets exist in cluster with proper annotations"
        }
      },
      "issues": []
    },
    {
      "workloadType": "microservice",
      "workloadName": "payment-processor",
      "status": "ERROR",
      "checks": {
        "externalSecretsPresent": {
          "passed": false,
          "details": "ExternalSecrets block NOT found in values.yaml"
        },
        "secretCoverage": {
          "passed": false,
          "details": "Missing ExternalSecrets block"
        },
        "dataMapping": {
          "passed": false,
          "details": "Cannot validate without ExternalSecrets block"
        },
        "clusterCoherence": {
          "passed": false,
          "details": "Cannot verify cluster coherence"
        }
      },
      "issues": [
        {
          "type": "ERROR",
          "code": "EXTERNAL_SECRETS_MISSING",
          "message": "ExternalSecrets block not found in values.yaml",
          "remediation": "Run external-secrets-generator for this workload"
        }
      ]
    },
    {
      "workloadType": "cronjob",
      "workloadName": "data-processor",
      "status": "WARNING",
      "checks": {
        "externalSecretsPresent": {
          "passed": true,
          "details": "ExternalSecrets block found"
        },
        "secretCoverage": {
          "passed": true,
          "details": "All secrets covered"
        },
        "dataMapping": {
          "passed": true,
          "details": "All mappings correct"
        },
        "clusterCoherence": {
          "passed": false,
          "details": "Secret 'legacy-api-key' lacks AWS annotation"
        }
      },
      "issues": [
        {
          "type": "WARNING",
          "code": "MISSING_ANNOTATION",
          "message": "Secret 'legacy-api-key' missing AWS Secrets Manager annotation",
          "remediation": "Add annotation: infra.interop.pagopa.it/aws-secretsmanager-secret-id"
        }
      ]
    }
  ]
}
```

#### Check Categories

| Check | Purpose |
|-------|---------|
| `externalSecretsPresent` | Verifies ExternalSecrets block exists in values.yaml |
| `secretCoverage` | Confirms all repo secret references are covered |
| `dataMapping` | Validates envVar→secretKey→remoteRef correctness |
| `clusterCoherence` | Ensures referenced secrets exist in cluster |

### 2. Coverage Report

**File**: `validator-coverage-<env>.json`

Detailed mapping between repository secrets and ExternalSecrets.

```json
{
  "environment": "dev",
  "workloadCoverage": [
    {
      "workloadType": "microservice",
      "workloadName": "email-digest-dispatcher",
      "totalRepoSecretReferences": 3,
      "totalExternalSecretsData": 3,
      "coverage": {
        "percentage": 100,
        "status": "FULL"
      },
      "mappings": [
        {
          "repoReference": {
            "secretName": "rds-secret",
            "secretKey": "password",
            "envVar": "DB_PASSWORD",
            "referenceType": "secretKeyRef"
          },
          "externalSecretsData": {
            "secretKey": "DB_PASSWORD",
            "remoteRef": {
              "key": "rds/interop-platform-data-dev/email_dispatcher_user",
              "property": "password",
              "version": "uuid/terraform-20260212"
            }
          },
          "status": "MATCHED",
          "mapping": {
            "repoEnvVar": "DB_PASSWORD",
            "externalSecretsSecretKey": "DB_PASSWORD",
            "match": "EXACT"
          }
        },
        {
          "repoReference": {
            "secretName": "rds-secret",
            "secretKey": "username",
            "envVar": "DB_USER",
            "referenceType": "secretKeyRef"
          },
          "externalSecretsData": {
            "secretKey": "DB_USER",
            "remoteRef": {
              "key": "rds/interop-platform-data-dev/email_dispatcher_user",
              "property": "username",
              "version": "uuid/terraform-20260212"
            }
          },
          "status": "MATCHED",
          "mapping": {
            "repoEnvVar": "DB_USER",
            "externalSecretsSecretKey": "DB_USER",
            "match": "EXACT"
          }
        }
      ]
    }
  ],
  "summary": {
    "totalWorkloads": 24,
    "fullyCovered": 22,
    "partiallyCovered": 1,
    "notCovered": 1,
    "coveragePercentage": 95.8
  }
}
```

## ✅ Validation Checks Explained

### 1. ExternalSecrets Presence

**What it checks**: Does the ExternalSecrets block exist in values.yaml?

**Passes if**: 
- File contains `externalSecrets:` top-level key
- Block has `create: true` or `create: false`
- Block contains `data:` array

**Fails if**:
- Block is missing entirely
- Block is malformed (invalid YAML)

**Example**:
```yaml
externalSecrets:
  create: true
  data:
    - secretKey: DB_PASSWORD
      remoteRef:
        key: rds/path
        property: password
```

### 2. Secret Coverage

**What it checks**: Are all repository secret references included?

**Passes if**:
- Count of repo secret refs ≤ count of ExternalSecrets data entries
- All unique (secretName, secretKey) pairs are covered

**Example**:
- Repo has: `DB_PASSWORD`, `DB_USER`, `API_KEY` (3 refs)
- ExternalSecrets data has: 3 entries matching above
- Result: ✓ PASS

### 3. Data Mapping

**What it checks**: Is the envVar→secretKey→remoteRef mapping correct?

**Critical**: After the bug fix, this validation ensures:
- `secretKey` = environment variable name (e.g., `DB_PASSWORD`)
- `remoteRef.property` = AWS secret key (e.g., `password`)
- NOT the old buggy pattern of `secretKey = AWS_KEY`

**Example - CORRECT**:
```json
{
  "envVar": "READMODEL_DB_USERNAME",
  "secretKey": "READMODEL_DB_USERNAME",
  "remoteRef": {
    "key": "read-model/path",
    "property": "READONLY_USR"
  }
}
```

### 4. Cluster Coherence

**What it checks**: Do all referenced secrets exist in cluster with proper annotations?

**Passes if**:
- Each `remoteRef.key` matches an annotation in cluster secret
- Secret has required AWS Secrets Manager annotations
- Annotation version ID (if present) is valid

**Example**:
```bash
# Cluster secret must have:
kubectl get secret read-model -n interop -o yaml
# annotations:
#   infra.interop.pagopa.it/aws-secretsmanager-secret-id: read-model/path
```

## 🔍 Key Insights

### Run Basic Validation

```bash
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks
```

### Check Production Readiness

```bash
npm run secret-references-external-secrets-validator -- \
  --env prod \
  --cluster prod-eks \
  --strict

# Check overall status
cat secret-inventory/validator-results-prod.json | \
  jq '.summary.readyForProduction'
```

### Find All Validation Issues

```bash
npm run secret-references-external-secrets-validator -- \
  --env staging \
  --cluster staging-eks

cat secret-inventory/validator-results-staging.json | \
  jq '.validations[] | select(.issues | length > 0)'
```

### Check Coverage by Workload

```bash
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks

cat secret-inventory/validator-coverage-dev.json | \
  jq '.workloadCoverage[] | {name: .workloadName, coverage: .coverage.percentage}'
```

## 📋 Pre-Production Checklist

Before production migration, validate:

```bash
npm run secret-references-external-secrets-validator -- \
  --env prod \
  --cluster prod-eks \
  --strict
```

**Verify in Results**:
- [ ] `.summary.allChecksPassed` = `true`
- [ ] `.summary.readyForProduction` = `true`
- [ ] No workloads with `status: "ERROR"`
- [ ] All workloads with `status: "VALID"` or `"WARNING"`
- [ ] Coverage percentage = 100%

**If Warnings Exist**:
1. Review each warning in `.validations[].issues[]`
2. Resolve based on `remediation` field
3. Re-run validation

## 🏗️ Architecture

### Validation Flow

```
Generated values.yaml
+ ExternalSecrets blocks
        │
        ▼
Validation Engine
        │
    ┌───┴─────┬─────────┬──────────┐
    │         │         │          │
    ▼         ▼         ▼          ▼
 Check 1   Check 2   Check 3    Check 4
Presence  Coverage  Mapping   Coherence
    │         │         │          │
    └───┬─────┴─────────┴──────────┘
        │
        ▼
   Aggregate Results
        │
    ┌───┴────────────┐
    ▼                ▼
Results Report   Coverage Report
```

## 🧪 Testing

### Validation Workflow

```bash
# 1. Generate ExternalSecrets
npm run secret-references-external-secrets-generator -- --env dev

# 2. Validate generation
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks

# 3. Review results
cat secret-inventory/validator-results-dev.json | jq '.summary'

# 4. If all valid, deploy
git add microservices/*/dev/values.yaml jobs/*/dev/values.yaml
git commit -m "Add ExternalSecrets for dev"
```

### Common Test Scenarios

```bash
# Test with completely missing ExternalSecrets
npm run secret-references-external-secrets-validator -- \
  --env dev \
  --cluster dev-eks

# Test with partial coverage
npm run secret-references-external-secrets-validator -- \
  --env staging \
  --cluster staging-eks

# Test strict mode (warnings fail)
npm run secret-references-external-secrets-validator -- \
  --env prod \
  --cluster prod-eks \
  --strict
```

## 🔍 Troubleshooting

### Error: "ExternalSecrets block not found"

**Cause**: Generator hasn't been run or output wasn't saved

**Solution**:
```bash
npm run secret-references-external-secrets-generator -- --env dev
```

### Error: "Secret not found in cluster"

**Cause**: Referenced secret doesn't exist or is in different namespace

**Solution**:
```bash
# Verify secret exists
kubectl get secret secret-name -n <namespace>

# If missing, create it
kubectl create secret generic secret-name --from-literal=key=value -n <namespace>
```

### Warning: "Missing AWS annotation"

**Cause**: Secret lacks `aws-secretsmanager-secret-id` annotation

**Solution**:
```bash
kubectl patch secret secret-name -n interop -p \
  '{"metadata":{"annotations":{"infra.interop.pagopa.it/aws-secretsmanager-secret-id":"aws/path/to/secret"}}}'
```

### Error: "Mapping mismatch"

**Cause**: envVar and secretKey don't match (old bug)

**Solution**:
Re-generate with latest code:
```bash
npm run build:secret-references
npm run secret-references-external-secrets-generator -- --env dev --regenerate
```

## 📝 Related Commands

- **Repository Inventory**: `npm run secret-references-repo-inventory`
- **Cluster Inventory**: `npm run secret-references-cluster-inventory`
- **Compare Repo vs Cluster**: `npm run secret-references-compare`
- **Generate ExternalSecrets**: `npm run secret-references-external-secrets-generator`
