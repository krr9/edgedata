# OTEL-First AI Search Implementation Plan

**Goal:** Turn EdgeData into an OpenTelemetry-first operational search product with continuous schema learning, index-aware query routing, and explainable AI-assisted query generation without weakening existing RBAC or search guardrails.

**Architecture:** Keep the current R2 `events`/`tokens` search path and WAE aggregate path intact. Add a metadata plane that learns `index -> service -> field schema` during ingest, consolidates that metadata into D1, and uses it in `query-worker` for smarter suggestions and natural-language-to-PPL query assist.

**Tech Stack:** Cloudflare Workers (`workers/ingest-worker`, `workers/query-worker`), D1 migrations, existing reprocess path, React + TypeScript (`pages`), current PPL parser/planner, existing RBAC/auth middleware.

**Product decision:** OTLP logs and traces are the only first-class ingest path for the next cycle. Generic JSON/NDJSON remains a compatibility path, but new intelligence features target OTEL semantics first.

---

### Task 1: Lock OTEL-first scope in product docs

**Files:**
- Modify: `README.md`
- Modify: `docs/PRD.md`
- Optional: `docs/EXECUTION_PLAN_30_60_90.md`

**Step 1: Update product positioning**

State clearly:
- EdgeData is OpenTelemetry-first
- OTLP logs/traces are the optimized ingestion path
- generic JSON/NDJSON is best-effort compatibility
- AI search means explainable query planning over learned schema, not opaque autonomous analysis

**Step 2: Update non-goals**

Add explicit non-goals:
- no per-event LLM inference at ingest
- no universal schema understanding for arbitrary log formats
- no unbounded secondary indexing of every attribute

**Step 3: Align architecture language**

Clarify that:
- current canonical schema remains the execution contract
- OTEL semantic fields are promoted first
- schema metadata is stored separately from raw/event/token data

**Step 4: Verify docs are internally consistent**

Check that README, PRD, and execution plan use the same OTEL-first language.

**Step 5: Commit**

```bash
git add README.md docs/PRD.md docs/EXECUTION_PLAN_30_60_90.md
git commit -m "docs: position EdgeData as OTEL-first for AI search roadmap"
```

---

### Task 2: Harden canonical OTEL normalization in ingest-worker

**Files:**
- Modify: `workers/ingest-worker/src/ingest-framework.mjs`
- Modify: `workers/ingest-worker/src/index.ts`
- Test: `workers/ingest-worker/test/ingest-framework.test.mjs`

**Step 1: Define OTEL semantic field promotion rules**

Promote these fields consistently when present:
- `service.name` -> `service`
- `deployment.environment` -> `env`
- `host.name` -> `host`
- `trace_id`, `span_id`, `parent_span_id`
- `http.method`, `http.route`, `http.status_code`
- `rpc.system`, `rpc.method`
- `otel.scope.name`, `otel.scope.version`
- `otel.span.kind`, `otel.span.status_code`

**Step 2: Add alias normalization**

Create a bounded alias map so equivalent OTEL keys normalize predictably across logs and traces.

Examples:
- `http.status_code` and `http.response.status_code`
- `trace.id` and `trace_id`
- `enduser.id`, `user.id`, and `user_id`

**Step 3: Preserve long-tail attrs without over-promoting**

Continue storing remaining OTEL/custom attributes in `attrs_json`, but ensure promoted fields are removed from ambiguity and stay stable.

**Step 4: Add tests**

Cover:
- OTLP log payload normalization
- OTLP trace payload normalization
- alias collisions and precedence
- bounded attribute handling

**Step 5: Verify**

Run:
- `npm run test:unit -- workers/ingest-worker/test/ingest-framework.test.mjs`

Expected: PASS with stable OTEL field extraction.

**Step 6: Commit**

```bash
git add workers/ingest-worker/src/ingest-framework.mjs workers/ingest-worker/src/index.ts workers/ingest-worker/test/ingest-framework.test.mjs
git commit -m "feat(ingest): harden OTEL normalization for schema-aware search"
```

---

### Task 3: Add D1 schema catalog tables

**Files:**
- Create: `deploy/migrations/013_schema_catalog.sql`
- Modify: `schema.sql`

**Step 1: Add observation table**

Create `schema_field_observations` for short-window ingest observations.

Minimum columns:
- `id` TEXT PK
- `index_name` TEXT NOT NULL
- `service_name` TEXT NOT NULL
- `field_path` TEXT NOT NULL
- `field_type` TEXT NOT NULL
- `semantic_type` TEXT
- `source_kind` TEXT NOT NULL
- `sample_value` TEXT
- `observed_at` TEXT NOT NULL
- `date_hour` TEXT NOT NULL

Add indexes on:
- `(index_name, service_name, observed_at DESC)`
- `(field_path, observed_at DESC)`

**Step 2: Add stable field catalog table**

Create `schema_fields` for merged schema state.

Minimum columns:
- `id` TEXT PK
- `index_name` TEXT NOT NULL
- `service_name` TEXT NOT NULL
- `field_path` TEXT NOT NULL
- `field_type` TEXT NOT NULL
- `semantic_type` TEXT
- `source_kind` TEXT NOT NULL
- `presence_count` INTEGER NOT NULL DEFAULT 0
- `sample_values_json` TEXT NOT NULL DEFAULT '[]'
- `cardinality_hint` TEXT
- `promoted` INTEGER NOT NULL DEFAULT 0
- `first_seen_at` TEXT NOT NULL
- `last_seen_at` TEXT NOT NULL

Add unique index on:
- `(index_name, service_name, field_path)`

**Step 3: Add index profile table**

Create `index_profiles` with:
- `index_name` TEXT PK
- `profile_json` TEXT NOT NULL DEFAULT '{}'
- `otel_confidence` REAL NOT NULL DEFAULT 0
- `top_services_json` TEXT NOT NULL DEFAULT '[]'
- `top_terms_json` TEXT NOT NULL DEFAULT '[]'
- `updated_at` TEXT NOT NULL

**Step 4: Add feedback table**

Create `query_assist_feedback` with:
- `id` TEXT PK
- `principal` TEXT
- `query_text` TEXT NOT NULL
- `chosen_index` TEXT
- `generated_ppl` TEXT
- `accepted` INTEGER
- `edited` INTEGER
- `executed` INTEGER
- `created_at` TEXT NOT NULL

**Step 5: Verify migration shape**

Run:
- `./scripts/check-migrations.sh`

Expected: PASS with migration ordering intact.

**Step 6: Commit**

```bash
git add deploy/migrations/013_schema_catalog.sql schema.sql
git commit -m "feat(db): add schema catalog tables for OTEL-first AI search"
```

---

### Task 4: Implement ingest-time schema observation

**Files:**
- Modify: `workers/ingest-worker/src/index.ts`
- Optional: create `workers/ingest-worker/src/schema-observer.mjs`
- Test: new ingest-worker unit tests if split into helper

**Step 1: Build field extraction helper**

Extract schema observations from each normalized event:
- canonical fields
- selected promoted OTEL attrs
- flattened `attrs_json` dotted paths with depth and count bounds

Each observation should infer:
- primitive type: `string`, `int`, `float`, `bool`, `timestamp`, `ip`, `json`
- semantic type: `identifier`, `dimension`, `status_code`, `duration`, `trace_id`, `message_like`, `otel_semantic`
- source kind: `canonical`, `otel`, `custom`

**Step 2: Bound the work**

Hard limits:
- max observed custom fields per event
- max flatten depth
- max sample value length
- no recursive schema expansion beyond a safe depth

**Step 3: Persist asynchronously**

Write observations through `ctx.waitUntil(...)` after ingest normalization and alongside existing async writes.

Do not block the critical ingest response on schema observation writes.

**Step 4: Emit ops metrics**

Track:
- observation rows written
- observation write failures
- schema fields skipped due to bounds

**Step 5: Verify**

Run:
- `npm run test:unit`

Expected: PASS with no ingest regressions.

**Step 6: Commit**

```bash
git add workers/ingest-worker/src/index.ts workers/ingest-worker/src/schema-observer.mjs workers/ingest-worker/test
git commit -m "feat(ingest): capture schema observations during OTEL ingest"
```

---

### Task 5: Extend reprocess path to backfill schema metadata

**Files:**
- Modify: `workers/ingest-worker/src/index.ts`
- Modify: `scripts/reprocess-raw.mjs`

**Step 1: Add reprocess mode**

Extend `/reprocess` and the script wrapper to support:
- `schema_only`
- `indexes_only`
- `full`

Default behavior should remain backward compatible.

**Step 2: Reuse normalization pipeline**

Backfill schema by reading raw objects, normalizing them through existing code paths, then sending schema observations through the same bounded extractor.

**Step 3: Add dry-run reporting**

Return:
- matched objects
- normalized events
- observation rows that would be written

**Step 4: Verify**

Run:
- `npm run test:unit`

Expected: PASS with reprocess compatibility preserved.

**Step 5: Commit**

```bash
git add workers/ingest-worker/src/index.ts scripts/reprocess-raw.mjs
git commit -m "feat(ops): add schema backfill mode to raw reprocess flow"
```

---

### Task 6: Add schema consolidation and drift detection in query-worker

**Files:**
- Create: `workers/query-worker/src/schema-catalog-core.mjs`
- Modify: `workers/query-worker/src/index.ts`
- Test: `workers/query-worker/test/schema-catalog-core.test.mjs`

**Step 1: Implement observation consolidation**

Merge `schema_field_observations` into `schema_fields` by:
- field path
- index
- service
- source kind

Update:
- `presence_count`
- rolling `sample_values_json`
- `first_seen_at`
- `last_seen_at`
- `cardinality_hint`

**Step 2: Build index profile generation**

For each index, compute:
- top services
- most stable fields
- OTEL confidence score
- top terms if available from summary cache or sampled events

Store result in `index_profiles`.

**Step 3: Detect drift**

Mark and return:
- new fields
- disappearing critical fields
- field type changes
- sudden custom-field explosions

Keep drift bounded and informational first; do not fail ingest/query flows.

**Step 4: Add admin trigger endpoint**

Add a bounded endpoint such as:
- `POST /admin/schema/consolidate`

Protect it with admin permissions and return summary stats.

**Step 5: Add tests**

Cover:
- stable merge behavior
- type conflict resolution
- OTEL confidence scoring
- drift signal generation

**Step 6: Verify**

Run:
- `npm run test:unit -- workers/query-worker/test/schema-catalog-core.test.mjs`

Expected: PASS.

**Step 7: Commit**

```bash
git add workers/query-worker/src/schema-catalog-core.mjs workers/query-worker/src/index.ts workers/query-worker/test/schema-catalog-core.test.mjs
git commit -m "feat(api): add schema consolidation and index profile generation"
```

---

### Task 7: Add schema APIs for indexes, services, and fields

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Test: new query-worker endpoint tests

**Step 1: Add read APIs**

Implement:
- `GET /schema/indexes`
- `GET /schema/indexes/:index`
- `GET /schema/indexes/:index/services/:service`

Each response should be RBAC-filtered by the caller's allowed scope.

**Step 2: Define response shapes**

Include:
- top services
- promoted fields
- field type and semantic type
- sample values
- last seen timestamp
- OTEL confidence
- drift flags if present

**Step 3: Add lightweight search endpoint**

Optional:
- `POST /schema/lookup`

Allow field name prefix search scoped to the user's visible indexes/services.

**Step 4: Verify**

Run:
- `npm run test:unit`

Expected: PASS with auth and scope enforcement intact.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts workers/query-worker/test
git commit -m "feat(api): add RBAC-scoped schema catalog endpoints"
```

---

### Task 8: Upgrade PPL suggestions to use learned schema

**Files:**
- Modify: `workers/query-worker/src/ppl-suggestions.mjs`
- Modify: `workers/query-worker/src/index.ts`
- Test: `workers/query-worker/test/ppl-suggestions.test.mjs`

**Step 1: Replace hard-coded-only field bias**

Keep current canonical suggestions, but supplement them with schema-derived fields from the selected or inferred index/service.

**Step 2: Prioritize OTEL-relevant fields**

Bias higher:
- `trace_id`
- `span_id`
- `http.status_code`
- `http.route`
- `otel.span.kind`
- `service`
- `env`
- `duration_ms`

**Step 3: Use context-aware ranking**

Rank suggestions using:
- current index filter
- current service filter
- recent field usage
- promoted field flag
- OTEL confidence

**Step 4: Verify**

Run:
- `npm run test:unit -- workers/query-worker/test/ppl-suggestions.test.mjs`

Expected: PASS with deterministic ranking behavior.

**Step 5: Commit**

```bash
git add workers/query-worker/src/ppl-suggestions.mjs workers/query-worker/src/index.ts workers/query-worker/test/ppl-suggestions.test.mjs
git commit -m "feat(search): make PPL suggestions schema-aware for OTEL indexes"
```

---

### Task 9: Add natural-language query assist with index routing

**Files:**
- Create: `workers/query-worker/src/search-assist-core.mjs`
- Modify: `workers/query-worker/src/index.ts`
- Test: `workers/query-worker/test/search-assist-core.test.mjs`

**Step 1: Start with heuristic assist, not LLM dependency**

Implement intent classification for common OTEL workflows:
- error investigation
- latency spike
- trace lookup
- route-specific failures
- service comparison
- auth anomaly

**Step 2: Add index routing**

Score candidate indexes using:
- query term overlap with `index_profiles`
- service and field matches from `schema_fields`
- current UI context
- RBAC-visible scope

Return top candidate indexes and a chosen primary index.

**Step 3: Generate bounded PPL**

Compile explainable PPL that:
- includes explicit `index=...` when confidence is sufficient
- uses known schema fields only
- respects existing phrase/token/structured guardrails
- remains editable before execution

**Step 4: Add assist endpoint**

Implement:
- `POST /search/assist`

Response fields:
- `intent`
- `candidate_indexes`
- `chosen_index`
- `confidence`
- `generated_ppl`
- `reasoning_summary`
- `guardrail_notes`

**Step 5: Capture feedback**

Add a bounded write path for acceptance/edit/reject feedback into `query_assist_feedback`.

**Step 6: Verify**

Run:
- `npm run test:unit -- workers/query-worker/test/search-assist-core.test.mjs`

Expected: PASS with valid generated PPL and safe routing behavior.

**Step 7: Commit**

```bash
git add workers/query-worker/src/search-assist-core.mjs workers/query-worker/src/index.ts workers/query-worker/test/search-assist-core.test.mjs
git commit -m "feat(ai): add OTEL-first natural language query assist with index routing"
```

---

### Task 10: Add assisted-search UX in Pages

**Files:**
- Modify: `pages/src/App.tsx`
- Optional: create `pages/src/search-assist/*`
- Modify: `pages/src/index.css`

**Step 1: Add Ask/Search mode switch**

Allow the user to choose between:
- raw PPL search
- AI-assisted ask mode

**Step 2: Render transparent assist output**

Show:
- selected index
- inferred time range
- intent label
- generated PPL
- confidence
- reason summary

The user must be able to edit the PPL before execution.

**Step 3: Add schema explorer panel**

For the selected index/service, show:
- promoted OTEL fields
- top attributes
- sample values
- last-seen timestamps

**Step 4: Capture feedback**

Expose explicit actions:
- Use query
- Edit and run
- Reject

Send feedback to the assist feedback endpoint.

**Step 5: Verify**

Run:
- `npm -C pages run build`

Expected: PASS with no type/build regressions.

**Step 6: Commit**

```bash
git add pages/src/App.tsx pages/src/index.css pages/src/search-assist
git commit -m "feat(ui): add OTEL-first assisted search and schema explorer"
```

---

### Task 11: Add field promotion policy and bounded secondary indexing

**Files:**
- Modify: `workers/ingest-worker/src/index.ts`
- Modify: `workers/query-worker/src/schema-catalog-core.mjs`
- Test: targeted unit tests

**Step 1: Define promotion criteria**

Promote fields only when they are:
- OTEL-semantic or canonical
- present frequently enough
- stable in type
- useful in actual queries

**Step 2: Keep token growth bounded**

Do not tokenize every discovered field.

If secondary field tokenization is added, restrict it to promoted fields only and use a strict prefix namespace such as:
- `attr:http.method:get`
- `attr:http.route:/cart/checkout`

**Step 3: Reuse query feedback**

Use real accepted/edited queries to inform promotion decisions rather than static allowlists alone.

**Step 4: Verify**

Run:
- `npm run test:unit`

Expected: PASS without violating existing ingest/token limits.

**Step 5: Commit**

```bash
git add workers/ingest-worker/src/index.ts workers/query-worker/src/schema-catalog-core.mjs workers/query-worker/test
git commit -m "feat(search): add bounded field promotion policy for OTEL schema learning"
```

---

### Task 12: End-to-end verification and rollout gates

**Files:**
- Optional: `scripts/run-golden-activation.sh`
- Optional: new smoke script for schema/assist workflow
- Modify docs as needed

**Step 1: Add a schema-aware smoke path**

Test flow:
- ingest OTEL sample payload
- verify schema catalog population
- consolidate schema
- request `/search/assist`
- run generated PPL
- verify result set and planner stats

**Step 2: Define rollout gates**

Require before general availability:
- no measurable ingest latency regression beyond agreed threshold
- schema APIs honor RBAC scope
- query assist always produces valid PPL or explicit ambiguity
- index routing confidence is measurable and logged

**Step 3: Add feature flags if needed**

Gate:
- schema observation
- assist endpoint
- UI ask mode

Use existing runtime/admin patterns where possible.

**Step 4: Verify**

Run:
- `npm run test:unit`
- `npm run test:access-config`
- `npm -C pages run build`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts workers pages docs
git commit -m "test: add OTEL-first schema and assisted-search rollout verification"
```

---

## Delivery Order

1. Task 1: docs and product contract
2. Task 2: OTEL normalization hardening
3. Task 3: D1 schema catalog
4. Task 4: ingest-time observation
5. Task 5: reprocess backfill
6. Task 6: consolidation and drift
7. Task 7: schema APIs
8. Task 8: schema-aware suggestions
9. Task 9: natural-language assist
10. Task 10: UI
11. Task 11: promotion policy
12. Task 12: rollout verification

## Scope Rules

- Do not change the current search execution contract or bypass planner guardrails.
- Do not broaden generic log support while implementing OTEL-first AI search.
- Do not add unbounded field indexing or per-event AI inference.
- Prefer heuristic assist first; add model-backed assist only behind a feature flag after schema quality is proven.

## Definition of Done

- OTEL is clearly the first-class ingest story in product docs and UX.
- Schema metadata is learned continuously and can be backfilled from raw.
- Query-worker exposes RBAC-scoped schema APIs and index profiles.
- Assisted search produces explainable, editable, valid PPL.
- Existing search guardrails, index routing semantics, and auth constraints remain intact.
- Unit tests and frontend build pass for impacted areas.
