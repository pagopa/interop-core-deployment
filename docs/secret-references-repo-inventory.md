# Secret References Repository Inventory

Analyzes Helm values.yaml files in the repository to extract all secret references and build a comprehensive inventory of what secrets are used by which workloads.

## 🎯 Overview

This tool scans the repository to:

1. **Walk Workloads**: Traverses microservices and cronjob directories for the specified environment
2. **Extract References**: Identifies secret references in values.yaml files (envFromSecrets, secretKeyRef, volumeSecrets, etc.)
3. **Build Inventory**: Creates structured records mapping workloads → secrets → keys
4. **Generate Reports**: Produces CSV and JSON output for analysis and cross-reference

## 📋 Prerequisites

- Node.js ≥ 20.0.0
- Repository with standard directory structure:
  - `microservices/*/dev/values.yaml`
  - `jobs/*/dev/values.yaml`
  - `commons/dev/values-*.yaml`

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
npm run secret-references-repo-inventory -- \
  --env <environment> \
  [--output-dir <path>] \
  [--format csv|json|both]
```

### Command-Line Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--env` | ✅ Yes | - | Environment name (dev, qa, prod, staging, etc.) |
| `--output-dir` | ❌ No | `./secret-inventory` | Output directory for reports |
| `--format` | ❌ No | `both` | Output format: `csv`, `json`, or `both` |

### Examples

#### 1. Basic Repository Scan

```bash
npm run secret-references-repo-inventory -- --env dev
```

**Output**: 
- `secret-inventory/secret-references-repo-dev.csv`
- `secret-inventory/secret-references-repo-dev.json`

#### 2. JSON Output Only

```bash
npm run secret-references-repo-inventory -- --env dev --format json
```

**Output**: 
- `secret-inventory/secret-references-repo-dev.json`

#### 3. Custom Output Directory

```bash
npm run secret-references-repo-inventory -- \
  --env staging \
  --output-dir ./reports/secrets
```

**Output**: 
- `reports/secrets/secret-references-repo-staging.csv`
- `reports/secrets/secret-references-repo-staging.json`

## 📊 Output

### CSV Format

**Location**: `secret-inventory/secret-references-repo-<env>.csv`

```csv
environment,workloadType,component,sourceScope,sourceFile,line,yamlPath,containerPath,referenceType,envVar,secretName,secretKey,rawReference
dev,microservice,email-digest-dispatcher,workload,microservices/email-digest-dispatcher/dev/values.yaml,28,deployment.spec.template.spec.containers[0].env[0],containers[0],secretKeyRef,DB_PASSWORD,rds-secret,password,rds-secret:password
dev,microservice,email-digest-dispatcher,workload,microservices/email-digest-dispatcher/dev/values.yaml,35,deployment.spec.template.spec.containers[0].envFrom[0],containers[0],envFromSecrets,PROJECTION_PSW,read-model,READONLY_PSW,read-model:READONLY_PSW
dev,cronjob,datalake-data-export,workload,jobs/datalake-data-export/dev/values.yaml,40,cronjob.envFromSecrets,cronjob,envFromSecrets,READMODEL_DB_USERNAME,read-model,READONLY_USR,read-model:READONLY_USR
dev,microservice,flyway-migrator,workload,microservices/flyway-migrator/dev/values.yaml,15,initContainers[0].env[0].valueFrom.secretKeyRef,initContainers[0],secretKeyRef,FLYWAY_PASSWORD,flyway-db-secret,password,flyway-db-secret:password
```

### Column Definitions

| Column | Description |
|--------|-------------|
| `environment` | Environment name (dev, qa, prod, etc.) |
| `workloadType` | `microservice` or `cronjob` |
| `component` | Workload name (e.g., email-digest-dispatcher) |
| `sourceScope` | `workload` (individual values.yaml) or `common` (commons templates) |
| `sourceFile` | Path to the values.yaml file containing the reference |
| `line` | Line number in the source file (for quick navigation) |
| `yamlPath` | Full YAML path to the reference (e.g., `deployment.spec.template.spec.containers[0].env[0]`) |
| `containerPath` | Container type path (e.g., `containers[0]`, `initContainers[0]`) |
| `referenceType` | Type of reference: `secretKeyRef`, `envFromSecrets`, `secretRef`, `volumeSecret` |
| `envVar` | Environment variable name (only for secretKeyRef) |
| `secretName` | Kubernetes Secret name |
| `secretKey` | Key within the Secret (remote property) |
| `rawReference` | Human-readable reference format |

### JSON Format

**Location**: `secret-inventory/secret-references-repo-<env>.json`

```json
[
  {
    "environment": "dev",
    "workloadType": "microservice",
    "component": "email-digest-dispatcher",
    "sourceScope": "workload",
    "sourceFile": "microservices/email-digest-dispatcher/dev/values.yaml",
    "line": 28,
    "yamlPath": "deployment.spec.template.spec.containers[0].env[0]",
    "containerPath": "containers[0]",
    "referenceType": "secretKeyRef",
    "envVar": "DB_PASSWORD",
    "secretName": "rds-secret",
    "secretKey": "password",
    "rawReference": "rds-secret:password"
  },
  {
    "environment": "dev",
    "workloadType": "cronjob",
    "component": "datalake-data-export",
    "sourceScope": "workload",
    "sourceFile": "jobs/datalake-data-export/dev/values.yaml",
    "line": 40,
    "yamlPath": "cronjob.envFromSecrets",
    "containerPath": "cronjob",
    "referenceType": "envFromSecrets",
    "envVar": "READMODEL_DB_USERNAME",
    "secretName": "read-model",
    "secretKey": "READONLY_USR",
    "rawReference": "read-model:READONLY_USR"
  }
]
```

## 🔍 Reference Types

### secretKeyRef
Individual environment variable pointing to a specific key in a Secret.

```yaml
containers:
  - env:
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: rds-secret
          key: password
```

**Inventory Record**:
- `envVar`: `DB_PASSWORD`
- `referenceType`: `secretKeyRef`
- `secretName`: `rds-secret`
- `secretKey`: `password`

### envFromSecrets
Imports all keys from a Secret as environment variables.

```yaml
containers:
  - envFrom:
    - secretRef:
        name: read-model
```

**Inventory Record**:
- `envVar`: Individual key name (e.g., `READONLY_USR`)
- `referenceType`: `envFromSecrets`
- `secretName`: `read-model`
- `secretKey`: Individual key from the secret

### volumeSecret
References a Secret mounted as a volume.

```yaml
volumes:
  - name: config-volume
    secret:
      secretName: app-config
      items:
      - key: config.json
        path: config.json
```

**Inventory Record**:
- `referenceType`: `volumeSecret`
- `secretName`: `app-config`
- `secretKey`: Key within the volume (e.g., `config.json`)

## 🏗️ Architecture

### Core Components

1. **`workload.ts`**
   - Walks directory tree for microservices and cronjobs
   - Identifies values.yaml files by environment
   - Coordinates inventory creation

2. **`yaml-walker.ts`**
   - Recursively traverses YAML structures
   - Identifies secret references patterns
   - Extracts line numbers and YAML paths

3. **`csv.ts`**
   - Formats records as CSV with proper escaping
   - Handles special characters and quotes

## 🔄 Data Flow

```
Repository
  ├─ microservices/
  │  ├─ workload-a/
  │  │  └─ dev/values.yaml
  │  └─ workload-b/
  │     └─ dev/values.yaml
  └─ jobs/
     ├─ job-a/
     │  └─ dev/values.yaml
     └─ job-b/
        └─ dev/values.yaml
             │
             ▼
         Walk & Parse
             │
             ▼
     Extract References
        │      │      │
        ▼      ▼      ▼
   secretKeyRef   envFromSecrets   volumeSecret
        │      │      │
        └──────┴──────┘
             │
             ▼
      Build Inventory Records
      (SecretReferenceRecord[])
             │
        ┌────┴────┐
        ▼         ▼
       CSV       JSON
```

## 🧪 Testing

### Run Unit Tests

```bash
npm test -- workload.test.ts
npm test -- yaml-walker.test.ts
```

### Sample Commands for Testing

```bash
# Test with dev environment
npm run secret-references-repo-inventory -- --env dev

# Test with specific output format
npm run secret-references-repo-inventory -- --env dev --format json

# Test with custom directory
npm run secret-references-repo-inventory -- --env qa --output-dir ./qa-audit
```

## 📝 Use Cases

### 1. Identify All Secret Users

```bash
npm run secret-references-repo-inventory -- --env dev --format json | \
  jq '.[] | select(.secretName == "rds-secret")'
```

Lists all workloads using the `rds-secret` secret.

### 2. Find Workloads with envFromSecrets

```bash
npm run secret-references-repo-inventory -- --env dev --format csv | \
  grep "envFromSecrets" | cut -d',' -f3 | sort -u
```

Lists all workloads using `envFromSecrets` pattern.

### 3. Audit Secret Usage

Generate reports for multiple environments:

```bash
for env in dev qa staging prod; do
  npm run secret-references-repo-inventory -- --env $env \
    --output-dir ./audit-$env
done
```

### 4. Cross-Reference with Cluster

Use output with `secret-references-cluster-inventory` and `secret-references-compare` to identify:
- Secrets in repo but not in cluster
- Orphaned secrets in cluster
- Missing AWS annotations

## 🔐 Security Considerations

- **No Secret Values**: This tool never reads or displays actual secret values
- **Local Only**: All analysis happens locally; no external API calls
- **Safe for Audit**: Output is safe to commit to version control (contains only reference paths)
