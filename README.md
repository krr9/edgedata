# EdgeData

Edge-native log search and SIEM-lite on Cloudflare Workers, R2, WAE, D1, and Pages.

## Product Positioning

EdgeData is a Cloudflare-operations control layer, not a replacement for Cloudflare-native analytics.

- Differentiate on operator workflows: alert -> context -> investigation -> runbook.
- Optimize for MTTR reduction, explainable investigations, and repeatable incident response.
- Keep storage/query backend choices implementation-level and swappable.

## Evidence Pack

Launch-readiness proof artifacts are tracked in [`docs/evidence`](docs/evidence/README.md):

- Benchmark scorecard: [`docs/evidence/benchmark-scorecard-2026-03-09.md`](docs/evidence/benchmark-scorecard-2026-03-09.md)
- Design-partner outcomes tracker: [`docs/evidence/design-partner-outcomes.md`](docs/evidence/design-partner-outcomes.md)
- Case-study artifact: [`docs/evidence/case-study-synthetic-alert-to-investigation.md`](docs/evidence/case-study-synthetic-alert-to-investigation.md)

Current design-partner status: `pending` (tracked in `docs/evidence/design-partner-outcomes.md`).

## Components

- `workers/ingest-worker`: pluggable ingest framework that accepts batched log events (EdgeData JSON, OTLP/HTTP JSON logs, NDJSON), authenticates (Bearer or HMAC), normalizes payloads, writes raw NDJSON to R2, then asynchronously writes WAE metrics and token index shards.
- `workers/query-worker`: search API, search summary API (facets/timeline/top terms/field coverage), dashboard query API, saved search CRUD over D1, and live tail WebSocket streaming via TailHub Durable Object. Query planning is backend-agnostic: default deep search uses partitioned `events`/`tokens` indexes, with optional provider-managed query-store integration.
- `workers/alert-worker`: cron evaluator for D1 alert definitions with state/cooldown tracking and Slack/webhook notifications.
- `workers/synthetic-worker`: cron-based synthetic data producer that posts small demo batches to ingest for always-on searchable data.
- `pages`: React UI for log explorer, dashboards, incident workspace investigations, alerts management, saved searches, and live tail real-time log streaming, including event inspector syntax highlighting and field-count side panels.

## Data Layout

Raw events:

- `raw/date=YYYY-MM-DD/index=<index>/hour=HH/service=<service>/env=<env>/part-<id>.ndjson`

Token index:

- `tokens/date=YYYY-MM-DD/index=<index>/service=<service>/env=<env>/part-<id>.jsonl`

Event index (primary search path):

- `events/date=YYYY-MM-DD/index=<index>/service=<service>/env=<env>/part-<id>.jsonl`

`index` is a first-class ingest dimension (defaults to `default`). Agents can set event-level `index` or `X-Index` header on ingest requests.

Default deep-search backend is object-backed partition indexes (`events` + `tokens`). Provider-managed query-store integration can be enabled later as an optional accelerator path without changing API contracts.

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
INGEST_URL=<ingest-worker-url> \
QUERY_URL=<query-worker-url> \
ALERT_URL=<alert-worker-url> \
INGEST_SECRET=<secret> \
npm run demo:zeek
```

If `ALERT_RUN_SECRET` is configured on `alert-worker`, set it before running the demo script:

```bash
INGEST_URL=<ingest-worker-url> \
QUERY_URL=<query-worker-url> \
ALERT_URL=<alert-worker-url> \
INGEST_SECRET=<secret> \
ALERT_RUN_SECRET=<secret> \
npm run demo:zeek
```

If query authentication is enabled, include a query bearer token:

```bash
INGEST_URL=<ingest-worker-url> \
QUERY_URL=<query-worker-url> \
ALERT_URL=<alert-worker-url> \
INGEST_SECRET=<secret> \
QUERY_AUTH_TOKEN=<token> \
ALERT_RUN_SECRET=<secret> \
npm run demo:zeek
```

Dry-run Worker bundles:

```bash
D1_DATABASE_ID=<d1-database-uuid> \
npm run deploy:all:d1:dry-run
```

Deploy workers (first deployment or updates):

```bash
D1_DATABASE_ID=<d1-database-uuid> \
npm run deploy:all:d1
```

Production note:

- `deploy:all:d1` now auto-injects `QUERY_WORKER_URL` for `alert-worker`.
- For production deploys (`-- --env production`), set one of these first:

```bash
export QUERY_WORKER_URL="https://<query-worker-prod>.<subdomain>.workers.dev"
# or reuse QUERY_URL only if it is already the query-worker-prod URL
export QUERY_URL="https://<query-worker-prod>.<subdomain>.workers.dev"
```

Single-worker deploy examples:

```bash
D1_DATABASE_ID=<d1-database-uuid> \
npm run deploy:query:d1

D1_DATABASE_ID=<d1-database-uuid> \
bash scripts/wrangler-with-d1.sh --config workers/query-worker/wrangler.toml deploy --dry-run
```

How to discover worker URLs on first deployment:

- You do not need to know URLs ahead of time.
- `wrangler deploy` prints the published `https://<worker-name>.<account-subdomain>.workers.dev` URL.
- You can also copy the URL from Cloudflare Dashboard -> Workers & Pages -> Worker.
- Export the URLs for scripts/UI:

```bash
export QUERY_URL="https://<query-worker>.<subdomain>.workers.dev"
export INGEST_URL="https://<ingest-worker>.<subdomain>.workers.dev"
export ALERT_URL="https://<alert-worker>.<subdomain>.workers.dev"
export VITE_QUERY_API_BASE="$QUERY_URL"
```

How to discover D1 database ID on first deployment:

- Create the DB once (or list existing DBs) and copy the returned UUID.
- Export it for deploy commands (the deploy wrappers inject it into temporary wrangler configs).

```bash
npx wrangler d1 create edgedata-db
# or, if it already exists:
npx wrangler d1 list

export D1_DATABASE_ID="<d1-database-uuid>"
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
INGEST_URL=<ingest-worker-url> \
QUERY_URL=<query-worker-url> \
INGEST_SECRET=<secret> \
QUERY_AUTH_TOKEN=<token-if-required> \
npm run test:load
```

Run raw-to-index reprocessing (dry-run by default):

```bash
INGEST_URL=<ingest-worker-url> \
REPROCESS_SECRET=<secret> \
npm run ops:reprocess -- --from 2026-02-16 --to 2026-02-18 --service zeek-conn --env demo
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

Deployment helper:

- `D1_DATABASE_ID` (required for `deploy:*:d1` scripts; not committed to repository files)

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
- `DEMO_SCENARIOS_ENABLED` (`"true"` enables investigation demo scenario presets, default `"false"`)
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
- `INGEST_URL` (required if `INGEST_SERVICE` binding is not used)
- `SYNTHETIC_ENABLED` (`"true"`/`"false"`, default `"true"`)
- `SYNTHETIC_BATCH_SIZE` (base batch size, runtime fallback `24`; deployed default `48`)
- `SYNTHETIC_BATCH_MIN` (optional lower bound for per-run variability, default derived from base)
- `SYNTHETIC_BATCH_MAX` (optional upper bound for per-run variability, default derived from base)
- `SYNTHETIC_PROFILE` (`basic`, `realistic`, `mixed`, or `otel-demo`/`otel`; deployed default `otel-demo`)
- `SYNTHETIC_INDEX` (default `otel-demo`)
- `SYNTHETIC_SERVICE` (default `frontend`)
- `SYNTHETIC_ENV` (default `demo`)
- `SYNTHETIC_HOST_PREFIX` (default `otel-demo-node`)
- `SYNTHETIC_REGION` (default `us`)
- `SYNTHETIC_EXTRA_TARGETS` (optional semicolon-delimited targets as `index,service,profile[,env]`)
- Wrangler secret `INGEST_SECRET` (must match ingest-worker auth secret)
- Wrangler secret `SYNTHETIC_RUN_SECRET` (optional; protects manual `/run`)

Pages:

- `VITE_QUERY_API_BASE` (required; set to deployed query-worker URL)

## API Endpoints

Ingest worker:

- `GET /health`
- `POST /ingest`
- `POST /v1/logs` (OTLP/HTTP JSON logs compatible)
- `POST /otlp/v1/logs` (OTLP/HTTP JSON logs compatible)
- `POST /v1/traces` (OTLP/HTTP JSON traces compatible)
- `POST /otlp/v1/traces` (OTLP/HTTP JSON traces compatible)
- `POST /reprocess` (rebuild `events/` and `tokens/` from `raw/` date partitions)

Ingest payload formats (`/ingest`, `/v1/logs`, `/otlp/v1/logs`):

- EdgeData JSON array: `[{"ts":"...","service":"...","message":"..."}]`
- EdgeData wrapped JSON: `{"events":[...]}`
- OpenTelemetry OTLP/HTTP JSON logs: `{"resourceLogs":[...]}`
- OpenTelemetry OTLP/HTTP JSON traces: `{"resourceSpans":[...]}`
- NDJSON: one JSON event object per line

Query worker:

- `GET /health`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /auth/invites`
- `POST /auth/invite`
- `POST /auth/invite/resend`
- `POST /auth/invite/revoke`
- `POST /auth/invite/accept`
- `POST /search`
- `POST /search/stream` (NDJSON streaming: `meta`, `event`/`row`, `progress`, `final`, `error`)
- `POST /search/summary`
- `POST /investigations/bootstrap`
- `POST /investigations/related-events`
- `POST /investigations/session`
- `GET /investigations/session/:id`
- `GET /investigations/demo-scenarios`
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
- Cron trigger every 5 minutes (default)

## AuthZ Model

- `superadmin`: all permissions, role management, mappings, audit access
- `admin`: search/dashboard/saved-search/alerts/user-admin + role read/write
- `analyst`: search/dashboard + saved-search write + alerts read
- `viewer`: search/dashboard + saved-search read

Saved searches are owner-scoped (`created_by`) for non-admin users.

Authentication is SSO-first (Cloudflare Access JWT) with optional local password login (`AUTH_ENABLE_LOCAL_LOGIN=true`).

## Onboarding Checklist

Use the in-app **Settings -> Onboarding Checklist** card and the canonical checklist doc:

- `docs/ONBOARDING_CHECKLIST.md`

Checklist completion is tied to runtime state:

- Access group mappings configured
- Users onboarded (active users or pending invites)
- Starter alerts applied with runbook/deep-link/team metadata
- Synthetic ingest enabled

## PRD Smoke Tests

Run auth + query guardrail integration checks:

```bash
QUERY_URL=<query-worker-url> \
QUERY_AUTH_TOKEN=<token-or-use-email-password> \
npm run test:prd
```

Alternative auth mode for `test:prd`:

```bash
QUERY_URL=<query-worker-url> \
EMAIL=<admin-email> PASSWORD=<admin-password> \
npm run test:prd
```

Run the end-to-end golden activation path (deploy-ready stack):

```bash
QUERY_URL=<query-worker-url> \
ALERT_URL=<alert-worker-url> \
DEEP_LINK_BASE=<pages-url> \
RUNBOOK_BASE_URL=<runbook-base-url> \
ALERT_RUN_SECRET=<alert-run-secret> \
EMAIL=<admin-email> PASSWORD=<admin-password> \
npm run test:golden-path
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

Default schedule is every 5 minutes with variable batches (`24..96` events/run) to keep demo data fresher while maintaining bounded synthetic volume.

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
