# EdgeData

Edge-native log search and SIEM-lite on Cloudflare Workers, R2, WAE, D1, and Pages.

## Components

- `workers/ingest-worker`: pluggable ingest framework that accepts batched log events (EdgeData JSON, OTLP/HTTP JSON logs, NDJSON), authenticates (Bearer or HMAC), normalizes payloads, writes raw NDJSON to R2, then asynchronously writes WAE metrics and token index shards.
- `workers/query-worker`: search API, search summary API (facets/timeline/top terms/field coverage), dashboard query API, saved search CRUD over D1, and live tail WebSocket streaming via TailHub Durable Object.
- `workers/alert-worker`: cron evaluator for D1 alert definitions with state/cooldown tracking and Slack/webhook notifications.
- `workers/synthetic-worker`: cron-based synthetic data producer that posts small demo batches to ingest for always-on searchable data.
- `pages`: React UI for log explorer, dashboards, alerts management, saved searches, and live tail real-time log streaming, including event inspector syntax highlighting and field-count side panels.

## Data Layout

Raw events:

- `raw/date=YYYY-MM-DD/index=<index>/hour=HH/service=<service>/env=<env>/part-<id>.ndjson`

Token index:

- `tokens/date=YYYY-MM-DD/index=<index>/service=<service>/env=<env>/part-<id>.jsonl`

Event index (primary search path):

- `events/date=YYYY-MM-DD/index=<index>/service=<service>/env=<env>/part-<id>.jsonl`

`index` is a first-class ingest dimension (defaults to `default`). Agents can set event-level `index` or `X-Index` header on ingest requests.

## Local Commands

Install dependencies:

```bash
npm install
npm -C pages install
```

Run workers/pages locally:

```bash
npm run dev:ingest
npm run dev:query
npm run dev:alert
npm run dev:synthetic
npm run dev:pages
```

Build Pages:

```bash
npm -C pages run build
```

Run the public Zeek demo (downloads Zeek baseline logs from the Zeek GitHub repository, ingests, then runs search/dashboard/alert showcase calls):

```bash
npm run demo:zeek
```

If `ALERT_RUN_SECRET` is configured on `alert-worker`, set it before running the demo script:

```bash
ALERT_RUN_SECRET=<secret> npm run demo:zeek
```

If query authentication is enabled, include a query bearer token:

```bash
QUERY_AUTH_TOKEN=<token> ALERT_RUN_SECRET=<secret> npm run demo:zeek
```

Dry-run Worker bundles:

```bash
npx wrangler deploy --dry-run --config workers/ingest-worker/wrangler.toml
npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml
npx wrangler deploy --dry-run --config workers/alert-worker/wrangler.toml
npx wrangler deploy --dry-run --config workers/synthetic-worker/wrangler.toml
```

Run unit tests for query parser/planner internals:

```bash
npm run test:unit
```

Validate Access audience/group pinning in Wrangler configs:

```bash
npm run test:access-config
```

Run load-test automation (ingest + query):

```bash
INGEST_SECRET=<secret> QUERY_AUTH_TOKEN=<token-if-required> npm run test:load
```

Run raw-to-index reprocessing (dry-run by default):

```bash
REPROCESS_SECRET=<secret> npm run ops:reprocess -- --from 2026-02-16 --to 2026-02-18 --service zeek-conn --env demo
```

Apply reprocessing writes with `--apply`.

## Database

Apply schema:

```bash
npm run d1:migrate
npm run d1:migrate:authz
npm run d1:migrate:users
npm run d1:migrate:ratelimits
npm run d1:migrate:rbac
```

Schema file: `schema.sql`

## Required Secrets/Vars

Set per worker with Wrangler secrets/vars.

Ingest worker:

- `INGEST_SECRET` (Bearer token)
- `INGEST_HMAC_SECRET` (optional HMAC mode)
- `INGEST_RATE_LIMIT_PER_MIN` (fixed-window request limit per minute per IP/agent)
- `REPROCESS_SECRET` (optional secret for `POST /reprocess`, defaults to `INGEST_SECRET` if unset)

Query worker:

- `CF_API_TOKEN` (for WAE SQL API)
- `CF_ACCOUNT_ID`
- `REQUIRE_ACCESS_JWT` (`"true"` in production)
- `ACCESS_AUD` (Access audience)
- `ACCESS_ISSUER` (e.g. `https://<team>.cloudflareaccess.com`)
- `ACCESS_JWKS_URL` (optional override; defaults to `<issuer>/cdn-cgi/access/certs`)
- `ACCESS_SUPERADMIN_GROUPS` (comma-separated Access groups mapped to `superadmin`)
- `ACCESS_VIEWER_GROUPS` (comma-separated Access groups)
- `ACCESS_ANALYST_GROUPS` (comma-separated Access groups)
- `ACCESS_ADMIN_GROUPS` (comma-separated Access groups)
- `ACCESS_ADMIN_EMAILS` (comma-separated admin emails)
- `AUTH_ENABLE_LOCAL_LOGIN` (`"false"` to disable local password login, SSO-only)
- `AUTH_BOOTSTRAP_SUPERADMIN_EMAIL` (first-deploy superadmin email; falls back to `AUTH_BOOTSTRAP_EMAIL`)
- `AUTH_INVITE_TTL_HOURS` (invite expiration, default 48)
- `SESSION_TTL_SECONDS` (session duration, defaults to 43200)
- `QUERY_RATE_LIMIT_PER_MIN` (fixed-window request limit per minute per IP/principal)
- `AUTH_LOGIN_RATE_LIMIT_PER_MIN` (fixed-window login attempts per minute per IP)
- `CORS_ORIGINS` (comma-separated allowed origins)
- `QUERY_VIEWER_TOKEN` (optional bearer token for viewer role)
- `QUERY_ANALYST_TOKEN` (optional bearer token for analyst role)
- `QUERY_ADMIN_TOKEN` (optional bearer token for admin role)
- `OPS_WAE` analytics dataset binding (optional operational metrics)
- `SYNTHETIC_SERVICE` service binding to `synthetic-worker` (required for admin synthetic ingest controls)
- Wrangler secret `SYNTHETIC_RUN_SECRET` (must match `synthetic-worker`; used by query worker admin proxy for `/admin/synthetic-ingest`)
- Wrangler secret `AUTH_BOOTSTRAP_PASSWORD`
- Wrangler secret `AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD` (preferred; falls back to `AUTH_BOOTSTRAP_PASSWORD`)
- Wrangler secret `AUTH_SESSION_SECRET`

If any `QUERY_*_TOKEN` is configured, requests without a matching bearer token are rejected (unless Access JWT is enabled and valid).

Alert worker:

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `REQUIRE_ACCESS_JWT` (`"true"` to require Access JWT on `/run`)
- `ACCESS_AUD`
- `ACCESS_ISSUER`
- `ACCESS_JWKS_URL` (optional override)
- `ACCESS_ADMIN_GROUPS`
- `ACCESS_ADMIN_EMAILS`
- `ALERT_RUN_SECRET` (optional bearer secret for machine-triggered `/run`)
- `SLACK_WEBHOOK_URL` (optional)
- `WEBHOOK_URL` (optional)

Synthetic worker:

- `INGEST_SERVICE` service binding to `ingest-worker` (preferred)
- `INGEST_URL` (defaults to deployed ingest-worker URL)
- `SYNTHETIC_ENABLED` (`"true"`/`"false"`, default `"true"`)
- `SYNTHETIC_BATCH_SIZE` (base batch size, default `48`)
- `SYNTHETIC_BATCH_MIN` (optional lower bound for per-run variability, default derived from base)
- `SYNTHETIC_BATCH_MAX` (optional upper bound for per-run variability, default derived from base)
- `SYNTHETIC_PROFILE` (`basic`, `realistic`, or `otel-demo`/`otel`; default `otel-demo`)
- `SYNTHETIC_INDEX` (default `otel-demo`)
- `SYNTHETIC_SERVICE` (default `frontend`)
- `SYNTHETIC_ENV` (default `demo`)
- `SYNTHETIC_HOST_PREFIX` (default `otel-demo-node`)
- `SYNTHETIC_REGION` (default `us`)
- Wrangler secret `INGEST_SECRET` (must match ingest-worker auth secret)
- Wrangler secret `SYNTHETIC_RUN_SECRET` (optional; protects manual `/run`)

Pages:

- `VITE_QUERY_API_BASE` (optional, defaults to deployed query worker URL)

## API Endpoints

Ingest worker:

- `GET /health`
- `POST /ingest`
- `POST /v1/logs` (OTLP/HTTP JSON logs compatible)
- `POST /otlp/v1/logs` (OTLP/HTTP JSON logs compatible)
- `POST /reprocess` (rebuild `events/` and `tokens/` from `raw/` date partitions)

Ingest payload formats (`/ingest`, `/v1/logs`, `/otlp/v1/logs`):

- EdgeData JSON array: `[{"ts":"...","service":"...","message":"..."}]`
- EdgeData wrapped JSON: `{"events":[...]}`
- OpenTelemetry OTLP/HTTP JSON logs: `{"resourceLogs":[...]}`
- NDJSON: one JSON event object per line

Query worker:

- `GET /health`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/invite`
- `POST /auth/invite/accept`
- `POST /search`
- `POST /search/stream` (NDJSON streaming: `meta`, `event`/`row`, `progress`, `final`, `error`)
- `POST /search/summary`
- `POST /dashboards/query`
- `GET /users`
- `PATCH /users/:id`
- `GET /roles`
- `POST /roles`
- `PATCH /roles/:id`
- `GET /rbac/mappings`
- `POST /rbac/mappings`
- `GET /audit`
- `GET /admin/synthetic-ingest`
- `POST /admin/synthetic-ingest`
- `POST /admin/synthetic-ingest/run`
- `GET /saved-searches`
- `POST /saved-searches`
- `PUT /saved-searches/:id`
- `DELETE /saved-searches/:id`
- `GET /alerts`
- `GET /alerts/starter-pack`
- `POST /alerts`
- `POST /alerts/starter-pack/apply`
- `PUT /alerts/:id`
- `DELETE /alerts/:id`
- `GET /tail` (WebSocket upgrade; real-time log streaming with per-session filters)
- `GET /tail/stats` (active tail session count and ring buffer size)

Search APIs are now PPL-first:

- `POST /search` expects `{ time: { from, to }, ppl, limit?, cursor? }`
- `POST /search/stream` expects `{ time: { from, to }, ppl, limit?, cursor? }` and returns NDJSON chunks
- `POST /search/summary` expects `{ time: { from, to }, ppl, limit? }`
- Supported commands today: `search`, `where` (AND conditions), `sort`, `head`, `fields`, `stats count() by ...`

Examples:

- `search timeout postgres | where index="default" and service="payments" and env="prod" and status>=500 | sort -ts | head 200`
- `search error | where env="demo" | stats count() by service, level | sort -count`

Alert worker:

- `GET /health`
- `POST /run` (manual evaluation trigger)
- Cron trigger every minute

Synthetic worker:

- `GET /health`
- `GET /control` (reads runtime synthetic ingest toggle; requires bearer token via `SYNTHETIC_RUN_SECRET`)
- `POST /control` (updates runtime synthetic ingest toggle; requires bearer token via `SYNTHETIC_RUN_SECRET`)
- `POST /run` (manual synthetic run; requires bearer token via `SYNTHETIC_RUN_SECRET`)
- Cron trigger every 15 minutes (default)

## AuthZ Model

- `superadmin`: all permissions, role management, mappings, audit access
- `admin`: search/dashboard/saved-search/alerts/user-admin + role read/write
- `analyst`: search/dashboard + saved-search write + alerts read
- `viewer`: search/dashboard + saved-search read

Saved searches are owner-scoped (`created_by`) for non-admin users.

Authentication is SSO-first (Cloudflare Access JWT) with optional local password login (`AUTH_ENABLE_LOCAL_LOGIN=true`).

## PRD Smoke Tests

Run auth + query guardrail integration checks:

```bash
npm run test:prd
```

## Synthetic Data Seeder (Free-Tier-Friendly)

To keep searchable demo data flowing without manual ingest, deploy the synthetic worker:

```bash
npm run deploy:synthetic
```

Set ingest auth secret for the synthetic worker:

```bash
npx wrangler secret put INGEST_SECRET --config workers/synthetic-worker/wrangler.toml
```

Optional manual trigger secret:

```bash
npx wrangler secret put SYNTHETIC_RUN_SECRET --config workers/synthetic-worker/wrangler.toml
```

Default schedule is every 30 minutes with small variable batches (`12..48` events/run) to stay safely within free-tier envelopes while still producing realistic traffic swings.

Migration `deploy/migrations/008_otel_saved_scheduled_showcase.sql` seeds OTel-focused saved searches and scheduled searches for a ready-to-demo operational workflow.

## Optional Terraform Bootstrap

Provision base infra (R2 + D1) with Terraform:

```bash
cd deploy/terraform
terraform init
terraform apply
```

Module docs: `deploy/terraform/README.md`
# edgedata
