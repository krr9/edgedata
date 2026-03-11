# EdgeData Onboarding Checklist

Last updated: 2026-03-10

Use this checklist for fresh deployments and design-partner onboarding.

## 1) Access and Auth Baseline

- [ ] `REQUIRE_ACCESS_JWT=true` is set for `query-worker` and `alert-worker`.
- [ ] `ACCESS_AUD` and `ACCESS_ISSUER` are configured for both workers.
- [ ] At least one Access group mapping exists (`Settings -> Access Group Mapping`).
- [ ] `AUTH_ENABLE_LOCAL_LOGIN` is set to your intended mode (`false` for strict SSO, `true` for fallback).

## 2) User Onboarding

- [ ] First admin/superadmin can sign in.
- [ ] Invite at least one additional operator user.
- [ ] For local-password invite mode, invited user completes `Accept Invite` flow.
- [ ] Pending invites can be listed/resend/revoked in `Settings -> Invite Queue`.

## 3) Data and Alert Activation

- [ ] Synthetic ingest is enabled or real source ingest is configured.
- [ ] Search returns recent events for target `index/service/env`.
- [ ] Starter alert pack is applied with governance metadata:
  - `owner_team`
  - `runbook_url`
  - `deep_link`

## 4) Investigation Workflow

- [ ] Alert evaluation runs successfully (`alert-worker /run` or cron).
- [ ] Firing alert links into investigation workflow in <= 2 clicks.
- [ ] `POST /investigations/bootstrap` returns starter queries.

## 5) Verification Commands

```bash
npm run test:unit
npm run test:access-config
npm -C pages run build
```

For deployed environments:

```bash
QUERY_URL=<query-worker-url> QUERY_AUTH_TOKEN=<token> npm run test:prd
QUERY_URL=<query-worker-url> ALERT_URL=<alert-worker-url> DEEP_LINK_BASE=<pages-url> RUNBOOK_BASE_URL=<runbook-base-url> ALERT_RUN_SECRET=<secret> EMAIL=<admin-email> PASSWORD=<admin-password> npm run test:golden-path
```

## 6) In-App Completion State

The Pages admin view exposes a runtime onboarding checklist at:

- `Settings -> Onboarding Checklist`

This card derives completion from live API state and should be used as the operator-facing source of truth during tenant setup.
