# EdgeData
# Edge-Native Log Search & SIEM-lite (Cloudflare-Only)
## Full Product + Technical Specification (Operational-First, Deep-Search-Backed)
**Version:** 1.2  
**Date:** 2026-03-08  
**Deployment model:** Self-hosted in *customer* Cloudflare account (single-tenant per CF account)  
**Primary objective:** Cloudflare-native operational product for SMB/mid companies that run on Cloudflare, with deep search as the core troubleshooting engine.

Auth/RBAC canonical spec: `docs/PRD_AUTH_RBAC.md` (SSO-first for existing Cloudflare customers).
Execution roadmap: `docs/EXECUTION_PLAN_30_60_90.md`.

---

## Table of contents
1. Product scope & principles  
2. Architecture  
3. Data model & schemas (canonical schema + query-store options + WAE)  
4. Search design (token index + query planner)  
5. Ingestion design (agents + ingest Worker)  
6. Storage design (R2 raw + optional query-store integration)  
7. Query layer (Query Worker)  
8. UI (Pages)  
9. Alerting (Alert Worker)  
10. Security & tenancy  
11. Reliability, backpressure, and failure modes  
12. Performance & cost controls  
13. Deployment (wrangler + optional Terraform)  
14. Observability & operations  
15. Extension guidance (Phase C & D)  
16. Acceptance criteria & test plan  
17. Appendix (schemas, stopwords, example queries, API contracts)

---

# 1) Product scope & principles

## 1.1 Target customer profile (ICP) and jobs-to-be-done
**Target account profile**
- Small/mid companies (roughly 20–500 employees) that have standardized on Cloudflare for edge/app delivery and access control.
- Typically 5–80 engineers, with few or no dedicated observability specialists.
- Need self-hosted control (their Cloudflare account), predictable spend, and low operational overhead.

**Primary personas**
- Platform/DevOps generalist: owns deployment, uptime, and incident tooling.
- On-call application engineer: needs fast root-cause during incidents.
- Security/compliance generalist: needs alerting, auditability, and retention controls.
- Technical buyer (CTO/Head of Eng): wants business-safe reliability without enterprise SIEM complexity.

**Core jobs**
- Detect production issues quickly (edge + app signals).
- Triage and isolate root cause in minutes, not hours.
- Route actionable alerts into existing team workflows (Slack/webhook).
- Maintain defensible access controls and audit trail without standing up extra infrastructure.

## 1.2 Phases implemented by this spec
### Phase A: Logs + dashboards + **deep search**
- Ingest logs from common sources (app logs, nginx, syslog-ish, structured JSON)
- Deep search with:
  - time range + filters (service/env/host/level/status)
  - keyword search (fast)
  - phrase/substring search (bounded)
  - pivots (trace_id/request_id/user_id/ip/msg_hash)
- Dashboards: throughput, error rate, latency distributions, top errors
- Operator UX: saved searches, query transparency, and service-centric triage views

### Phase B: Alerts
- Scheduled evaluations
- Alert state management (dedupe + cooldown + “still firing”)
- Notification channels: Slack webhook + generic webhook (email/PagerDuty later)
- Operational workflows: alert deep-links to prefilled investigations + runbook metadata

## 1.3 Non-goals (A & B)
- No full SIEM correlation engine (that’s Phase C)
- No full-text inverted index like Elastic (we approximate with token indexing + bounded substring scans)
- No multi-tenant SaaS (each customer deploys into their CF account)
- No “blank slate analytics platform”; this is an opinionated operations product first
- No attempt to replace every Cloudflare built-in analytics screen; we focus on cross-signal operations workflow
- No enterprise-SOC feature parity race in Phase A/B

## 1.4 Design principles
1. **Operational outcomes first**: optimize for MTTD/MTTR and incident clarity, not query-language sophistication alone.  
2. **Cloudflare-native default path**: Access, Workers, Pages, R2, WAE, D1 should be first-class and low-friction.  
3. **Deep search is the truth layer**: dashboards/alerts summarize; deep search must always support drilldown and recall.  
4. **Opinionated defaults over blank canvas**: ship with starter dashboards, alerts, and investigation patterns.  
5. **Predictable spend and bounded blast radius**: guardrails on expensive paths (phrase scans, candidates, windows).  
6. **Secure self-hosted by default**: tenant control, Access-first auth, clear secret boundaries.  
7. **Fail-open ingestion where safe**: preserve raw source-of-truth and support reprocessing.
8. **Differentiate on workflow, not storage internals**: invest in alert-to-investigation speed, runbook context, and operator outcomes over provider-level query backend implementation details.

## 1.5 Success metrics (product + business)
**Adoption/activation**
- Time-to-first-value: fresh deploy to first dashboard + first working alert in <= 60 minutes.
- At least 80% of new deployments enable >= 3 starter alerts in week 1.

**Operational outcome**
- P50 triage time for common incidents (error spike, latency regression, auth failures) under 10 minutes.
- Alert payloads include deep-link + runbook context 100% of the time.

**Technical efficiency**
- Phase A query latency targets met under guardrails (see section 16).
- Cost envelope remains predictable at SMB volumes (bounded by token/phrase/candidate constraints).

## 1.6 Competitive stance in Cloudflare-first environments
- EdgeData complements Cloudflare native observability tools rather than replacing them.
- Winning wedge: one operational plane for app + edge logs, saved investigations, and alert stateful workflows.
- The product should feel like “Cloudflare operations control center,” not “another generic log viewer.”

---

# 2) Architecture

## 2.1 Components
**Source adapters**
- Agent path: Vector (preferred) or Fluent Bit on customer infra.
- Cloudflare-native path: Cloudflare Logpush sources landing in R2 raw partitions, then normalized/reprocessed into `events` + `tokens`.

**Cloudflare Workers**
- `ingest-worker`: receives batches, authenticates, normalizes, writes hot+cold.
- `query-worker`: auth-gated API for search + dashboards; owns query planning.
- `alert-worker`: cron-triggered evaluator of alert rules; sends notifications with investigation links.

**Storage**
- Workers Analytics Engine (WAE): hot aggregation + alert evaluation (recent window).
- R2 Raw: immutable NDJSON partitioned by time/service (audit + reprocessing).
- R2 index partitions (`events` + `tokens`) as the default deep-search backend in v1.
- Optional provider-managed query-store integration (for example, Data Catalog/Iceberg + SQL) as a non-differentiating accelerator path.
- D1: saved searches, alert definitions, alert state, user preferences.

**UI**
- Cloudflare Pages (React/Vue), protected with Cloudflare Access.

## 2.2 Data flows

### Ingestion flow
Agent → (HTTP) → Ingest Worker  
Ingest Worker → (async)  
- WAE write (metrics/aggregates)
- R2 raw NDJSON write
- R2 event index write
- R2 token index write

Optional integration path:
- provider-managed query-store writes for acceleration/compliance use-cases

Cloudflare Logpush source → R2 raw landing prefix → Reprocess/normalization job → `events` + `tokens` indexes

### Query flow
UI → Query Worker →  
- WAE SQL API (dashboards + fast aggregates)
- Deep-search backend (default: R2 partitioned `events`/`tokens`; optional: provider-managed SQL path)

### Alert flow
Cron → Alert Worker →  
- WAE SQL (default)
- Optional deep-search backend for advanced alerts
→ Slack/Webhook

---

# 3) Data model & schemas

## 3.1 Canonical event schema (internal representation)
All incoming events are normalized into:

| Field | Type | Required | Notes |
|---|---:|:---:|---|
| `event_id` | string | ✅ | ULID or stable hash; used for dedupe/drilldown |
| `ts` | timestamp | ✅ | event timestamp (UTC) |
| `date` | string | ✅ | `YYYY-MM-DD` derived from `ts` |
| `hour` | int | ✅ | 0–23 derived from `ts` |
| `service` | string | ✅ | app/service name |
| `env` | string | ✅ | prod/stage/dev |
| `host` | string | ✅ | hostname/pod/node |
| `level` | string | ✅ | debug/info/warn/error |
| `message` | string | ✅ | full raw message |
| `message_lc` | string | ✅ | lowercased for case-insensitive searching |
| `msg_hash` | string | ✅ | hash of message for grouping |
| `trace_id` | string | ⛔ | optional |
| `request_id` | string | ⛔ | optional |
| `status` | int | ⛔ | HTTP status / app status |
| `duration_ms` | double | ⛔ | latency |
| `src_ip` | string | ⛔ | client IP if available |
| `user_id` | string | ⛔ | user id if available |
| `attrs_json` | string | ⛔ | JSON-encoded additional fields (bounded) |

**Notes**
- Keep `attrs_json` bounded (e.g., max 8–16KB) and consider dropping high-cardinality junk.
- Extract a known set of “first-class” fields (status, duration, ip, user) into columns.

---

## 3.2 Queryable store options for deep search

### 3.2.1 `events` schema contract (primary deep search shape)
**Partitioning / layout (v1 recommended)**
- Partition by `date` and `service`
- Add `env` to partition only if it’s high-volume and frequently filtered.
- Avoid partitioning by `hour` unless daily volumes are huge (it creates many small partitions).

**Columns (logical contract)**
- `event_id` STRING
- `ts` TIMESTAMP
- `date` STRING
- `hour` INT
- `service` STRING
- `env` STRING
- `host` STRING
- `level` STRING
- `message` STRING
- `message_lc` STRING
- `msg_hash` STRING
- `trace_id` STRING
- `request_id` STRING
- `status` INT
- `duration_ms` DOUBLE
- `src_ip` STRING
- `user_id` STRING
- `attrs_json` STRING

**Why store full message?**
Because this is a search product. Token index accelerates search; message column provides exact recall.

### 3.2.2 `tokens` schema contract (accelerator index)
Purpose: fast keyword search without scanning full `message` in the `events` table.

**Columns**
- `date` STRING
- `hour` INT
- `service` STRING
- `env` STRING
- `token` STRING
- `event_id` STRING

**Partitioning**
- Same as `events`: `date`, `service` (+ optional `env`)

**Cardinality control**
- Enforce max N tokens per event (suggested 12).
- Enforce token length (2–32 chars).
- Drop purely numeric tokens except whitelisted (e.g., 500, 404, 503).

### 3.2.3 Backend implementation options
- Default v1: partitioned object-backed indexes (`events` and `tokens`) queried via the query-worker planner.
- Optional integration: provider-managed query-store (for example, Data Catalog/Iceberg + SQL) when it improves operations without becoming product-critical coupling.

Implementation note:
- Treat this section as a logical schema contract; backend engine choice is an implementation detail and should remain swappable.

---

## 3.3 Hot dataset (Workers Analytics Engine)
WAE is for aggregates and alert evaluation.

**Dataset:** `log_metrics`

**WAE datapoint mapping**
- `blobs` (dimensions):  
  1. `service`  
  2. `env`  
  3. `host`  
  4. `level`  
  5. `msg_hash` (or error_signature)  
  6. `route` (optional)  
- `doubles` (metrics):  
  1. `count` (always 1)  
  2. `status` (or 0)  
  3. `duration_ms` (or 0)  
- `indexes` (optional high-cardinality index):  
  - use `service` or `env:service` if needed

**Guideline:** do NOT put full message in WAE; keep it small and aggregatable.

---

# 4) Search design

## 4.1 Search requirements
Search supports:
- time range (required)
- structured filters: service/env/host/level/status/user_id/src_ip
- keyword search: `timeout`, `postgres`, `nullpointer`
- phrase search: `"connection refused"` (bounded)
- pivots: click msg_hash/trace_id/request_id to filter

## 4.2 Query planner overview (Query Worker)
Because the deep-search backend may vary by deployment and capability, the query worker implements a planner with backend-agnostic guardrails:

**If query has no keyword/phrase:**  
→ single backend query on `events` with filters + time range + ORDER BY ts DESC + LIMIT.

**If query has keyword(s):**  
→ token-accelerated flow:
1) backend query on `tokens` to fetch candidate `event_id`s (bounded)
2) backend query on `events` with `event_id IN (...)` in chunks
3) Merge + sort by `ts` in worker
4) Return page

**If query has phrase/substring:**  
→ bounded scan:
- Require tight time range and service/env filter
- Query `events` with phrase/substring matching (`message_lc LIKE '%phrase%'` where supported)
- Possibly add token pre-filter if phrase includes keywords

## 4.3 Query language (UI-level)
Provide a simple K/V query language (Splunk-ish lite):

Examples:
- `service=payments env=prod level=error`
- `status>=500 duration_ms>1000`
- `q=timeout postgres`
- `phrase="connection refused"`

Query worker parses this to:
- structured predicates
- token list
- phrase pattern

## 4.4 Tokenization algorithm
**Input:** `message_lc`  
**Steps:**
1. Normalize: lowercase, unicode normalize, replace `_` and `-` with space.
2. Split on non-alphanumeric.
3. Filter:
   - length 2..32
   - drop stopwords (see Appendix)
   - drop tokens with >60% digits unless whitelisted
4. Deduplicate tokens within an event
5. Cap to top N tokens (12) by:
   - prefer alphabetic tokens
   - prefer exception names / known keywords
   - include status code (e.g., 500) if present
6. Add synthetic tokens:
   - `level:error`
   - `status:500`
   - `svc:payments`
   - (optional) `host:api-01` (careful: can blow up cardinality)

**Why synthetic tokens?**
They enable “fast search” even when structured filters aren’t used by the user.

## 4.5 Ranking and pagination
- Primary sort: `ts DESC`
- Secondary: `event_id` for stable ordering
- Pagination:
  - Use cursor-based pagination: `before_ts`, `before_event_id`
  - Avoid OFFSET (expensive/unstable)

---

# 5) Ingestion design

## 5.1 Source onboarding model (Cloudflare-native + agent)
Two first-class onboarding paths:
- **Path A (agent):** Vector/Fluent Bit/OpenTelemetry Collector pushes normalized batches to `/ingest` (or OTLP-compatible log paths).
- **Path B (Cloudflare-native):** Logpush feeds R2 landing prefixes; reprocess job normalizes into queryable indexes.

Both paths must produce the same canonical schema (section 3.1) so operations workflows stay uniform.

## 5.2 Agent configuration (Vector recommended)
**Required capabilities**
- File tailing, JSON parsing, remap transforms
- HTTP batching + backpressure
- Add host/service/env metadata at source

**Batching**
- Start with `batch.max_events = 100`
- Keep under:
  - Worker request size constraints
  - WAE datapoint limit: max 250 datapoints per invocation
- If you write 1 WAE datapoint per event, keep ≤ 200 per request as buffer.

## 5.3 Ingest endpoint contract
**HTTP:** `POST /ingest`  
Also supported for OTLP compatibility:
- `POST /v1/logs`
- `POST /otlp/v1/logs`
**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` OR HMAC scheme below
- `X-Agent-Id: <string>` (optional)
- `X-Timestamp: <unix_ms>` (required for HMAC)
- `X-Signature: <hex>` (required for HMAC)

**Body (pluggable parser framework):**
- EdgeData JSON array of log objects
- EdgeData wrapped body: `{ events: [...] }`
- OpenTelemetry OTLP/HTTP JSON logs: `{ resourceLogs: [...] }`
- NDJSON (one JSON log object per line)

## 5.4 Authentication (production)
### Option A: Bearer token (simplest)
- `Authorization: Bearer <INGEST_SECRET>`
- Rotate by updating Worker secret + agent configs

### Option B: HMAC (recommended)
- `sig = HMAC_SHA256(secret, timestamp + "." + raw_body_bytes)`
- Reject if timestamp skew > 5 minutes
- Reject if signature mismatch
- Optionally store a small replay cache keyed by (agent_id, timestamp, sig) in DO/KV

## 5.5 Normalization rules
For each incoming event:
- determine `ts`:
  - prefer provided timestamp if parseable
  - else use ingestion time
- set defaults:
  - `service` from agent config or header
  - `env` from agent config
  - `host` from agent or derived
- ensure `level` normalized to: debug/info/warn/error
- compute:
  - `message_lc = message.lower()`
  - `msg_hash = sha1(message_lc)` (or xxhash)
  - `event_id`:
    - prefer ULID generated at ingest
    - OR stable hash of `(ts_bucket, host, message_lc, request_id)` to help dedupe

## 5.6 Write strategy (tri-write)
**Goal:** fast ack to agent, async processing.

In `fetch()`:
- validate auth
- parse body
- `ctx.waitUntil(processBatch(events))`
- return `200 Ingested` quickly

In `processBatch`:
1) Write raw NDJSON to R2 (single object per batch)
2) Write WAE datapoints (batched)
3) Write index rows (`events` and `tokens`)

**Ordering**
- Prefer writing raw R2 first (source of truth)
- If index write fails, you can reprocess from raw later

## 5.7 Cloudflare-native source templates (must-have for target segment)
Ship starter source templates for Cloudflare-first teams:
- HTTP request logs / edge errors
- WAF/security events
- Access/authentication events
- Workers runtime/application logs

Template requirements:
- deterministic mapping into canonical schema
- documented field mapping and dropped-field policy
- “ingested + searchable + alertable” validation checklist

---

# 6) Storage design

## 6.1 R2 raw layout
Store NDJSON with time+service partition keys:

```
raw/date=YYYY-MM-DD/index=<index>/hour=HH/service=<service>/env=<env>/part-<ulid>.ndjson
```

**Object metadata (optional)**
- `x-min-ts`, `x-max-ts`, `x-count`, `x-index`, `x-service`, `x-env`

**Compression**
- Optional gzip for cost reduction; if used, mark content-encoding and adjust reprocessing.

## 6.2 Query-store implementation strategy
Two supported approaches:

### Path 1: Default object-backed indexes (recommended for v1 differentiation)
- Ingest Worker writes normalized rows to partitioned `events` and `tokens` objects.
- Query-worker planner executes structured/token/phrase flows against these indexes with strict guardrails.
- Pros: low coupling to provider-specific storage internals, clearer product ownership, fast iteration on operator workflows.
- Cons: requires disciplined partition hygiene and planner optimization at higher volume tiers.

### Path 2: Optional provider-managed query-store integration
- Use managed query-store capabilities when available (for example, Data Catalog/Iceberg + SQL).
- Treat this as an acceleration/compliance option, not a required product dependency.
- Pros: can simplify scale operations where provider capabilities are mature.
- Cons: roadmap coupling and potential overlap with provider-native offerings.

**Spec assumption:** ship and validate differentiation on Path 1 first; enable Path 2 only when it clearly improves outcomes without diluting product identity.

## 6.3 Maintenance and partition health
- Monitor partition/object health for `events` and `tokens` to avoid query degradation over time.
- Keep partition strategy aligned with common filters (date/service/env) and avoid unnecessary granularity early.
- If optional provider-managed query-store integration is enabled, inherit and monitor its maintenance mechanisms.

---

# 7) Query layer (Query Worker)

## 7.1 Responsibilities
- Authenticate user (Access JWT / SSO)
- Enforce query guardrails
- Parse user query language
- Plan queries (token-first, bounded scan)
- Execute deep-search plans against the active backend and WAE SQL API calls for aggregates
- Merge, sort, paginate results
- Return stable JSON to UI

## 7.2 Endpoints
### `GET /health`
Returns version and basic status.

### `POST /search`
Request:
```json
{
  "time": { "from": "2026-02-16T22:00:00Z", "to": "2026-02-16T23:00:00Z" },
  "ppl": "search timeout postgres | where index=\"default\" and service=\"payments\" and env=\"prod\" and level=\"error\" | head 200",
  "limit": 200,
  "cursor": null
}
```

Response:
```json
{
  "results": [ { "ts": "...", "service": "...", "message": "...", "event_id": "..." } ],
  "next_cursor": { "before_ts": "...", "before_event_id": "..." },
  "stats": { "scanned_partitions": 12, "candidates": 1300, "returned": 200 }
}
```

### `POST /dashboards/query`
Proxy to WAE SQL templates; only allow predefined queries.

### `POST /saved-searches/*`
CRUD for saved searches in D1.

## 7.3 Guardrails
- Require time range for all searches.
- Default max time window:
  - structured search: 7 days
  - token search: 14 days (if partitions are prunable)
  - phrase search: 6 hours (configurable)
- Hard limit result rows per request: 200–500
- Candidate cap for token search: 5,000 event_ids (configurable)
- Chunk `IN (...)` lists (e.g., 250 ids per backend call)

## 7.4 Query execution algorithms

### Structured-only
Single backend query:
- WHERE date in range AND ts between range
- AND filters
- ORDER BY ts DESC
- LIMIT N

### Token search
1) Build token set from `q`:
   - tokenize q using same tokenizer
2) backend query `tokens`:
   - WHERE date in range AND service/env filters AND token IN (...)
   - LIMIT candidate_cap
3) Fetch events in chunks:
   - WHERE event_id IN (...)
   - optional additional filters
4) Merge, sort by ts desc, apply cursor pagination.

### Phrase search
- Require narrow window + service filter
- backend phrase scan: `WHERE message_lc LIKE '%phrase%'` where supported
- LIMIT N
- If phrase includes tokens, optionally prefilter via token step then apply phrase filter in worker.

---

# 8) UI (Cloudflare Pages)

## 8.1 Pages app features (v1)
- Operations Home
  - “what changed in the last hour” summary
  - active alerts and service risk indicators
  - quick links to top investigations
- Log Explorer
  - time picker
  - filter panel
  - search box
  - results table
  - log detail drawer (full message, attrs_json, pivots)
- Dashboards
  - throughput/errors/latency charts
  - top services, top hosts
  - top error signatures (msg_hash)
- Saved searches
- Alert + runbook catalog (template-backed, not blank by default)

## 8.2 UX for deep search
- Search box supports:
  - keywords
  - quoted phrase
  - `field=value` filters
- “Search mode” indicator:
  - Structured / Token / Phrase (auto-chosen)
- Show “query stats” (candidates, partitions scanned) for transparency
- Promote pivots and one-click narrowing over manual query rewriting

## 8.3 Security
- Protect Pages with Cloudflare Access
- Query Worker validates identity (don’t rely on frontend)

## 8.4 Operator-first UX constraints
- Primary workflows must be executable by generalist engineers, not only query experts.
- Every alert screen must include:
  - last firing context
  - direct deep-search link
  - runbook link (if configured)
- Preserve “explainability”: user should see why an alert fired and what data window was evaluated.

---

# 9) Alerts (Phase B)

## 9.1 Alert definitions (D1)
Tables:

### `alerts`
- `id` TEXT PRIMARY KEY
- `name` TEXT
- `enabled` INT
- `type` TEXT (e.g., `wae_sql`, `r2sql_token_spike`)
- `query_template` TEXT
- `params_json` TEXT
- `schedule_seconds` INT (60, 300, 900)
- `threshold_json` TEXT
- `notify_json` TEXT (channels + severity + optional `runbook_url` + owner/team metadata)
- `cooldown_seconds` INT
- `created_at` TEXT
- `updated_at` TEXT

### `alert_state`
- `alert_id` TEXT PRIMARY KEY
- `last_evaluated_at` TEXT
- `last_fired_at` TEXT
- `is_firing` INT
- `last_value_json` TEXT
- `fingerprint` TEXT (dedupe key for incident-like behavior)

## 9.2 Alert Worker execution model
Cron runs every minute:
1) Load enabled alerts
2) For each alert due:
   - Execute query (prefer WAE SQL)
   - Evaluate threshold
   - Apply cooldown/dedupe
   - Send notifications
   - Update state

## 9.3 Alert types to ship
- Error rate per service exceeds X% over last 5m (WAE)
- p95 latency exceeds threshold (WAE)
- Token spike: token count over threshold for last 5m (WAE or R2SQL depending on implementation)
- Authentication failure spike (Access/app auth events)
- Traffic drop anomaly for business-critical services

## 9.4 Notifications (v1)
- Slack incoming webhook
- Generic webhook

**Payload format**
- alert name, severity, value, time window
- deep link to UI with prefilled search
- runbook URL + ownership metadata when configured

## 9.5 Starter alert pack (required for activation)
Default enabled/one-click templates:
- Service 5xx rate spike
- p95 latency regression
- Auth failure spike
- WAF block surge (if source connected)
- Ingestion pipeline degradation

---

# 10) Security & tenancy

## 10.1 Tenancy model
- Single tenant per Cloudflare account deployment.
- Multi-env is modeled via `env` field.

## 10.2 Secrets
- `INGEST_HMAC_SECRET` or `INGEST_BEARER_SECRET`
- `CF_API_TOKEN` for WAE SQL API (scoped minimally)
- Slack/webhook secrets
- Access JWT validation parameters

## 10.3 Abuse prevention
- Rate limit ingestion endpoint by agent id/IP
- Reject oversized payloads
- Reject unauth attempts quickly
- Optionally add WAF rules at the route

---

# 11) Reliability & failure modes

## 11.1 Backpressure
- Agent (Vector) handles backpressure; configure retries.
- Ingest worker must:
  - return 200 quickly
  - do heavy work async
- If downstream writes fail:
  - raw R2 is source-of-truth
  - reprocessing job can rebuild `events`/`tokens` indexes later

## 11.2 Partial failure behavior
- If WAE write fails: still store raw + indexes; dashboards may lag.
- If index write fails: store raw; mark ingestion status; reprocess.
- If raw R2 fails: return 500 (since you lose source-of-truth).

## 11.3 Idempotency & duplicates
- Event IDs allow dedupe at query time if needed.
- For reprocessing, dedupe by `event_id`.

---

# 12) Performance & cost controls

## 12.1 Partitioning strategy
- Partition by `date`, `service` first.
- Add `env` if queries frequently filter env and volumes are large.
- Avoid `hour` partition unless necessary.

## 12.2 Token index cost control
- Cap tokens per event (12)
- Drop stopwords and noisy tokens
- Consider a “token whitelist” for certain sources if very noisy

## 12.3 Phrase search constraints
Phrase search is the most expensive; enforce:
- must specify service
- must be ≤ 6 hours
- must set limit ≤ 200

---

# 13) Deployment

## 13.1 Wrangler configuration outline
You will have three Workers and one Pages app.

### ingest-worker `wrangler.toml` (example)
- bindings:
  - R2 bucket (raw)
  - WAE dataset
  - (optional) pipeline endpoint config
- secrets:
  - ingest secret

### query-worker
- D1 binding
- WAE SQL API token (if proxying WAE queries)
- Access JWT validation config
- Optional provider-managed query-store binding/config (only when integration path is enabled)

### alert-worker
- D1 binding
- WAE SQL API token
- Slack/webhook secrets
- cron trigger

## 13.2 Optional Terraform
Provide a module that:
- creates R2 bucket
- sets up D1 database
- provisions datasets/bindings
- deploys Workers
- optionally enables provider-managed query-store integration resources

---

# 14) Observability & operations

## 14.1 Operational metrics
Write operational metrics to WAE:
- ingest_requests_total
- ingest_auth_failures
- ingest_parse_errors
- r2_write_failures
- iceberg_write_failures
- query_latency_ms
- r2sql_calls_total
- alert_evaluations_total
- alert_notifications_sent
- alert_dedup_suppressed_total

## 14.2 Logging
- Use structured logs in Workers
- Include request_id everywhere

## 14.3 Operational workflow instrumentation
Track product-level operational outcomes:
- time_to_first_value_minutes (deploy -> first successful search + first alert fire)
- alert_to_triage_start_seconds
- triage_duration_seconds
- top investigation entry paths (home card, alert deep-link, manual search)

These metrics validate whether the product reduces incident toil for small/mid Cloudflare-first teams.

## 14.4 Runbook governance
- Alert templates should carry optional runbook link and owner metadata.
- UI should surface stale/missing runbooks as operational debt.
- For critical services, “no runbook attached” should be visible in admin/ops views.

---

# 15) Extensions

## 15.1 Phase C: Operational security expansion (SIEM-lite)
Add:
- Rule packs (YAML) mapping to token/structured searches
- Enrichment (GeoIP/ASN, threat intel tags)
- Incident/case objects in D1
- Correlation implemented in Query Worker via multi-step queries (since no joins)
- Compliance-oriented reports for SMB/mid buyers (access anomalies, auth failures, critical service incidents)

## 15.2 Phase D: Infra only
Remove:
- Pages UI
- alert worker
Keep:
- ingest worker
- query API (minimal)
- schemas + deployment tooling

---

# 16) Acceptance criteria & test plan

## Phase A acceptance
- Fresh deployment reaches “first searchable data + first dashboard + first starter alert” in <= 60 minutes.
- Ingest 10k events/min without errors (batched)
- Deep search returns results < 2–5 seconds for:
  - last 1 hour, service specified, keyword search
- Phrase search works with guardrails
- Dashboards render from WAE
- Operators can pivot from alert to scoped investigation in <= 2 clicks

## Phase B acceptance
- Alert fires within schedule interval
- Cooldown prevents spam
- Notifications include deep link and key fields
- Starter alert pack supports top incident classes (error, latency, auth, traffic drop)

## Tests
- Unit tests: tokenizer, query planner, auth
- Integration: ingest → R2 raw + `events`/`tokens` rows + WAE metrics
- Load test: ingestion batching + query concurrency
- Golden-path activation test: deploy -> ingest sample -> search -> alert fire -> deep-link investigation

---

# 17) Appendix

## 17.1 Stopwords (starter list)
a, an, the, and, or, but, if, then, else, for, to, from, of, in, on, at, by, with, is, are, was, were, be, been, being, as, it, this, that, these, those, not

## 17.2 Example WAE dashboard queries
- Error rate last 5m by service
- p95 duration by service last 15m
- top msg_hash last 1h

## 17.3 Example search queries
- `service=payments env=prod q=timeout`
- `service=api level=error phrase="connection refused"`
- `trace_id=abcd1234`

---

## End of specification
