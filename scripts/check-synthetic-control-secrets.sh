#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUERY_TOML="${QUERY_TOML:-$ROOT/workers/query-worker/wrangler.toml}"
SYNTHETIC_TOML="${SYNTHETIC_TOML:-$ROOT/workers/synthetic-worker/wrangler.toml}"
INGEST_TOML="${INGEST_TOML:-$ROOT/workers/ingest-worker/wrangler.toml}"
TARGET_ENV="${TARGET_ENV:-production}"

fail=0

check_secret() {
  local file="$1"
  local secret_name="$2"
  local label="$3"
  local output

  if ! output="$(npx wrangler secret list --config "$file" --env "$TARGET_ENV" 2>/dev/null)"; then
    echo "FAIL: ${label} -> unable to list secrets"
    fail=1
    return
  fi

  if printf '%s\n' "$output" | grep -q "\"name\": \"${secret_name}\""; then
    echo "OK:   ${label} -> ${secret_name} present"
  else
    echo "FAIL: ${label} -> ${secret_name} missing"
    fail=1
  fi
}

check_secret "$QUERY_TOML" "SYNTHETIC_RUN_SECRET" "query worker"
check_secret "$SYNTHETIC_TOML" "SYNTHETIC_RUN_SECRET" "synthetic worker"
check_secret "$SYNTHETIC_TOML" "INGEST_SECRET" "synthetic worker"
check_secret "$INGEST_TOML" "INGEST_SECRET" "ingest worker"

if [[ "$fail" -ne 0 ]]; then
  echo "Synthetic control secret validation failed."
  exit 1
fi

echo "Synthetic control secret validation passed."
