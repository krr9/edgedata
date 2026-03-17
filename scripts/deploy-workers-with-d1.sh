#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/wrangler-with-d1.sh"

BOOTSTRAP_MODE=0
HAS_DRY_RUN=0
TARGET_ENV=""
HAS_QUERY_WORKER_VAR=0
HAS_INGEST_URL_VAR=0
DEPLOY_ARGS=()
TMP_FILES=()
LAST_DEPLOY_LOG=""
EXTRA_ARGS=()

cleanup() {
  if ((${#TMP_FILES[@]} > 0)); then
    rm -f "${TMP_FILES[@]}"
  fi
}
trap cleanup EXIT

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bootstrap)
      BOOTSTRAP_MODE=1
      shift
      ;;
    --dry-run)
      HAS_DRY_RUN=1
      DEPLOY_ARGS+=("$1")
      shift
      ;;
    --env|-e)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1"
        exit 1
      fi
      TARGET_ENV="$2"
      DEPLOY_ARGS+=("$1" "$2")
      shift 2
      ;;
    --env=*)
      TARGET_ENV="${1#--env=}"
      DEPLOY_ARGS+=("$1")
      shift
      ;;
    --var)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --var"
        exit 1
      fi
      case "$2" in
        QUERY_WORKER_URL:*)
          HAS_QUERY_WORKER_VAR=1
          ;;
        INGEST_URL:*)
          HAS_INGEST_URL_VAR=1
          ;;
      esac
      DEPLOY_ARGS+=("$1" "$2")
      shift 2
      ;;
    --var=QUERY_WORKER_URL:*)
      HAS_QUERY_WORKER_VAR=1
      DEPLOY_ARGS+=("$1")
      shift
      ;;
    --var=INGEST_URL:*)
      HAS_INGEST_URL_VAR=1
      DEPLOY_ARGS+=("$1")
      shift
      ;;
    *)
      DEPLOY_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "${D1_DATABASE_ID:-}" ]]; then
  echo "Set D1_DATABASE_ID before running this script."
  exit 1
fi

strip_service_bindings() {
  local input_path="$1"
  local output_path="$2"
  local bindings_csv="$3"

  awk -v bindings_csv="$bindings_csv" '
    function trim_value(value) {
      sub(/^[[:space:]]+/, "", value);
      sub(/[[:space:]]+$/, "", value);
      return value;
    }
    function flush_block(    i) {
      if (block_len == 0) return;
      if (!(block_is_service && (block_binding in skip_binding))) {
        for (i = 1; i <= block_len; i++) print block_lines[i];
      }
      delete block_lines;
      block_len = 0;
      block_is_service = 0;
      block_binding = "";
    }
    BEGIN {
      split(bindings_csv, raw_bindings, ",");
      for (i in raw_bindings) {
        binding = trim_value(raw_bindings[i]);
        if (binding != "") skip_binding[binding] = 1;
      }
      block_len = 0;
      block_is_service = 0;
      block_binding = "";
    }
    /^\[\[(env\.production\.)?services\]\][[:space:]]*$/ {
      flush_block();
      block_is_service = 1;
      block_lines[++block_len] = $0;
      next;
    }
    /^\[\[/ || /^\[/ {
      flush_block();
      print;
      next;
    }
    {
      if (block_is_service) {
        block_lines[++block_len] = $0;
        if (match($0, /^[[:space:]]*binding[[:space:]]*=[[:space:]]*"([^"]+)"/, matches)) {
          block_binding = matches[1];
        }
        next;
      }
      print;
    }
    END {
      flush_block();
    }
  ' "$input_path" >"$output_path"
}

make_bootstrap_config() {
  local source_config="$1"
  local bindings_csv="$2"
  local config_dir
  local temp_config

  config_dir="$(cd "$(dirname "$source_config")" && pwd)"
  temp_config="$(mktemp "$config_dir/.wrangler.bootstrap.XXXXXX.toml")"
  TMP_FILES+=("$temp_config")
  strip_service_bindings "$source_config" "$temp_config" "$bindings_csv"
  printf '%s\n' "$temp_config"
}

extract_workers_dev_url() {
  local log_file="$1"
  perl -ne 'if (m{(https://[A-Za-z0-9._-]+\.workers\.dev(?:/[^\s"]*)?)}) { print "$1\n"; exit }' "$log_file"
}

run_wrapped_deploy() {
  local config_path="$1"
  shift

  local log_file
  log_file="$(mktemp "/tmp/edgedata-deploy.XXXXXX.log")"
  TMP_FILES+=("$log_file")

  if bash "$WRAPPER" --config "$config_path" deploy "${DEPLOY_ARGS[@]}" "$@" 2>&1 | tee "$log_file"; then
    LAST_DEPLOY_LOG="$log_file"
    return 0
  fi

  LAST_DEPLOY_LOG="$log_file"
  return 1
}

deploy_worker() {
  local config_path="$1"
  shift

  echo
  echo "==> Deploying $config_path"
  run_wrapped_deploy "$config_path" "$@"
}

QUERY_WORKER_URL_VALUE="$(trim "${QUERY_WORKER_URL:-${QUERY_URL:-}}")"
INGEST_URL_VALUE="$(trim "${INGEST_WORKER_URL:-${INGEST_URL:-}}")"

if [[ "$TARGET_ENV" == "production" ]]; then
  if [[ -n "${QUERY_WORKER_URL:-}" ]]; then
    QUERY_WORKER_URL_VALUE="$(trim "${QUERY_WORKER_URL}")"
  elif [[ "${QUERY_URL:-}" == *"query-worker-prod."* ]]; then
    QUERY_WORKER_URL_VALUE="$(trim "${QUERY_URL}")"
  else
    QUERY_WORKER_URL_VALUE=""
  fi

  if [[ -n "${INGEST_WORKER_URL:-}" ]]; then
    INGEST_URL_VALUE="$(trim "${INGEST_WORKER_URL}")"
  elif [[ "${INGEST_URL:-}" == *"ingest-worker-prod."* ]]; then
    INGEST_URL_VALUE="$(trim "${INGEST_URL}")"
  else
    INGEST_URL_VALUE=""
  fi
fi

build_extra_args() {
  local config_path="$1"
  EXTRA_ARGS=()

  if [[ "$config_path" == "workers/alert-worker/wrangler.toml" || "$config_path" == "workers/materialize-worker/wrangler.toml" ]]; then
    if [[ "$HAS_QUERY_WORKER_VAR" != "1" && -n "$QUERY_WORKER_URL_VALUE" ]]; then
      EXTRA_ARGS+=(--var "QUERY_WORKER_URL:${QUERY_WORKER_URL_VALUE}")
    fi
  fi

  if [[ "$config_path" == "workers/synthetic-worker/wrangler.toml" ]]; then
    if [[ "$HAS_INGEST_URL_VAR" != "1" && -n "$INGEST_URL_VALUE" ]]; then
      EXTRA_ARGS+=(--var "INGEST_URL:${INGEST_URL_VALUE}")
    fi
  fi
}

WORKER_CONFIGS=(
  "workers/query-worker/wrangler.toml"
  "workers/ingest-worker/wrangler.toml"
  "workers/alert-worker/wrangler.toml"
  "workers/materialize-worker/wrangler.toml"
  "workers/synthetic-worker/wrangler.toml"
)

declare -A BOOTSTRAP_BINDINGS
BOOTSTRAP_BINDINGS["workers/query-worker/wrangler.toml"]="SYNTHETIC_SERVICE,ALERT_SERVICE"
BOOTSTRAP_BINDINGS["workers/ingest-worker/wrangler.toml"]="QUERY_SERVICE"
BOOTSTRAP_BINDINGS["workers/alert-worker/wrangler.toml"]="QUERY_SERVICE"
BOOTSTRAP_BINDINGS["workers/materialize-worker/wrangler.toml"]="QUERY_SERVICE"
BOOTSTRAP_BINDINGS["workers/synthetic-worker/wrangler.toml"]="INGEST_SERVICE"

if [[ "$BOOTSTRAP_MODE" == "1" ]]; then
  echo "Bootstrap mode enabled: deploying workers once without service bindings, then redeploying with full bindings."

  for config in "${WORKER_CONFIGS[@]}"; do
    bootstrap_config="$(make_bootstrap_config "$ROOT_DIR/$config" "${BOOTSTRAP_BINDINGS[$config]}")"
    build_extra_args "$config"
    deploy_worker "$bootstrap_config" "${EXTRA_ARGS[@]}"

    if [[ "$config" == "workers/query-worker/wrangler.toml" && -z "$QUERY_WORKER_URL_VALUE" && "$HAS_DRY_RUN" != "1" ]]; then
      QUERY_WORKER_URL_VALUE="$(extract_workers_dev_url "$LAST_DEPLOY_LOG")"
      if [[ -n "$QUERY_WORKER_URL_VALUE" ]]; then
        echo "Captured query-worker URL for bootstrap fallbacks: $QUERY_WORKER_URL_VALUE"
      fi
    fi

    if [[ "$config" == "workers/ingest-worker/wrangler.toml" && -z "$INGEST_URL_VALUE" && "$HAS_DRY_RUN" != "1" ]]; then
      INGEST_URL_VALUE="$(extract_workers_dev_url "$LAST_DEPLOY_LOG")"
      if [[ -n "$INGEST_URL_VALUE" ]]; then
        echo "Captured ingest-worker URL for bootstrap fallbacks: $INGEST_URL_VALUE"
      fi
    fi
  done

  if [[ "$HAS_DRY_RUN" == "1" ]]; then
    echo
    echo "Bootstrap dry-run completed with service bindings temporarily removed."
    echo "Run the same command without --dry-run to create the workers, then redeploy normally to validate the full bound graph."
    exit 0
  fi
fi

for config in "${WORKER_CONFIGS[@]}"; do
  build_extra_args "$config"
  deploy_worker "$config" "${EXTRA_ARGS[@]}"
done

echo
echo "Worker deploy sequence completed."
