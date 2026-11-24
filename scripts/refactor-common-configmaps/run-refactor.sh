#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-refactor.sh <phase> --environment <env> [options]

Phases:
  prepare       Generate inventory, classification, mapping, and baseline reports
  inventory     Run task 1: verify ConfigMap references
  classify      Run task 2: classify ConfigMap keys
  mapping       Run task 3: build the common-values mapping
  baseline      Run task 4: build the current configuration baseline
  equivalence   Run task 4: compare the rendered workload with the baseline (requires Helm)
  build-values  Run task 5: generate values-commons.yaml (requires --apply)

Options:
  --environment, -e  Target environment (required)
  --root, -r         Repository root (default: auto-detected)
  --output-dir, -o   Report directory (default: reports/refactor-common-configmaps)
  --values-file      Generated values file (default: commons/<env>/values-commons.yaml)
  --apply             Authorize build-values to write the common values file
  --help, -h          Show this help

Requires Node.js >= 22.
Review the classification and mapping reports before running build-values.
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

INVENTORY_CSV="$OUTPUT_DIR/task-1-inventory-$ENVIRONMENT.csv"
CLASSIFICATION_CSV="$OUTPUT_DIR/task-2-common-configmaps-classification-$ENVIRONMENT.csv"
MAPPING_CSV="$OUTPUT_DIR/task-3-common-values-mapping-$ENVIRONMENT.csv"
BASELINE_CSV="$OUTPUT_DIR/task-4-baseline-$ENVIRONMENT.csv"
TASKS_DIR="$SCRIPT_DIR/dist"

case "$PHASE" in
  prepare|inventory|classify|mapping|baseline|equivalence|build-values) ;;
  *)
    echo "Unknown phase: $PHASE" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "$APPLY" == true && "$PHASE" != "build-values" ]]; then
  echo "--apply is only valid with the build-values phase." >&2
  exit 2
fi
if [[ "$PHASE" == "build-values" && "$APPLY" != true ]]; then
  echo "Phase 'build-values' writes repository files; rerun with --apply." >&2
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
    --inventory-csv "$INVENTORY_CSV" \
    --output-csv "$CLASSIFICATION_CSV" \
    --output-summary-csv "$OUTPUT_DIR/task-2-classification-summary-$ENVIRONMENT.csv"
}

run_mapping() {
  run_task task3-build-mapping \
    --classification-csv "$CLASSIFICATION_CSV" \
    --output-dir "$OUTPUT_DIR"
}

run_baseline() {
  run_task task4-build-baseline \
    --inventory-csv "$INVENTORY_CSV" \
    --output-csv "$BASELINE_CSV"
}

run_equivalence() {
  run_task task4-check-equivalence \
    --inventory-csv "$INVENTORY_CSV" \
    --baseline-csv "$BASELINE_CSV" \
    --output-target-csv "$OUTPUT_DIR/task-4-target-$ENVIRONMENT.csv" \
    --output-comparison-csv "$OUTPUT_DIR/task-4-equivalence-$ENVIRONMENT.csv" \
    --common-values "$VALUES_FILE"
}

run_build_values() {
  run_task task5-build-common-values \
    --mapping-csv "$MAPPING_CSV" \
    --output-yaml "$VALUES_FILE" \
    --output-coverage-csv "$OUTPUT_DIR/task-5-migration-coverage-$ENVIRONMENT.csv" \
    --output-coverage-md "$OUTPUT_DIR/task-5-migration-coverage-$ENVIRONMENT.md"
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
  equivalence) run_equivalence ;;
  build-values) run_build_values ;;
esac

echo "SUCCESS - phase '$PHASE' completed for environment '$ENVIRONMENT'."
