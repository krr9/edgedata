#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SCRIPT="$ROOT/scripts/check-access-config.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

write_query_file() {
  local file="$1"
  local require_jwt="$2"
  local access_aud="$3"
  local access_issuer="$4"
  local superadmin_groups="$5"
  local admin_groups="$6"
  local analyst_groups="$7"
  local viewer_groups="$8"

  cat > "$file" <<EOF
name = "query-worker"
main = "src/index.ts"
compatibility_date = "2026-02-16"

[vars]
REQUIRE_ACCESS_JWT = "${require_jwt}"
ACCESS_AUD = "${access_aud}"
ACCESS_ISSUER = "${access_issuer}"
ACCESS_SUPERADMIN_GROUPS = "${superadmin_groups}"
ACCESS_ADMIN_GROUPS = "${admin_groups}"
ACCESS_ANALYST_GROUPS = "${analyst_groups}"
ACCESS_VIEWER_GROUPS = "${viewer_groups}"
EOF
}

write_alert_file() {
  local file="$1"
  local require_jwt="$2"
  local access_aud="$3"
  local access_issuer="$4"
  local admin_groups="$5"

  cat > "$file" <<EOF
name = "alert-worker"
main = "src/index.ts"
compatibility_date = "2026-02-16"

[vars]
REQUIRE_ACCESS_JWT = "${require_jwt}"
ACCESS_AUD = "${access_aud}"
ACCESS_ISSUER = "${access_issuer}"
ACCESS_ADMIN_GROUPS = "${admin_groups}"
EOF
}

run_check_expect_pass() {
  local label="$1"
  local query_file="$2"
  local alert_file="$3"

  if ! QUERY_TOML="$query_file" ALERT_TOML="$alert_file" bash "$CHECK_SCRIPT" >/dev/null 2>&1; then
    echo "FAILED: ${label} was expected to pass"
    QUERY_TOML="$query_file" ALERT_TOML="$alert_file" bash "$CHECK_SCRIPT" || true
    exit 1
  fi
  echo "PASS: ${label}"
}

run_check_expect_fail() {
  local label="$1"
  local query_file="$2"
  local alert_file="$3"

  if QUERY_TOML="$query_file" ALERT_TOML="$alert_file" bash "$CHECK_SCRIPT" >/dev/null 2>&1; then
    echo "FAILED: ${label} was expected to fail"
    exit 1
  fi
  echo "PASS: ${label}"
}

QUERY_FILE="$TMP_DIR/query.toml"
ALERT_FILE="$TMP_DIR/alert.toml"

# JWT disabled should skip strict checks.
write_query_file "$QUERY_FILE" "false" "" "" "" "" "" ""
write_alert_file "$ALERT_FILE" "false" "" "" ""
run_check_expect_pass "skip when JWT disabled" "$QUERY_FILE" "$ALERT_FILE"

# Missing query ACCESS_AUD should fail when JWT required.
write_query_file "$QUERY_FILE" "true" "" "https://example.cloudflareaccess.com" "cf-superadmins" "" "" ""
write_alert_file "$ALERT_FILE" "true" "alert-aud" "https://example.cloudflareaccess.com" "cf-admins"
run_check_expect_fail "query requires ACCESS_AUD" "$QUERY_FILE" "$ALERT_FILE"

# Missing query group mappings should fail.
write_query_file "$QUERY_FILE" "true" "query-aud" "https://example.cloudflareaccess.com" "" "" "" ""
write_alert_file "$ALERT_FILE" "true" "alert-aud" "https://example.cloudflareaccess.com" "cf-admins"
run_check_expect_fail "query requires at least one ACCESS_*_GROUPS mapping" "$QUERY_FILE" "$ALERT_FILE"

# Missing alert admin groups should fail.
write_query_file "$QUERY_FILE" "true" "query-aud" "https://example.cloudflareaccess.com" "cf-superadmins" "" "" ""
write_alert_file "$ALERT_FILE" "true" "alert-aud" "https://example.cloudflareaccess.com" ""
run_check_expect_fail "alert requires ACCESS_ADMIN_GROUPS" "$QUERY_FILE" "$ALERT_FILE"

# Fully configured should pass.
write_query_file "$QUERY_FILE" "true" "query-aud" "https://example.cloudflareaccess.com" "cf-superadmins" "cf-admins" "cf-analysts" "cf-viewers"
write_alert_file "$ALERT_FILE" "true" "alert-aud" "https://example.cloudflareaccess.com" "cf-admins"
run_check_expect_pass "fully configured access policy" "$QUERY_FILE" "$ALERT_FILE"

echo "All access config tests passed."
