# ApplicationSet Configuration - Environment-Specific Microservices

## Problem Statement

The original ApplicationSet configuration was generating Applications for **all microservices** found in the `microservices/` directory, regardless of whether they had configuration files for the target environment.

This caused issues when:
- A microservice didn't have configuration for a specific environment (e.g., `dev-experimental-argocd-interop-apps-post-sync-hook`)
- The deployment would fail or create incomplete Applications
- Applications were generated even when no environment-specific configuration existed

## Initial Approach (Not Working)

The original configuration used a wildcard pattern that matched all microservice directories:

```yaml
- git:
    repoURL: https://github.com/pagopa/interop-core-deployment.git
    revision: feature/argocd
    pathParamPrefix: ms
    directories:
    - path: microservices/*
```

**Why it didn't work:**
- This pattern matches **all** subdirectories under `microservices/`
- It generates an Application for every microservice, regardless of environment availability
- `.ms.path.basename` returns the microservice name (e.g., `agreement-process`)
- No validation that `microservices/<service>/<environment>` exists

## Solution Implemented

The configuration now uses an environment-aware pattern:

```yaml
- git:
    repoURL: https://github.com/pagopa/interop-core-deployment.git
    revision: feature/argocd
    pathParamPrefix: ms
    directories:
    - path: microservices/*/{{.env}}
```

**How it works:**
1. The pattern `microservices/*/{{.env}}` only matches directories where the environment folder exists
2. For environment `dev-experimental-argocd-interop-apps-post-sync-hook`, it matches:
   - `microservices/agreement-process/dev-experimental-argocd-interop-apps-post-sync-hook/` ✓
   - `microservices/catalog-process/dev-experimental-argocd-interop-apps-post-sync-hook/` ✓
   - But NOT `microservices/some-service/` if it lacks the environment folder ✗

3. **Extracting the microservice name:**
   - `.ms.path.path` contains the full path: `microservices/<service>/<env>`
   - `.ms.path.basename` now contains the environment name (last directory)
   - To get the service name, we use: `{{ base (dir .ms.path.path) }}`
     - `dir .ms.path.path` → removes the last segment → `microservices/<service>`
     - `base` → extracts the last segment → `<service>`

## Template Changes

### Before:
```yaml
name: '{{.ms.path.basename}}-post-sync-hook'
# ...
- name: SERVICE
  value: '{{.ms.path.basename}}'
```

### After:
```yaml
name: '{{ base (dir .ms.path.path) }}-post-sync-hook'
# ...
- name: SERVICE
  value: '{{ base (dir .ms.path.path) }}'
```

## Understanding the Data Structure

When using `pathParamPrefix: ms`, the `.ms` variable is a **map** with these fields:
- `.ms.path.path` - full directory path (string)
- `.ms.path.basename` - last directory name (string)
- `.ms.path[0]`, `.ms.path[1]`, etc. - path segments (array access)

For `path: microservices/*/{{.env}}`:
- `.ms.path.path` = `microservices/agreement-process/dev-experimental-argocd-interop-apps-post-sync-hook`
- `.ms.path.basename` = `dev-experimental-argocd-interop-apps-post-sync-hook`
- `.ms.path[1]` = `agreement-process`

## Benefits

✅ Applications are only created for microservices with environment-specific configuration  
✅ Prevents deployment failures from missing configuration  
✅ Cleaner ArgoCD application list  
✅ Automatic filtering based on directory structure  

---

## 📝 TODO: Apply to Other ApplicationSets

**IMPORTANT:** This same pattern should be applied to other ApplicationSet configurations in this repository to ensure consistent behavior across all environments.

Check and update:
- `/argocd/dev/microservices-appset.yaml`
- `/argocd/dev-experimental-argocd-default/microservices-appset.yaml`
- `/argocd/dev-experimental-argocd-interop/microservices-appset.yaml`
- `/argocd/prod/microservices-appset.yaml`
- `/argocd/qa/microservices-appset.yaml`
- `/argocd/test/microservices-appset.yaml`
- Any other ApplicationSet files using the `microservices/*` pattern

Apply the same transformation:
1. Change `path: microservices/*` to `path: microservices/*/{{.env}}`
2. Replace `.ms.path.basename` with `{{ base (dir .ms.path.path) }}`
