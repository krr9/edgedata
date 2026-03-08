# EdgeData Dashboard Overhaul Design
## Widget Builder with React Grid Layout, Ant Design, and ECharts

**Date:** 2026-03-07  
**Status:** Approved  
**Scope:** Replace current static dashboard cards with a full-featured widget builder and runtime experience using popular, lightweight libraries and schema-backed widget configuration.

---

## 1) Goals and Product Direction

### 1.1 Goals

1. Deliver a polished, intuitive dashboard builder where users assemble dashboards from query-backed widgets.
2. Use popular frameworks instead of custom widget implementations.
3. Preserve current search/query guardrails and RBAC semantics.
4. Keep rollout safe by maintaining backward compatibility for existing dashboards while introducing a richer widget model.

### 1.2 Chosen stack

- Layout and drag/resize: `react-grid-layout`
- UI framework and form UX: `antd`
- Visualization engine: `echarts` + `echarts-for-react`
- Markdown widget support: `react-markdown`

### 1.3 Included widget set (v1)

- Time series
- Bar
- Pie/Donut
- Table
- KPI / Single-stat
- Top-N breakdown
- Markdown/Text note

---

## 2) Frontend Architecture (Pages)

### 2.1 Module breakdown

- `DashboardPage` container
  - Owns dashboard selection, global time range, view/edit mode, and refresh orchestration.
- `WidgetGrid` (`react-grid-layout`)
  - Renders responsive draggable/resizable widgets and emits layout changes.
- `WidgetRenderer`
  - Maps widget type to renderer implementation (ECharts series/chart, AntD table, Markdown, KPI).
- `WidgetEditorDrawer` (AntD drawer + form)
  - Single create/edit experience with sections for Data, Visualization, Layout, and Display.
- `WidgetChrome`
  - Reusable header/actions for each widget card: edit, duplicate, refresh, delete.

### 2.2 Interaction model

- View mode: read-only dashboard experience with time presets and refresh actions.
- Edit mode: layout handles, add-widget action, save/discard changes controls.
- Add widget flow in one drawer:
  1. Widget type
  2. Query and field binding
  3. Visual/display options

---

## 3) Data Model and API Contract (Query Worker + D1)

### 3.1 Schema strategy

Keep existing `dashboards` and `dashboard_panels` tables, evolve `dashboard_panels` with explicit widget configuration fields.

Add columns to `dashboard_panels`:

- `widget_type` TEXT NOT NULL DEFAULT `'table'`
- `query_text` TEXT NOT NULL DEFAULT `''`
- `query_mode` TEXT NOT NULL DEFAULT `'ppl'`
- `viz_config_json` TEXT NOT NULL DEFAULT `'{}'`
- `layout_json` TEXT NOT NULL DEFAULT `'{}'`
- `bindings_json` TEXT NOT NULL DEFAULT `'{}'`
- `display_options_json` TEXT NOT NULL DEFAULT `'{}'`

Keep legacy fields (`ppl`, `viz_type`, `position`, `options_json`) for compatibility during transition and backfill/mapping.

### 3.2 API behavior

- `GET /dashboards/:id/panels`
  - Returns normalized widget DTO shape; legacy rows are mapped in response.
- `POST /dashboards/:id/panels`
  - Accepts full widget payload (type/query/layout/bindings/options).
- `PUT /dashboards/:id/panels/:panelId`
  - Partial updates from editor saves.
- Optional convenience endpoint:
  - `PUT /dashboards/:id/layout` for bulk layout persistence.
- Keep `POST /dashboards/query` and `/search` execution path for widget data retrieval.

### 3.3 Validation and limits

- Worker enforces allowed widget types.
- Query required for data widgets; optional for markdown widget.
- Validate JSON blobs and cap payload size.
- Enforce layout bounds (grid width/height/min-max constraints).

---

## 4) Runtime Data Flow, Caching, and Error Handling

### 4.1 Query execution flow

1. Load dashboards list, selected dashboard widgets, and layout config.
2. Execute widget queries in parallel with bounded concurrency.
3. Track per-widget loading, data, and error state (isolation by widget).
4. Support per-widget refresh and global refresh.

### 4.2 Caching and throttling decisions

- Primary cache: lightweight worker-side cache with short TTL (15-30s) for widget query results.
- Cache key includes:
  - dashboard id
  - widget id
  - normalized query text
  - time range
  - auth scope key
- Frontend keeps only minimal tab-switch snapshot (UX continuity), not a general query cache.
- Frontend request de-duplication prevents duplicate in-flight requests.
- Debounced layout persistence avoids write amplification while dragging/resizing.

### 4.3 Error behavior

- Widget runtime errors render inside the affected widget card, with retry and edit actions.
- One widget failure never blocks the rest of the dashboard.
- Form validation errors are surfaced before save in editor drawer.

---

## 5) UX Principles

1. **Clarity over cleverness:** view mode and edit mode are explicit and visually distinct.
2. **Progressive disclosure:** widget setup starts simple; advanced options stay available.
3. **Fast iteration:** query preview and field mapping in-editor.
4. **Low friction:** add/edit/duplicate/delete are all one-click actions from widget chrome.
5. **Useful defaults:** auto-suggest bindings and chart defaults from query result shape.

---

## 6) Security and RBAC

- Preserve existing `dashboard.read`, `dashboard.write`, `dashboard.delete` permission checks.
- Continue to execute all widget queries through existing authenticated query endpoints.
- Never trust client-provided config; validate server-side for type, size, and shape.
- Keep owner/admin semantics unchanged for dashboard mutations.

---

## 7) Backward Compatibility

- Existing starter dashboards and current rows continue working through mapping:
  - `viz_type -> widget_type`
  - `ppl -> query_text`
  - `position -> layout_json` fallback placement
- Rollout can run in mixed mode until migration and UI adoption are complete.

---

## 8) Rollout Plan

1. Ship schema and API compatibility layer first.
2. Ship new builder UI behind a feature toggle.
3. Run smoke tests and RBAC checks.
4. Make new builder default once stable.
5. Optionally deprecate legacy-only fields after verification window.

---

## 9) Testing Strategy

### 9.1 Query worker tests

- Widget payload validation tests (good and bad shapes).
- API integration tests for CRUD and layout update behavior.
- RBAC tests for read/write/delete constraints.

### 9.2 Frontend tests

- Renderer mapping tests by widget type.
- Add/edit/delete widget flow tests.
- Drag/resize persistence tests.
- Error isolation tests (single widget fails, others render).

### 9.3 Verification commands

- `npm run test:unit`
- `npm run test:access-config`
- `npm -C pages run build`

---

## 10) Risks and Mitigations

- **Dependency weight risk:** Use targeted AntD imports and avoid unused components.
- **Schema migration risk:** Add defaults and compatibility mappers; test old dashboards explicitly.
- **Runtime query load risk:** Bound concurrency and apply short-lived worker cache.
- **UX complexity risk:** Keep v1 editor focused, with advanced options collapsed by default.

---

## 11) Non-Goals (v1)

- Cross-dashboard template marketplace
- Multi-user collaborative live editing
- Arbitrary plugin runtime for custom widget code
- Long-lived analytics cache or materialized aggregate pipelines
