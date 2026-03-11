# EdgeData 30/60/90-Day Execution Plan

Date: 2026-02-25  
Scope: Turn EdgeData into a credible "Cloudflare-native operational product" for SMB/mid Cloudflare-first companies.

## 1) Outcome by Day 90

By Day 90, EdgeData should be able to prove:
- Product fit for Cloudflare-first operators (not just engineers searching logs).
- Predictable performance/cost at target SMB/mid volumes.
- Fast activation (first value in <= 60 minutes) with opinionated defaults.

Target evidence by Day 90:
- 3-5 design partners live on non-demo data.
- >= 2 partners using starter alerts in production.
- >= 1 public or private case-study-quality result with measurable MTTR improvement.
- Clear proof that users prefer EdgeData workflows over native provider-only tooling for incident triage.

## 2) Strategic Thesis

Do not compete as a generic "better log search UI."  
Win as a Cloudflare operations control center:
- Unified app/edge/security troubleshooting workflows.
- Alert-to-investigation loop with runbook context.
- Self-hosted and Access-native posture.
- Guardrailed deep search with predictable spend.

## 3) Baseline (Current Reality)

Strengths already shipped:
- Ingest/query/alert workers + Pages UI.
- Auth/RBAC model, rate limiting, smoke/unit/load tests.
- Reprocess path from raw storage.

Critical gaps from current checklist:
- Access audience/group pinning still incomplete (`ACCESS_AUD`, `ACCESS_*_GROUPS` discipline).
- Alert-to-investigation loop and runbook governance still under-instrumented for proof-grade outcomes.
- Product activation path not yet codified as a single guided flow.

Update as of 2026-03-10:
- Access audience/group pinning checks are now enforced by config validation tests.
- Golden activation is codified via `npm run test:golden-path`.
- Alert workflow and runbook governance are surfaced in Alerts UI with direct Investigate/Deep Link/Runbook actions.
- Search guardrail explainability is surfaced as structured guardrail reasons in API + UI.

## 4) Priority Order (Non-Negotiable)

1. Reliability/security baseline (auth config correctness, access mapping hardening).  
2. Workflow differentiation (alert-to-investigation speed, runbook context, explainability, operator-first UX).  
3. Activation productization (starter alert pack + onboarding templates + golden path).  
4. Design partner outcomes and distribution proof.

## 5) Day 0-30: Foundation and Activation

### Engineering deliverables
- Close P0 auth config gap:
  - enforce non-empty `ACCESS_AUD` in production config checks;
  - require explicit role-group mapping policy for production.
- Build "golden activation" automation:
  - deploy -> ingest sample -> search success -> starter alert fire -> deep-link investigation.
- Add Cloudflare-native source templates (minimum v1):
  - Access/auth events
  - edge/request or WAF-style events
  - Workers app logs
- Ship starter alert pack (minimum):
  - 5xx spike
  - latency regression
  - auth failure spike
  - ingestion degradation
- Introduce runbook metadata support in alert templates/payloads.

### Product deliverables
- Add "Operations Home" v1 in Pages:
  - active alerts summary
  - recent high-risk service changes
  - jump-off cards for common investigations.
- Add onboarding checklist in UI/docs with explicit completion state.

### GTM/design-partner deliverables
- Recruit 8-12 qualified prospects to target 3-5 active design partners.
- Establish design partner agreement:
  - required weekly usage cadence
  - incident feedback loop
  - success metrics to be shared.

### Exit criteria for Day 30
- 2 design partners onboarded to staging/prod-like usage.
- Golden activation flow runs end-to-end in <= 60 min on fresh environment.
- Starter alert pack enabled by default and functional in at least 1 live tenant.

## 6) Day 31-60: Architecture and Proof of Performance

### Engineering deliverables
- Harden query-worker backend abstraction so deep search backend remains swappable without API/UI changes.
- Improve planner and partition/index hygiene for predictable query latency on default object-backed indexes.
- Add optional provider-managed query-store integration hook behind a non-default feature toggle.
- Build performance benchmark suite and publish internal scorecard:
  - p50/p95 query latency by mode
  - scanned partitions/objects
  - cost proxy metrics per query class.

### Product deliverables
- Query transparency UX enhancements:
  - show mode/candidate counts/guardrail triggers clearly.
- Alert investigation UX:
  - each firing alert shows evaluated window, threshold, and deep-link context.

### GTM/design-partner deliverables
- Run structured incident drills with partners (at least 2 classes: error spike + auth failure).
- Capture before/after operational data:
  - time to triage start
  - time to root-cause.

### Exit criteria for Day 60
- Default deep-search backend meets latency/cost envelope for at least 2 design partners.
- Alert-to-investigation loop demonstrates measurable triage acceleration in partner drills.
- Documented evidence of improved triage speed in at least 2 partner incidents/drills.

## 7) Day 61-90: Conversion, Packaging, and Repeatability

### Engineering deliverables
- Keep backend path swappable while defaulting to the operator-validated path.
- Finalize operational SLOs:
  - ingest acceptance
  - query latency by mode
  - alert evaluation timeliness.
- Harden production runbooks:
  - incident playbook for each major failure mode.

### Product deliverables
- Ship opinionated role-based views (platform/on-call/security emphasis).
- Complete runbook governance UI for missing/stale runbook metadata.

### Commercial deliverables
- Define v1 packaging for target segment:
  - Core Ops tier (logs + search + dashboards + starter alerts)
  - Extended Security Ops add-on (auth/WAF/security templates, expanded retention/reporting)
- Produce customer proof assets:
  - 1 written case study
  - 2 short operator testimonials
  - benchmark summary for buyers.

### Exit criteria for Day 90
- 3-5 design partners live, 2+ recurrent weekly users.
- One case-study-grade customer result.
- Clear go-to-market narrative: "Cloudflare operations control center for small/mid teams."

## 8) Weekly Operating Metrics (Track Every Week)

Activation:
- deploy_to_first_search_minutes
- deploy_to_first_alert_minutes
- % tenants enabling >= 3 starter alerts in first week

Operational value:
- median alert_to_triage_start_seconds
- median triage_duration_seconds
- % alerts with runbook attached

Technical:
- query p50/p95 by mode (structured/token/phrase)
- candidate cap hit rate and guardrail rejection rate
- partition/index health and planner efficiency

Business:
- active design partners
- weekly active operator users per partner
- conversion likelihood score (green/yellow/red)

## 9) Risks and Mitigations

Risk: Cloudflare native tooling overlaps core value proposition.  
Mitigation: focus messaging/product on cross-signal workflows, alert state, runbooks, and operational outcomes.

Risk: Performance/cost fails at higher data volumes.  
Mitigation: prioritize planner efficiency, partition hygiene, and benchmark envelope before broader sales push; enable provider-managed query-store integration only when evidence shows clear benefit.

Risk: Teams perceive setup as "yet another observability project."  
Mitigation: enforce 60-minute activation goal with templates and guided setup; no blank-slate default.

Risk: Design partners stall due to low internal bandwidth.  
Mitigation: pick partners with named owner + scheduled review cadence; remove passive "maybe later" accounts quickly.

## 10) Stop/Go Gates

Go at Day 45 only if:
- At least 2 design partners are actively evaluating.
- Activation flow consistently <= 60 minutes in internal runs.

Go at Day 75 only if:
- Core deep-search path is stable for pilot workloads with predictable latency/cost.
- At least one partner can show measurable incident response improvement.

If these gates fail, narrow scope:
- reduce feature surface,
- focus on one dominant incident class,
- defer expansion until core reliability/value proof is restored.
