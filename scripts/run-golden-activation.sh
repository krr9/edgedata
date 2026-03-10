#!/usr/bin/env bash
set -euo pipefail

QUERY_URL="${QUERY_URL:-}"
ALERT_URL="${ALERT_URL:-}"
DEEP_LINK_BASE="${DEEP_LINK_BASE:-}"
RUNBOOK_BASE_URL="${RUNBOOK_BASE_URL:-}"
OWNER_TEAM="${OWNER_TEAM:-edge-ops}"
QUERY_AUTH_TOKEN="${QUERY_AUTH_TOKEN:-}"
EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"
ALERT_RUN_SECRET="${ALERT_RUN_SECRET:-}"
GOLDEN_WINDOW_MINUTES="${GOLDEN_WINDOW_MINUTES:-30}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-20}"
POLL_SLEEP_SECONDS="${POLL_SLEEP_SECONDS:-3}"

if [[ -z "$QUERY_URL" ]]; then
  echo "QUERY_URL is required (for example: https://query-worker.example.workers.dev)"
  exit 1
fi
if [[ -z "$ALERT_URL" ]]; then
  echo "ALERT_URL is required (for example: https://alert-worker.example.workers.dev)"
  exit 1
fi
if [[ -z "$DEEP_LINK_BASE" ]]; then
  echo "DEEP_LINK_BASE is required (Pages URL for deep links)"
  exit 1
fi
if [[ -z "$RUNBOOK_BASE_URL" ]]; then
  echo "RUNBOOK_BASE_URL is required (runbook URL base)"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

start_epoch="$(date +%s)"

json_post() {
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

json_get() {
  local url="$1"
  local auth_header="${2:-}"
  local out="$3"

  if [[ -n "$auth_header" ]]; then
    curl -sS -o "$out" -w "%{http_code}" \
      "$url" \
      -H "authorization: Bearer $auth_header"
  else
    curl -sS -o "$out" -w "%{http_code}" "$url"
  fi
}

echo "[1/8] Validate deployed health endpoints"
QUERY_HEALTH_CODE=$(json_get "$QUERY_URL/health" "" "$TMP_DIR/query_health.json")
if [[ "$QUERY_HEALTH_CODE" != "200" ]]; then
  echo "Query worker health failed (status=$QUERY_HEALTH_CODE)"
  cat "$TMP_DIR/query_health.json"
  exit 1
fi
ALERT_HEALTH_CODE=$(json_get "$ALERT_URL/health" "" "$TMP_DIR/alert_health.json")
if [[ "$ALERT_HEALTH_CODE" != "200" ]]; then
  echo "Alert worker health failed (status=$ALERT_HEALTH_CODE)"
  cat "$TMP_DIR/alert_health.json"
  exit 1
fi

if [[ -z "$QUERY_AUTH_TOKEN" ]]; then
  if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
    echo "Set QUERY_AUTH_TOKEN or EMAIL+PASSWORD for query auth"
    exit 1
  fi
  echo "[2/8] Login"
  LOGIN_CODE=$(json_post "$QUERY_URL/auth/login" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "" "$TMP_DIR/login.json")
  if [[ "$LOGIN_CODE" != "200" ]]; then
    echo "Login failed (status=$LOGIN_CODE)"
    cat "$TMP_DIR/login.json"
    exit 1
  fi
  QUERY_AUTH_TOKEN=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.token||"");' "$TMP_DIR/login.json")
  if [[ -z "$QUERY_AUTH_TOKEN" ]]; then
    echo "Login succeeded but token was empty"
    cat "$TMP_DIR/login.json"
    exit 1
  fi
else
  echo "[2/8] Using provided QUERY_AUTH_TOKEN"
fi

echo "[3/8] Trigger ingest (synthetic -> ingest worker)"
RUN_CODE=$(json_post "$QUERY_URL/admin/synthetic-ingest/run" '{}' "$QUERY_AUTH_TOKEN" "$TMP_DIR/synthetic_run.json")
if [[ "$RUN_CODE" != "200" ]]; then
  echo "Synthetic ingest run failed (status=$RUN_CODE)"
  cat "$TMP_DIR/synthetic_run.json"
  exit 1
fi

RUN_TARGET=$(node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const runs=(j.run&&Array.isArray(j.run.runs))?j.run.runs:[];
const first=runs[0]||{};
const out={
  ok:j.ok===true && j.run && j.run.ok===true,
  index:String(first.index||"default"),
  service:String(first.service||"edgedata-demo")
};
process.stdout.write(JSON.stringify(out));
' "$TMP_DIR/synthetic_run.json")

RUN_OK=$(printf "%s" "$RUN_TARGET" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.ok?"1":"0");')
if [[ "$RUN_OK" != "1" ]]; then
  echo "Synthetic ingest response not ok"
  cat "$TMP_DIR/synthetic_run.json"
  exit 1
fi
TARGET_INDEX=$(printf "%s" "$RUN_TARGET" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.index);')
TARGET_SERVICE=$(printf "%s" "$RUN_TARGET" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.service);')

echo "[4/8] Poll search until new data is visible"
TIME_JSON=$(node -e '
const mins=Math.max(5, Number(process.argv[1])||30);
const now=new Date();
const from=new Date(now.getTime()-(mins*60*1000));
process.stdout.write(JSON.stringify({from:from.toISOString(),to:now.toISOString()}));
' "$GOLDEN_WINDOW_MINUTES")
FROM_ISO=$(printf "%s" "$TIME_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.from);')
TO_ISO=$(printf "%s" "$TIME_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.to);')

FOUND_RESULTS=0
for attempt in $(seq 1 "$POLL_ATTEMPTS"); do
  SEARCH_REQ=$(node -e '
const from=process.argv[1];
const to=process.argv[2];
const index=process.argv[3];
const service=process.argv[4];
const req={
  time:{from,to},
  ppl:`search * | where index="${index}" and service="${service}" | sort -ts | head 10`,
  limit:10
};
process.stdout.write(JSON.stringify(req));
' "$FROM_ISO" "$TO_ISO" "$TARGET_INDEX" "$TARGET_SERVICE")

  SEARCH_CODE=$(json_post "$QUERY_URL/search" "$SEARCH_REQ" "$QUERY_AUTH_TOKEN" "$TMP_DIR/search_${attempt}.json")
  if [[ "$SEARCH_CODE" == "200" ]]; then
    RESULT_COUNT=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j.results||[]).length));' "$TMP_DIR/search_${attempt}.json")
    if [[ "$RESULT_COUNT" -gt 0 ]]; then
      FOUND_RESULTS=1
      break
    fi
  fi
  sleep "$POLL_SLEEP_SECONDS"
done

if [[ "$FOUND_RESULTS" != "1" ]]; then
  echo "Search did not find recently ingested events for index=$TARGET_INDEX service=$TARGET_SERVICE"
  ls -1 "$TMP_DIR" | sed -n '1,120p'
  exit 1
fi

echo "[5/8] Apply starter alert pack with deep-link + runbook metadata"
STARTER_REQ=$(node -e '
const index=process.argv[1];
const service=process.argv[2];
const deep=process.argv[3];
const runbook=process.argv[4];
const team=process.argv[5];
process.stdout.write(JSON.stringify({
  index,
  service,
  env:"demo",
  deep_link_base:deep,
  runbook_base_url:runbook,
  owner_team:team
}));
' "$TARGET_INDEX" "$TARGET_SERVICE" "$DEEP_LINK_BASE" "$RUNBOOK_BASE_URL" "$OWNER_TEAM")
STARTER_CODE=$(json_post "$QUERY_URL/alerts/starter-pack/apply" "$STARTER_REQ" "$QUERY_AUTH_TOKEN" "$TMP_DIR/starter_apply.json")
if [[ "$STARTER_CODE" != "200" ]]; then
  echo "Starter pack apply failed (status=$STARTER_CODE)"
  cat "$TMP_DIR/starter_apply.json"
  exit 1
fi

echo "[6/8] Validate runbook/deep-link governance coverage"
ALERTS_CODE=$(json_get "$QUERY_URL/alerts" "$QUERY_AUTH_TOKEN" "$TMP_DIR/alerts.json")
if [[ "$ALERTS_CODE" != "200" ]]; then
  echo "Reading alerts failed (status=$ALERTS_CODE)"
  cat "$TMP_DIR/alerts.json"
  exit 1
fi

GOV_JSON=$(node -e '
const fs=require("fs");
const rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
let starterCount=0;
let withDeep=0;
let withRunbook=0;
let withTeam=0;
let sample=null;
for (const row of rows) {
  let params={};
  let notify={};
  try { params=JSON.parse(row.params_json||"{}"); } catch {}
  try { notify=JSON.parse(row.notify_json||"{}"); } catch {}
  if (!params || !params._starter_id) continue;
  starterCount += 1;
  if (String(notify.deep_link||"").trim()) withDeep += 1;
  if (String(notify.runbook_url||"").trim()) withRunbook += 1;
  if (String(notify.owner_team||"").trim()) withTeam += 1;
  if (!sample) {
    sample={
      index:String(params.index||"default"),
      service:String(params.service||""),
      env:String(params.env||"demo")
    };
  }
}
process.stdout.write(JSON.stringify({starterCount,withDeep,withRunbook,withTeam,sample}));
' "$TMP_DIR/alerts.json")

STARTER_COUNT=$(printf "%s" "$GOV_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.starterCount||0));')
WITH_DEEP=$(printf "%s" "$GOV_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.withDeep||0));')
WITH_RUNBOOK=$(printf "%s" "$GOV_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.withRunbook||0));')
WITH_TEAM=$(printf "%s" "$GOV_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.withTeam||0));')

if [[ "$STARTER_COUNT" -lt 3 || "$WITH_DEEP" -lt 3 || "$WITH_RUNBOOK" -lt 3 || "$WITH_TEAM" -lt 3 ]]; then
  echo "Starter alerts missing governance metadata"
  echo "starter_count=$STARTER_COUNT with_deep=$WITH_DEEP with_runbook=$WITH_RUNBOOK with_team=$WITH_TEAM"
  cat "$TMP_DIR/alerts.json"
  exit 1
fi

echo "[7/8] Trigger alert evaluation run"
if [[ -z "$ALERT_RUN_SECRET" ]]; then
  echo "ALERT_RUN_SECRET is required for manual alert run"
  exit 1
fi
ALERT_RUN_CODE=$(json_post "$ALERT_URL/run" '{}' "$ALERT_RUN_SECRET" "$TMP_DIR/alert_run.json")
if [[ "$ALERT_RUN_CODE" != "200" ]]; then
  echo "Alert run failed (status=$ALERT_RUN_CODE)"
  cat "$TMP_DIR/alert_run.json"
  exit 1
fi
ALERT_EVAL_OK=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.ok===true && Number(j.evaluated||0)>=1?"1":"0");' "$TMP_DIR/alert_run.json")
if [[ "$ALERT_EVAL_OK" != "1" ]]; then
  echo "Alert run response missing expected evaluation result"
  cat "$TMP_DIR/alert_run.json"
  exit 1
fi

echo "[8/8] Verify investigation bootstrap endpoint (deep-link destination payload)"
SCOPE_JSON=$(printf "%s" "$GOV_JSON" | node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(0,"utf8"));
const sample=j.sample||{};
process.stdout.write(JSON.stringify({
  index:String(sample.index||"default"),
  service:String(sample.service||""),
  env:String(sample.env||"demo")
}));
')
SCOPE_SERVICE=$(printf "%s" "$SCOPE_JSON" | node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(j.service||"");')
if [[ -z "$SCOPE_SERVICE" ]]; then
  SCOPE_SERVICE="$TARGET_SERVICE"
fi
BOOTSTRAP_REQ=$(node -e '
const from=process.argv[1];
const to=process.argv[2];
const index=process.argv[3];
const service=process.argv[4];
const env=process.argv[5];
process.stdout.write(JSON.stringify({
  source:"golden_activation",
  time:{from,to},
  scope:{index,service,env},
  pivots:{}
}));
' "$FROM_ISO" "$TO_ISO" "$TARGET_INDEX" "$SCOPE_SERVICE" "demo")
BOOTSTRAP_CODE=$(json_post "$QUERY_URL/investigations/bootstrap" "$BOOTSTRAP_REQ" "$QUERY_AUTH_TOKEN" "$TMP_DIR/bootstrap.json")
if [[ "$BOOTSTRAP_CODE" != "200" ]]; then
  echo "Investigation bootstrap failed (status=$BOOTSTRAP_CODE)"
  cat "$TMP_DIR/bootstrap.json"
  exit 1
fi
BOOTSTRAP_OK=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(Array.isArray(j.starter_queries)&&j.starter_queries.length>0?"1":"0");' "$TMP_DIR/bootstrap.json")
if [[ "$BOOTSTRAP_OK" != "1" ]]; then
  echo "Investigation bootstrap did not return starter queries"
  cat "$TMP_DIR/bootstrap.json"
  exit 1
fi

elapsed="$(( $(date +%s) - start_epoch ))"
if [[ "$elapsed" -gt 3600 ]]; then
  echo "Golden activation exceeded 60 minutes (${elapsed}s)"
  exit 1
fi

echo "Golden activation path passed in ${elapsed}s"
echo "Summary: deploy reachable -> ingest triggered -> search results -> alerts with deep-link/runbook/team -> alert run -> investigation bootstrap"
