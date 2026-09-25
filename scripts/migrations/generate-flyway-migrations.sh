#!/usr/bin/bash

set -euo pipefail

usage() {
  cat <<'EOF'
Generate Flyway migration values from Kubernetes ConfigMaps.

Usage:
  generate-flyway-migrations.sh -e|--environment <environment>

Options:
  -e, --environment  Target environment under commons/<environment>.
  -p, --prune        Remove values.yaml files from the target migrations directory that do not have corresponding ConfigMaps.
  -h, --help         Show this help message.

Examples:
  scripts/migrations/generate-flyway-migrations.sh --environment dev
EOF
}

fail() {
  echo "ERROR - $*" >&2
  exit 1
}

warn_exit() {
  echo "WARN - $*" >&2
  exit 0
}

environment=""
prune=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--environment)
      [[ $# -ge 2 ]] || fail "Missing value for $1."
      environment="$2"
      shift 2
      ;;
    -p|--prune)
      prune=true
      shift
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

[[ -n "$environment" ]] || {
  usage >&2
  fail "Target environment is required."
}

command -v yq >/dev/null 2>&1 || fail "Required command 'yq' was not found."

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)

commons_dir="$repo_root/commons/$environment"
configmaps_dir="$commons_dir/configmaps"
migrations_dir="$commons_dir/migrations"

[[ -d "$commons_dir" ]] || warn_exit "Environment directory not found: $commons_dir"
[[ -d "$configmaps_dir" ]] || warn_exit "ConfigMap directory not found: $configmaps_dir"
[[ -n "$(find "$configmaps_dir" -maxdepth 1 -type f -print -quit)" ]] || \
  warn_exit "ConfigMap directory is empty: $configmaps_dir"

temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT

generated_count=0

# Process each ConfigMap file and generate corresponding Flyway migration files.
while IFS= read -r -d '' configmap_file; do
  kind=$(yq eval -r '.kind // ""' "$configmap_file")
  configmap_name=$(yq eval -r '.metadata.name // ""' "$configmap_file")
  data_type=$(yq eval -r '.data | type' "$configmap_file")
  data_length=$(yq eval -r '.data | length' "$configmap_file")

  [[ "$kind" == "ConfigMap" ]] || fail "$configmap_file: expected kind ConfigMap, found '${kind:-<empty>}'."
  [[ -n "$configmap_name" ]] || fail "$configmap_file: metadata.name is required."
  [[ "$data_type" == "!!map" ]] || fail "$configmap_file: data must be a YAML mapping."
  [[ "$data_length" -gt 0 ]] || fail "$configmap_file: data must contain at least one migration."

  output_file="$temporary_dir/$configmap_name.yaml"
  if [[ -f "$output_file" ]]; then
    fail "Duplicate metadata.name '$configmap_name' found while processing '$configmap_file'."
  fi

  # Copy the raw "data:" block text (re-indented).
  data_line=$(grep -n '^data:' "$configmap_file" | head -1 | cut -d: -f1)
  [[ -n "$data_line" ]] || fail "$configmap_file: top-level 'data:' key not found."

  # tail -n "+$((data_line + 1))" starts reading the file from the line after 'data:'.
  {
    echo "migrations:"
    echo "  $configmap_name:"
    tail -n "+$((data_line + 1))" "$configmap_file" | awk '
      /^[^[:space:]]/ && NF { exit }
      NF { print "  " $0; next }
      { print "" }
    '
  } > "$output_file"

  yq eval '.' "$output_file" >/dev/null
  generated_count=$((generated_count + 1))
done < <(
  find "$configmaps_dir" -maxdepth 1 -type f \
    \( -name 'flyway*.yaml' -o -name 'flyway*.yml' \) \
    -print0 | sort -z
)

[[ "$generated_count" -gt 0 ]] || fail "No flyway*.yaml or flyway*.yml ConfigMaps found in $configmaps_dir."

mkdir -p "$migrations_dir"

# Copy generated migration files to the migrations directory, removing any obsolete files.
while IFS= read -r -d '' generated_file; do
  destination_file="$migrations_dir/$(basename "$generated_file")"
  cp "$generated_file" "$destination_file"
  echo "GENERATED - ${destination_file#$repo_root/}"
done < <(find "$temporary_dir" -maxdepth 1 -type f -name '*.yaml' -print0 | sort -z)

if [[ $prune == true ]]; then
  while IFS= read -r -d '' existing_file; do
    filename=$(basename "$existing_file")
    if [[ ! -f "$temporary_dir/$filename" ]]; then
      rm "$existing_file"
      echo "REMOVED UNMATCHED FILE - ${existing_file#$repo_root/}"
    fi
  done < <(
    find "$migrations_dir" -maxdepth 1 -type f \
      \( -name '*.yaml' -o -name '*.yml' \) \
      -print0 | sort -z
  )
fi

echo "DONE - Generated $generated_count Flyway migration file(s) for environment '$environment'."
echo "Configmap dir contains # of 'flyway' files: $(find "$configmaps_dir" -maxdepth 1 -type f -name 'flyway*.yaml' -o -name 'flyway*.yml' | wc -l)"
echo "Migrations dir contains # of files: $(find "$migrations_dir" -maxdepth 1 -type f | wc -l)"