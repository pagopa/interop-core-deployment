#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT=""
TARGET_ENV=""
WARNING_ONLY="false"
LEGACY_EXCEPTIONS_FILE=""

error_count=0
warning_count=0

usage() {
  cat <<'EOF'
Usage: validate-repo-structure.sh [options]

Options:
  --repo-root <path>                 Repository root (required)
  --target-env <env>                 Validate a single environment (required)
  --warning-only                     Report issues as warnings without failing
  --legacy-exceptions-file <path>    File with allowed missing paths, one per line
  --help                             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --target-env)
      TARGET_ENV="$2"
      shift 2
      ;;
    --warning-only)
      WARNING_ONLY="true"
      shift
      ;;
    --legacy-exceptions-file)
      LEGACY_EXCEPTIONS_FILE="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$REPO_ROOT" ]]; then
  echo "Missing required argument: --repo-root"
  usage
  exit 2
fi

if [[ -z "$TARGET_ENV" ]]; then
  echo "Missing required argument: --target-env"
  usage
  exit 2
fi

trim() {
  local value="$1"
  value="${value#${value%%[![:space:]]*}}"
  value="${value%${value##*[![:space:]]}}"
  echo "$value"
}

contains_value() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

annotation_level() {
  if [[ "$WARNING_ONLY" == "true" ]]; then
    echo "warning"
  else
    echo "error"
  fi
}

report_issue() {
  local file_path="$1"
  local message="$2"
  local level
  level="$(annotation_level)"

  if [[ "$level" == "error" ]]; then
    error_count=$((error_count + 1))
  else
    warning_count=$((warning_count + 1))
  fi

  echo "::${level} file=${file_path}::${message}"
}

report_warning() {
  local file_path="$1"
  local message="$2"
  warning_count=$((warning_count + 1))
  echo "::warning file=${file_path}::${message}"
}

declare -a legacy_exceptions
if [[ -n "$LEGACY_EXCEPTIONS_FILE" && -f "$LEGACY_EXCEPTIONS_FILE" ]]; then
  while IFS= read -r line; do
    line="$(trim "$line")"
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi
    legacy_exceptions+=("$line")
  done < "$LEGACY_EXCEPTIONS_FILE"
fi

is_legacy_exception() {
  local candidate="$1"
  contains_value "$candidate" "${legacy_exceptions[@]:-}"
}

validate_yaml() {
  local file_path="$1"

  if command -v ruby >/dev/null 2>&1; then
    if ! ruby -e 'require "yaml"; YAML.parse(File.read(ARGV[0]))' "$file_path" >/dev/null 2>&1; then
      report_issue "$file_path" "YAML malformato"
    fi
    return
  fi

  if command -v yq >/dev/null 2>&1; then
    if ! yq eval '.' "$file_path" >/dev/null 2>&1; then
      report_issue "$file_path" "YAML malformato"
    fi
    return
  fi

  report_issue "$file_path" "Parser YAML non disponibile (installare ruby o yq)"
}

cd "$REPO_ROOT"

if [[ ! -d commons || ! -d microservices || ! -d jobs ]]; then
  report_issue "." "Struttura repo non valida: richieste cartelle commons/, microservices/, jobs/"
fi

mapfile -t commons_envs < <(find commons -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)

if [[ ${#commons_envs[@]} -eq 0 ]]; then
  report_issue "commons" "Nessun ambiente trovato in commons/"
fi

required_commons_files=(
  "values-microservice.yaml"
  "values-cronjob.yaml"
  "images.yaml"
  "Chart.yaml"
)

# Validate mandatory files for the selected commons target env.
env_dir="commons/$TARGET_ENV"
if [[ ! -d "$env_dir" ]]; then
  report_issue "$env_dir" "Cartella ambiente commons mancante"
else
  for required_file in "${required_commons_files[@]}"; do
    required_path="$env_dir/$required_file"
    if [[ ! -f "$required_path" ]]; then
      if ! is_legacy_exception "$required_path"; then
        report_issue "$required_path" "File obbligatorio mancante"
      fi
      continue
    fi
    validate_yaml "$required_path"
  done

  if [[ ! -d "$env_dir/configmaps" ]]; then
    configmaps_path="$env_dir/configmaps"
    if ! is_legacy_exception "$configmaps_path"; then
      report_issue "$configmaps_path" "Directory obbligatoria mancante"
    fi
  fi
fi

validate_workload_group() {
  local group_dir="$1"

  if [[ ! -d "$group_dir" ]]; then
    report_issue "$group_dir" "Directory workload mancante"
    return
  fi

  mapfile -t workloads < <(find "$group_dir" -mindepth 1 -maxdepth 1 -type d | sort)

  local workload_dir
  for workload_dir in "${workloads[@]}"; do
    env_dir="$workload_dir/$TARGET_ENV"

    # For each workload, missing target env directory is a non-blocking warning.
    if [[ ! -d "$env_dir" ]]; then
      report_warning "$env_dir" "Directory ambiente mancante per workload"
      continue
    fi

    # values.yaml is mandatory and must not be empty.
    values_path="$env_dir/values.yaml"
    if [[ ! -f "$values_path" ]]; then
      report_issue "$values_path" "File obbligatorio mancante"
      continue
    fi

    if [[ ! -s "$values_path" ]]; then
      report_issue "$values_path" "File values.yaml vuoto"
      continue
    fi

    validate_yaml "$values_path"
  done
}

validate_workload_group "microservices"
validate_workload_group "jobs"

summary_msg="Repo structure validation completed. errors=$error_count warnings=$warning_count target_env=$TARGET_ENV"
echo "$summary_msg"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Repo Structure Validation"
    echo
    echo "- target_env: $TARGET_ENV"
    echo "- errors: $error_count"
    echo "- warnings: $warning_count"
    echo "- warning_only: $WARNING_ONLY"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [[ "$WARNING_ONLY" == "false" && $error_count -gt 0 ]]; then
  exit 1
fi

exit 0
