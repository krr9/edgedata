#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/wrangler-with-d1.sh"
DEPLOY_ARGS=("$@")

TARGET_ENV=""
HAS_QUERY_WORKER_VAR=0
for ((i = 0; i < ${#DEPLOY_ARGS[@]}; i++)); do
  arg="${DEPLOY_ARGS[$i]}"
  case "$arg" in
    --env|-e)
      if (( i + 1 < ${#DEPLOY_ARGS[@]} )); then
        TARGET_ENV="${DEPLOY_ARGS[$((i + 1))]}"
      fi
      ;;
    --env=*)
      TARGET_ENV="${arg#--env=}"
      ;;
    --var)
      if (( i + 1 < ${#DEPLOY_ARGS[@]} )); then
        next_arg="${DEPLOY_ARGS[$((i + 1))]}"
        if [[ "$next_arg" == QUERY_WORKER_URL:* ]]; then
          HAS_QUERY_WORKER_VAR=1
        fi
      fi
      ;;
    --var=QUERY_WORKER_URL:*)
      HAS_QUERY_WORKER_VAR=1
      ;;
  esac
done

if [[ -z "${D1_DATABASE_ID:-}" ]]; then
  echo "Set D1_DATABASE_ID before running this script."
  exit 1
fi

ALERT_QUERY_WORKER_URL=""
if [[ "$TARGET_ENV" == "production" ]]; then
  if [[ -n "${QUERY_WORKER_URL:-}" ]]; then
    ALERT_QUERY_WORKER_URL="$QUERY_WORKER_URL"
  elif [[ -n "${QUERY_URL:-}" && "$QUERY_URL" == *"query-worker-prod."* ]]; then
    ALERT_QUERY_WORKER_URL="$QUERY_URL"
  fi
  if [[ "$HAS_QUERY_WORKER_VAR" != "1" && -z "$ALERT_QUERY_WORKER_URL" ]]; then
    echo "For production deploys, set QUERY_WORKER_URL to your query-worker-prod URL."
    echo "Example: export QUERY_WORKER_URL=https://query-worker-prod.<subdomain>.workers.dev"
    exit 1
  fi
else
  ALERT_QUERY_WORKER_URL="${QUERY_WORKER_URL:-${QUERY_URL:-}}"
fi

WORKER_CONFIGS=(
  "workers/ingest-worker/wrangler.toml"
  "workers/query-worker/wrangler.toml"
  "workers/alert-worker/wrangler.toml"
  "workers/synthetic-worker/wrangler.toml"
)

for config in "${WORKER_CONFIGS[@]}"; do
  echo
  echo "==> Deploying $config"
  EXTRA_ARGS=()
  if [[ "$config" == "workers/alert-worker/wrangler.toml" && "$HAS_QUERY_WORKER_VAR" != "1" && -n "$ALERT_QUERY_WORKER_URL" ]]; then
    EXTRA_ARGS+=(--var "QUERY_WORKER_URL:${ALERT_QUERY_WORKER_URL}")
  fi
  if ((${#EXTRA_ARGS[@]} > 0)); then
    bash "$WRAPPER" --config "$config" deploy "${DEPLOY_ARGS[@]}" "${EXTRA_ARGS[@]}"
  else
    bash "$WRAPPER" --config "$config" deploy "${DEPLOY_ARGS[@]}"
  fi
done

echo
echo "Worker deploy sequence completed."
