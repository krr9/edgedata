# AGENTS.md

Guidance for coding agents working in `/Users/kishore/code/edgedata`.

## 1. Mission and Source of Truth

- Build and maintain EdgeData: edge-native log search + SIEM-lite on Cloudflare Workers, R2, WAE, D1, and Pages.
- Treat these docs as canonical before major changes:
  - `docs/PRD.md`
  - `docs/PRD_AUTH_RBAC.md`
  - `README.md`

## 2. Repository Map

- `workers/ingest-worker`: ingest API, normalization, raw/event/token writes, optional reprocess endpoint.
- `workers/query-worker`: auth, search planner, summaries, dashboards, saved searches, alerts CRUD, RBAC/admin APIs.
- `workers/alert-worker`: scheduled alert evaluation + notification dispatch.
- `workers/synthetic-worker`: scheduled synthetic event producer for low-volume demo/search bootstrap data.
- `pages`: React UI (Vite build; Pages served from `dist`).
- `scripts`: smoke tests, load tests, ops utilities.
- `deploy/migrations`: D1 incremental migrations.
- `deploy/terraform`: optional infra bootstrap.

## 3. Do Not Edit

- `node_modules/**` (root and `pages/node_modules/**`)
- `pages/dist/**` (build output)
- `.wrangler/**` artifacts

Edit source files instead and regenerate artifacts via commands when needed.

## 4. Runtime and Data Invariants

- Partition/path layout is contract-level behavior:
  - raw: `raw/date=YYYY-MM-DD/index=<index>/hour=HH/service=<service>/env=<env>/part-<id>.ndjson`
  - events: `events/date=YYYY-MM-DD/index=<index>/service=<service>/env=<env>/part-<id>.jsonl`
  - tokens: `tokens/date=YYYY-MM-DD/index=<index>/service=<service>/env=<env>/part-<id>.jsonl`
- Query planner guardrails are intentional product limits:
  - phrase search max window: 6 hours
  - token search max window: 14 days
  - structured search max window: 7 days
  - phrase search must remain tightly constrained (service filter required by smoke test expectations)
- Tokenization constraints are performance-critical:
  - de-duplicate tokens
  - token length and count bounds (12/event)
  - stopword and noisy numeric filtering
- Auth/RBAC defaults are security-critical:
  - Access JWT validation path (issuer/audience/JWKS)
  - role and permission semantics (viewer/analyst/admin/superadmin)
  - owner scoping for non-admin saved searches

## 5. Change Workflow

1. Identify impacted component(s): ingest/query/alert/pages/scripts/migrations.
2. Keep API contracts backward compatible unless task explicitly allows breaking changes.
3. If schema or auth semantics change, update relevant migration/docs in same change.
4. Run the smallest meaningful verification set (see section 6).
5. Summarize behavior impact and residual risk in handoff.

## 6. Verification Commands

- Install:
  - `npm install`
  - `npm -C pages install`
- Unit tests (query parser/planner):
  - `npm run test:unit`
- Access config consistency:
  - `npm run test:access-config`
- PRD smoke checks (auth + query guardrails against deployed stack):
  - `npm run test:prd`
- Load test (requires env secrets/tokens):
  - `npm run test:load`
- Frontend build sanity:
  - `npm -C pages run build`
- Worker bundle dry-runs:
  - `npx wrangler deploy --dry-run --config workers/ingest-worker/wrangler.toml`
  - `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`
  - `npx wrangler deploy --dry-run --config workers/alert-worker/wrangler.toml`
  - `npx wrangler deploy --dry-run --config workers/synthetic-worker/wrangler.toml`

## 7. Secrets and Security Rules

- Never hardcode credentials/tokens in code or docs.
- Use Wrangler secrets/vars for sensitive values.
- Preserve least-privilege CORS and auth checks when changing endpoints.
- Avoid logging raw secrets, session tokens, or sensitive payload fragments.

## 8. Project Conventions

- Keep changes focused and localized; avoid broad refactors unless requested.
- Follow existing style in touched files:
  - Workers: typed interfaces, explicit bounds/guards, small helpers.
  - Query core (`query-core.mjs`): pure utility functions with deterministic behavior.
  - Pages: typed React state/models; API payload shapes mirrored from query worker.
- Add or update tests when modifying parser/planner logic or guardrail behavior.

## 9. Deployment References

- Worker deploy scripts:
  - `npm run deploy:ingest`
  - `npm run deploy:query`
  - `npm run deploy:alert`
  - `npm run deploy:synthetic`
  - `npm run deploy:all`
- Pages deploy:
  - `npm run deploy:pages`
- D1 migrations:
  - `npm run d1:migrate`
  - `npm run d1:migrate:authz`
  - `npm run d1:migrate:users`
  - `npm run d1:migrate:ratelimits`
  - `npm run d1:migrate:rbac`

## 10. Definition of Done (Agent)

- Code compiles/tests pass for impacted areas, or failures are explicitly called out.
- No generated/vendor files edited directly.
- Security/auth and query guardrails remain intact unless the task explicitly changes them.
- Relevant docs are updated when behavior/API/config expectations change.
