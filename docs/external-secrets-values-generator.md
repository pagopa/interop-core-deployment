# External Secrets Values Generator

Automated tool for generating `externalSecrets` configuration in Helm values.yaml files by combining repository inventory with live Kubernetes cluster annotations.

## 🎯 Overview

This tool automates the migration of secret references to ExternalSecrets operator by:

1. **Scanning Repository**: Extracts all secret references from Helm values.yaml files
2. **Querying Cluster**: Fetches AWS Secrets Manager annotations from live K8s secrets
3. **Generating Config**: Creates `externalSecrets` entries mapped to AWS SM paths
4. **Applying Changes**: Merges configuration into workload values.yaml files
5. **Reporting**: Generates detailed migration reports with skipped secrets

## 📋 Prerequisites

- Node.js ≥ 20.0.0
- `kubectl` configured with access to target cluster
- Current kubeconfig with valid context
- `interop` namespace accessible in target cluster

## 🚀 Installation

```bash
# Install dependencies (already in package.json)
npm install

# Build TypeScript
npm run build:secret-references
```

## 💻 Usage

### Basic Syntax

```bash
npm run secret-references-external-secrets-generator -- \
  --env <environment> \
  [--scope microservice|cronjob|both] \
  [--keep-old-refs true|false] \
  [--validate-helm true|false] \
  [--dry-run] \
  [--output-dir <path>]
```

### Command-Line Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--env` | ✅ Yes | - | Environment name (dev, qa, prod, etc.) |
| `--scope` | ❌ No | `both` | Workload scope: `microservice`, `cronjob`, or `both` |
| `--keep-old-refs` | ❌ No | `false` | Keep old `envFromSecrets` references in values |
| `--validate-helm` | ❌ No | `true` | Validate generated configs with `helm template` |
| `--dry-run` | ❌ No | `false` | Preview changes without modifying files |
| `--output-dir` | ❌ No | `./external-secrets-analysis` | Report output directory |

### Examples

#### 1. Dry-Run Preview (Recommended First Step)

```bash
npm run secret-references-external-secrets-generator -- --env dev --dry-run
```

**Output**: Shows what would happen without modifying any files
- Lists workloads that would be migrated
- Shows skipped secrets and reasons
- Displays potential errors

#### 2. Generate for Microservices Only

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --scope microservice
```

**Output**: 
- Updates microservice values.yaml files with `externalSecrets` config
- Creates backup files (`.backup.ISO-TIMESTAMP`)
- Generates migration report

#### 3. Generate for All Workloads and Clean Up Old References

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --scope both \
  --keep-old-refs false
```

**Output**:
- Updates all workload values.yaml files
- Removes old `envFromSecrets` entries
- Creates comprehensive migration report

#### 4. Generate for Cronjobs Only with Validation

```bash
npm run secret-references-external-secrets-generator -- \
  --env dev \
  --scope cronjob \
  --validate-helm true
```

**Output**:
- Updates cronjob values.yaml files
- Validates with `helm template`
- Reports validation errors if any

## 📊 Output

### Console Output

```
🚀 Starting External Secrets Values Generator...

📋 Configuration:
   Environment: dev
   Scope: both
   Keep old refs: false
   Validate Helm: true
   Dry run: false

📂 Scanning repository for secret references...
   Found 145 secret references across 23 workloads

🔗 Connecting to Kubernetes cluster...
   Found 18 secrets in cluster

⚙️  Generating ExternalSecrets configuration...
   Generated 21 ExternalSecrets configurations
   Skipped 8 secret references

💾 Applying configurations to values.yaml files...
   ✅ microservice/email-digest-dispatcher (container)
   ✅ microservice/token-generation (initContainer)
   ⚠️  Job reference in commons (no workload-specific values)
   ...

📊 Migration Summary:
   Total workloads: 23
   Migrated: 21
   Failed: 0
   Total secret references: 145
   ExternalSecrets created: 21
   Skipped secrets: 8

=== SKIPPED SECRETS (requiring manual review) ===

microservice/email-digest-dispatcher:
  - Secret: legacy-config
    Reason: no-aws-annotation
    Details: Secret 'legacy-config' does not have AWS Secrets Manager annotation

💾 Report saved to: external-secrets-analysis/external-secrets-migration-dev.json

✨ External Secrets generation complete!
```

### Migration Report (JSON)

**Location**: `external-secrets-analysis/external-secrets-migration-<env>.json`

```json
{
  "environment": "dev",
  "scope": "both",
  "totalWorkloads": 23,
  "migratedWorkloads": 21,
  "skippedWorkloads": 0,
  "totalSecretsProcessed": 145,
  "successfulMigrations": 21,
  "skippedSecrets": [
    {
      "workloadType": "microservice",
      "workloadName": "email-digest-dispatcher",
      "secretName": "legacy-config",
      "reason": "no-aws-annotation",
      "details": "Secret 'legacy-config' does not have AWS Secrets Manager annotation"
    }
  ],
  "errors": [],
  "generatedExternalSecrets": [
    {
      "workloadType": "microservice",
      "workloadName": "email-digest-dispatcher",
      "workloadPath": "microservices/email-digest-dispatcher/dev/values.yaml",
      "containerType": "container",
      "secretName": "email-digest-dispatcher",
      "externalSecretsConfig": {
        "create": true,
        "secretStoreRef": {
          "name": "aws-secretsmanager",
          "kind": "ClusterSecretStore"
        },
        "targetSecret": {
          "name": "email-digest-dispatcher",
          "creationPolicy": "Owner",
          "deletionPolicy": "Retain"
        },
        "data": [
          {
            "secretKey": "DIGEST_TRACKING_DB_PASSWORD",
            "remoteRef": {
              "key": "rds/interop-platform-data-dev/users/email_digest_dispatcher_user",
              "property": "password",
              "version": "uuid/terraform-20260212133048976200000002"
            }
          }
        ]
      }
    }
  ]
}
```

## 🔄 Data Flow

```
┌─────────────────────────────────┐
│   Repository Values Files       │
│   (microservices/*/dev/*.yaml)  │
└──────────────┬──────────────────┘
               │
               ├─→ Walk workloads
               │
               ├─→ Extract secret references
               │   - env var name
               │   - secret name
               │   - secret key
               │
               ▼
┌─────────────────────────────────┐
│   Repo Inventory                │
│   (SecretReferenceRecord[])     │
└──────────────┬──────────────────┘
               │
               │
               ▼
┌─────────────────────────────────┐
│   Kubernetes Cluster API        │
│   → List all Secrets            │
│   → Extract annotations:        │
│     - aws-secretsmanager-id     │
│     - aws-secretsmanager-version│
└──────────────┬──────────────────┘
               │
               ├─→ Fetch from cluster
               │
               ├─→ Build inventory
               │
               ▼
┌─────────────────────────────────┐
│   Cluster Secrets Map           │
│   (SecretInventoryRecord[])     │
└──────────────┬──────────────────┘
               │
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    Merge            Report
    ────────────────────────
    Group by:      Skipped:
    - Workload    - No AWS
    - Container     annotation
    - Secret      - Errors
        │             │
        │             ▼
        │         Skip Report
        │         (JSON)
        │
        ▼
   Generate
   RemoteRef
   (AWS SM path)
        │
        ▼
   Build
   ExternalSecrets
   Config
        │
        ▼
   Merge into
   values.yaml
   (YAML merge)
        │
        ▼
   Updated
   values.yaml
   files
```

## 🏗️ Architecture

### Core Components

1. **`external-secrets-generator.ts`**
   - Groups repository inventory by workload
   - Builds RemoteRef from cluster annotations
   - Generates ExternalSecrets configuration

2. **`values-yaml-patcher.ts`**
   - YAML file I/O with structure preservation
   - Deep merge of configuration objects
   - Backup creation before modification
   - Optional old reference removal

3. **`secret-references-external-secrets-generator.ts`**
   - CLI argument parsing
   - Orchestration of data flow
   - Error handling and reporting
   - File application and backup

### Data Types

```typescript
// Input: Repository inventory
SecretReferenceRecord {
  environment: string;
  workloadType: 'microservice' | 'cronjob';
  component: string;
  secretName: string;
  secretKey: string;
  envVar: string;
  // ...
}

// Input: Cluster inventory
SecretInventoryRecord {
  secretName: string;
  keys: string[];
  annotations: {
    'infra.interop.pagopa.it/aws-secretsmanager-secret-id': string;
    'infra.interop.pagopa.it/aws-secretsmanager-version-id': string;
    // ...
  };
  // ...
}

// Output: Generated configuration
ExternalSecretsConfig {
  container?: ContainerExternalSecretsConfig;
  initContainer?: ContainerExternalSecretsConfig;
}

// Structure of generated data
// Note: secretStoreRef and targetSecret are inherited from commons template
// Generator only outputs: create flag and data array
ContainerExternalSecretsConfig {
  create: boolean;
  data: Array<{
    secretKey: string;   // env variable name (e.g., 'READMODEL_DB_USERNAME')
    remoteRef: {
      key: string;       // AWS SM path (from annotation)
      property: string;  // Key within AWS secret (e.g., 'READONLY_USR')
      version?: string;  // Optional version ID
    };
  }>;
}
```

## 🔍 Secret Mapping Logic

### EnvVar → SecretKey → RemoteRef Mapping

The generator preserves the complete mapping between environment variables and remote secret keys:

```yaml
# Original in values.yaml
envFromSecrets:
  READMODEL_DB_USERNAME: "read-model.READONLY_USR"
  READMODEL_DB_PASSWORD: "read-model.READONLY_PSW"

# Generated in externalSecrets
externalSecrets:
  container:
    data:
      - secretKey: READMODEL_DB_USERNAME      # ← env variable name preserved
        remoteRef:
          key: app/backend/read-model         # ← AWS SM path from annotation
          property: READONLY_USR              # ← actual key in AWS secret
      
      - secretKey: READMODEL_DB_PASSWORD      # ← env variable name preserved
        remoteRef:
          key: app/backend/read-model
          property: READONLY_PSW
```

**Mapping Flow**:
1. `secretKey`: Name of the environment variable (e.g., `READMODEL_DB_USERNAME`)
2. `remoteRef.key`: AWS Secrets Manager path (from cluster annotation)
3. `remoteRef.property`: Actual key within the AWS secret (e.g., `READONLY_USR`)

This preserves the original variable names while mapping to the actual AWS secret location.

### Matching Records from Repo to Cluster

1. **Repo Record**: Specifies `envVar`, `secretName` and `secretKey`
2. **Cluster Lookup**: Find K8s Secret with matching `metadata.name`
3. **Annotation Extraction**:
   - `infra.interop.pagopa.it/aws-secretsmanager-secret-id` → RemoteRef.key
   - `infra.interop.pagopa.it/aws-secretsmanager-version-id` → RemoteRef.version
4. **Build RemoteRef**: Combine AWS path + secret property + version

### Skipping Logic

Secrets are skipped and reported if:
- **No AWS Annotation**: Cluster Secret lacks `aws-secretsmanager-secret-id`
- **Missing Key**: Secret key in repo not found in cluster (indicates cleanup needed)
- **Annotation Error**: Annotation value is malformed or empty

Skipped secrets require manual review and potential:
- Addition of AWS annotations to cluster Secret
- Manual migration to ExternalSecrets
- Cleanup of stale references

## 📍 Positioning in values.yaml

The `externalSecrets` block is automatically positioned **before** the main workload section:

- **Microservices**: Inserted before `deployment:` key with blank line spacing
- **Cronjobs**: Inserted before `cronjob:` key with blank line spacing

Example:
```yaml
name: "test-app"
serviceAccount:
  name: "test-sa"

externalSecrets:           # ← Inserted here with blank line before
  container:
    create: true
    data: [...]

deployment:                # ← Blank line after externalSecrets
  replicas: 3
```



## 🛡️ Safety Features

1. **Backup Creation**: Every modified values.yaml gets `.backup.ISO-TIMESTAMP` backup
2. **Dry-Run Mode**: Preview all changes without modifying files
3. **Error Reporting**: Detailed logs of failures and skipped items
4. **YAML Preservation**: Deep merge maintains YAML structure and formatting
5. **Atomic Operations**: Each file operation is atomic to prevent partial updates

## 🧪 Testing

### Run Unit Tests

```bash
npm test
```

### Run Specific Test Suite

```bash
npm test -- external-secrets-generator.test.ts
npm test -- values-yaml-patcher.test.ts
```

### Test Coverage

- **external-secrets-generator.test.ts**: 12 tests
  - Grouping logic
  - RemoteRef building
  - Config generation
  - End-to-end scenarios

- **values-yaml-patcher.test.ts**: 16 tests
  - YAML read/write
  - Config merging
  - Reference removal
  - Dry-run mode
  - Error handling

**Current Status**: All 150 tests passing ✅

## 🐛 Troubleshooting

### Error: "Cannot access cluster context"

```
Error: Cannot access cluster context "default" namespace "interop". Verify kubeconfig.
```

**Solution**:
```bash
# Verify kubeconfig
kubectl config current-context
kubectl config get-contexts

# Check cluster access
kubectl get secrets -n interop
```

### Error: "No workloads found for environment"

```
Error: No workloads found for environment "staging" and scope "both"
```

**Solution**:
- Verify environment name matches directory structure:
  - `microservices/*/staging/values.yaml`
  - `jobs/*/staging/values.yaml`
- Check path traversal with:
  ```bash
  npm run secret-references-repo-inventory -- --env staging
  ```

### Skipped Secrets Report

If many secrets are skipped:

1. **Check annotations** on cluster Secrets:
   ```bash
   kubectl get secrets -n interop -o yaml | grep aws-secretsmanager-secret-id
   ```

2. **Add missing annotations** before re-running:
   ```bash
   kubectl patch secret my-secret -n interop -p \
     '{"metadata":{"annotations":{"infra.interop.pagopa.it/aws-secretsmanager-secret-id":"path/to/secret"}}}'
   ```

### YAML Merge Issues

If generated config isn't appearing in values.yaml:

1. **Check file permissions**: Ensure write access to values files
2. **Validate YAML**: Run through `yamllint`:
   ```bash
   yamllint microservices/*/dev/values.yaml
   ```
3. **Review backup**: Check `.backup.*` file to see original state

## 🔐 Security Considerations

1. **AWS Credentials**: Uses kubeconfig context (no additional credentials needed)
2. **Secret Values**: Never reads or displays actual secret values
3. **Backup Files**: Created in same directory as originals (ensure secure location)
4. **Report Files**: Contain structure but not values; treat as internal documentation

## 📝 Related Scripts

- **Repo Inventory**: `npm run secret-references-repo-inventory -- --env <env>`
- **Cluster Inventory**: `npm run secret-references-cluster-inventory -- --env <env>`
- **Compare**: `npm run secret-references-compare`
