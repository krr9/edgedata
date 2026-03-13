# Cloudflare Logpush Source Templates

Connect Cloudflare platform signals to EdgeData using Logpush.

## Architecture

Two complementary ingestion paths serve different signal types:

| Signal Type | Path | Latency |
|---|---|---|
| **Cloudflare platform logs** (HTTP, WAF, Workers) | Logpush → EdgeData ingest endpoint | Seconds (real-time) |
| **Application logs** (your services) | OTel Collector / Vector → EdgeData `/v1/logs` | Seconds (real-time) |

Logpush does not emit OpenTelemetry format -- and it doesn't need to. EdgeData maps Cloudflare's native field schemas directly. Use the OTLP ingest path (`/v1/logs`, `/v1/traces`) for your own application telemetry.

### Why HTTP destination, not R2 landing + reprocess?

Logpush supports pushing directly to an HTTPS endpoint. Pointing it at the EdgeData ingest worker avoids the R2→reprocess→R2 round trip entirely:

```
Logpush ──POST──→ /ingest ──→ raw R2 + events/ + tokens/ + WAE
                    ↑
            Logpush parser detects CF
            fields, normalizes inline
```

No intermediate storage. No batch reprocess. No cron job. The same pipeline that handles OTLP and agent-pushed logs handles Logpush.

The reprocess endpoint (`POST /reprocess` with `source_prefix`) exists for **backfilling historical Logpush data** that already lives in R2. It should not be the steady-state ingestion path.

## Supported Datasets

| Logpush Dataset | EdgeData Index | Fields Mapped |
|---|---|---|
| HTTP Requests | `cf-http-requests` | Method, URI, status, latency, RayID, client IP, host |
| Firewall Events | `cf-firewall-events` | Action, rule, source, method, URI, client IP |
| Workers Trace Events | `cf-workers-trace` | Script, outcome, logs, exceptions, RayID, status |

## Setup: Logpush → EdgeData Ingest (HTTP Destination)

### Step 1: Note your ingest worker URL and secret

```bash
# Your deployed ingest worker URL
INGEST_URL="https://ingest-worker.<subdomain>.workers.dev"

# The bearer token configured as INGEST_SECRET on the ingest worker
INGEST_SECRET="<your-ingest-secret>"
```

### Step 2: Create a Logpush job with HTTP destination

The `destination_conf` points directly at the ingest endpoint. Auth is passed via the `header_Authorization` URL parameter.

**HTTP Requests:**

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/logpush/jobs" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "edgedata-http-requests",
    "output_options": {
      "field_names": [
        "ClientIP", "ClientRequestHost", "ClientRequestMethod",
        "ClientRequestURI", "ClientRequestUserAgent",
        "EdgeStartTimestamp", "EdgeEndTimestamp", "EdgeResponseStatus",
        "OriginResponseTime", "RayID",
        "CacheCacheStatus", "SecurityLevel",
        "WAFAction", "WAFRuleID",
        "WorkerSubrequest", "WorkerStatus"
      ],
      "timestamp_format": "rfc3339"
    },
    "destination_conf": "'"${INGEST_URL}/ingest?header_Authorization=Bearer%20${INGEST_SECRET}"'",
    "max_upload_bytes": 5000000,
    "max_upload_records": 1000,
    "dataset": "http_requests",
    "enabled": true
  }'
```

**Firewall Events:**

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/logpush/jobs" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "edgedata-firewall-events",
    "output_options": {
      "field_names": [
        "Action", "ClientIP", "ClientRequestHost",
        "ClientRequestMethod", "ClientRequestURI",
        "Datetime", "RayID", "RuleId", "Source",
        "ClientCountry", "ClientASN", "EdgeColoCode"
      ],
      "timestamp_format": "rfc3339"
    },
    "destination_conf": "'"${INGEST_URL}/ingest?header_Authorization=Bearer%20${INGEST_SECRET}"'",
    "max_upload_bytes": 5000000,
    "max_upload_records": 1000,
    "dataset": "firewall_events",
    "enabled": true
  }'
```

**Workers Trace Events:**

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/logpush/jobs" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "edgedata-workers-trace",
    "output_options": {
      "field_names": [
        "ScriptName", "Outcome", "EventTimestampMs",
        "EventType", "Event", "Logs", "Exceptions",
        "DispatchNamespace"
      ],
      "timestamp_format": "rfc3339"
    },
    "destination_conf": "'"${INGEST_URL}/ingest?header_Authorization=Bearer%20${INGEST_SECRET}"'",
    "max_upload_bytes": 5000000,
    "max_upload_records": 1000,
    "dataset": "workers_trace_events",
    "enabled": true
  }'
```

**Notes on Logpush job configuration:**

- `max_upload_records: 1000` aligns with the ingest worker's default batch limit.
- `max_upload_bytes: 5000000` (5MB) keeps individual payloads within the ingest worker's body size limit. If you increase this, also set `INGEST_MAX_BODY_BYTES` on the ingest worker (default: 3145728).
- `timestamp_format: "rfc3339"` is recommended. EdgeData handles both RFC3339 and nanosecond timestamps, but RFC3339 is cleaner for debugging.
- Logpush sends a gzipped `{"content":"tests"}` validation payload when the job is created. The ingest worker accepts this automatically.

### Step 3: Verify in EdgeData

Wait 1-2 minutes for Logpush to start pushing, then search:

```
search * | where index="cf-http-requests" | head 50
search * | where index="cf-firewall-events" and level="error" | head 50
search * | where index="cf-workers-trace" and level="error" | head 50
```

### Step 4 (optional): Increase body size limit for high-volume zones

For zones with heavy traffic, Logpush batches may exceed the default 3MB body limit. Set `INGEST_MAX_BODY_BYTES` on the ingest worker:

```bash
npx wrangler secret put INGEST_MAX_BODY_BYTES --config workers/ingest-worker/wrangler.toml
# Enter: 10485760  (10MB)
```

Or set it as a var in `wrangler.toml`:

```toml
[vars]
INGEST_MAX_BODY_BYTES = "10485760"
```

## Backfill: Reprocessing Historical Logpush Data from R2

If you have existing Logpush data in R2 (from a prior Logpush→R2 job), you can backfill it into EdgeData using the reprocess endpoint:

```bash
curl -X POST "${INGEST_URL}/reprocess" \
  -H "Authorization: Bearer ${REPROCESS_SECRET}" \
  -H "Content-Type: application/json" \
  --data '{
    "source_prefix": "logpush/http-requests/",
    "max_objects": 500,
    "dry_run": false
  }'
```

Or via the CLI:

```bash
INGEST_URL=<url> REPROCESS_SECRET=<secret> \
npm run ops:reprocess -- --source-prefix logpush/http-requests/ --max-objects 500 --apply
```

Reprocess auto-detects Logpush format from field names. Use this for one-time migration, not steady-state ingestion.

## Field Mapping Reference

### HTTP Requests

| Cloudflare Field | EdgeData Field | Transform |
|---|---|---|
| `EdgeStartTimestamp` | `ts` | RFC3339 or nanosecond → ISO |
| `ClientRequestHost` | `service`, `host` | Direct |
| `EdgeResponseStatus` | `status` | Direct |
| `EdgeResponseStatus` | `level` | ≥500 → error, ≥400 → warn, else info |
| `OriginResponseTime` | `duration_ms` | Nanoseconds → milliseconds |
| `RayID` | `request_id` | Direct |
| `ClientIP` | `src_ip` | Direct |
| Method + URI + status + duration | `message` | `"GET /api/v1 200 12ms ray=abc"` |
| All other fields | `attrs_json` | Preserved as JSON |

Auto-assigned: `index` = `cf-http-requests`, `env` = `prod`.

### Firewall Events

| Cloudflare Field | EdgeData Field | Transform |
|---|---|---|
| `Datetime` | `ts` | RFC3339 → ISO |
| `ClientRequestHost` | `service`, `host` | Direct |
| `Action` | `level` | block/drop → error, challenge → warn, else info |
| `RayID` | `request_id` | Direct |
| `ClientIP` | `src_ip` | Direct |
| Action + method + URI + IP + rule | `message` | `"block: POST /login from 1.2.3.4 (rule=abc, source=waf)"` |
| All other fields | `attrs_json` | Preserved as JSON |

Auto-assigned: `index` = `cf-firewall-events`, `env` = `prod`.

### Workers Trace Events

Each trace record produces **multiple EdgeData events**:

1. One root event (outcome, request info).
2. One event per `Logs[]` entry (console output).
3. One event per `Exceptions[]` entry (uncaught errors).

| Cloudflare Field | EdgeData Field | Transform |
|---|---|---|
| `EventTimestampMs` | `ts` | Milliseconds → ISO |
| `ScriptName` | `service` | Direct |
| `Outcome` | `level` | exception/exceededCpu → error, canceled → warn, ok → info |
| `Event.RayID` | `request_id` | Direct |
| `Event.Response.Status` | `status` | Direct |
| `Logs[].Message` | `message` (per entry) | Direct |
| `Logs[].Level` | `level` (per entry) | Direct |
| `Exceptions[].Name + Message` | `message` (per entry) | `"TypeError: x is not a function"` |

Auto-assigned: `index` = `cf-workers-trace`, `env` = `prod`.

## Recommended Minimum Field Sets

Include at least these fields in each Logpush job. Additional fields are preserved in `attrs_json`.

**HTTP Requests:**
`ClientIP`, `ClientRequestHost`, `ClientRequestMethod`, `ClientRequestURI`, `EdgeStartTimestamp`, `EdgeResponseStatus`, `OriginResponseTime`, `RayID`

**Firewall Events:**
`Action`, `ClientIP`, `ClientRequestHost`, `ClientRequestMethod`, `ClientRequestURI`, `Datetime`, `RayID`, `RuleId`, `Source`

**Workers Trace Events:**
`ScriptName`, `Outcome`, `EventTimestampMs`, `EventType`, `Event`, `Logs`, `Exceptions`

## Starter Alerts for Logpush Sources

Once Logpush data flows through EdgeData, create alerts for:

| Alert | Query |
|---|---|
| Edge 5xx spike | `search * \| where index="cf-http-requests" and status>=500 \| stats count() by service` |
| WAF block surge | `search * \| where index="cf-firewall-events" and level="error" \| stats count() by service` |
| Workers exception spike | `search * \| where index="cf-workers-trace" and level="error" \| stats count() by service` |

## Validation Checklist

- [ ] Logpush job created and enabled (HTTP destination pointing at ingest worker)
- [ ] Ingest worker returns 200 for Logpush validation payload
- [ ] Search returns results for `index="cf-http-requests"` (or other dataset index)
- [ ] `request_id` field contains RayID values (confirms field mapping works)
- [ ] Dashboards show Logpush data alongside application logs
- [ ] At least one Logpush-specific alert is enabled

## Troubleshooting

**Logpush job creation fails with "error validating destination":**
The ingest worker must be deployed and reachable at the configured URL. Verify with `curl ${INGEST_URL}/health`. The worker automatically accepts Logpush's gzipped `{"content":"tests"}` validation payload.

**Logpush job enabled but no data appears:**
Logpush batches every 5-30 seconds. Wait a few minutes. Check the Logpush job status in the Dashboard under Analytics > Logs. If the job shows errors, check the ingest worker logs for auth failures or body size rejections.

**Events ingested but field values look wrong:**
Ensure `timestamp_format: "rfc3339"` in the Logpush job output options. Verify that field names in the Logpush job match the documented field names (PascalCase, e.g., `EdgeStartTimestamp` not `edge_start_timestamp`).

**Payload too large errors:**
Logpush batches can exceed the default 3MB limit for high-traffic zones. Either reduce `max_upload_bytes` in the Logpush job or increase `INGEST_MAX_BODY_BYTES` on the ingest worker.
