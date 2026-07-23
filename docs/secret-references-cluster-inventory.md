# Secret References Cluster Inventory

Connects to a live Kubernetes cluster to extract all Secrets and their AWS Secrets Manager annotations, building a comprehensive inventory of what secrets exist in the cluster.

## 🎯 Overview

This tool queries the Kubernetes cluster to:

1. **Connect to Cluster**: Authenticates using current kubeconfig context
2. **Fetch Secrets**: Lists all Secrets in the specified namespace
3. **Extract Annotations**: Reads AWS Secrets Manager metadata and version IDs
4. **Identify Usage**: Analyzes which workloads reference each secret
5. **Generate Reports**: Produces secret-centric and workload-centric inventory reports

## 📋 Prerequisites

- Node.js ≥ 20.0.0
- `kubectl` configured with access to target cluster
- Current kubeconfig with valid context
- Target namespace with Secrets (typically `interop` or similar)
- Network access to Kubernetes API server

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
npm run secret-references-cluster-inventory -- \
  --cluster <context-name> \
  --namespace <namespace> \
  [--output-dir <path>] \
  [--format csv|json|both]
```

### Command-Line Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--cluster` | ✅ Yes | - | Kubernetes context name (from kubeconfig) |
| `--namespace` | ✅ Yes | - | Kubernetes namespace to scan |
| `-n` | ✅ Yes (alt) | - | Short form for `--namespace` |
| `--output-dir` | ❌ No | `./secret-inventory` | Output directory for reports |
| `--format` | ❌ No | `both` | Output format: `csv`, `json`, or `both` |

### Examples

#### 1. Basic Cluster Scan

```bash
npm run secret-references-cluster-inventory -- \
  --cluster dev-eks-cluster \
  --namespace interop
```

**Output**: 
- `secret-inventory/secret-inventory-cluster-secrets-interop.csv`
- `secret-inventory/secret-inventory-cluster-secrets-interop.json`
- `secret-inventory/secret-inventory-cluster-workloads-interop.csv`
- `secret-inventory/secret-inventory-cluster-workloads-interop.json`

#### 2. Using Short Options

```bash
npm run secret-references-cluster-inventory -- \
  -c prod-eks-cluster \
  -n production
```

#### 3. Custom Output Directory

```bash
npm run secret-references-cluster-inventory -- \
  --cluster qa-cluster \
  --namespace qa \
  --output-dir ./audit/qa-cluster
```

#### 4. JSON Output Only

```bash
npm run secret-references-cluster-inventory -- \
  --cluster staging \
  --namespace interop \
  --format json
```

## 📊 Output

The tool generates **two complementary views** of the cluster secrets:

### 1. Secret-Centric View

**Files**: 
- `secret-inventory-cluster-secrets-<namespace>.csv`
- `secret-inventory-cluster-secrets-<namespace>.json`

Lists all secrets with their metadata and usage information.

#### CSV Format

```csv
secretName,secretNamespace,keyCount,keys,hasAwsSecretsManagerSecretId,hasAwsSecretsManagerVersionId,isUnused,usageCount,usageList
rds-secret,interop,2,"password,username",true,true,false,2,"microservice/email-digest-dispatcher:containers[0],microservice/token-generation:containers[0]"
read-model,interop,4,"PROJECTION_PSW,PROJECTION_USR,READONLY_PSW,READONLY_USR",true,true,false,3,"cronjob/datalake-data-export:cronjob,microservice/anac-certified-attributes-importer:container"
legacy-config,interop,3,"api_key,db_url,timeout",false,false,true,0,""
```

#### JSON Format

```json
[
  {
    "secretName": "rds-secret",
    "secretNamespace": "interop",
    "keyCount": 2,
    "keys": ["password", "username"],
    "annotations": {
      "infra.interop.pagopa.it/aws-secretsmanager-secret-id": "rds/interop-platform-data-dev/users/email_digest_dispatcher_user",
      "infra.interop.pagopa.it/aws-secretsmanager-version-id": "uuid/terraform-20260212133048976200000002",
      "infra.interop.pagopa.it/updated-at": "2026-02-12T13:30:48Z"
    },
    "referencedBy": ["microservice/email-digest-dispatcher:containers[0]"],
    "hasAwsSecretsManagerSecretId": true,
    "hasAwsSecretsManagerVersionId": true,
    "hasUpdatedAt": true,
    "hasAnyManagedAnnotation": true,
    "hasNoManagedAnnotations": false,
    "managedAnnotationStatus": "aws-secretsmanager-secret-id",
    "isUnused": false,
    "usageCount": 1
  }
]
```

### 2. Workload-Centric View

**Files**:
- `secret-inventory-cluster-workloads-<namespace>.csv`
- `secret-inventory-cluster-workloads-<namespace>.json`

Lists all secret references from workload perspectives.

#### CSV Format

```csv
workloadType,workloadName,workloadNamespace,containerName,containerType,referenceType,secretName,secretKey
microservice,email-digest-dispatcher,interop,app,container,secretKeyRef,rds-secret,password
microservice,email-digest-dispatcher,interop,app,container,secretKeyRef,rds-secret,username
cronjob,datalake-data-export,interop,main,container,envFromSecrets,read-model,PROJECTION_PSW
cronjob,datalake-data-export,interop,main,container,envFromSecrets,read-model,PROJECTION_USR
microservice,flyway-migrator,interop,migrations,initContainer,secretKeyRef,flyway-db-secret,password
```

#### JSON Format

```json
[
  {
    "workloadType": "microservice",
    "workloadName": "email-digest-dispatcher",
    "workloadNamespace": "interop",
    "containerName": "app",
    "containerType": "container",
    "referenceType": "secretKeyRef",
    "secretName": "rds-secret",
    "secretKey": "password"
  }
]
```

## 📊 Metadata Fields

### AWS Secrets Manager Annotations

| Annotation | Purpose |
|-----------|---------|
| `infra.interop.pagopa.it/aws-secretsmanager-secret-id` | AWS Secrets Manager path (e.g., `rds/interop-platform-data-dev/users/email_dispatcher_user`) |
| `infra.interop.pagopa.it/aws-secretsmanager-version-id` | AWS secret version ID (e.g., `uuid/terraform-20260212133048976200000002`) |
| `infra.interop.pagopa.it/updated-at` | Last update timestamp (ISO 8601) |

### Status Fields

| Field | Meaning |
|-------|---------|
| `hasAwsSecretsManagerSecretId` | Secret has AWS path annotation ✓ Required for ExternalSecrets migration |
| `hasAwsSecretsManagerVersionId` | Secret has version annotation |
| `hasUpdatedAt` | Secret has update timestamp |
| `hasAnyManagedAnnotation` | Secret has at least one managed annotation |
| `hasNoManagedAnnotations` | Secret is missing all managed annotations |
| `isUnused` | Secret is not referenced by any workload ⚠️ Candidate for cleanup |
| `referencedWithoutManagedAnnotations` | Secret is used but lacks AWS annotations ⚠️ Needs annotation |

## 🔍 Key Insights

### Identify Unused Secrets

```bash
npm run secret-references-cluster-inventory -- \
  --cluster prod \
  --namespace interop \
  --format json | \
  jq '.[] | select(.isUnused == true) | .secretName'
```

### Find Secrets Missing AWS Annotations

```bash
npm run secret-references-cluster-inventory -- \
  --cluster prod \
  --namespace interop \
  --format json | \
  jq '.[] | select(.hasAwsSecretsManagerSecretId == false) | .secretName'
```

### Export for Compliance Audit

```bash
npm run secret-references-cluster-inventory -- \
  --cluster prod \
  --namespace interop \
  --output-dir ./compliance-audit
```

### Analyze Container Type Distribution

```bash
npm run secret-references-cluster-inventory -- \
  --cluster dev \
  --namespace interop \
  --format json | \
  jq -r '.[].containerType' | \
  sort | uniq -c
```

## 🏗️ Architecture

### Core Components

1. **`k8s-client.ts`**
   - Initializes Kubernetes client using kubeconfig
   - Authenticates and verifies cluster access
   - Fetches Secrets from cluster API

2. **`k8s-secret-extractor.ts`**
   - Walks Deployment, StatefulSet, DaemonSet, Job, CronJob resources
   - Extracts secret references from pod specs
   - Tracks container type (container, initContainer, ephemeralContainer)

3. **`k8s-inventory.ts`**
   - Aggregates extracted data
   - Builds secret-centric and workload-centric views
   - Analyzes annotation status and usage

## 🔄 Data Flow

```
Kubernetes API
    │
    ├─ List Secrets (with annotations)
    │
    ├─ List Deployments
    ├─ List StatefulSets
    ├─ List DaemonSets
    ├─ List Jobs
    └─ List CronJobs
         │
         ▼
   Extract References
         │
         ├─ Container references
         ├─ InitContainer references
         └─ EphemeralContainer references
         │
         ▼
   Build Inventory
         │
    ┌────┴────────────────┐
    ▼                     ▼
Secret-Centric       Workload-Centric
    │                     │
    ├─ CSV               ├─ CSV
    └─ JSON              └─ JSON
```

## 🧪 Testing

### Verify Cluster Access

```bash
# Test connectivity and namespace access
npm run secret-references-cluster-inventory -- \
  --cluster your-cluster \
  --namespace interop \
  --format json | head -5
```

### Sample Commands

```bash
# DEV environment
npm run secret-references-cluster-inventory -- \
  --cluster dev-eks \
  --namespace interop

# QA environment  
npm run secret-references-cluster-inventory -- \
  --cluster qa-eks \
  -n qa

# PROD environment with custom output
npm run secret-references-cluster-inventory -- \
  --cluster prod-eks \
  --namespace production \
  --output-dir ./prod-audit
```

## 🐛 Troubleshooting

### Error: "Cannot access cluster"

```
Error: Failed to load kubeconfig: ENOENT: no such file or directory, open '/Users/user/.kube/config'
```

**Solution**:
```bash
# Verify kubeconfig
export KUBECONFIG=~/.kube/config
kubectl config current-context

# Check cluster context
kubectl config get-contexts
```

### Error: "Namespace not found"

```
Error: Namespace 'interop' not found or not accessible
```

**Solution**:
```bash
# List available namespaces
kubectl get namespaces

# Check access to namespace
kubectl auth can-i get secrets -n interop
```

### No Secrets Found

If output shows 0 secrets, verify:

```bash
# List secrets in namespace
kubectl get secrets -n interop

# Check for AWS annotations
kubectl get secrets -n interop -o yaml | grep aws-secretsmanager
```

## 🔐 Security Considerations

- **No Secret Values**: Never reads or displays secret data, only metadata
- **Read-Only**: Only queries cluster; makes no modifications
- **Kubeconfig Auth**: Uses local kubeconfig for authentication
- **Safe Output**: Reports contain only reference paths, not secret contents

## 📝 Related Commands

- **Repository Inventory**: `npm run secret-references-repo-inventory`
- **Compare Repo vs Cluster**: `npm run secret-references-compare`
- **Validate Migration**: `npm run secret-references-external-secrets-validator`
