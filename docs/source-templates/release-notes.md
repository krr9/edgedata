# EdgeData Release Notes Template

## EdgeData vX.Y.Z

Release date: YYYY-MM-DD

### Summary

Short paragraph describing the release in operator language.

### Operator action required

Choose one:

- `none`
- `redeploy`
- `migration required`
- `migration + secret/config update`

### Included changes

- Change 1
- Change 2
- Change 3

### Affected components

- `ingest-worker`
- `query-worker`
- `alert-worker`
- `materialize-worker`
- `synthetic-worker`
- `pages`

Delete components that are not affected.

### Upgrade steps

Use only the steps required for this release.

```bash
# Example migration step
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run d1:migrate:upgrade
```

```bash
# Example worker deploy step
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run deploy:query:d1
```

```bash
# Example Pages deploy step
export VITE_QUERY_API_BASE="https://<query-worker>.<subdomain>.workers.dev"
npm run deploy:pages
```

### Verification

- Tests run:
- Dry-runs run:
- Smoke checks run:

### Risks and rollback notes

- Known risk 1
- Rollback guidance

### Notes for fresh installs

If this release changes onboarding expectations, add a short note here. Otherwise delete this section.
