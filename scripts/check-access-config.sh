#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUERY_TOML="${QUERY_TOML:-$ROOT/workers/query-worker/wrangler.toml}"
ALERT_TOML="${ALERT_TOML:-$ROOT/workers/alert-worker/wrangler.toml}"

get_var() {
  local file="$1"
  local key="$2"
  awk -F'=' -v key="$key" '
    $1 ~ "^[[:space:]]*"key"[[:space:]]*$" {
      val = $2
      gsub(/^[[:space:]]*"/, "", val)
      gsub(/"[[:space:]]*$/, "", val)
      print val
      exit
    }
  ' "$file"
}

is_truthy() {
  local raw="$1"
  local lowered
  lowered="$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
  [[ "$lowered" == "1" || "$lowered" == "true" || "$lowered" == "yes" || "$lowered" == "on" ]]
}

is_empty() {
  local value="$1"
  [[ -z "$(echo "$value" | tr -d '[:space:]')" ]]
}

fail=0

check_non_empty() {
  local file="$1"
  local key="$2"
  local value
  value="$(get_var "$file" "$key")"
  if [[ -z "$value" ]]; then
    echo "FAIL: ${file#$ROOT/} -> ${key} is empty"
    fail=1
  else
    echo "OK:   ${file#$ROOT/} -> ${key} set"
  fi
}

check_query_config() {
  local require_jwt
  require_jwt="$(get_var "$QUERY_TOML" "REQUIRE_ACCESS_JWT")"
  if ! is_truthy "$require_jwt"; then
    echo "SKIP: workers/query-worker/wrangler.toml -> REQUIRE_ACCESS_JWT is not true"
    return
  fi

  check_non_empty "$QUERY_TOML" "ACCESS_ISSUER"
  check_non_empty "$QUERY_TOML" "ACCESS_AUD"

  local superadmin viewer analyst admin
  superadmin="$(get_var "$QUERY_TOML" "ACCESS_SUPERADMIN_GROUPS")"
  viewer="$(get_var "$QUERY_TOML" "ACCESS_VIEWER_GROUPS")"
  analyst="$(get_var "$QUERY_TOML" "ACCESS_ANALYST_GROUPS")"
  admin="$(get_var "$QUERY_TOML" "ACCESS_ADMIN_GROUPS")"

  if is_empty "$superadmin" && is_empty "$viewer" && is_empty "$analyst" && is_empty "$admin"; then
    echo "FAIL: workers/query-worker/wrangler.toml -> at least one ACCESS_*_GROUPS value is required"
    fail=1
  else
    echo "OK:   workers/query-worker/wrangler.toml -> Access groups configured"
  fi
}

check_alert_config() {
  local require_jwt
  require_jwt="$(get_var "$ALERT_TOML" "REQUIRE_ACCESS_JWT")"
  if ! is_truthy "$require_jwt"; then
    echo "SKIP: workers/alert-worker/wrangler.toml -> REQUIRE_ACCESS_JWT is not true"
    return
  fi

  check_non_empty "$ALERT_TOML" "ACCESS_ISSUER"
  check_non_empty "$ALERT_TOML" "ACCESS_AUD"

  local alert_admin
  alert_admin="$(get_var "$ALERT_TOML" "ACCESS_ADMIN_GROUPS")"
  if is_empty "$alert_admin"; then
    echo "FAIL: workers/alert-worker/wrangler.toml -> ACCESS_ADMIN_GROUPS is empty"
    fail=1
  else
    echo "OK:   workers/alert-worker/wrangler.toml -> ACCESS_ADMIN_GROUPS configured"
  fi
}

check_query_config
check_alert_config

if [[ "$fail" -ne 0 ]]; then
  echo "Access config validation failed."
  exit 1
fi

echo "Access config validation passed."
