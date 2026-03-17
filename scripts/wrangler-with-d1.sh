#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  D1_DATABASE_ID=<uuid> bash scripts/wrangler-with-d1.sh --config <wrangler.toml> [--] <wrangler args...>

Examples:
  D1_DATABASE_ID=<uuid> bash scripts/wrangler-with-d1.sh --config workers/query-worker/wrangler.toml deploy --dry-run
  D1_DATABASE_ID=<uuid> bash scripts/wrangler-with-d1.sh --config workers/query-worker/wrangler.toml deploy --env production
USAGE
}

CONFIG_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --config"
        usage
        exit 1
      fi
      CONFIG_PATH="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [[ -z "$CONFIG_PATH" ]]; then
  echo "--config is required."
  usage
  exit 1
fi

if [[ -z "${D1_DATABASE_ID:-}" ]]; then
  echo "Set D1_DATABASE_ID before running this script."
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Pass wrangler arguments after --config (for example: deploy --dry-run)."
  usage
  exit 1
fi

if [[ "$CONFIG_PATH" != /* ]]; then
  CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config file not found: $CONFIG_PATH"
  exit 1
fi
CONFIG_DIR="$(cd "$(dirname "$CONFIG_PATH")" && pwd)"

TMP_CONFIG="$(mktemp "$CONFIG_DIR/.wrangler.d1.XXXXXX.toml")"
cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

perl -pe 's/^(\s*database_id\s*=\s*")[^"]*(".*)$/$1$ENV{D1_DATABASE_ID}$2/' "$CONFIG_PATH" >"$TMP_CONFIG"

if rg -q "REPLACE_WITH_D1_DATABASE_ID" "$TMP_CONFIG"; then
  echo "Failed to inject D1_DATABASE_ID into temporary config."
  exit 1
fi

if ! rg -q "database_id\\s*=\\s*\"${D1_DATABASE_ID}\"" "$TMP_CONFIG"; then
  echo "Failed to inject D1_DATABASE_ID into temporary config."
  exit 1
fi

echo "Using temporary config for $CONFIG_PATH with D1_DATABASE_ID from environment."
npx wrangler "$@" --config "$TMP_CONFIG"
