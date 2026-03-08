# PRD Closure Checklist

Last updated: 2026-02-18
Source PRD: `docs/PRD.md`

## P0 (must-have for production readiness)

- [x] Access JWT enforced in workers (`REQUIRE_ACCESS_JWT=true`)
- [x] Access audience pinned (`ACCESS_AUD`) and Access groups mapped (`ACCESS_*_GROUPS`) with runtime/config validation
- [x] Traditional UI auth flow (email/password login + session token)
- [x] AuthZ role gates for search/saved-search/alerts APIs
- [x] Owner-scoped saved searches (`created_by` authz checks)
- [x] Secrets removed from plaintext config (`AUTH_BOOTSTRAP_PASSWORD`, `AUTH_SESSION_SECRET` now secret bindings)
- [x] CORS narrowed to deployed Pages origin
- [x] Ingest/query rate limiting (agent/IP abuse controls)
- [x] Automated integration smoke tests for auth/query guardrails (`npm run test:prd`)
- [x] Unit tests for tokenizer/query planner internals (`npm run test:unit`)

## P1 (core product differentiation and execution)

- [x] Canonical normalization at ingest (`ts,date,hour,service,env,host,level,message,msg_hash,...`)
- [x] Tri-write pattern (raw + hot metrics + token/event indexes)
- [ ] Golden activation path codified and validated (`deploy -> ingest -> search -> alert -> deep-link investigation <= 60 min`)
- [ ] Operator workflow differentiation complete (`alert -> context -> investigation -> runbook` in <= 2 clicks)
- [ ] Query transparency and explainability complete (mode, candidates, guardrail reasons visible)
- [ ] Optional provider-managed query-store integration hook available behind non-default toggle
- [x] Token-candidate planner with guardrails (window/candidate caps)

## P2 (operational hardening)

- [x] Alert evaluator with cooldown/dedupe/fingerprint + notifications
- [x] Ops metrics emission hooks (`ingest_*`, `query_*`)
- [x] Reprocessing job from raw storage to rebuild cold indexes (`POST /reprocess` + `npm run ops:reprocess`)
- [x] Load test automation for acceptance targets in PRD (`npm run test:load`)
- [x] Optional Terraform module for one-shot infra provisioning (`deploy/terraform/`)
- [x] Starter alert pack bootstrap + idempotent apply endpoint (`/alerts/starter-pack*`)

## Current implementation notes

- Query worker currently performs deep search by scanning R2 objects for `events/` and `tokens/` partitions.
- This is acceptable for differentiation-focused execution; backend integration with provider-managed query stores remains optional and non-core.
- Current auth mode is hybrid-safe: Access JWT required by default, with bearer session tokens used by traditional login.
