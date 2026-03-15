#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGES_TOML="${PAGES_TOML:-$ROOT/pages/wrangler.toml}"
QUERY_TOML="${QUERY_TOML:-$ROOT/workers/query-worker/wrangler.toml}"
SYNTHETIC_TOML="${SYNTHETIC_TOML:-$ROOT/workers/synthetic-worker/wrangler.toml}"

fail=0

check_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if perl -0ne "exit((/${pattern}/s) ? 0 : 1)" "$file"
  then
    echo "OK:   ${label}"
  else
    echo "FAIL: ${label}"
    fail=1
  fi
}

check_contains \
  "$PAGES_TOML" \
  '\[\[services\]\][\s\S]*?binding = "QUERY_API"[\s\S]*?service = "query-worker-prod"' \
  "pages/wrangler.toml -> QUERY_API targets query-worker-prod"

check_contains \
  "$QUERY_TOML" \
  '\[\[env\.production\.services\]\][\s\S]*?binding = "SYNTHETIC_SERVICE"[\s\S]*?service = "synthetic-worker-prod"' \
  "workers/query-worker/wrangler.toml -> production SYNTHETIC_SERVICE targets synthetic-worker-prod"

check_contains \
  "$QUERY_TOML" \
  '\[\[env\.production\.services\]\][\s\S]*?binding = "ALERT_SERVICE"[\s\S]*?service = "alert-worker-prod"' \
  "workers/query-worker/wrangler.toml -> production ALERT_SERVICE targets alert-worker-prod"

check_contains \
  "$SYNTHETIC_TOML" \
  '\[\[env\.production\.services\]\][\s\S]*?binding = "INGEST_SERVICE"[\s\S]*?service = "ingest-worker-prod"' \
  "workers/synthetic-worker/wrangler.toml -> production INGEST_SERVICE targets ingest-worker-prod"

if [[ "$fail" -ne 0 ]]; then
  echo "Production binding validation failed."
  exit 1
fi

echo "Production binding validation passed."
