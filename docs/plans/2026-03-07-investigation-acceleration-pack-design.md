# Investigation Acceleration Pack Design
## Incident Workspace + Prefilled Triage + Related Events

**Date:** 2026-03-07  
**Status:** Approved  
**Scope:** Ship a mixed portfolio for high demo ROI focused on investigation speed: three fast wins and one larger `Incident Workspace` experience.

---

## 1) Product Intent and Success Criteria

### 1.1 Primary objective

Deliver a clear "signal to root cause" experience that feels meaningfully faster than generic log tooling in demos and real incident workflows.

### 1.2 Success criteria (v1)

1. Alert click opens investigation with prefilled context (time, service, env, pivots) in one step.
2. Operators can pivot within seconds to related events and wider blast-radius views.
3. Triage state can be saved/shared as a reproducible session link.
4. Existing search, dashboard, and RBAC behavior remains backward-compatible.

### 1.3 Non-goals (v1)

- No ML anomaly engine or correlation graph.
- No global case management workflow.
- No long-lived materialized investigation cache.

---

## 2) Solution Overview

### 2.1 Portfolio shape (mixed ROI)

- **Quick Win 1:** Alert deep-link prefill + pivot chips.
- **Quick Win 2:** Related events panel with bounded heuristic matching.
- **Quick Win 3:** Demo scenario mode with seeded "incident story" presets.
- **Bigger Bet:** New `Incident Workspace` page that unifies triage components.

### 2.2 Why this sequence

- Quick wins create immediate visible demo value in days.
- The larger workspace consolidates value into a durable product surface.
- All pieces reuse existing query APIs and guardrails, minimizing platform risk.

---

## 3) UX and Navigation Design

### 3.1 Entry points

- Alerts list/detail -> "Investigate" action.
- Dashboard widget context menu -> "Investigate from this panel".
- Search results -> "Open in Incident Workspace".

### 3.2 Workspace layout

- `InvestigationHeader`: source context, time range, pivot chips, share action.
- `InvestigationTimeline`: event volume + error spikes.
- `TopSignalsPanel`: top errors/status/services in scoped window.
- `RelatedEventsPanel`: heuristic matches and quick drill actions.
- `EventStreamPanel`: matching events list with inspector.

### 3.3 Pivot and blast-radius actions

- One-click pivots: `trace_id`, `request_id`, `user_id`, `msg_hash`.
- Time controls: +/- preset windows (15m, 1h, 6h).
- Scope expansion: same service -> same env -> related services.

---

## 4) API and Data Contract Design

### 4.1 New endpoints in `query-worker`

- `POST /investigations/bootstrap`
  - Input: `source`, `time`, `scope`, optional pivots.
  - Output: normalized workspace bootstrap payload (cards + starter queries).
- `POST /investigations/related-events`
  - Input: current scope + selected pivots + bounds.
  - Output: related event candidates and match reasons.
- `POST /investigations/session`
  - Persists triage state snapshot for reuse/share.
- `GET /investigations/session/:id`
  - Loads previously saved triage state.

### 4.2 Payload principles

- Use PPL-first query payloads to align with existing search APIs.
- Include explicit bounds to preserve current planner guardrails.
- Keep response shapes stable and normalized for Pages components.

### 4.3 Session persistence model

- Add D1 table for session snapshots (owner, scope, state JSON, TTL metadata).
- Enforce owner/admin read semantics to avoid cross-user leakage.

---

## 5) Related Events Heuristic (Bounded)

### 5.1 Matching strategy

Rank candidates by weighted signals:

1. Exact pivot match (`trace_id`, `request_id`, `user_id`, `msg_hash`).
2. Same `service` + `env` within tight time bucket.
3. Token overlap score from bounded event sample.

### 5.2 Guardrails

- Hard cap candidate set and evaluation window.
- Fallback gracefully when pivots are absent.
- Return match reason labels for explainability in UI.

---

## 6) Security, RBAC, and Privacy

- Reuse existing auth middleware and role checks.
- Require `dashboard.read`/search permissions for bootstraped queries.
- Restrict session reads to owner/admin contexts.
- Never include secrets or unsafe raw auth context in saved sessions.

---

## 7) Rollout and Backward Compatibility

1. Ship API endpoints behind optional feature flag.
2. Add quick-win UI hooks (deep-link, pivots, related panel).
3. Introduce workspace route and progressive adoption.
4. Enable demo scenario presets for guided buyer walkthroughs.
5. Keep current alerts/search/dashboard flows operational throughout.

---

## 8) Testing Strategy

### 8.1 Worker tests

- Endpoint contract tests for bootstrap/session/related-events.
- Guardrail tests for bounded windows and candidate caps.
- RBAC and owner-scope tests for session access.

### 8.2 Frontend tests

- Deep-link prefill behavior and pivot chip interactions.
- Related events panel rendering and retry behavior.
- Session save/load and share-link restore behavior.
- Workspace isolation: failed panel does not block other panels.

### 8.3 Verification commands

- `npm run test:unit`
- `npm run test:access-config`
- `npm -C pages run build`

---

## 9) Risks and Mitigations

- **Complexity creep:** keep v1 focused on bounded heuristics and explicit pivots.
- **Query cost risk:** enforce strict windows/caps and reuse existing planner guardrails.
- **UX overload risk:** progressive disclosure, compact defaults, and guided quick actions.
- **Data leakage risk:** explicit owner/admin checks on session retrieval and sharing.
