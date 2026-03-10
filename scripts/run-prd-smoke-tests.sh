#!/usr/bin/env bash
set -euo pipefail

QUERY_URL="${QUERY_URL:-}"
QUERY_AUTH_TOKEN="${QUERY_AUTH_TOKEN:-}"
EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

post_json() {
  local url="$1"
  local body="$2"
  local auth_header="${3:-}"
  local out="$4"

  if [[ -n "$auth_header" ]]; then
    curl -sS -o "$out" -w "%{http_code}" \
      -X POST "$url" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $auth_header" \
      --data "$body"
  else
    curl -sS -o "$out" -w "%{http_code}" \
      -X POST "$url" \
      -H 'content-type: application/json' \
      --data "$body"
  fi
}

TOKEN="$QUERY_AUTH_TOKEN"
if [[ -z "$QUERY_URL" ]]; then
  echo "Set QUERY_URL to your deployed query-worker URL."
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
    echo "Set QUERY_AUTH_TOKEN or EMAIL+PASSWORD before running this script."
    exit 1
  fi

  echo "[1/5] Login"
  LOGIN_CODE=$(post_json "$QUERY_URL/auth/login" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "" "$TMP_DIR/login.json")
  if [[ "$LOGIN_CODE" != "200" ]]; then
    echo "Login failed (status=$LOGIN_CODE):"
    cat "$TMP_DIR/login.json"
    exit 1
  fi
  TOKEN=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.token||"");' "$TMP_DIR/login.json")
  if [[ -z "$TOKEN" ]]; then
    echo "Login returned no token"
    cat "$TMP_DIR/login.json"
    exit 1
  fi
else
  echo "[1/5] Using QUERY_AUTH_TOKEN from environment"
fi

echo "[2/5] Auth me"
ME_CODE=$(curl -sS -o "$TMP_DIR/me.json" -w "%{http_code}" "$QUERY_URL/auth/me" -H "authorization: Bearer $TOKEN")
if [[ "$ME_CODE" != "200" ]]; then
  echo "auth/me failed (status=$ME_CODE):"
  cat "$TMP_DIR/me.json"
  exit 1
fi

echo "[3/5] Phrase guardrail requires service"
REQ_NO_SERVICE='{"time":{"from":"2026-02-18T00:00:00Z","to":"2026-02-18T01:00:00Z"},"ppl":"search \"connection refused\"","limit":50}'
NO_SERVICE_CODE=$(post_json "$QUERY_URL/search" "$REQ_NO_SERVICE" "$TOKEN" "$TMP_DIR/no_service.json")
if [[ "$NO_SERVICE_CODE" != "400" ]]; then
  echo "Expected 400 for phrase-without-service, got $NO_SERVICE_CODE"
  cat "$TMP_DIR/no_service.json"
  exit 1
fi

echo "[4/5] Phrase guardrail max 6h"
REQ_LONG_WINDOW='{"time":{"from":"2026-02-17T00:00:00Z","to":"2026-02-18T00:00:00Z"},"ppl":"search \"connection refused\" | where index=\"default\" and service=\"zeek-conn\"","limit":50}'
LONG_WINDOW_CODE=$(post_json "$QUERY_URL/search" "$REQ_LONG_WINDOW" "$TOKEN" "$TMP_DIR/long_window.json")
if [[ "$LONG_WINDOW_CODE" != "400" ]]; then
  echo "Expected 400 for phrase long window, got $LONG_WINDOW_CODE"
  cat "$TMP_DIR/long_window.json"
  exit 1
fi

echo "[5/5] Token search basic success"
REQ_TOKEN='{"time":{"from":"2026-02-16T00:00:00Z","to":"2026-02-18T23:59:59Z"},"ppl":"search s0 rej | where index=\"default\" and service=\"zeek-conn\" | head 10","limit":10}'
TOKEN_CODE=$(post_json "$QUERY_URL/search" "$REQ_TOKEN" "$TOKEN" "$TMP_DIR/token_search.json")
if [[ "$TOKEN_CODE" != "200" ]]; then
  echo "Expected 200 for token search, got $TOKEN_CODE"
  cat "$TMP_DIR/token_search.json"
  exit 1
fi

echo "All PRD smoke tests passed."
