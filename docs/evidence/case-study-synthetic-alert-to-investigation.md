# Case Study: Alert-to-Investigation Workflow (Synthetic Tenant)

## Profile

- Tenant type: Internal synthetic/demo environment
- Goal: Validate end-to-end operator workflow from alert creation to investigation launch
- Stack: `ingest-worker`, `query-worker`, `alert-worker`, `pages`

## Scenario

A service starts returning elevated errors and latency. Operator uses EdgeData to:

1. Create threshold-based alerts from the Alerts UI
2. Receive alert context with deep-link and runbook metadata
3. Open investigation workspace with prefilled scope pivots
4. Triage root cause via search + related events

## What This Proves

- Alert definitions are operator-friendly (form-driven, not raw JSON entry)
- Alerts preserve governance metadata (`owner_team`, `runbook_url`, `deep_link`)
- Investigation handoff from alert context is directly actionable

## Reproducibility

Use these repo commands/scripts for reproducible workflow verification:

```bash
npm -C pages run build
npm run test:unit
npm run test:access-config
# For deployed-stack workflow validation:
# scripts/run-prd-smoke-tests.sh (set QUERY_URL + QUERY_AUTH_TOKEN or EMAIL+PASSWORD)
# scripts/run-golden-activation.sh (with ALERT_URL + auth env vars set)
```

## Next Upgrade To Customer-Grade Proof

To convert this to an external case study, add:

- Baseline vs post-adoption incident triage timing from one design partner
- Real alert payload examples (anonymized)
- 2-3 operator quotes and operational impact summary
