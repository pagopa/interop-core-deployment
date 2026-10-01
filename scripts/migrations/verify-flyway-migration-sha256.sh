#!/usr/bin/env bash

case "${BASH##*/}:${BASH_VERSION:-}" in
  sh:*|:*) exec bash "$0" "$@" ;;
esac

set -euo pipefail

usage() {
  cat <<'EOF'
Compare SHA-256 hashes of migrations in ConfigMaps and generated values.

Usage:
  verify-flyway-migration-sha256.sh --root <project_root> --environment <environment>

Options:
  -r, --root         Absolute path to the project root.
  -e, --environment  Target environment under commons/<environment>.
  -h, --help         Show this help message.

Requirements:
  bash, yq v4 (mikefarah/yq), openssl (SHA-256), and standard Unix tools
  (find, sort, grep, awk, mktemp).

Expected layout under <project_root>:
  commons/<environment>/configmaps/flyway*.yaml (or flyway*.yml)
  commons/<environment>/migrations/<metadata.name>.yaml
  Each source must be a ConfigMap with metadata.name and a nonempty data
  mapping of SQL migration names to strings. The matching target must
  contain migrations.<metadata.name> with the same keys and SQL values.

Example:
  scripts/migrations/verify-flyway-migration-sha256.sh --root "$(pwd)" --environment dev
EOF
}

fail() {
  echo "ERROR - $*" >&2
  exit 1
}

report_error() {
  printf 'ERROR - %s\n' "$*" >> "$error_log"
}

sha256() {
  openssl dgst -sha256 | awk '{print $NF}'
}

project_root=""
environment=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--root)
      [[ $# -ge 2 && "$2" != -* ]] || fail "Missing value for $1."
      project_root="$2"
      shift 2
      ;;
    -e|--environment)
      [[ $# -ge 2 && "$2" != -* ]] || fail "Missing value for $1."
      environment="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option '$1'."
      ;;
  esac
done

# Validate required inputs
[[ -n "$project_root" ]] || fail "Project root is required (use --root)."
[[ "$project_root" == /* && -d "$project_root" ]] || fail "Project root must be an existing absolute directory: $project_root"

[[ -n "$environment" ]] || fail "Target environment is required (use --environment)."
[[ "$environment" != */* && "$environment" != "." && "$environment" != ".." ]] || fail "Invalid environment: $environment"

# Validate required commands
command -v yq >/dev/null 2>&1 || fail "Required command 'yq' was not found."
command -v openssl >/dev/null 2>&1 || fail "Required command 'openssl' was not found."

# Validate required directories
repo_root=$(cd "$project_root" && pwd)
configmaps_dir="$repo_root/commons/$environment/configmaps"
migrations_dir="$repo_root/commons/$environment/migrations"
[[ -d "$configmaps_dir" ]] || fail "ConfigMap directory not found: $configmaps_dir"
[[ -d "$migrations_dir" ]] || fail "Migration directory not found: $migrations_dir"

# Create temporary directory for intermediate files and set up cleanup trap
temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT
error_log="$temporary_dir/errors.log"

examined_files=0
checked_migrations=0
errors=0

while IFS= read -r -d '' configmap_file; do
  examined_files=$((examined_files + 1))
  kind=$(yq eval -r '.kind // ""' "$configmap_file")
  configmap_name=$(yq eval -r '.metadata.name // ""' "$configmap_file")

  # Checks done:
  # - The kind must be "ConfigMap".
  # - The metadata.name must be non-empty and not contain slashes or be "." or "..".
  if [[ "$kind" != "ConfigMap" || -z "$configmap_name" || "$configmap_name" == */* || "$configmap_name" == "." || "$configmap_name" == ".." ]]; then
    report_error "Invalid ConfigMap kind or metadata.name in ${configmap_file#$repo_root/}."
    errors=$((errors + 1))
    continue
  fi

  if [[ -e "$temporary_dir/$configmap_name" ]]; then
    report_error "Duplicate source ConfigMap metadata.name '$configmap_name'."
    errors=$((errors + 1))
    continue
  fi
  # Create an empty file in the temporary directory to track this ConfigMap name and detect duplicates.
  touch "$temporary_dir/$configmap_name"

  migration_file="$migrations_dir/$configmap_name.yaml"
  if [[ ! -f "$migration_file" ]]; then
    report_error "Missing generated file: ${migration_file#$repo_root/}"
    errors=$((errors + 1))
    continue
  fi
 
  # Determine the types of the source data and the target migration to ensure they are both mappings.
  source_type=$(yq eval -r '.data | type' "$configmap_file")
  target_type=$(CONFIGMAP_NAME="$configmap_name" yq eval -r '.migrations[strenv(CONFIGMAP_NAME)] | type' "$migration_file")
  if [[ "$source_type" != "!!map" || "$target_type" != "!!map" ]]; then
    report_error "$configmap_name: source data and generated migrations must be YAML mappings."
    errors=$((errors + 1))
    continue
  fi

  # Extract the keys from the source data and the target migration for comparison.
  source_keys="$temporary_dir/source-keys"
  target_keys="$temporary_dir/target-keys"
  yq eval -r '.data | keys | .[]' "$configmap_file" | sort > "$source_keys"
  CONFIGMAP_NAME="$configmap_name" yq eval -r '.migrations[strenv(CONFIGMAP_NAME)] | keys | .[]' "$migration_file" | sort > "$target_keys"

  # -s return true if FILE exists and has a size greater than zero.
  if [[ ! -s "$source_keys" ]]; then
    report_error "$configmap_name: no migrations in source data."
    errors=$((errors + 1))
    continue
  fi
 
  # Iterate over each migration key in the source data and verify it against the target migration for existence, type, and SHA-256 hash.
  while IFS= read -r migration_name; do
    if ! grep -Fqx -- "$migration_name" "$target_keys"; then
      report_error "$configmap_name: missing migration '$migration_name'."
      errors=$((errors + 1))
      continue
    fi

    source_type=$(MIGRATION_NAME="$migration_name" yq eval -r '.data[strenv(MIGRATION_NAME)] | type' "$configmap_file")
    target_type=$(CONFIGMAP_NAME="$configmap_name" MIGRATION_NAME="$migration_name" \
      yq eval -r '.migrations[strenv(CONFIGMAP_NAME)][strenv(MIGRATION_NAME)] | type' "$migration_file")
    if [[ "$source_type" != "!!str" || "$target_type" != "!!str" ]]; then
      report_error "$configmap_name/$migration_name: both migration values must be strings."
      errors=$((errors + 1))
      continue
    fi

    source_hash=$(MIGRATION_NAME="$migration_name" yq eval -r '.data[strenv(MIGRATION_NAME)]' "$configmap_file" | sha256)
    target_hash=$(CONFIGMAP_NAME="$configmap_name" MIGRATION_NAME="$migration_name" \
      yq eval -r '.migrations[strenv(CONFIGMAP_NAME)][strenv(MIGRATION_NAME)]' "$migration_file" | sha256)
    checked_migrations=$((checked_migrations + 1))

    if [[ "$source_hash" != "$target_hash" ]]; then
      report_error "$configmap_name/$migration_name: SHA-256 mismatch (source=$source_hash, generated=$target_hash)."
      errors=$((errors + 1))
    else
      echo "MATCH - $configmap_name/$migration_name sha256=$source_hash"
    fi
  done < "$source_keys"
 
  # Iterate over each migration key in the target migration and check if it exists in the source data.
  while IFS= read -r migration_name; do
    if ! grep -Fqx -- "$migration_name" "$source_keys"; then
      report_error "$configmap_name: unexpected migration '$migration_name'."
      errors=$((errors + 1))
    fi
  done < "$target_keys"
done < <(
  find "$configmaps_dir" -maxdepth 1 -type f \
    \( -name 'flyway*.yaml' -o -name 'flyway*.yml' \) -print0 | sort -z
)

if [[ "$examined_files" -eq 0 ]]; then
  report_error "No flyway ConfigMaps found in $configmaps_dir."
  errors=$((errors + 1))
fi

echo "SUMMARY - $examined_files ConfigMap(s), $checked_migrations migration(s) compared, $errors error(s)." >&2
if [[ "$errors" -gt 0 ]]; then
  echo "Errors found:" >&2
  cat "$error_log" >&2
  echo "FAILED - Verification completed with $errors error(s)." >&2
  exit 1
fi

echo "SUCCESS - Verified $checked_migrations SHA-256 hashes in $examined_files ConfigMap(s) for environment '$environment'."