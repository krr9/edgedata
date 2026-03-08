# Investigation Acceleration Pack Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a high-demo-ROI investigation flow that moves users from alert/search/dashboard signals to root-cause context quickly via prefilled workspace, related events, and shareable triage sessions.

**Architecture:** Add bounded investigation endpoints in `query-worker`, persist triage sessions in D1, and introduce a Pages investigation surface that composes timeline, pivots, related events, and event stream panels. Ship three quick wins first (deep-link prefill, pivot chips, related events), then harden into a dedicated `Incident Workspace` route and demo scenario mode.

**Tech Stack:** Cloudflare Workers (`workers/query-worker`), D1 migrations, React + TypeScript (`pages`), existing PPL/search APIs, existing RBAC/auth middleware.

---

### Task 1: Add D1 schema for investigation sessions

**Files:**
- Create: `deploy/migrations/011_investigation_sessions.sql`
- Modify: `schema.sql`

**Step 1: Write the failing migration expectation check**

Define expected columns and constraints:
- `id` (TEXT PK)
- `owner_user_id` (TEXT)
- `source_type` (TEXT)
- `scope_json` (TEXT NOT NULL)
- `state_json` (TEXT NOT NULL)
- `created_at` (TEXT NOT NULL)
- `expires_at` (TEXT NULL)

**Step 2: Run migration flow to verify RED**

Run: `npm run d1:migrate`  
Expected: FAIL because migration `011` does not exist yet.

**Step 3: Write minimal migration and schema mirror**

Create table with index on `owner_user_id, created_at` and safe defaults for JSON text fields.

**Step 4: Run migration flow to verify GREEN**

Run: `npm run d1:migrate`  
Expected: PASS with new table created.

**Step 5: Commit**

```bash
git add deploy/migrations/011_investigation_sessions.sql schema.sql
git commit -m "feat(db): add investigation session persistence table"
```

---

### Task 2: Add investigation contract helpers in query-worker

**Files:**
- Create: `workers/query-worker/src/investigation-core.mjs`
- Test: `workers/query-worker/test/investigation-core.test.mjs`

**Step 1: Write failing unit tests for contract normalization**

Cover:
- bootstrap request validation (required fields + bounds)
- pivot normalization (`trace_id`, `request_id`, `user_id`, `msg_hash`)
- related-events bounds validation (time/candidate caps)
- session payload serialization size guard

**Step 2: Run test to verify RED**

Run: `npm run test:unit -- workers/query-worker/test/investigation-core.test.mjs`  
Expected: FAIL for missing helper module.

**Step 3: Implement minimal helper module**

Implement:
- `validateBootstrapRequest(body)`
- `normalizePivots(input)`
- `validateRelatedEventsRequest(body)`
- `buildSessionRecord(input)`

**Step 4: Run test to verify GREEN**

Run: `npm run test:unit -- workers/query-worker/test/investigation-core.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add workers/query-worker/src/investigation-core.mjs workers/query-worker/test/investigation-core.test.mjs
git commit -m "feat(api): add investigation request validation and normalization helpers"
```

---

### Task 3: Implement `POST /investigations/bootstrap`

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Test: `workers/query-worker/test/query-core.test.mjs`

**Step 1: Write failing endpoint behavior tests**

Cover:
- valid payload returns bootstrap shape with starter queries
- missing scope/time returns `400`
- unauthorized caller returns `401/403`

**Step 2: Run tests to verify RED**

Run: `npm run test:unit`  
Expected: FAIL on new endpoint expectations.

**Step 3: Implement minimal endpoint**

Use existing auth and planner guardrail utilities; return:
- normalized scope
- prebuilt panel query definitions
- recommended pivot chips

**Step 4: Run tests to verify GREEN**

Run: `npm run test:unit`  
Expected: PASS with no regressions.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts workers/query-worker/test/query-core.test.mjs
git commit -m "feat(api): add investigation bootstrap endpoint"
```

---

### Task 4: Implement `POST /investigations/related-events`

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Modify: `workers/query-worker/src/investigation-core.mjs`
- Test: `workers/query-worker/test/investigation-core.test.mjs`

**Step 1: Write failing tests for ranking and guardrails**

Cover:
- exact pivot match ranks above token overlap
- candidate cap enforced
- window cap enforced
- response includes `match_reason`

**Step 2: Run tests to verify RED**

Run: `npm run test:unit -- workers/query-worker/test/investigation-core.test.mjs`  
Expected: FAIL due to missing scoring logic.

**Step 3: Implement bounded related-events ranking**

Implement weighted match scoring and stable sorting with explicit caps.

**Step 4: Run tests to verify GREEN**

Run: `npm run test:unit`  
Expected: PASS.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts workers/query-worker/src/investigation-core.mjs workers/query-worker/test/investigation-core.test.mjs
git commit -m "feat(api): add bounded related-events endpoint with explainable ranking"
```

---

### Task 5: Implement session save/load endpoints

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Modify: `workers/query-worker/src/investigation-core.mjs`
- Test: `workers/query-worker/test/query-core.test.mjs`

**Step 1: Write failing tests for session ownership semantics**

Cover:
- owner can save and fetch
- non-owner cannot fetch unless admin role
- invalid session id returns `404`

**Step 2: Run tests to verify RED**

Run: `npm run test:unit`  
Expected: FAIL on ownership checks.

**Step 3: Implement minimal endpoints**

Add:
- `POST /investigations/session`
- `GET /investigations/session/:id`

Enforce owner/admin access and JSON size limits.

**Step 4: Run tests to verify GREEN**

Run: `npm run test:unit`  
Expected: PASS.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts workers/query-worker/src/investigation-core.mjs workers/query-worker/test/query-core.test.mjs
git commit -m "feat(api): add investigation session save and restore endpoints"
```

---

### Task 6: Add quick win UI deep-link and pivot chips

**Files:**
- Modify: `pages/src/App.tsx`
- Create: `pages/src/investigation/types.ts`
- Create: `pages/src/investigation/PivotChips.tsx`
- Modify: `pages/src/index.css`

**Step 1: Write failing UI behavior checklist**

Checklist:
- query string prefill hydrates investigation scope
- pivot chips render from prefilled pivots
- clicking chip updates investigation query state

**Step 2: Run build to verify RED**

Run: `npm -C pages run build`  
Expected: FAIL until new investigation components are wired.

**Step 3: Implement minimal deep-link + pivot chip wiring**

Parse investigation params from URL and connect chip actions to local scope state.

**Step 4: Run build to verify GREEN**

Run: `npm -C pages run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add pages/src/App.tsx pages/src/investigation/types.ts pages/src/investigation/PivotChips.tsx pages/src/index.css
git commit -m "feat(ui): add investigation deep-link prefill and pivot chip controls"
```

---

### Task 7: Add related events panel in Pages

**Files:**
- Create: `pages/src/investigation/RelatedEventsPanel.tsx`
- Modify: `pages/src/investigation/types.ts`
- Modify: `pages/src/App.tsx`

**Step 1: Write failing behavior checklist**

Checklist:
- panel requests related events with current scope
- failed request is isolated to panel
- selecting related row pivots workspace state

**Step 2: Run build to verify RED**

Run: `npm -C pages run build`  
Expected: FAIL while component integration is incomplete.

**Step 3: Implement minimal panel**

Call `POST /investigations/related-events`, render match reason badges, and expose pivot actions.

**Step 4: Run build to verify GREEN**

Run: `npm -C pages run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add pages/src/investigation/RelatedEventsPanel.tsx pages/src/investigation/types.ts pages/src/App.tsx
git commit -m "feat(ui): add related events panel for investigation workflows"
```

---

### Task 8: Build dedicated Incident Workspace shell (bigger bet)

**Files:**
- Create: `pages/src/investigation/IncidentWorkspacePage.tsx`
- Create: `pages/src/investigation/InvestigationTimeline.tsx`
- Create: `pages/src/investigation/SessionShareBar.tsx`
- Modify: `pages/src/App.tsx`
- Modify: `pages/src/index.css`

**Step 1: Write failing behavior checklist**

Checklist:
- workspace route renders from app navigation
- bootstrap endpoint hydrates timeline/top signal sections
- share bar can save state and restore from session link

**Step 2: Run build to verify RED**

Run: `npm -C pages run build`  
Expected: FAIL before full route/component wiring.

**Step 3: Implement minimal workspace shell**

Compose page sections and wire bootstrap/session APIs; keep other app routes unchanged.

**Step 4: Run build to verify GREEN**

Run: `npm -C pages run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add pages/src/investigation pages/src/App.tsx pages/src/index.css
git commit -m "feat(ui): add incident workspace route with bootstrap and session sharing"
```

---

### Task 9: Add demo scenario mode presets

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Create: `pages/src/investigation/DemoScenarioPicker.tsx`
- Modify: `pages/src/investigation/IncidentWorkspacePage.tsx`

**Step 1: Write failing behavior checklist**

Checklist:
- preset scenarios available in demo environments only
- selecting scenario updates scope, pivots, and starter panels
- non-demo env does not show scenario picker

**Step 2: Run verification to verify RED**

Run:
- `npm run test:unit`
- `npm -C pages run build`  
Expected: FAIL before scenario wiring.

**Step 3: Implement minimal scenario mode**

Expose preset payloads via query-worker and bind selector to workspace bootstrap actions.

**Step 4: Run verification to verify GREEN**

Run:
- `npm run test:unit`
- `npm -C pages run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts pages/src/investigation/DemoScenarioPicker.tsx pages/src/investigation/IncidentWorkspacePage.tsx
git commit -m "feat(demo): add guided investigation scenario presets"
```

---

### Task 10: Final guardrail verification and docs touch-up

**Files:**
- Modify: `README.md`
- Modify: `docs/PRD.md` (only if API surface summary needs update)
- Modify: additional files only for fixes found during verification

**Step 1: Run full required verification suite**

Run:
- `npm run test:unit`
- `npm run test:access-config`
- `npm -C pages run build`

Expected: all PASS.

**Step 2: Optional bundle validation**

Run: `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`  
Expected: bundle succeeds.

**Step 3: Update docs for new endpoints/routes**

Document:
- investigation endpoints
- workspace route and share behavior
- any new required env vars

**Step 4: Re-run minimal verification**

Run:
- `npm run test:unit`
- `npm -C pages run build`

Expected: PASS.

**Step 5: Commit**

```bash
git add README.md docs/PRD.md workers/query-worker/src pages/src/investigation pages/src/App.tsx deploy/migrations/011_investigation_sessions.sql schema.sql
git commit -m "feat: ship investigation acceleration pack with workspace and triage quick wins"
```

---

## Notes for Execution

- Preserve existing query planner guardrails and RBAC behavior.
- Keep endpoints backward-compatible with existing UI/API clients.
- Favor small, reviewable commits by task to reduce rollback risk.
- Prefer bounded heuristics over broad scans for related-events behavior.
