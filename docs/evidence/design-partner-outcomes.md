# Design-Partner Outcomes Tracker

## Purpose

Track externally verifiable outcomes from design partners in a consistent, reviewable format.

## Required Evidence Per Partner

- Environment type (staging/prod-like) and go-live date
- Weekly active operator count
- Time-to-first-value (deploy to first dashboard + first enabled alert)
- Incident workflow outcome (MTTD/MTTR delta or triage-time delta)
- Link to anonymized artifacts (runbook, alert payload, investigation screenshot, or call notes)

## Current Status (as of 2026-03-09)

Design-partner status: `pending`

External partner outcomes are not yet available. This file remains the canonical location for adding them as soon as partner onboarding starts.

## Tracker

| Partner ID | Status | Go-live Date | Weekly Active Users | Time-to-First-Value | Outcome Delta | Evidence Links |
|---|---|---|---:|---|---|---|
| - | No active design partners yet | - | - | - | - | - |

## Interim Proof (Until First Partner)

Use internal reproducible proof artifacts to maintain launch evidence quality:

- Build/test scorecard: `benchmark-scorecard-2026-03-09.md`
- Workflow narrative: `case-study-synthetic-alert-to-investigation.md`
- Deployed guardrail validation: `scripts/run-prd-smoke-tests.sh` output (with `QUERY_URL` set) attached to PRs

## Update Rules

- Use anonymized IDs only (no customer names).
- Every non-empty row must include at least one evidence link.
- Update this file in the same PR when partner outcome numbers change.
