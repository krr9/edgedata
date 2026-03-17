#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/wrangler-with-d1.sh"
DB_NAME="${D1_DATABASE_NAME:-edgedata-db}"
MODE="${1:-}"

usage() {
  cat <<'USAGE'
Usage:
  D1_DATABASE_ID=<uuid> bash scripts/apply-d1-migrations.sh fresh
  D1_DATABASE_ID=<uuid> bash scripts/apply-d1-migrations.sh upgrade

Modes:
  fresh    Apply the consolidated schema baseline plus the starter/data migrations
           that remain safe on top of the current schema snapshot.
  upgrade  Apply the full incremental migration chain (002-017) to an existing DB.
USAGE
}

if [[ -z "$MODE" ]]; then
  usage
  exit 1
fi

if [[ -z "${D1_DATABASE_ID:-}" ]]; then
  echo "Set D1_DATABASE_ID before running this script."
  exit 1
fi

case "$MODE" in
  fresh)
    FILES=(
      "./schema.sql"
      "./deploy/migrations/008_otel_saved_scheduled_showcase.sql"
      "./deploy/migrations/009_otel_dashboard_jazz_up.sql"
      "./deploy/migrations/010_runtime_synthetic_ingest_control.sql"
      "./deploy/migrations/012_shorten_otel_overview_copy.sql"
      "./deploy/migrations/015_role_id_index.sql"
      "./deploy/migrations/016_remove_zeek_role.sql"
    )
    ;;
  upgrade)
    FILES=(
      "./deploy/migrations/002_authz_ownership.sql"
      "./deploy/migrations/003_auth_users.sql"
      "./deploy/migrations/004_rate_limits.sql"
      "./deploy/migrations/005_auth_rbac.sql"
      "./deploy/migrations/006_operational_workflows.sql"
      "./deploy/migrations/007_dashboard_widget_model.sql"
      "./deploy/migrations/008_otel_saved_scheduled_showcase.sql"
      "./deploy/migrations/009_otel_dashboard_jazz_up.sql"
      "./deploy/migrations/010_runtime_synthetic_ingest_control.sql"
      "./deploy/migrations/011_investigation_sessions.sql"
      "./deploy/migrations/012_shorten_otel_overview_copy.sql"
      "./deploy/migrations/013_performance_policies_and_materializations.sql"
      "./deploy/migrations/014_scheduled_search_run_artifacts.sql"
      "./deploy/migrations/015_role_id_index.sql"
      "./deploy/migrations/016_remove_zeek_role.sql"
      "./deploy/migrations/017_investigation_session_name.sql"
    )
    ;;
  *)
    echo "Unknown mode: $MODE"
    usage
    exit 1
    ;;
esac

cd "$ROOT_DIR"

for file in "${FILES[@]}"; do
  echo
  echo "==> Applying $file"
  bash "$WRAPPER" --config wrangler.toml d1 execute "$DB_NAME" --remote --file="$file"
done

echo
echo "Completed D1 migration sequence: $MODE"
