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

## P1 (core architecture parity)

- [x] Canonical normalization at ingest (`ts,date,hour,service,env,host,level,message,msg_hash,...`)
- [x] Tri-write pattern (raw + hot metrics + token/event indexes)
- [ ] Iceberg/R2 Data Catalog as primary query store
- [ ] R2 SQL execution path over Iceberg tables (instead of object scans)
- [ ] Compaction/maintenance pipeline for query performance
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
- This delivers functionality but does not yet meet the PRD target architecture of Iceberg + R2 SQL query execution.
- Current auth mode is hybrid-safe: Access JWT required by default, with bearer session tokens used by traditional login.
