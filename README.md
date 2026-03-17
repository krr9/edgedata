# EdgeData

Edge-native log search and SIEM-lite on Cloudflare Workers, R2, WAE, D1, and Pages.

## Product Positioning

EdgeData is a Cloudflare-operations control layer, not a replacement for Cloudflare-native analytics.

- Differentiate on operator workflows: alert -> context -> investigation -> runbook.
- Optimize for MTTR reduction, explainable investigations, and repeatable incident response.
- Keep storage/query backend choices implementation-level and swappable.

## Components

- `workers/ingest-worker`: pluggable ingest framework that accepts batched log events (EdgeData JSON, OTLP/HTTP JSON logs, NDJSON), authenticates (Bearer or HMAC), normalizes payloads, writes raw NDJSON to R2, then asynchronously writes WAE metrics and token index shards.
- `workers/query-worker`: search API, search summary API (facets/timeline/top terms/field coverage), dashboard query API, saved search CRUD over D1, and live tail WebSocket streaming via TailHub Durable Object. Query planning is backend-agnostic: default deep search uses partitioned `events`/`tokens` indexes, with optional provider-managed query-store integration.
- `workers/alert-worker`: cron evaluator for D1 alert definitions with state/cooldown tracking and Slack/webhook notifications.
- `workers/materialize-worker`: cron-driven dashboard widget materializer for precomputed performance-mode results.
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

## Quick Start

Install dependencies:

```bash
npm install
npm -C pages install
```

Authenticate Wrangler and create the D1 database you want to deploy against:

```bash
npx wrangler login
npx wrangler d1 create edgedata-db
export D1_DATABASE_ID="<your-d1-database-id>"
```

Bootstrap a fresh worker deployment:

```bash
npm run deploy:all:d1:fresh
```

After deploy, copy the published `query-worker` URL from Wrangler output and use it to deploy the Pages UI:

```bash
export VITE_QUERY_API_BASE="https://<query-worker>.<subdomain>.workers.dev"
npm run deploy:pages
```

If you have not created the Pages project yet, create it first and make sure [`pages/wrangler.toml`](/Users/kishore/code/edgedata/pages/wrangler.toml) uses that project name.

```bash
npx wrangler pages project create <project-name>
```

For a full fresh-deploy walkthrough, Cloudflare Access setup, and secret-by-secret instructions, use [`docs/ONBOARDING.md`](/Users/kishore/code/edgedata/docs/ONBOARDING.md).

## Core Commands

Run the workers and UI locally:

```bash
npm run dev:ingest
npm run dev:query
npm run dev:alert
npm run dev:materialize
npm run dev:synthetic
npm run dev:pages
```

Build the Pages UI:

```bash
npm -C pages run build
```

Deploy updates to an existing stack:

```bash
npm run deploy:all:d1
```

Dry-run worker bundles:

```bash
npm run deploy:all:d1:dry-run
```

Run the most useful verification commands:

```bash
npm run test:unit
npm run test:migrations
npm run test:access-config
npm -C pages run build
```

Run the end-to-end golden activation path against a deployed stack:

```bash
QUERY_URL=<query-worker-url> \
ALERT_URL=<alert-worker-url> \
DEEP_LINK_BASE=<pages-url> \
RUNBOOK_BASE_URL=<runbook-base-url> \
ALERT_RUN_SECRET=<alert-run-secret> \
EMAIL=<admin-email> PASSWORD=<admin-password> \
npm run test:golden-path
```

For demoable data on a fresh stack, deploy the synthetic worker and let it seed the OTel-focused starter dashboards and searches:

```bash
npm run deploy:synthetic
```

Run raw-to-index reprocessing when you need to rebuild `events/` and `tokens/` from `raw/`:

```bash
INGEST_URL=<ingest-worker-url> \
REPROCESS_SECRET=<secret> \
npm run ops:reprocess -- --from 2026-02-16 --to 2026-02-18 --service checkoutservice --env demo
```

Apply reprocessing writes with `--apply`.

## Search Model

EdgeData search is PPL-only. The main query endpoints accept a `{ time, ppl, limit?, cursor? }` shape, and the current command set centers on investigation-friendly pipelines such as:

- `search`
- `where` (AND conditions)
- `sort`
- `head`
- `fields`
- `stats count() by ...`

Example queries:

- `search timeout postgres | where index="default" and service="payments" and env="prod" and status>=500 | sort -ts | head 200`
- `search error | where env="demo" | stats count() by service, level | sort -count`

## AuthZ Model

- `superadmin`: all permissions, role management, mappings, audit access
- `admin`: search/dashboard/saved-search/alerts/user-admin + role read/write
- `analyst`: search/dashboard + saved-search write + alerts read
- `viewer`: search/dashboard + saved-search read

Saved searches are owner-scoped (`created_by`) for non-admin users.

Authentication is SSO-first (Cloudflare Access JWT) with optional local password login (`AUTH_ENABLE_LOCAL_LOGIN=true`).
Cloudflare Access owns the authentication challenge itself, including email OTP / One-Time PIN delivery when that login method is enabled. EdgeData owns application invites, roles, and post-login authorization.

## Onboarding Checklist

Use the in-app **Settings -> Onboarding Checklist** card and the canonical checklist doc:

- `docs/ONBOARDING_CHECKLIST.md`

Checklist completion is tied to runtime state:

- Access group mappings configured
- Users onboarded (active users or pending invites)
- Starter alerts applied with runbook/deep-link/team metadata
- Synthetic ingest enabled

## Where To Go Deeper

- Fresh deployment and secret setup: [`docs/ONBOARDING.md`](/Users/kishore/code/edgedata/docs/ONBOARDING.md)
- Release workflow and production updates: [`docs/RELEASING.md`](/Users/kishore/code/edgedata/docs/RELEASING.md)
- Product spec: [`docs/PRD.md`](/Users/kishore/code/edgedata/docs/PRD.md)
- Auth/RBAC spec: [`docs/PRD_AUTH_RBAC.md`](/Users/kishore/code/edgedata/docs/PRD_AUTH_RBAC.md)
- Terraform bootstrap: [`deploy/terraform/README.md`](/Users/kishore/code/edgedata/deploy/terraform/README.md)
