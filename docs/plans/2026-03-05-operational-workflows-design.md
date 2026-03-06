# EdgeData Operational Workflows Design
## Scheduled Searches, PPL Expansion, Search-Powered Dashboards, Lookup Tables

**Date:** 2026-03-05
**Status:** Approved
**Scope:** Four features that shift EdgeData's moat from infrastructure plumbing to operational workflow stickiness.

---

## 1) Strategic Context

EdgeData's current value is ingest + search + alerts on Cloudflare-native infrastructure. That infrastructure (R2, Workers, WAE) is commoditizable — Cloudflare can replicate or improve it at any time.

The defensible layer is operational workflows: the searches teams schedule, the dashboards they build, the lookup tables that encode their organizational knowledge, and the PPL queries that become shared triage muscle memory. Once a team has 15 scheduled searches, 3 custom dashboards, and a lookup table mapping services to on-call channels, switching cost is real.

This design adds four features in priority order:

1. **Scheduled searches** — run PPL on a cron, store results, trigger actions
2. **PPL expansion** — `timechart`, `top`, `rare`, `dedup`, `eval`, `rex`, `transaction`, richer `stats`
3. **Search-powered dashboards** — any PPL query becomes a dashboard panel
4. **Lookup tables** — key-value enrichment at search time

### Relationship to existing features

| Existing | New | Relationship |
|----------|-----|-------------|
| Saved searches | Scheduled searches | Scheduled extends saved with cron + result persistence + actions |
| Alerts (WAE SQL) | Scheduled searches | Alerts remain for real-time threshold monitoring; scheduled searches handle complex PPL-based reporting |
| Hardcoded WAE dashboards | Search-powered dashboards | PPL dashboards replace hardcoded cards; WAE stays for alert evaluation |
| PPL (6 commands) | PPL expansion (15 commands) | Additive — all new commands compose with existing pipeline |

---

## 2) Scheduled Searches

### 2.1 Concept

A scheduled search is a saved PPL query that runs on a cron, persists result rows to D1, and optionally triggers actions (Slack, webhook). Unlike alerts which evaluate a numeric threshold, scheduled searches store full result sets — enabling reports, compliance digests, and operational baselines.

### 2.2 Data Model (D1 migration)

```sql
CREATE TABLE IF NOT EXISTS scheduled_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ppl TEXT NOT NULL,
  time_window_minutes INTEGER NOT NULL DEFAULT 60,
  schedule_cron TEXT NOT NULL DEFAULT '0 * * * *',
  enabled INTEGER NOT NULL DEFAULT 1,
  actions_json TEXT NOT NULL DEFAULT '[]',
  max_results INTEGER NOT NULL DEFAULT 500,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_search_results (
  id TEXT PRIMARY KEY,
  scheduled_search_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  time_from TEXT NOT NULL,
  time_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  result_count INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  stats_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sched_results_search_run
  ON scheduled_search_results(scheduled_search_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_searches_enabled
  ON scheduled_searches(enabled);
```

### 2.3 Execution model

Scheduled searches run in the alert-worker cron cycle (already fires every minute):

1. Load enabled scheduled searches from D1.
2. For each search due (compare `schedule_cron` against last `run_at`):
   - Compute `time_from` = now - `time_window_minutes`, `time_to` = now.
   - Execute PPL via query-worker search endpoint (service binding or fetch).
   - Store results in `scheduled_search_results` (capped by `max_results`).
   - Execute configured actions (Slack/webhook with result summary).
   - Delete expired result rows (older than `retain_days` from `actions_json` config).
3. Same time guardrails as interactive search apply.

### 2.4 Actions

`actions_json` is an array of action objects:

```json
[
  { "type": "summary", "retain_days": 30 },
  { "type": "slack", "webhook_url": "...", "template": "Found {{result_count}} results" },
  { "type": "webhook", "url": "...", "method": "POST" }
]
```

The `summary` action is implicit (results always stored). Slack and webhook actions include the result count, first N rows, search link, and execution stats.

### 2.5 API endpoints (query-worker)

| Method | Path | Permission |
|--------|------|-----------|
| `GET` | `/scheduled-searches` | `scheduled_search.read` |
| `POST` | `/scheduled-searches` | `scheduled_search.write` |
| `PUT` | `/scheduled-searches/:id` | `scheduled_search.write` |
| `DELETE` | `/scheduled-searches/:id` | `scheduled_search.delete` |
| `GET` | `/scheduled-searches/:id/results` | `scheduled_search.read` |
| `POST` | `/scheduled-searches/:id/run` | `scheduled_search.write` |

Owner-scoped for non-admin roles (same pattern as saved searches).

### 2.6 RBAC permissions

New: `scheduled_search.read`, `scheduled_search.write`, `scheduled_search.delete`.

| Role | Permissions |
|------|------------|
| viewer | `scheduled_search.read` |
| analyst | `scheduled_search.read`, `scheduled_search.write` |
| admin/superadmin | all three |

---

## 3) PPL Pipeline Expansion

### 3.1 Current state

Commands: `search`, `where`, `fields`, `sort`, `head`, `stats` (count only).

### 3.2 Tier 1 commands (ship first)

**`timechart`** — time-bucketed aggregation.

```
timechart span=<interval> <agg_fn>(<field>) [by <group_field>]
```

Examples:
- `search * | where service="payments" | timechart span=5m count() by level`
- `search * | timechart span=1h avg(duration_ms) by service`

Supported intervals: `1m`, `5m`, `15m`, `30m`, `1h`, `6h`, `1d`.
Output columns: `_time`, aggregation value(s), group-by field(s).
Implementation: truncate event `ts` to span boundary, group, aggregate in-worker.

**`top`** — most frequent values.

```
top <N> <field> [by <group_field>]
```

Example: `search * | top 10 msg_hash by service`
Output columns: field value, count, percent, optional group field.

**`rare`** — least frequent values.

```
rare <N> <field> [by <group_field>]
```

Inverse of `top`.

**`dedup`** — deduplicate by field.

```
dedup <field> [, <field2>] [sortby <sort_field> <asc|desc>]
```

Example: `search * | dedup trace_id`
Keeps first event per unique key combination. Memory-bounded by pipeline limit.

**`eval`** — computed fields.

```
eval <new_field>=<expression>
```

Examples:
- `eval duration_sec=duration_ms/1000`
- `eval is_error=if(status>=500, "yes", "no")`
- `eval short_msg=substr(message, 0, 100)`

Safe expression subset:
- Arithmetic: `+`, `-`, `*`, `/`
- String: `lower()`, `upper()`, `len()`, `substr()`, `replace()`
- Conditional: `if(condition, true_val, false_val)`
- Null: `coalesce(field, default)`
- Field references and literals

No arbitrary code execution. Expression parser validates before execution.

### 3.3 Tier 2 commands (ship next)

**`rex`** — regex field extraction.

```
rex field=<source_field> "<regex_with_named_groups>"
```

Example: `rex field=message "(?<error_code>E[0-9]{4})"`
Applies regex, adds named capture groups as new fields. Bounded: 50ms timeout per event.

**`transaction`** — group events by shared field.

```
transaction <field> [maxspan=<duration>] [maxevents=<N>]
```

Example: `search * | transaction trace_id maxspan=5m`
Groups events, computes `duration` and `eventcount`. Bounded by `maxspan` and `maxevents`.

**`rename`** — rename output fields.

```
rename <old_field> as <new_field>
```

**`table`** — alias for `fields` (Splunk compatibility).

### 3.4 `stats` expansion

Currently: `count()` only.

Expand to:

| Function | Syntax | Notes |
|----------|--------|-------|
| `count()` | `stats count() by service` | Existing |
| `sum(field)` | `stats sum(duration_ms) by service` | Numeric |
| `avg(field)` | `stats avg(duration_ms) by service` | Numeric |
| `min(field)` | `stats min(duration_ms) by service` | Numeric |
| `max(field)` | `stats max(duration_ms) by service` | Numeric |
| `dc(field)` | `stats dc(src_ip) by service` | Distinct count |
| `values(field)` | `stats values(host) by service` | Collect unique values |
| `earliest(field)` | `stats earliest(ts) by trace_id` | First by sort order |
| `latest(field)` | `stats latest(ts) by trace_id` | Last by sort order |

Multiple aggregations per stats: `stats count() avg(duration_ms) max(status) by service, env`

### 3.5 Implementation architecture

All commands execute in-worker on the event stream produced by `search` + `where`:

- `ppl-core.mjs`: new `parse*Clause` functions for each command
- `search-stream-core.mjs`: new pipeline executors

Streaming vs blocking classification:

| Streaming (incremental) | Blocking (needs all events) |
|------------------------|-----------------------------|
| `eval`, `rex`, `rename`, `table`, `dedup`, `lookup` | `timechart`, `top`, `rare`, `stats`, `transaction`, `sort` |

The existing `isIncrementalStreamPipeline` function is extended to classify new commands.

### 3.6 `COMMANDS` set update

```javascript
const COMMANDS = new Set([
  'search', 'where', 'fields', 'sort', 'head', 'stats',
  'timechart', 'top', 'rare', 'dedup', 'eval', 'rex',
  'transaction', 'rename', 'table', 'lookup'
]);
```

---

## 4) Search-Powered Dashboards

### 4.1 Concept

A dashboard is a named collection of panels. Each panel is a PPL query with a visualization type, time window, and refresh interval. Users build dashboards from their operational searches.

### 4.2 Data model (D1 migration)

```sql
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  layout_json TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS dashboard_panels (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ppl TEXT NOT NULL,
  viz_type TEXT NOT NULL DEFAULT 'table',
  time_window_minutes INTEGER NOT NULL DEFAULT 60,
  refresh_seconds INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_panels_dashboard
  ON dashboard_panels(dashboard_id, position);
CREATE INDEX IF NOT EXISTS idx_dashboards_default
  ON dashboards(is_default);
```

### 4.3 Panel rendering

Dashboard view renders each panel by executing its PPL query via the search API:

1. For each panel, compute `time_from` = now - `time_window_minutes`, `time_to` = now.
2. `POST /search` with panel's PPL query.
3. Render result based on `viz_type`:
   - `timechart` → line/area chart (expects `_time` column from timechart command)
   - `table` → results table
   - `counter` → single numeric value (first row, first numeric column)
   - `bar` → bar chart (expects group field + numeric column)
   - `pie` → pie chart (same as bar)
4. Auto-refresh via `refresh_seconds` (0 = manual only).

### 4.4 Default dashboards

Two system dashboards (`is_default=1`) ship with the product:

**Operations Overview:**
- Error rate by service: `search * | timechart span=5m count() by level`
- p95 latency by service: `search * | where duration_ms>0 | stats avg(duration_ms) by service`
- Top error messages: `search * | where level="error" | top 10 msg_hash`
- Throughput: `search * | timechart span=5m count()`

**Service Health:**
- Status distribution: `search * | where status>0 | stats count() by status`
- Top hosts by errors: `search * | where level="error" | top 10 host`
- Slowest routes: `search * | where duration_ms>0 | stats avg(duration_ms) by service | sort -avg`

System dashboards are read-only. Users can clone them.

### 4.5 API endpoints (query-worker)

| Method | Path | Permission |
|--------|------|-----------|
| `GET` | `/dashboards` | `dashboard.read` |
| `POST` | `/dashboards` | `dashboard.write` |
| `PUT` | `/dashboards/:id` | `dashboard.write` |
| `DELETE` | `/dashboards/:id` | `dashboard.delete` |
| `GET` | `/dashboards/:id/panels` | `dashboard.read` |
| `POST` | `/dashboards/:id/panels` | `dashboard.write` |
| `PUT` | `/dashboards/:id/panels/:panelId` | `dashboard.write` |
| `DELETE` | `/dashboards/:id/panels/:panelId` | `dashboard.write` |

### 4.6 RBAC permissions

New: `dashboard.write`, `dashboard.delete`.

| Role | Permissions |
|------|------------|
| viewer | `dashboard.read` |
| analyst | `dashboard.read`, `dashboard.write` |
| admin/superadmin | all three |

### 4.7 Migration from WAE dashboards

Existing `POST /dashboards/query` endpoint remains for backward compatibility. The frontend migrates to panel-based rendering. WAE SQL stays available for alert evaluation, which operates on different data (aggregated metrics vs raw events).

---

## 5) Lookup Tables

### 5.1 Concept

A lookup table is a key-value mapping stored in D1 that enriches events at search time. A `lookup` PPL command joins an event field against a lookup table and appends enrichment fields.

### 5.2 Data model (D1 migration)

```sql
CREATE TABLE IF NOT EXISTS lookup_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  key_field TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS lookup_rows (
  lookup_id TEXT NOT NULL,
  key_value TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (lookup_id, key_value)
);

CREATE INDEX IF NOT EXISTS idx_lookup_tables_name
  ON lookup_tables(name);
```

### 5.3 PPL command

```
lookup <table_name> <event_field> [as <alias>] [output <field1>, <field2>, ...]
```

Example:
```
search error | where level="error" | lookup service_owners service | fields ts, service, team, oncall_slack_channel, message
```

Semantics:
- Match `event[event_field]` against `lookup_rows.key_value`.
- Append enrichment fields from `data_json`.
- Non-matching events pass through with null enrichment fields (left join).
- `output` limits which enrichment fields are added.

### 5.4 Execution

`lookup` is a streaming pipeline stage. On first invocation per search, load the full lookup table into `Map<string, object>` (bounded at 10,000 rows). For each event, look up key and merge fields.

### 5.5 API endpoints (query-worker)

| Method | Path | Permission |
|--------|------|-----------|
| `GET` | `/lookup-tables` | `lookup.read` |
| `POST` | `/lookup-tables` | `lookup.write` |
| `GET` | `/lookup-tables/:id` | `lookup.read` |
| `PUT` | `/lookup-tables/:id` | `lookup.write` |
| `PATCH` | `/lookup-tables/:id/rows` | `lookup.write` |
| `DELETE` | `/lookup-tables/:id` | `lookup.delete` |

`POST` and `PUT` accept JSON body or CSV upload. CSV: first row as headers, key field specified in body or inferred from first column.

### 5.6 RBAC permissions

New: `lookup.read`, `lookup.write`, `lookup.delete`.

| Role | Permissions |
|------|------------|
| viewer | `lookup.read` |
| analyst | `lookup.read`, `lookup.write` |
| admin/superadmin | all three |

### 5.7 Guardrails

- Max 10,000 rows per lookup table
- Max 50 lookup tables per deployment
- Max 1KB per `data_json` row
- Lookup loaded once per search execution, cached in-request

---

## 6) Implementation Priority

| Phase | Features | Dependencies |
|-------|----------|-------------|
| **Phase 1** | PPL Tier 1 (`timechart`, `top`, `rare`, `dedup`, `eval`) + `stats` expansion | None — pure parser/executor additions |
| **Phase 2** | Scheduled searches (D1 schema + alert-worker integration + API) | Phase 1 (PPL commands make scheduled searches useful) |
| **Phase 3** | Search-powered dashboards (D1 schema + API + frontend panels) | Phase 1 (timechart/stats needed for dashboard panels) |
| **Phase 4** | Lookup tables (D1 schema + API + `lookup` command) | Phase 1 (eval/fields needed for enrichment workflows) |
| **Phase 5** | PPL Tier 2 (`rex`, `transaction`, `rename`, `table`) | Phase 1 |

### D1 migration file

All new tables ship in a single migration: `deploy/migrations/006_operational_workflows.sql`.

### Test plan

- Unit tests for every new PPL command parser (`ppl-core.test.mjs`)
- Unit tests for every new pipeline executor (`search-stream-core.test.mjs`)
- Unit tests for `timechart` bucketing, `stats` aggregation functions, `eval` expression evaluator
- Integration smoke tests for scheduled search execution
- Integration smoke tests for dashboard panel rendering
- Integration smoke tests for lookup table CRUD and PPL enrichment

---

## 7) Files Impacted

| File | Changes |
|------|---------|
| `workers/query-worker/src/ppl-core.mjs` | New command parsers |
| `workers/query-worker/src/search-stream-core.mjs` | New pipeline executors |
| `workers/query-worker/src/index.ts` | New API routes for scheduled searches, dashboards, lookup tables |
| `workers/alert-worker/src/index.ts` | Scheduled search execution in cron cycle |
| `deploy/migrations/006_operational_workflows.sql` | New D1 tables |
| `schema.sql` | Updated with new tables |
| `pages/src/App.tsx` | Dashboard panels, scheduled search UI, lookup table management |
| `workers/query-worker/test/ppl-core.test.mjs` | Tests for new commands |
| `workers/query-worker/test/search-stream-core.test.mjs` | Tests for new executors |

### RBAC permission updates

`ROLE_PERMISSION_DEFAULTS` in `workers/query-worker/src/index.ts`:

```
superadmin: ['*']
admin: + scheduled_search.*, dashboard.write, dashboard.delete, lookup.*
analyst: + scheduled_search.read, scheduled_search.write, dashboard.write, lookup.read, lookup.write
viewer: + scheduled_search.read, lookup.read
```
