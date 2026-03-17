# EdgeData Release Guide

Last updated: 2026-03-16

Use this guide for all post-launch releases after the initial customer deployment. This is the operational playbook for shipping fixes, features, schema changes, and breaking upgrades in a controlled way.

## 1. Release Policy

### 1.1 Source of truth

Each public release should have all of the following:

- A Git tag like `v1.0.1`, `v1.1.0`, or `v2.0.0`
- A GitHub release using the same version
- Release notes describing user-visible changes and operator upgrade steps

Treat the Git tag and release notes as the canonical public release identifier.

### 1.2 Versioning model

EdgeData uses semantic versioning:

- `PATCH` (`v1.0.1`): bug fixes, performance improvements, docs-only fixes, non-breaking UI polish, safe worker updates
- `MINOR` (`v1.1.0`): new backward-compatible features, new endpoints, new dashboard capabilities, optional config additions
- `MAJOR` (`v2.0.0`): breaking API changes, breaking auth or RBAC changes, incompatible migration changes, removed config or behavior

When unsure, prefer the higher version bump.

### 1.3 Version locations in this repo

Before creating a tagged release, update the visible version references that operators may inspect:

- Root package version in [`package.json`](/Users/kishore/code/edgedata/package.json)
- Health endpoint versions in the deployed workers

Today, worker health versions are maintained in code. Until they are automated, bump them as part of any tagged release so `/health` responses match the published release notes.

## 2. Release Types

### 2.1 Patch release

Use a patch release for:

- Bug fixes
- Query planner or parser fixes that preserve API contracts
- Alert evaluation correctness fixes
- UI defects
- Performance improvements that do not change operator workflow

Typical deployment:

1. Run focused verification for the affected area.
2. Redeploy only the changed worker(s) and/or Pages.
3. Publish short release notes.

### 2.2 Minor release

Use a minor release for:

- New user-facing features
- New non-breaking APIs or pages
- New optional secrets or environment variables
- New dashboards, starter content, or workflows

Typical deployment:

1. Run the standard verification set.
2. Apply any additive migrations first.
3. Deploy workers, then Pages if the UI changed.
4. Publish release notes with explicit upgrade steps.

### 2.3 Major release

Use a major release for:

- Removed or renamed endpoints
- Breaking auth or RBAC changes
- Required operator behavior changes
- Required config changes that invalidate older setups
- Migration sequences that older installs must handle differently

Typical deployment:

1. Write an upgrade guide before shipping.
2. Test upgrade path from a previous release, not just fresh install.
3. Call out downtime risk, sequencing, rollback limits, and new config requirements.

## 3. Standard Release Workflow

Use this workflow for every tagged release.

### 3.1 Classify the release

Decide whether the change is `PATCH`, `MINOR`, or `MAJOR`.

Questions to ask:

- Is any existing API contract broken?
- Is any D1 migration required?
- Are new secrets, bindings, or Access settings required?
- Does the Pages app require the worker deploy to happen first?

### 3.2 Prepare the change

Before release:

- Merge the intended code into your release branch or `main`
- Update docs for any new operator-facing behavior
- Add migrations in `deploy/migrations` if schema changes are required
- Update visible version references for tagged releases

### 3.3 Run verification

Use the smallest meaningful set from this baseline:

```bash
npm run test:unit
npm run test:migrations
npm run test:access-config
npm -C pages run build
```

Add these when appropriate:

- `npm run test:prd` for deployed-stack smoke validation
- `npm run test:load` for performance-sensitive releases
- `D1_DATABASE_ID=<uuid> npm run deploy:all:d1:dry-run` for worker bundle validation

### 3.4 Apply migrations first when needed

For existing deployments that need schema changes:

```bash
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run d1:migrate:upgrade
```

Do not tell existing operators to run `d1:migrate:fresh`. That path is for fresh environments.

### 3.5 Deploy the changed services

For targeted worker changes:

```bash
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run deploy:query:d1
```

For a broader worker release:

```bash
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run deploy:all:d1
```

For production-environment worker names:

```bash
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run deploy:query:d1 -- --env production

export QUERY_WORKER_URL="https://query-worker-prod.<subdomain>.workers.dev"

npm run deploy:all:d1 -- --env production
```

If the Pages app changed:

```bash
export VITE_QUERY_API_BASE="https://<query-worker>.<subdomain>.workers.dev"
npm run deploy:pages
```

### 3.6 Tag and publish

After verification and deployment:

1. Create a Git tag such as `v1.0.1`.
2. Push the tag.
3. Publish a GitHub release with upgrade notes.

## 4. Upgrade Guidance by Change Type

### 4.1 Worker-only release

Examples:

- Search correctness fix in `query-worker`
- Alert dedupe fix in `alert-worker`
- Ingest parser fix in `ingest-worker`

Operator instructions:

1. Pull the new release.
2. Redeploy the affected worker(s).
3. Run smoke checks against `/health` and the affected feature path.

### 4.2 Pages-only release

Examples:

- UI bug fix
- Dashboard layout improvement
- Investigation page polish

Operator instructions:

1. Pull the new release.
2. Confirm `VITE_QUERY_API_BASE` points at the intended query worker origin.
3. Run `npm run deploy:pages`.

### 4.3 Migration-backed release

Examples:

- New D1 tables
- RBAC schema additions
- Dashboard model changes

Operator instructions:

1. Pull the new release.
2. Run `npm run d1:migrate:upgrade`.
3. Deploy the workers that use the new schema.
4. Deploy Pages if the UI depends on the new behavior.

### 4.4 Secrets or bindings release

Examples:

- New webhook secret
- New query-worker binding
- New Access or auth requirement

Operator instructions must explicitly include:

- Which worker needs the new secret or binding
- Whether the value is required or optional
- Whether deployment order matters
- Whether the change is backward-compatible

## 5. Release Notes Requirements

Every release note should contain:

- Version
- Release date
- Summary of what changed
- Operator action required: `none`, `redeploy`, `migration required`, or `migration + secret/config update`
- Affected components: `ingest-worker`, `query-worker`, `alert-worker`, `materialize-worker`, `synthetic-worker`, `pages`
- Verification status
- Known risks or rollback notes

Use the template in [`docs/source-templates/release-notes.md`](/Users/kishore/code/edgedata/docs/source-templates/release-notes.md).

## 6. Recommended Checklists

### 6.1 Patch release checklist

- [ ] Version bump chosen correctly
- [ ] User-visible docs updated if behavior changed
- [ ] Focused tests passed
- [ ] Affected workers or Pages redeployed
- [ ] Git tag created
- [ ] Release notes published

### 6.2 Minor release checklist

- [ ] Version bump chosen correctly
- [ ] Docs updated
- [ ] Standard verification set passed
- [ ] Required migrations applied and verified
- [ ] Workers deployed in the correct order
- [ ] Pages deployed if needed
- [ ] Git tag created
- [ ] Release notes published with upgrade steps

### 6.3 Major release checklist

- [ ] Breaking changes documented clearly
- [ ] Upgrade path tested from previous version
- [ ] Migration and rollback limitations documented
- [ ] New secrets, bindings, and auth changes documented
- [ ] Git tag created
- [ ] GitHub release published with explicit upgrade guide

## 7. Rollback Policy

Prefer roll-forward over rollback when a D1 migration has already been applied.

Rollback guidance:

- Pages-only regressions: redeploy the previous Pages release
- Worker-only regressions without schema changes: redeploy the previous worker version
- Schema-backed regressions: assess whether a roll-forward hotfix is safer than trying to reverse a migration

If a release contains irreversible data-shape changes, say so plainly in the release notes.

## 8. First Public Launch vs Later Releases

The initial public launch is a product announcement.

Every change after that should be treated as one of:

- A patch release
- A minor release
- A major release

That keeps the upgrade story simple for users:

- fresh deployment: follow [`docs/ONBOARDING.md`](/Users/kishore/code/edgedata/docs/ONBOARDING.md)
- existing deployment: follow this release guide and the release notes for the target version
