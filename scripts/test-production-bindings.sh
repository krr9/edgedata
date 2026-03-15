#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SCRIPT="$ROOT/scripts/check-production-bindings.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

write_pages_file() {
  local file="$1"
  local query_service="$2"

  cat > "$file" <<EOF
name = "edgedata-1fo"
pages_build_output_dir = "dist"

[[services]]
binding = "QUERY_API"
service = "${query_service}"
EOF
}

write_query_file() {
  local file="$1"
  local synthetic_service="$2"
  local alert_service="$3"

  cat > "$file" <<EOF
name = "query-worker"
main = "src/index.ts"

[env.production]
name = "query-worker-prod"

[[env.production.services]]
binding = "SYNTHETIC_SERVICE"
service = "${synthetic_service}"

[[env.production.services]]
binding = "ALERT_SERVICE"
service = "${alert_service}"
EOF
}

write_synthetic_file() {
  local file="$1"
  local ingest_service="$2"

  cat > "$file" <<EOF
name = "synthetic-worker"
main = "src/index.ts"

[env.production]
name = "synthetic-worker-prod"

[[env.production.services]]
binding = "INGEST_SERVICE"
service = "${ingest_service}"
EOF
}

run_check_expect_pass() {
  local label="$1"
  if ! PAGES_TOML="$2" QUERY_TOML="$3" SYNTHETIC_TOML="$4" bash "$CHECK_SCRIPT" >/dev/null 2>&1; then
    echo "FAILED: ${label} was expected to pass"
    PAGES_TOML="$2" QUERY_TOML="$3" SYNTHETIC_TOML="$4" bash "$CHECK_SCRIPT" || true
    exit 1
  fi
  echo "PASS: ${label}"
}

run_check_expect_fail() {
  local label="$1"
  if PAGES_TOML="$2" QUERY_TOML="$3" SYNTHETIC_TOML="$4" bash "$CHECK_SCRIPT" >/dev/null 2>&1; then
    echo "FAILED: ${label} was expected to fail"
    exit 1
  fi
  echo "PASS: ${label}"
}

PAGES_FILE="$TMP_DIR/pages.toml"
QUERY_FILE="$TMP_DIR/query.toml"
SYNTHETIC_FILE="$TMP_DIR/synthetic.toml"

write_pages_file "$PAGES_FILE" "query-worker-prod"
write_query_file "$QUERY_FILE" "synthetic-worker-prod" "alert-worker-prod"
write_synthetic_file "$SYNTHETIC_FILE" "ingest-worker-prod"
run_check_expect_pass "production binding chain is aligned" "$PAGES_FILE" "$QUERY_FILE" "$SYNTHETIC_FILE"

write_query_file "$QUERY_FILE" "synthetic-worker" "alert-worker-prod"
run_check_expect_fail "query production synthetic binding must target synthetic-worker-prod" "$PAGES_FILE" "$QUERY_FILE" "$SYNTHETIC_FILE"

write_query_file "$QUERY_FILE" "synthetic-worker-prod" "alert-worker-prod"
write_pages_file "$PAGES_FILE" "query-worker"
run_check_expect_fail "pages QUERY_API must target query-worker-prod" "$PAGES_FILE" "$QUERY_FILE" "$SYNTHETIC_FILE"

write_pages_file "$PAGES_FILE" "query-worker-prod"
write_synthetic_file "$SYNTHETIC_FILE" "ingest-worker"
run_check_expect_fail "synthetic production ingest binding must target ingest-worker-prod" "$PAGES_FILE" "$QUERY_FILE" "$SYNTHETIC_FILE"

echo "All production binding tests passed."
