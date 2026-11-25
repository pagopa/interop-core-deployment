#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-refactor.sh <phase> --environment <env> [options]

Phases, in execution order:
  prepare       Run tasks 1-4: inventory, classify, mapping, baseline
  inventory     Run task 1: verify ConfigMap references
  classify      Run task 2: classify ConfigMap keys
  mapping       Run task 3: build the common-values mapping
  baseline      Run task 4: build the current configuration baseline
  build-values  Run task 5: generate values-commons.yaml (requires --apply)
  validate      Run task 6: check values-commons.yaml against the ConfigMaps and their classification
  plan          Optional, run task 7 without changes: show the workload migration plan
  migrate       Optional, run task 7: move COMMON_VALUE references to env in the workload values (requires --apply)
  equivalence   Optional, run task 8 after migrate: compare the rendered workloads with the baseline (requires Helm)

Options:
  --environment, -e  Target environment (required)
  --root, -r         Repository root (default: auto-detected)
  --output-dir, -o   Report directory (default: reports/refactor-common-configmaps)
  --values-file      Common values file (default: commons/<env>/values-commons.yaml)
  --workloads        plan/migrate only: comma-separated workload folder names to migrate (default: all)
  --apply            Authorize migrate and build-values to write repository files
  --help, -h         Show this help

Requires Node.js >= 22.
Review the classification and mapping reports before running build-values and migrate.
Keep the reports of prepare: the baseline must describe the configuration before the migration.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PHASE="${1:-}"

if [[ -z "$PHASE" || "$PHASE" == "--help" || "$PHASE" == "-h" ]]; then
  usage
  exit 0
fi
shift

ROOT="$DEFAULT_ROOT"
ENVIRONMENT=""
OUTPUT_DIR="reports/refactor-common-configmaps"
VALUES_FILE=""
WORKLOADS=""
APPLY=false

while (($#)); do
  case "$1" in
    -e|--environment)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing environment" >&2; exit 2; }
      ENVIRONMENT="$2"
      shift 2
      ;;
    -r|--root)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing repository root" >&2; exit 2; }
      ROOT="$2"
      shift 2
      ;;
    -o|--output-dir)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing report directory" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --values-file)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing values file" >&2; exit 2; }
      VALUES_FILE="$2"
      shift 2
      ;;
    --workloads)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing workloads" >&2; exit 2; }
      WORKLOADS="$2"
      shift 2
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$ENVIRONMENT" ]] || { echo "--environment is required" >&2; exit 2; }
[[ "$ENVIRONMENT" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || {
  echo "Invalid environment: $ENVIRONMENT" >&2
  exit 2
}

ROOT="$(cd "$ROOT" && pwd)"
if [[ "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="$ROOT/$OUTPUT_DIR"
fi
if [[ -z "$VALUES_FILE" ]]; then
  VALUES_FILE="$ROOT/commons/$ENVIRONMENT/values-commons.yaml"
elif [[ "$VALUES_FILE" != /* ]]; then
  VALUES_FILE="$ROOT/$VALUES_FILE"
fi

INVENTORY_JSON="$OUTPUT_DIR/task-1-inventory-$ENVIRONMENT.json"
CLASSIFICATION_CSV="$OUTPUT_DIR/task-2-classification-common-configmaps-$ENVIRONMENT.csv"
CLASSIFICATION_JSON="$OUTPUT_DIR/task-2-classification-common-configmaps-$ENVIRONMENT.json"
MAPPING_JSON="$OUTPUT_DIR/task-3-common-values-mapping-$ENVIRONMENT.json"
BASELINE_CSV="$OUTPUT_DIR/task-4-baseline-$ENVIRONMENT.csv"
BASELINE_JSON="$OUTPUT_DIR/task-4-baseline-$ENVIRONMENT.json"
TASKS_DIR="$SCRIPT_DIR/dist"

case "$PHASE" in
  prepare|inventory|classify|mapping|baseline|build-values|validate|plan|migrate|equivalence) ;;
  *)
    echo "Unknown phase: $PHASE" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "$APPLY" == true && "$PHASE" != "migrate" && "$PHASE" != "build-values" ]]; then
  echo "--apply is only valid with the migrate and build-values phases." >&2
  exit 2
fi
if [[ ( "$PHASE" == "migrate" || "$PHASE" == "build-values" ) && "$APPLY" != true ]]; then
  echo "Phase '$PHASE' writes repository files; rerun with --apply." >&2
  exit 2
fi
if [[ -n "$WORKLOADS" && "$PHASE" != "plan" && "$PHASE" != "migrate" ]]; then
  echo "--workloads is only valid with the plan and migrate phases." >&2
  exit 2
fi

MIN_NODE_MAJOR=22
command -v node >/dev/null || { echo "Node.js >= $MIN_NODE_MAJOR is required but node was not found." >&2; exit 2; }
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" || {
  echo "Node.js >= $MIN_NODE_MAJOR is required; found $(node --version)." >&2
  exit 2
}

(
  cd "$SCRIPT_DIR"
  # Install the pinned dependencies of this package when missing or out of date with package-lock.json.
  if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    npm ci --no-audit --no-fund
  fi
  npm run build
)
cd "$ROOT"

run_task() {
  local script="$1"
  shift
  node "$TASKS_DIR/$script.js" --env "$ENVIRONMENT" --root "$ROOT" "$@"
}

run_inventory() {
  run_task task1-verify --output-dir "$OUTPUT_DIR"
}

run_classification() {
  run_task task2-classify \
    --inventory-json "$INVENTORY_JSON" \
    --output-csv "$CLASSIFICATION_CSV" \
    --output-json "$CLASSIFICATION_JSON" \
    --output-summary-csv "$OUTPUT_DIR/task-2-classification-summary-$ENVIRONMENT.csv" \
    --output-summary-json "$OUTPUT_DIR/task-2-classification-summary-$ENVIRONMENT.json"
}

run_mapping() {
  run_task task3-build-mapping \
    --classification-json "$CLASSIFICATION_JSON" \
    --output-dir "$OUTPUT_DIR"
}

run_baseline() {
  run_task task4-build-baseline \
    --inventory-json "$INVENTORY_JSON" \
    --output-csv "$BASELINE_CSV" \
    --output-json "$BASELINE_JSON"
}

run_build_values() {
  run_task task5-build-common-values \
    --mapping-json "$MAPPING_JSON" \
    --output-yaml "$VALUES_FILE" \
    --output-coverage-csv "$OUTPUT_DIR/task-5-common-values-coverage-$ENVIRONMENT.csv" \
    --output-coverage-json "$OUTPUT_DIR/task-5-common-values-coverage-$ENVIRONMENT.json" \
    --output-coverage-md "$OUTPUT_DIR/task-5-common-values-coverage-$ENVIRONMENT.md"
}

run_validate() {
  run_task task6-validate-common-values \
    --mapping-json "$MAPPING_JSON" \
    --common-values "$VALUES_FILE" \
    --output-csv "$OUTPUT_DIR/task-6-common-values-validation-$ENVIRONMENT.csv" \
    --output-json "$OUTPUT_DIR/task-6-common-values-validation-$ENVIRONMENT.json"
}

run_workload_migration() {
  local args=(
    --mapping-json "$MAPPING_JSON"
    --output-csv "$OUTPUT_DIR/task-7-workload-migration-$ENVIRONMENT.csv"
    --output-json "$OUTPUT_DIR/task-7-workload-migration-$ENVIRONMENT.json"
  )
  if [[ -n "$WORKLOADS" ]]; then
    args+=(--workloads "$WORKLOADS")
  fi
  if [[ "$PHASE" == "migrate" ]]; then
    args+=(--apply)
  fi
  run_task task7-migrate-workloads "${args[@]}"
}

run_equivalence() {
  run_task task8-check-equivalence \
    --inventory-json "$INVENTORY_JSON" \
    --baseline-json "$BASELINE_JSON" \
    --output-target-csv "$OUTPUT_DIR/task-8-target-$ENVIRONMENT.csv" \
    --output-target-json "$OUTPUT_DIR/task-8-target-$ENVIRONMENT.json" \
    --output-comparison-csv "$OUTPUT_DIR/task-8-equivalence-$ENVIRONMENT.csv" \
    --output-comparison-json "$OUTPUT_DIR/task-8-equivalence-$ENVIRONMENT.json" \
    --common-values "$VALUES_FILE"
}

case "$PHASE" in
  prepare)
    run_inventory
    run_classification
    run_mapping
    run_baseline
    ;;
  inventory) run_inventory ;;
  classify) run_classification ;;
  mapping) run_mapping ;;
  baseline) run_baseline ;;
  build-values) run_build_values ;;
  validate) run_validate ;;
  plan|migrate) run_workload_migration ;;
  equivalence) run_equivalence ;;
esac

echo "SUCCESS - phase '$PHASE' completed for environment '$ENVIRONMENT'."
