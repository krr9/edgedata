# Scheduled Searches V2 Implementation Plan

**Goal:** Turn scheduled searches from a thin cron counter into a first-class recurring analysis workflow with on-demand run results, durable run artifacts, and explainable comparisons across runs.

**Architecture:** Keep the existing `scheduled_searches` control plane in D1 and the existing alert-worker cron loop, but promote each execution into a durable run artifact. Store run metadata and summaries in D1, reuse the in-flight materialization storage model for larger payloads where possible, and add query-worker APIs plus a Pages run-detail experience for drilldown and comparisons.

**Tech Stack:** Cloudflare Workers (`workers/alert-worker`, `workers/query-worker`), D1 migrations, existing materialization storage (`materialized_results`), React + TypeScript (`pages`), existing auth/RBAC middleware, current PPL/search execution path.

**Product decision:** Scheduled searches remain distinct from alerts. Alerts answer "is a threshold firing now?" Scheduled searches answer "what did this recurring analysis produce, how did it change, and can I inspect or compare the output on demand?"

---

### Current gaps to fix

- `alert-worker` stores only a truncated inline snapshot today (`results.slice(0, 100)`), which is not a durable run artifact.
- `GET /scheduled-searches/:id/results` returns raw run rows but not a usable run-detail model.
- `POST /scheduled-searches/:id/run` is effectively a placeholder and does not execute a run.
- Pages only shows recent run status and result count, so scheduled searches behave like weak alert history instead of recurring reports.

---

### Target user experience

For each scheduled search, an operator should be able to:

1. See latest run health and summary on the list page.
2. Trigger `Run now` and receive a real `run_id`.
3. Open a run detail view with:
   - execution metadata
   - sampled or full results
   - query and evaluated time window
   - summary metrics
   - comparison against previous run / yesterday / last week
4. Open the run in the main search view for deeper investigation.
5. Receive Slack/webhook notifications that explain what changed, not just how many rows matched.

---

### Task 1: Lock the scheduled-search V2 contract

**Files:**
- Modify: `docs/plans/2026-03-05-operational-workflows-design.md`
- Optional: `README.md`

**Step 1: Clarify product semantics**

State explicitly:
- scheduled searches produce persisted run artifacts
- alerts remain threshold evaluators
- scheduled searches support comparison-oriented summaries and drilldown

**Step 2: Define run artifact contract**

Document three output layers per run:
- `metadata`: timing, status, counts, execution stats
- `summary`: compact derived insights for UI and notifications
- `artifact`: preview rows plus full payload reference when needed

**Step 3: Define comparison contract**

Support these baseline modes initially:
- previous run
- same scheduled window 24 hours earlier
- same scheduled window 7 days earlier
- explicit baseline run id

**Step 4: Verify docs remain consistent**

Make sure operational workflow docs do not continue describing scheduled searches as only "stored result rows".

---

### Task 2: Extend D1 schema for richer run metadata

**Files:**
- Create: `deploy/migrations/014_scheduled_search_run_artifacts.sql`
- Modify: `schema.sql`

**Step 1: Extend `scheduled_search_results` instead of replacing it**

Keep the existing table for backward compatibility, but add columns so each row clearly represents a run:
- `trigger_type` TEXT NOT NULL DEFAULT `'schedule'`
- `requested_by` TEXT
- `query_request_json` TEXT NOT NULL DEFAULT `'{}'`
- `preview_json` TEXT NOT NULL DEFAULT `'[]'`
- `summary_json` TEXT NOT NULL DEFAULT `'{}'`
- `materialized_result_id` TEXT
- `comparison_json` TEXT NOT NULL DEFAULT `'{}'`
- `started_at` TEXT
- `completed_at` TEXT
- `baseline_run_id` TEXT

**Step 2: Preserve compatibility during transition**

Continue writing `results_json` for a bounded preview during the transition window, but treat `preview_json` as the canonical inline preview field going forward.

**Step 3: Add indexes for new access patterns**

Add indexes for:
- `(scheduled_search_id, run_at DESC)`
- `(scheduled_search_id, status, run_at DESC)`
- `(materialized_result_id)`

**Step 4: Reuse existing materialization storage**

Do not invent a parallel artifact table if `materialized_results` is already sufficient. Prefer storing larger result payloads via `materialized_results.id` and keep D1 rows small.

**Step 5: Verify migration flow**

Run:
- `./scripts/check-migrations.sh`

Expected: migration ordering and schema validation stay intact.

---

### Task 3: Add scheduled-search run contract helpers

**Files:**
- Create: `workers/query-worker/src/scheduled-search-core.mjs`
- Test: `workers/query-worker/test/scheduled-search-core.test.mjs`
- Optional: `workers/alert-worker/src/scheduled-search-core.mjs`

**Step 1: Add normalization helpers**

Implement helpers for:
- run summary normalization
- preview bounds enforcement
- baseline selection
- comparison result shaping
- row fingerprint extraction for diffing

**Step 2: Define diff primitives**

Start with deterministic, explainable primitives:
- count delta
- added groups
- removed groups
- changed groups by key
- new event fingerprints for raw-event outputs

**Step 3: Bound cost and payload size**

Hard limits:
- max preview rows stored inline
- max groups diffed in a single run
- max serialized summary size

**Step 4: Add unit tests**

Cover:
- stats-table comparisons by grouping key
- raw-event comparisons by fingerprint
- empty baseline handling
- deterministic summary ordering

---

### Task 4: Refactor alert-worker scheduled execution into real run artifacts

**Files:**
- Modify: `workers/alert-worker/src/index.ts`
- Optional: create `workers/alert-worker/src/scheduled-search-executor.mjs`
- Test: `workers/alert-worker/test/scheduled-search-core.test.mjs`

**Step 1: Split execution phases**

Refactor scheduled execution into:
- build request window
- execute PPL query
- generate preview
- generate summary
- persist full artifact or inline payload
- compute comparison against baseline
- dispatch notifications

**Step 2: Write run metadata comprehensively**

Persist:
- `started_at`, `completed_at`
- `status`
- `result_count`
- execution stats (`duration_ms`, scan details if available)
- summary payload
- baseline linkage
- materialized artifact reference if payload is large

**Step 3: Add materialization fallback rules**

Suggested policy:
- inline preview only for small runs
- use `materialized_results` for larger payloads or when `materialize_enabled=1`
- keep retention cleanup separate for run metadata vs artifact payloads

**Step 4: Improve notification payloads**

Slack/webhook messages should include:
- result count
- delta vs baseline
- top changed entities
- run link / search deep link
- execution window

**Step 5: Preserve failure visibility**

On query failure or artifact write failure:
- persist an errored run row
- store `error_message`
- do not silently drop failed runs

---

### Task 5: Implement a real manual run path

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Modify: `workers/alert-worker/src/index.ts`
- Test: `workers/query-worker/test/query-core.test.mjs`

**Step 1: Replace the placeholder `POST /scheduled-searches/:id/run` behavior**

The endpoint should:
- validate ownership / RBAC
- trigger execution immediately
- return `202` only if truly queued, otherwise `200`
- always include `run_id` when a run record exists

**Step 2: Keep the first implementation simple**

Preferred v1:
- query-worker authenticates the caller
- query-worker creates a run request and forwards to alert-worker internal path
- alert-worker executes and returns the new run metadata

If direct execution from query-worker is cleaner, use that instead, but avoid shipping another fake queue placeholder.

**Step 3: Add idempotency guardrails**

Prevent accidental double-runs from rapid repeated clicks by reusing the same due-window run when safe.

**Step 4: Test ownership and error behavior**

Cover:
- owner can run
- non-owner cannot run unless admin
- missing search returns `404`
- worker failure returns persisted errored run metadata

---

### Task 6: Add run-focused query-worker endpoints

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Test: `workers/query-worker/test/query-core.test.mjs`

**Step 1: Expand list response**

`GET /scheduled-searches` should optionally include lightweight latest-run data:
- `last_run_at`
- `last_status`
- `last_result_count`
- `last_summary`

**Step 2: Replace the coarse results endpoint model**

Keep `GET /scheduled-searches/:id/results` for compatibility, but evolve it into a run-history endpoint that returns:
- run id
- window
- status
- count
- summary
- baseline metadata

**Step 3: Add run detail endpoint**

Add:
- `GET /scheduled-searches/:id/runs/:runId`

Return:
- full run metadata
- inline preview
- artifact metadata
- summary
- comparison summary

**Step 4: Add run artifact paging**

Add:
- `GET /scheduled-searches/:id/runs/:runId/results`

Behavior:
- return inline preview for small runs
- page or hydrate from materialized storage for larger runs

**Step 5: Add comparison endpoint**

Add:
- `GET /scheduled-searches/:id/runs/:runId/compare?baseline=previous|day|week|run:<id>`

Return:
- headline deltas
- changed groups
- new and removed entities
- fallback explanation when no valid baseline exists

---

### Task 7: Add a real Scheduled Search run UI in Pages

**Files:**
- Modify: `pages/src/App.tsx`
- Create: `pages/src/scheduled/RunHistoryPanel.tsx`
- Create: `pages/src/scheduled/RunDetailPanel.tsx`
- Create: `pages/src/scheduled/ComparisonSummary.tsx`
- Modify: `pages/src/index.css`

**Step 1: Improve list cards**

Each scheduled search row should show:
- latest run badge
- last run time
- latest result count
- short summary text
- `Run now`
- `View runs`
- `Open in search`

**Step 2: Add a run history surface**

Show more than status/count:
- execution window
- summary line
- delta vs baseline
- manual vs scheduled trigger

**Step 3: Add run detail panel**

For a selected run, show:
- metadata and query
- preview table
- comparison summary
- actions: `Open in search`, `Compare`, `Copy deep link`

**Step 4: Add comparison UI**

Provide baseline selector:
- previous run
- previous day
- previous week
- specific run

**Step 5: Keep the UI incremental**

Do not block the first release on a brand-new route if a drawer or expandable panel is faster to land. A dedicated route can follow once the run contract stabilizes.

---

### Task 8: Make comparisons useful instead of clever

**Files:**
- Modify: `workers/query-worker/src/scheduled-search-core.mjs`
- Modify: `workers/alert-worker/src/index.ts`
- Test: `workers/query-worker/test/scheduled-search-core.test.mjs`

**Step 1: Support two comparison strategies**

For grouped outputs like `stats ... by service`:
- compare by stable group key

For event/sample outputs:
- compare by event fingerprint such as `service + level + msg_hash`

**Step 2: Emit summary copy that operators can act on**

Examples:
- `error volume up 38% vs previous run`
- `2 new services entered the top offenders list`
- `checkoutservice disappeared from the last 24h failure sample`

**Step 3: Keep it explainable**

Do not ship opaque anomaly scoring in v1. Operators should be able to see why a run is "different" from its baseline.

---

### Task 9: Strengthen notification payloads

**Files:**
- Modify: `workers/alert-worker/src/index.ts`
- Optional: `docs/evidence/case-study-synthetic-alert-to-investigation.md`

**Step 1: Upgrade Slack/webhook templates**

Include:
- summary headline
- result count
- delta vs baseline
- top changed groups
- run detail link
- open-in-search link

**Step 2: Add per-search notification mode**

Allow future modes such as:
- `always`
- `only_on_change`
- `only_on_regression`

Start with schema support if implementing behavior immediately is too much for one pass.

---

### Task 10: Verification and rollout

**Files:**
- Test: `workers/query-worker/test/*.test.mjs`
- Test: `workers/alert-worker/test/*.test.mjs`
- Verify: `pages`

**Step 1: Unit-test the core logic**

Run:
- `npm run test:unit -- workers/query-worker/test/scheduled-search-core.test.mjs`
- `npm run test:unit -- workers/alert-worker/test/scheduled-search-core.test.mjs`

**Step 2: Run broader impacted tests**

Run:
- `npm run test:unit`
- `npm run test:access-config`

**Step 3: Verify frontend build**

Run:
- `npm -C pages run build`

**Step 4: Dry-run impacted workers**

Run:
- `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`
- `npx wrangler deploy --dry-run --config workers/alert-worker/wrangler.toml`

**Step 5: Manual acceptance checklist**

Confirm:
- a scheduled search can be manually executed and returns a real run id
- a run detail view shows preview rows and execution metadata
- comparison against previous run produces a stable summary
- notifications include a useful change summary
- existing scheduled searches continue running without migration breakage

---

### Recommended delivery order

**Phase 1: Make runs real**
- schema extension
- worker persistence refactor
- manual run endpoint
- run detail endpoint

**Phase 2: Make runs inspectable**
- Pages history/detail UI
- search deep-links
- inline preview and artifact hydration

**Phase 3: Make runs comparable**
- baseline selection
- deterministic diff summaries
- improved notifications

**Phase 4: Make runs smarter**
- notification modes (`only_on_change`, `only_on_regression`)
- richer baseline policies
- dashboard integration from scheduled-search run summaries

---

### Non-goals for this pass

- Replacing alerts with scheduled searches
- Adding opaque anomaly detection or ML scoring
- Building a full queueing system before manual execution works
- Storing unbounded payloads inline in D1
- Breaking existing `scheduled_searches` CRUD or owner-scoping semantics
