#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT=""
TARGET_ENV=""
WARNING_ONLY="false"
LEGACY_EXCEPTIONS_FILE=""

info_count=0
warning_count=0
error_count=0
infos=()
warnings=()
issues=()


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
  issues+=("$file_path: $message")
}

report_warning() {
  local file_path="$1"
  local message="$2"
  warning_count=$((warning_count + 1))
  echo "::warning file=${file_path}::${message}"
  # Also store this warning to print it in the summary at the end of the script.
  warnings+=("$file_path: $message")
}

report_info() {
  local file_path="$1"
  local message="$2"
  info_count=$((info_count + 1))
  echo "::info file=${file_path}::${message}"
  # Also store this info to print it in the summary at the end of the script.
  infos+=("$file_path: $message")
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

  if ! command -v yq >/dev/null 2>&1; then
    report_issue "$file_path" "YAML parser not available (install yq)"
    return
  fi

  if ! yq eval '.' "$file_path" >/dev/null 2>&1; then
    report_issue "$file_path" "Malformed YAML"
  fi
}

cd "$REPO_ROOT"

# Check 1: Validate the presence of required directories (commons / microservices / jobs).
if [[ ! -d commons || ! -d microservices || ! -d jobs ]]; then
  report_issue "." "Invalid repository structure: required directories are commons/, microservices/, jobs/"
fi

# Check 2: commons_env_count is the number of environment directories found in commons/. If none are found, report an issue.
commons_env_count=$(find commons -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$commons_env_count" -eq 0 ]; then
  report_issue "commons" "No environments found in commons/"
fi

# These files should be present in commons/<target_env> directory. (TO VERIFY: If this is not the case, we can remove this check.)
required_commons_files=(
  "values-microservice.yaml"
  "values-cronjob.yaml"
  "images.yaml"
  "Chart.yaml"
)

# Check 3: Validate the presence of the commons/<target_env> directory.
env_dir="commons/$TARGET_ENV"
if [[ ! -d "$env_dir" ]]; then
  report_issue "$env_dir" "Missing commons environment directory"
else
  # Check 4: Validate mandatory files for the selected commons target env.
  for required_file in "${required_commons_files[@]}"; do
    required_path="$env_dir/$required_file"
    if [[ ! -f "$required_path" ]]; then
      if ! is_legacy_exception "$required_path"; then
        report_issue "$required_path" "Missing required file"
      fi
      continue
    fi
    # Check 5: Validate that the mandatory files are not empty.
    validate_yaml "$required_path"
  done

  # Check 6: Configmaps directory is mandatory for commons/<target_env> and must not be empty. (TO VERIFY: If this is not the case, we can remove this check.)
  if [[ ! -d "$env_dir/configmaps" ]]; then
    configmaps_path="$env_dir/configmaps"
    if ! is_legacy_exception "$configmaps_path"; then
      report_issue "$configmaps_path" "Missing required directory"
    fi
  fi
fi

validate_workload_group() {
  local group_dir="$1"

  if [[ ! -d "$group_dir" ]]; then
    report_issue "$group_dir" "Missing workload directory"
    return
  fi

  for workload_dir in $(find "$group_dir" -mindepth 1 -maxdepth 1 -type d | sort); do
    env_dir="$workload_dir/$TARGET_ENV"

    # For each workload, missing target env directory is a non-blocking info.
    if [[ ! -d "$env_dir" ]]; then
      report_info "$env_dir" "Missing environment directory for workload $workload_dir"
      continue
    fi

    # values.yaml is mandatory and must not be empty.
    values_path="$env_dir/values.yaml"
    if [[ ! -f "$values_path" ]]; then
      report_issue "$values_path" "Missing required file"
      continue
    fi

    if [[ ! -s "$values_path" ]]; then
      report_issue "$values_path" "Empty values.yaml file"
      continue
    fi

    # Validate that the values.yaml file is a valid YAML file.
    validate_yaml "$values_path"
  done
}

# Check 7: Validate the presence of required workload directories (microservices / jobs) and their target env subdirectories.
validate_workload_group "microservices"
validate_workload_group "jobs"

# todo argocd 


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
    echo ""

    # Print the list of issues if any
    if [[ ${#issues[@]} -gt 0 ]]; then
      echo "#### Issues:"
      for issue in "${issues[@]}"; do
        echo "- $issue"
      done
    fi
    # Print the list of warnings if any
    if [[ ${#warnings[@]} -gt 0 ]]; then
      echo "#### Warnings:"
      for warning in "${warnings[@]}"; do
        echo "- $warning"
      done
    fi
    # Print the list of info if any
    if [[ ${#infos[@]} -gt 0 ]]; then
      echo "#### Info:"
      for info in "${infos[@]}"; do
        echo "- $info"
      done
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [[ "$WARNING_ONLY" == "false" && $error_count -gt 0 ]]; then
  exit 1
fi

exit 0
