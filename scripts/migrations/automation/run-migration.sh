#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-migration.sh <phase> --environment <env> [options]

Phases:
  preflight          Install dependencies, typecheck and test both toolsets
  repository         Generate the repository inventory
  cluster            Generate the cluster inventory
  compare            Compare existing repository and cluster inventories
  inventory          Generate repository/cluster inventories and compare them
  generate           Generate commons/<env>/migrations (requires --apply; optional --prune)
  verify             Verify generated values with SHA-256 and CRC32
  plan               Show workload migration plan without changing files
  migrate            Replace migrationsConfigmap with migrationDomain (requires --apply)
  validate           Run final validation plus SHA-256 and CRC32 verification

Options:
  --environment, -e  Target environment (required)
  --namespace, -n    Kubernetes namespace (default: environment)
  --context, -c      Kubernetes context (required by inventory)
  --root, -r         Repository root (default: auto-detected)
  --output-dir, -o   Report directory (default: migration-inventory/<env>);
                     every phase writes JSON/CSV reports into <output-dir>/<phase>/
  --apply             Authorize a mutating generate or migrate phase
  --prune             generate only: remove commons/<env>/migrations files without a source
                      ConfigMap; refused when commons/<env>/configmaps has no flyway*.yaml
  --help, -h          Show this help

The script is run manually by the migration operator.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PHASE="${1:-}"
if [[ -z "$PHASE" || "$PHASE" == "--help" || "$PHASE" == "-h" ]]; then usage; exit 0; fi
shift

ROOT="$DEFAULT_ROOT"
ENVIRONMENT=""
NAMESPACE=""
CONTEXT=""
OUTPUT_DIR=""
APPLY=false
PRUNE=false

while (($#)); do
  case "$1" in
    -e|--environment) ENVIRONMENT="${2:?Missing environment}"; shift 2 ;;
    -n|--namespace) NAMESPACE="${2:?Missing namespace}"; shift 2 ;;
    -c|--context) CONTEXT="${2:?Missing context}"; shift 2 ;;
    -r|--root) ROOT="${2:?Missing root}"; shift 2 ;;
    -o|--output-dir) OUTPUT_DIR="${2:?Missing output directory}"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --prune) PRUNE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$ENVIRONMENT" ]] || { echo "--environment is required" >&2; exit 2; }
[[ "$ENVIRONMENT" != */* && "$ENVIRONMENT" != "." && "$ENVIRONMENT" != ".." ]] || { echo "Invalid environment" >&2; exit 2; }
ROOT="$(cd "$ROOT" && pwd)"
NAMESPACE="${NAMESPACE:-$ENVIRONMENT}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/migration-inventory/$ENVIRONMENT}"
AUTOMATION="$ROOT/scripts/migrations/automation"
FLYWAY="$ROOT/scripts/migrations/flyway"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 2)) process.exit(1)' || {
  echo "Node.js >=22.2.0 is required; found $(node --version)." >&2
  exit 2
}

require_apply() {
  [[ "$APPLY" == true ]] || { echo "Phase '$PHASE' changes repository files; rerun with --apply." >&2; exit 2; }
}

case "$PHASE" in
  preflight)
    # flyway first: automation imports the shared modules of scripts/migrations/flyway and their dependencies.
    (cd "$FLYWAY" && npm ci && npm run typecheck && npm test)
    (cd "$AUTOMATION" && npm ci && npm run typecheck && npm test)
    ;;
  repository)
    mkdir -p "$OUTPUT_DIR"
    (cd "$AUTOMATION" && npm run inventory:repository -- --root "$ROOT" --environment "$ENVIRONMENT" --namespace "$NAMESPACE" --output-dir "$OUTPUT_DIR")
    ;;
  cluster)
    [[ -n "$CONTEXT" ]] || { echo "--context is required by cluster inventory" >&2; exit 2; }
    mkdir -p "$OUTPUT_DIR"
    (cd "$AUTOMATION" && npm run inventory:cluster -- --environment "$ENVIRONMENT" --namespace "$NAMESPACE" --context "$CONTEXT" --output-dir "$OUTPUT_DIR")
    ;;
  compare)
    context_args=()
    if [[ -n "$CONTEXT" ]]; then context_args=(--context "$CONTEXT"); fi
    (cd "$AUTOMATION" && npm run compare -- --repository "$OUTPUT_DIR/repository/repository-migrations-$ENVIRONMENT.json" --cluster "$OUTPUT_DIR/cluster/cluster-migrations-$ENVIRONMENT.json" --environment "$ENVIRONMENT" --namespace "$NAMESPACE" ${context_args[@]+"${context_args[@]}"} --output "$OUTPUT_DIR/compare-$ENVIRONMENT.json")
    ;;
  inventory)
    # Collect both inventories, but never compare stale reports after a failed acquisition.
    status=0
    "$0" repository --root "$ROOT" --environment "$ENVIRONMENT" --namespace "$NAMESPACE" --output-dir "$OUTPUT_DIR" || status=1
    "$0" cluster --root "$ROOT" --environment "$ENVIRONMENT" --namespace "$NAMESPACE" --context "$CONTEXT" --output-dir "$OUTPUT_DIR" || status=1
    if [[ "$status" -eq 0 ]]; then
      "$0" compare --root "$ROOT" --environment "$ENVIRONMENT" --namespace "$NAMESPACE" --context "$CONTEXT" --output-dir "$OUTPUT_DIR" || status=1
    else
      echo "SKIPPED - compare: at least one inventory failed; existing reports must not be reused." >&2
    fi
    exit "$status"
    ;;
  generate)
    require_apply
    prune_args=()
    if [[ "$PRUNE" == true ]]; then
      # Without any source ConfigMap every generated file would be "orphan": never prune in that state
      # (e.g. after the legacy flyway*.yaml cleanup).
      shopt -s nullglob nocaseglob
      sources=("$ROOT/commons/$ENVIRONMENT/configmaps"/flyway*.yaml "$ROOT/commons/$ENVIRONMENT/configmaps"/flyway*.yml)
      shopt -u nullglob nocaseglob
      [[ ${#sources[@]} -gt 0 ]] || { echo "Refusing --prune: no flyway*.yaml ConfigMap in commons/$ENVIRONMENT/configmaps; it would delete every file in commons/$ENVIRONMENT/migrations." >&2; exit 2; }
      prune_args=(--prune)
    fi
    (cd "$FLYWAY" && npm run generate -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/generate" ${prune_args[@]+"${prune_args[@]}"})
    ;;
  verify)
    status=0
    (cd "$FLYWAY" && npm run verify:sha256 -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/verify") || status=1
    (cd "$FLYWAY" && npm run verify:crc32 -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/verify") || status=1
    [[ "$status" -eq 0 ]] || exit "$status"
    ;;
  plan)
    (cd "$FLYWAY" && npm run migrate:workloads -- --root "$ROOT" --environment "$ENVIRONMENT" --dry-run --report-dir "$OUTPUT_DIR/plan")
    ;;
  migrate)
    require_apply
    (cd "$FLYWAY" && npm run migrate:workloads -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/migrate")
    ;;
  validate)
    status=0
    (cd "$AUTOMATION" && npm run validate:migration -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/validate") || status=1
    (cd "$FLYWAY" && npm run verify:sha256 -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/validate") || status=1
    (cd "$FLYWAY" && npm run verify:crc32 -- --root "$ROOT" --environment "$ENVIRONMENT" --report-dir "$OUTPUT_DIR/validate") || status=1
    [[ "$status" -eq 0 ]] || exit "$status"
    ;;
  *) echo "Unknown phase: $PHASE" >&2; usage >&2; exit 2 ;;
esac

echo "SUCCESS - phase '$PHASE' completed for environment '$ENVIRONMENT'."
