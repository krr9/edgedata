# Dashboard Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a full-featured dashboard widget builder using `react-grid-layout`, `antd`, and `echarts`, with query-backed widgets, D1 schema support, and backward-compatible dashboard behavior.

**Architecture:** Split dashboard into composable frontend modules (`DashboardPage`, grid, renderer, editor) and evolve query-worker dashboard panel contracts to a normalized widget DTO. Add D1 migration columns for widget config and layout persistence, while mapping legacy rows to the new model.

**Tech Stack:** React + TypeScript (Pages), `react-grid-layout`, `antd`, `echarts`, `echarts-for-react`, `react-markdown`, Cloudflare Workers (query-worker), D1 migration SQL.

---

### Task 1: Add frontend dependencies and baseline compile

**Files:**
- Modify: `pages/package.json`

**Step 1: Add dependency declarations**

Update `pages/package.json` dependencies:
- `react-grid-layout`
- `antd`
- `echarts`
- `echarts-for-react`
- `react-markdown`

**Step 2: Install dependencies**

Run: `npm -C pages install`  
Expected: Install succeeds with lockfile updates and no unresolved peer dependency errors.

**Step 3: Build baseline**

Run: `npm -C pages run build`  
Expected: Build passes before functional refactor begins.

**Step 4: Commit**

```bash
git add pages/package.json pages/package-lock.json
git commit -m "chore: add dashboard builder UI dependencies"
```

---

### Task 2: Add D1 migration for widget-backed dashboard panels

**Files:**
- Create: `deploy/migrations/00xx_dashboard_widgets.sql` (next sequential id)
- Modify: `workers/query-worker/src/starter-dashboards.mjs` (only if starter seeding needs new defaults)
- Test: migration dry-run through existing migration flow

**Step 1: Write migration (schema-first)**

Add `ALTER TABLE dashboard_panels` statements to introduce:
- `widget_type`
- `query_text`
- `query_mode`
- `viz_config_json`
- `layout_json`
- `bindings_json`
- `display_options_json`

Include safe defaults and backfill statements:
- `query_text = COALESCE(NULLIF(query_text, ''), ppl, '')`
- `widget_type` derived from legacy `viz_type`
- `layout_json` derived from `position` fallback grid placement

**Step 2: Verify migration applies**

Run: `npm run d1:migrate`  
Expected: Migration succeeds without data loss on existing rows.

**Step 3: Commit**

```bash
git add deploy/migrations/00xx_dashboard_widgets.sql workers/query-worker/src/starter-dashboards.mjs
git commit -m "feat: add widget configuration columns for dashboard panels"
```

---

### Task 3: Introduce widget DTOs and mapping helpers in query-worker

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- (Optional) Create: `workers/query-worker/src/dashboard-widgets.mjs` for mapper helpers
- Test: `npm run test:unit`

**Step 1: Write failing tests for mapping/validation**

Add tests to cover:
- Legacy row maps to normalized widget DTO
- Invalid `widget_type` rejected
- Markdown widget accepts empty `query_text`
- Data widgets require non-empty `query_text`

**Step 2: Run tests to verify RED**

Run: `npm run test:unit`  
Expected: New widget tests fail for missing mapper/validator logic.

**Step 3: Implement minimal mapper and validator**

Implement:
- `normalizeDashboardPanelRow(row)` -> widget DTO
- `validateWidgetPayload(body)` with bounds and JSON parsing guards

**Step 4: Run tests to verify GREEN**

Run: `npm run test:unit`  
Expected: New tests pass and no regressions in existing query tests.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts workers/query-worker/src/dashboard-widgets.mjs
git commit -m "feat: add normalized dashboard widget DTO mapping and validation"
```

---

### Task 4: Update dashboard panel CRUD endpoints for widget payloads

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Test: request-level tests or script checks against `/dashboards/:id/panels`

**Step 1: Write failing endpoint tests/checks**

Cover:
- `POST /dashboards/:id/panels` with full widget payload
- `PUT /dashboards/:id/panels/:id` partial updates
- `GET /dashboards/:id/panels` returns normalized shape

**Step 2: Verify RED**

Run: `npm run test:unit` (or existing endpoint verification script)  
Expected: endpoint behavior tests fail until handlers are updated.

**Step 3: Implement endpoint updates**

Update handlers to:
- Accept/store widget fields
- Preserve legacy fields for compatibility
- Return normalized DTO for reads

**Step 4: Verify GREEN**

Run:
- `npm run test:unit`
- `npm run test:access-config`

Expected: both pass with no auth/rbac regressions.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts
git commit -m "feat: support widget-first dashboard panel CRUD APIs"
```

---

### Task 5: Add optional lightweight server-side widget result cache

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Test: unit tests for key generation and TTL behavior (where practical)

**Step 1: Write failing cache-key tests**

Create tests for cache key normalization using:
- dashboard id
- widget id
- normalized query
- time range
- auth scope key

**Step 2: Verify RED**

Run: `npm run test:unit`  
Expected: tests fail before cache helper exists.

**Step 3: Implement minimal cache layer**

Implement short-TTL cache integration in dashboard query flow:
- TTL 15-30 seconds
- safe fallback on cache miss/error
- no cross-scope leakage

**Step 4: Verify GREEN**

Run: `npm run test:unit`  
Expected: key tests pass and no behavior regressions.

**Step 5: Commit**

```bash
git add workers/query-worker/src/index.ts
git commit -m "perf: add short-lived cache for dashboard widget query responses"
```

---

### Task 6: Split dashboard frontend into dedicated components

**Files:**
- Create: `pages/src/dashboard/types.ts`
- Create: `pages/src/dashboard/DashboardPage.tsx`
- Create: `pages/src/dashboard/WidgetGrid.tsx`
- Create: `pages/src/dashboard/WidgetRenderer.tsx`
- Create: `pages/src/dashboard/WidgetEditorDrawer.tsx`
- Modify: `pages/src/App.tsx`
- Modify: `pages/src/index.css` (or additional dashboard CSS module)

**Step 1: Write failing UI tests (or behavior checklist if no harness exists)**

Target behaviors:
- dashboard view renders from new `DashboardPage`
- edit mode toggle appears
- add widget action appears in edit mode

**Step 2: Verify RED**

Run: `npm -C pages run build`  
Expected: fails after swapping imports before all components are implemented.

**Step 3: Implement minimal component extraction**

Implement modular structure with typed props and state:
- move existing dashboard logic out of monolithic `App.tsx`
- wire selected dashboard and time controls through `DashboardPage`

**Step 4: Verify GREEN**

Run: `npm -C pages run build`  
Expected: build succeeds and dashboard route renders using new structure.

**Step 5: Commit**

```bash
git add pages/src/App.tsx pages/src/dashboard pages/src/index.css
git commit -m "refactor: extract dashboard page into modular widget builder components"
```

---

### Task 7: Implement `react-grid-layout` drag/resize and layout persistence

**Files:**
- Modify: `pages/src/dashboard/WidgetGrid.tsx`
- Modify: `pages/src/dashboard/DashboardPage.tsx`
- Modify: `workers/query-worker/src/index.ts` (if adding bulk layout endpoint)

**Step 1: Add failing behavior test/checklist**

Expected behaviors:
- drag/resize updates local layout state
- save action persists updated layout
- reload restores saved layout

**Step 2: Verify RED**

Run: `npm -C pages run build` and manual smoke  
Expected: persistence not working before wiring save API.

**Step 3: Implement minimal persistence**

Use `react-grid-layout` callbacks:
- `onLayoutChange` -> local dirty layout state
- save action -> panel `PUT` updates or bulk layout endpoint

**Step 4: Verify GREEN**

Run:
- `npm -C pages run build`
- manual smoke of drag/resize/save/reload

Expected: layout survives refresh.

**Step 5: Commit**

```bash
git add pages/src/dashboard workers/query-worker/src/index.ts
git commit -m "feat: add draggable/resizable widget grid with persisted layouts"
```

---

### Task 8: Implement widget rendering with ECharts, AntD table, and markdown

**Files:**
- Modify: `pages/src/dashboard/WidgetRenderer.tsx`
- (Optional) Create: `pages/src/dashboard/renderers/*.tsx`
- Modify: `pages/src/index.css`

**Step 1: Write failing renderer mapping tests**

Cover:
- type-to-renderer mapping for all v1 widget types
- safe fallback for unknown widget type

**Step 2: Verify RED**

Run: `npm -C pages run build`  
Expected: missing renderers/mapping causes failures.

**Step 3: Implement minimal renderers**

Implement:
- time series, bar, pie/donut, top-n via ECharts
- table via AntD Table
- KPI and markdown renderers

**Step 4: Verify GREEN**

Run: `npm -C pages run build`  
Expected: build succeeds and all types render with sample data.

**Step 5: Commit**

```bash
git add pages/src/dashboard pages/src/index.css
git commit -m "feat: add full widget renderer set with ECharts, AntD table, and markdown"
```

---

### Task 9: Build AntD widget editor drawer (create/edit/delete/duplicate)

**Files:**
- Modify: `pages/src/dashboard/WidgetEditorDrawer.tsx`
- Modify: `pages/src/dashboard/DashboardPage.tsx`

**Step 1: Write failing flow checks**

Flows:
- create widget via drawer
- edit existing widget
- duplicate widget
- delete widget with confirmation

**Step 2: Verify RED**

Run: `npm -C pages run build` and manual flow smoke  
Expected: flows fail before full wiring.

**Step 3: Implement minimal create/edit flows**

Use AntD `Form`, `Drawer`, `Tabs`, and `Modal`:
- validate required fields
- post/put/delete against dashboard panel APIs
- update local grid state optimistically where safe

**Step 4: Verify GREEN**

Run:
- `npm -C pages run build`
- manual smoke for all four flows

Expected: CRUD flows work and reflect immediately in grid.

**Step 5: Commit**

```bash
git add pages/src/dashboard
git commit -m "feat: add widget editor drawer with full widget CRUD flows"
```

---

### Task 10: Add error isolation, loading skeletons, and request de-duplication

**Files:**
- Modify: `pages/src/dashboard/DashboardPage.tsx`
- Modify: `pages/src/dashboard/WidgetRenderer.tsx`

**Step 1: Write failing behavior checks**

Checks:
- one widget query failure does not block others
- loading skeletons appear per widget
- duplicate refresh actions do not issue duplicate in-flight requests

**Step 2: Verify RED**

Run: `npm -C pages run build` and manual smoke  
Expected: behavior gaps observed.

**Step 3: Implement minimal resilience controls**

Add:
- per-widget state isolation
- widget-level loading placeholders
- in-flight map for de-duplication

**Step 4: Verify GREEN**

Run:
- `npm -C pages run build`
- manual smoke using an intentionally failing query widget

Expected: unaffected widgets continue rendering.

**Step 5: Commit**

```bash
git add pages/src/dashboard
git commit -m "fix: isolate widget failures and add per-widget loading and request dedup"
```

---

### Task 11: Verify end-to-end and guardrails

**Files:**
- Modify only as needed for fixes discovered during verification

**Step 1: Run required verification suite**

Run:
- `npm run test:unit`
- `npm run test:access-config`
- `npm -C pages run build`

Expected: all pass.

**Step 2: Optional worker bundle dry-runs**

Run:
- `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`

Expected: query worker bundles cleanly.

**Step 3: Manual acceptance smoke**

Validate:
- open dashboard view
- enter edit mode
- add each widget type
- drag/resize/save/reload
- edit and delete widget
- verify role-based access paths

**Step 4: Final commit**

```bash
git add .
git commit -m "feat: ship dashboard widget builder overhaul with schema-backed widgets"
```

---

## Notes for Execution

- Keep changes focused; do not refactor unrelated areas of `pages/src/App.tsx`.
- Preserve query guardrails and RBAC behavior unless explicitly changing product policy.
- Do not delete legacy fields in this pass; keep compatibility layer until a separate deprecation phase.
