# EdgeData Onboarding Guide

**Audience:** Platform engineers and DevOps generalists deploying EdgeData into their own Cloudflare account.
**Time estimate:** 45–90 minutes from clone to first searchable data with active alerts.

**Billing disclaimer:** EdgeData is deployed into your Cloudflare account. You are responsible for reviewing, understanding, and paying any Cloudflare charges your deployment incurs, including charges related to Workers, R2, D1, Workers Analytics Engine, Durable Objects, Access, Pages, and any other enabled Cloudflare services.

This guide is for fresh deployments. For updates after launch, use the release workflow in [`docs/RELEASING.md`](/Users/kishore/code/edgedata/docs/RELEASING.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Cloudflare Account Setup](#3-cloudflare-account-setup)
4. [Clone and Install](#4-clone-and-install)
5. [Provision Infrastructure](#5-provision-infrastructure)
6. [Run Database Migrations](#6-run-database-migrations)
7. [Deploy Workers](#7-deploy-workers)
8. [Configure Secrets](#8-configure-secrets)
9. [Set Up Cloudflare Access (SSO)](#9-set-up-cloudflare-access-sso)
10. [Deploy the UI (Pages)](#10-deploy-the-ui-pages)
11. [Verify the Stack](#11-verify-the-stack)
12. [Ingest Your First Data](#12-ingest-your-first-data)
13. [Connect Real Data Sources](#13-connect-real-data-sources)
14. [Activate Alerts](#14-activate-alerts)
15. [Onboard Your Team](#15-onboard-your-team)
16. [Post-Deploy Checklist](#16-post-deploy-checklist)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Overview

EdgeData is a self-hosted, edge-native log search and SIEM-lite product that runs entirely within your Cloudflare account. It uses:

| Cloudflare Service | Purpose |
|---|---|
| **Workers** | Ingest API, query API, alert evaluation, synthetic data, materialization |
| **R2** | Raw log storage, event index, token index |
| **D1** | Saved searches, alerts, RBAC, user state, dashboards |
| **Workers Analytics Engine (WAE)** | Hot aggregation for dashboards and alert evaluation |
| **Pages** | React UI for log explorer, dashboards, alerts, investigations |
| **Cloudflare Access** | SSO authentication (IdP-backed) |
| **Durable Objects** | Live tail streaming (TailHub), dashboard caching |

EdgeData is single-tenant: one deployment per Cloudflare account. Your data never leaves your account.

---

## 2. Prerequisites

### 2.0 Before You Deploy

Complete these items before you start the actual worker and Pages deployment steps:

- Create the Cloudflare API token in [2.3 API Token](#23-api-token).
- Log in with Wrangler in [2.4 Local Tooling](#24-local-tooling).
- Create the D1 database in [3.2 Create a D1 Database](#32-create-a-d1-database).
- Export `D1_DATABASE_ID` from the D1 create output before running any `deploy:*:d1` or migration helper command.
- Plan to set `CF_API_TOKEN` as a Wrangler secret on `query-worker` and `alert-worker` in section 8 before verifying dashboards, alerts, or WAE-backed queries.

### 2.1 Cloudflare Account Requirements

You need a Cloudflare account on a **Workers Paid** plan (or higher). The Free plan is insufficient because EdgeData requires:

- **Workers**: 5 workers deployed simultaneously (ingest, query, alert, synthetic, materialize)
- **R2**: at least one bucket for raw logs, events, and token indexes
- **D1**: at least one database for application state
- **Workers Analytics Engine**: dataset for hot metrics (included with Workers Paid)
- **Durable Objects**: for live tail and dashboard caching (included with Workers Paid)
- **Cloudflare Pages**: for the UI (free tier is fine)
- **Cloudflare Access** (optional but strongly recommended): for SSO authentication

### 2.2 Cloudflare Products to Enable

In the Cloudflare dashboard, confirm or enable:

1. **Workers & Pages** — enabled by default on paid plans
2. **R2 Object Storage** — go to **R2** in the sidebar and accept terms if prompted
3. **D1 Databases** — go to **Workers & Pages > D1** and verify access
4. **Workers Analytics Engine** — available under **Workers & Pages > Analytics Engine**; some fresh accounts still require an explicit dashboard enablement step before deploys succeed
5. **Cloudflare Access** (if using SSO) — go to **Zero Trust > Access** and connect your IdP

### 2.3 API Token

Create a Cloudflare API token with scoped permissions. Go to **My Profile > API Tokens > Create Token** with these permissions:

| Permission | Access Level | Reason |
|---|---|---|
| Account > Workers Scripts | Edit | Deploy workers |
| Account > Workers R2 Storage | Edit | Create bucket, read/write objects |
| Account > D1 | Edit | Create database, run migrations |
| Account > Workers Analytics Engine | Read | WAE SQL queries from query/alert workers |
| Account > Cloudflare Pages | Edit | Deploy the UI |
| Account > Workers Tail | Read | Live tail (optional) |
| Account > Access: Apps and Policies | Edit | Only if configuring Access programmatically |

Save this token — you will use it for Wrangler CLI authentication and as the `CF_API_TOKEN` secret.

### 2.4 Local Tooling

Install on your workstation:

```bash
node --version   # v18+ required
npm --version    # v9+ required
npx wrangler --version  # Wrangler v3+ (installed via npm)
```

If Wrangler is not installed globally:

```bash
npm install -g wrangler
```

Authenticate Wrangler with your Cloudflare account:

```bash
wrangler login
```

This opens a browser for OAuth. After login, Wrangler can deploy to your account.

### 2.5 Gather Account Details

You will need these values throughout setup. Find them in the Cloudflare dashboard:

| Value | Where to Find |
|---|---|
| **Account ID** | Dashboard sidebar or **Account Home** URL (`dash.cloudflare.com/<account-id>/...`) |
| **Zone ID** (if using Logpush) | **Websites > your domain > Overview** sidebar |
| **Access Team Name** | **Zero Trust > Settings > Custom Pages** (the `<team>` in `<team>.cloudflareaccess.com`) |

---

## 3. Cloudflare Account Setup

### 3.1 Create an R2 Bucket

```bash
wrangler r2 bucket create edgedata-raw
```

This creates the bucket that stores raw logs, event indexes, and token indexes. The default name `edgedata-raw` matches the wrangler configs. If you use a different name, update `bucket_name` in each worker's `wrangler.toml`.

### 3.2 Create a D1 Database

```bash
wrangler d1 create edgedata-db
```

Output will include a UUID like:

```
Created D1 database edgedata-db
database_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Save this `database_id`** — you will export it as `D1_DATABASE_ID` for every deploy command:

```bash
export D1_DATABASE_ID="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

### 3.3 Enable Workers Analytics Engine

Navigate to **Workers & Pages > Analytics Engine** in the dashboard. If Cloudflare shows an enable or accept-terms flow for your account, complete it before deploying workers. The `log_metrics` dataset is still created automatically when the ingest worker first writes to it, so no manual dataset creation is needed after Analytics Engine is enabled for the account.

---

## 4. Clone and Install

```bash
git clone https://github.com/your-org/edgedata.git
cd edgedata

npm install
npm -C pages install
```

Verify the build toolchain works:

```bash
npm -C pages run build
```

---

## 5. Provision Infrastructure

You have two options: manual (already done in step 3) or Terraform.

### Option A: Manual (Recommended for First Deploy)

If you already created the R2 bucket and D1 database in step 3, skip to step 6.

### Option B: Terraform

For reproducible infrastructure:

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
cloudflare_api_token = "<your-api-token>"
account_id           = "<your-account-id>"
raw_bucket_name      = "edgedata-raw"
d1_database_name     = "edgedata-db"
```

Apply:

```bash
terraform init
terraform plan
terraform apply
```

Terraform outputs the D1 database ID. Export it:

```bash
export D1_DATABASE_ID="$(terraform output -raw d1_database_id)"
```

Return to the repo root:

```bash
cd ../..
```

---

## 6. Run Database Migrations

For a fresh Cloudflare account, use the consolidated schema baseline plus the post-schema starter/data migrations that are still safe on top of the current schema snapshot:

```bash
npm run d1:migrate:fresh
```

This helper uses the root `wrangler.toml` plus `D1_DATABASE_ID` and avoids the duplicate-column errors you hit when replaying older schema migrations on top of the current `schema.sql` snapshot.

Important:

- After `schema.sql`, do not re-run migrations `002` through `007`, `011`, `013`, `014`, or `017`. Those schema changes are already folded into the current baseline.
- If you are upgrading an older existing database instead of bootstrapping a fresh one, run the full ordered chain instead:

```bash
npm run d1:migrate:upgrade
```

- If you prefer raw `wrangler d1 execute` commands, remember that Wrangler reads the root [`wrangler.toml`](/Users/kishore/code/edgedata/wrangler.toml). Either update its `database_id` first or keep using the helper scripts above.

Verify the schema snapshot and migration metadata stay aligned:

```bash
npm run test:migrations
```

---

## 7. Deploy Workers

### 7.1 First Deploy (All Workers)

The deploy wrapper script injects the D1 database ID into each worker's config at deploy time.

For the quickest onboarding path, deploy the top-level worker names first:

```bash
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run deploy:all:d1
```

If you want the `env.production` worker names, use a staged production deploy so you can capture the query-worker production URL before deploying the workers that depend on it:

```bash
export D1_DATABASE_ID="<your-d1-database-uuid>"
npm run deploy:query:d1 -- --env production

# Copy the exact URL printed by Wrangler for query-worker-prod.
export QUERY_WORKER_URL="https://query-worker-prod.<subdomain>.workers.dev"

npm run deploy:all:d1 -- --env production
```

Wrangler will warn that multiple environments are defined. That is expected in this repo. Without `--env production`, Wrangler deploys the top-level worker names (`query-worker`, `ingest-worker`, and so on).

This deploys all five workers:
- `ingest-worker` — log ingestion API
- `query-worker` — search, dashboards, auth, RBAC
- `alert-worker` — scheduled alert evaluation (cron every minute)
- `synthetic-worker` — demo data generator (cron every 5 minutes)
- `materialize-worker` — dashboard widget pre-computation (cron every minute)

### 7.2 Note Your Worker URLs

After deployment, Wrangler prints the URL for each worker:

```
Published ingest-worker to https://ingest-worker.<subdomain>.workers.dev
Published query-worker to https://query-worker.<subdomain>.workers.dev
Published alert-worker to https://alert-worker.<subdomain>.workers.dev
Published synthetic-worker to https://synthetic-worker.<subdomain>.workers.dev
Published materialize-worker to https://materialize-worker.<subdomain>.workers.dev
```

You can also find URLs in **Dashboard > Workers & Pages**.

Export them for the remaining setup steps:

```bash
export INGEST_URL="https://ingest-worker.<subdomain>.workers.dev"
export QUERY_URL="https://query-worker.<subdomain>.workers.dev"
export ALERT_URL="https://alert-worker.<subdomain>.workers.dev"
```

### 7.3 Dry-Run (Optional)

To validate worker bundles without deploying:

```bash
D1_DATABASE_ID="<uuid>" npm run deploy:all:d1:dry-run
```

### 7.4 Single Worker Redeploy

After updating a single worker, redeploy it to the same environment you originally chose:

```bash
D1_DATABASE_ID="<uuid>" npm run deploy:query:d1
D1_DATABASE_ID="<uuid>" npm run deploy:query:d1 -- --env production
```

---

## 8. Configure Secrets

Secrets are set per worker using `wrangler secret put`. They are encrypted at rest and never committed to the repository.

If you deployed with `--env production`, add `--env production` to each `wrangler secret put` command below so the secret lands in the same worker environment you deployed.

### 8.1 Ingest Worker Secrets

```bash
# Required: bearer token for agent authentication
npx wrangler secret put INGEST_SECRET --config workers/ingest-worker/wrangler.toml
# Prompt: enter a strong random string (e.g., openssl rand -hex 32)
```

Optional:
```bash
# HMAC mode (alternative to bearer token)
npx wrangler secret put INGEST_HMAC_SECRET --config workers/ingest-worker/wrangler.toml

# Separate secret for the reprocess endpoint (defaults to INGEST_SECRET if unset)
npx wrangler secret put REPROCESS_SECRET --config workers/ingest-worker/wrangler.toml
```

### 8.2 Query Worker Secrets

```bash
# Required: Cloudflare API token for WAE SQL queries
npx wrangler secret put CF_API_TOKEN --config workers/query-worker/wrangler.toml

# Required: session signing key
npx wrangler secret put AUTH_SESSION_SECRET --config workers/query-worker/wrangler.toml
# Prompt: enter a strong random string

# Required for local password login: bootstrap superadmin password
npx wrangler secret put AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD --config workers/query-worker/wrangler.toml

# Optional: bearer tokens for programmatic/inter-worker access
npx wrangler secret put QUERY_ADMIN_TOKEN --config workers/query-worker/wrangler.toml
npx wrangler secret put QUERY_VIEWER_TOKEN --config workers/query-worker/wrangler.toml
npx wrangler secret put QUERY_ANALYST_TOKEN --config workers/query-worker/wrangler.toml

# Required if alert-worker proxy is used
npx wrangler secret put ALERT_RUN_SECRET --config workers/query-worker/wrangler.toml

# Required if synthetic worker admin controls are needed
npx wrangler secret put SYNTHETIC_RUN_SECRET --config workers/query-worker/wrangler.toml
```

### 8.3 Alert Worker Secrets

```bash
npx wrangler secret put CF_API_TOKEN --config workers/alert-worker/wrangler.toml
npx wrangler secret put ALERT_RUN_SECRET --config workers/alert-worker/wrangler.toml

# Notification channels (set at least one)
npx wrangler secret put SLACK_WEBHOOK_URL --config workers/alert-worker/wrangler.toml
npx wrangler secret put WEBHOOK_URL --config workers/alert-worker/wrangler.toml
```

### 8.4 Synthetic Worker Secrets

```bash
npx wrangler secret put INGEST_SECRET --config workers/synthetic-worker/wrangler.toml
# Must match the ingest worker's INGEST_SECRET

npx wrangler secret put SYNTHETIC_RUN_SECRET --config workers/synthetic-worker/wrangler.toml
```

### 8.5 Materialize Worker Secrets

```bash
npx wrangler secret put QUERY_WORKER_TOKEN --config workers/materialize-worker/wrangler.toml
# Must match the query worker's QUERY_ADMIN_TOKEN
```

---

## 9. Set Up Cloudflare Access (SSO)

Cloudflare Access provides SSO authentication so your team signs in with their existing IdP (Okta, Entra ID, Google Workspace, etc.). This is the recommended authentication model.

### 9.1 Recommended Identity Architecture

For EdgeData, the recommended trust model is:

1. Your external IdP authenticates the user
2. Cloudflare Access sits in front of the EdgeData Pages app and query API
3. Cloudflare Access issues the identity headers/JWT that EdgeData validates
4. EdgeData uses the authenticated email plus Access group membership to enforce RBAC, data scope, invitations, and user state

This means EdgeData does not directly integrate with Okta, Entra ID, Google Workspace, or Ping Identity. Instead, it relies on Cloudflare Access as the authentication boundary and consumes the resulting Access identity.

Operationally:

- Manage sign-in methods, MFA, and primary group membership in your IdP
- Manage application reachability in Cloudflare Access
- Manage EdgeData roles, invitations, and enabled/disabled user state inside EdgeData

### 9.2 IdP Setup References

Use Cloudflare's provider documentation for the actual IdP setup. EdgeData is compatible with the providers below when they are connected to Cloudflare Access correctly.

| Provider | When to Use It | Cloudflare Setup Guide |
|---|---|---|
| Okta | Common enterprise OIDC/SAML deployment with group-based access | <https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/okta/> |
| Microsoft Entra ID | Microsoft 365 / Azure environments with Entra groups | <https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/> |
| Google Workspace | Google Workspace environments where you want Workspace group membership in Access | <https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google-workspace/> |
| PingOne / Ping Identity | Enterprise SAML environments already standardized on Ping | <https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/pingone-saml/> |
| Generic OIDC / SAML | Any other standards-based enterprise IdP | <https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/> |

Notes:

- Prefer `Google Workspace` over generic `Google` if you need group membership in Cloudflare Access.
- If your IdP supports both OIDC and SAML, Cloudflare generally recommends OIDC for simpler setup.
- If you do not see your provider listed in Cloudflare's UI, use the generic OIDC or SAML option.

### 9.3 How Identity Flows Into EdgeData

The identity path for SSO users is:

1. User browses to the EdgeData Pages URL or Access-protected query API
2. Cloudflare Access redirects the user to your configured IdP
3. The IdP authenticates the user and returns identity details to Cloudflare Access
4. Cloudflare Access evaluates its application policy and group rules
5. Cloudflare Access forwards the request to EdgeData with:
   - `CF-Access-Jwt-Assertion`
   - `CF-Access-Authenticated-User-Email`
6. EdgeData validates the Access JWT issuer and audience
7. EdgeData reads the authenticated email and any `groups` claim from the Access JWT
8. EdgeData resolves the user's effective roles from:
   - direct role assignments in EdgeData
   - Access-group-to-role mappings stored in EdgeData
   - the bootstrap admin email allowlist, if configured
9. EdgeData enforces product permissions and data scope on every API request

In other words:

- The external IdP proves who the user is
- Cloudflare Access decides whether the user may reach EdgeData at all
- EdgeData decides what the user may do after they get in
- For email OTP / One-Time PIN flows, Cloudflare Access also controls whether the verification email is sent and delivered. EdgeData does not send or manage those emails.

### 9.4 Connect Your Identity Provider

1. Go to **Zero Trust > Settings > Authentication**
2. Add your IdP (Okta, Entra ID, Google Workspace, GitHub, etc.)
3. Follow the IdP-specific setup to enable SAML or OIDC
4. Verify the connection with a test login

### 9.5 Create Access Groups

Create groups that map to EdgeData roles. Go to **Zero Trust > Access > Access Groups**:

| Access Group Name | Members | EdgeData Role |
|---|---|---|
| `edgedata-superadmins` | Platform leads, security leads | `superadmin` |
| `edgedata-admins` | DevOps engineers, senior SREs | `admin` |
| `edgedata-analysts` | On-call engineers, developers | `analyst` |
| `edgedata-viewers` | Broader engineering team | `viewer` |

Group membership can be based on IdP groups, email domains, or individual emails.

### 9.6 Protect the Query Worker

Create an Access Application for the query API:

1. Go to **Zero Trust > Access > Applications > Add an Application**
2. Choose **Self-hosted**
3. Configure:
   - **Application name:** EdgeData API
   - **Session duration:** 12 hours
   - **Application domain:** `query-worker.<subdomain>.workers.dev` (or your custom domain)
4. Add a policy:
   - **Policy name:** Allow EdgeData Users
   - **Action:** Allow
   - **Include rules:** the Access groups you created above
5. Save and note the **Application Audience (AUD)** tag — you need it for worker configuration

Important:

- The query API origin is the security-critical Access application because EdgeData validates Access JWTs there
- `VITE_QUERY_API_BASE` must point at this Access-protected API origin, not an unprotected `workers.dev` URL

### 9.7 Protect the Pages App

Create a second Access Application for the UI:

1. Same flow as above
2. **Application domain:** your actual Pages hostname (for example `your-project.pages.dev`, `your-project-your-account.pages.dev`, or your custom domain)
3. Use the same policy/groups
4. Both applications should share the same audience tag, or configure separate audiences

### 9.8 Configure Query Worker for Access JWT Validation

Set these environment variables in `workers/query-worker/wrangler.toml` under `[vars]` (or set them via `wrangler secret put` for sensitive values):

```toml
[vars]
CF_ACCOUNT_ID = "<your-account-id>"
REQUIRE_ACCESS_JWT = "true"
ACCESS_AUD = "<application-audience-tag-from-step-9.6>"
ACCESS_ISSUER = "https://<your-team-name>.cloudflareaccess.com"
ACCESS_SUPERADMIN_GROUPS = "edgedata-superadmins"
ACCESS_ADMIN_GROUPS = "edgedata-admins"
ACCESS_ANALYST_GROUPS = "edgedata-analysts"
ACCESS_VIEWER_GROUPS = "edgedata-viewers"
ACCESS_ADMIN_EMAILS = "your-admin@example.com"
AUTH_BOOTSTRAP_SUPERADMIN_EMAIL = "your-admin@example.com"
AUTH_ENABLE_LOCAL_LOGIN = "true"
CORS_ORIGINS = "https://<your-pages-host>,https://*.<your-pages-host>"
```

Set the same Access variables on the alert worker:

```toml
[vars]
CF_ACCOUNT_ID = "<your-account-id>"
REQUIRE_ACCESS_JWT = "true"
ACCESS_AUD = "<application-audience-tag>"
ACCESS_ISSUER = "https://<your-team-name>.cloudflareaccess.com"
ACCESS_ADMIN_GROUPS = "edgedata-admins"
ACCESS_ADMIN_EMAILS = "your-admin@example.com"
```

After editing `wrangler.toml` vars, redeploy the affected workers:

```bash
D1_DATABASE_ID="<uuid>" npm run deploy:query:d1
D1_DATABASE_ID="<uuid>" npm run deploy:alert:d1
D1_DATABASE_ID="<uuid>" npm run deploy:query:d1 -- --env production
D1_DATABASE_ID="<uuid>" npm run deploy:alert:d1 -- --env production
```

Replace `<your-pages-host>` with the exact hostname Wrangler prints after your Pages deploy, then keep the wildcard preview entry if you want preview deployments to work with credentialed browser requests.

### 9.9 Skip Access (Local-Only or Development Mode)

If you are evaluating EdgeData without SSO, set:

```toml
[vars]
REQUIRE_ACCESS_JWT = "false"
AUTH_ENABLE_LOCAL_LOGIN = "true"
```

And use email/password login via the bootstrap superadmin account. This is not recommended for production.

---

## 10. Deploy the UI (Pages)

### 10.1 Create or Update the Pages Project

Set the Pages project name in [`pages/wrangler.toml`](/Users/kishore/code/edgedata/pages/wrangler.toml) before your first deploy:

```toml
name = "<your-pages-project-name>"
```

If the project does not already exist in your Cloudflare account, create it once:

```bash
npx wrangler pages project create <your-pages-project-name>
```

### 10.2 Set the Query API Base URL

The Pages app must know where to call the query API:

```bash
export VITE_QUERY_API_BASE="https://query-worker.<subdomain>.workers.dev"
```

If using Cloudflare Access SSO, this must be the exact Access-protected origin.

### 10.3 Build and Deploy

```bash
npm run deploy:pages
```

This command validates `VITE_QUERY_API_BASE`, builds the React app, and deploys to Cloudflare Pages. The deploy script will fail if `VITE_QUERY_API_BASE` is missing.

### 10.4 Note the Pages URL

After deployment:

```
Published to https://<actual-pages-url>
```

Copy the exact hostname Wrangler prints. Depending on your account and deployment type, it may be the production hostname, an account-scoped hostname, or a preview URL with a deployment hash. Use that exact host when you set `CORS_ORIGINS`.

### 10.5 Custom Domain (Optional)

To serve EdgeData on your own domain:

1. Go to **Workers & Pages > <your-pages-project-name> > Custom Domains**
2. Add your domain (e.g., `logs.yourcompany.com`)
3. Cloudflare handles SSL automatically
4. Update `CORS_ORIGINS` on the query worker to include the custom domain

---

## 11. Verify the Stack

### 11.1 Health Checks

```bash
curl -s "$INGEST_URL/health" | jq .
curl -s "$QUERY_URL/health" | jq .
curl -s "$ALERT_URL/health" | jq .
```

All should return JSON with status and version info.

### 11.2 Run Unit Tests

```bash
npm run test:unit
```

### 11.3 Validate Access Configuration

```bash
npm run test:access-config
```

### 11.4 Smoke Tests (Against Deployed Stack)

```bash
QUERY_URL="$QUERY_URL" \
EMAIL="<admin-email>" PASSWORD="<admin-password>" \
npm run test:prd
```

Or with a bearer token:

```bash
QUERY_URL="$QUERY_URL" \
QUERY_AUTH_TOKEN="<token>" \
npm run test:prd
```

---

## 12. Ingest Your First Data

### 12.1 Enable Synthetic Data (Quickest Path)

The synthetic worker generates demo data automatically. Verify it is running:

```bash
curl -s "$QUERY_URL/admin/synthetic-ingest" \
  -H "Authorization: Bearer <QUERY_ADMIN_TOKEN>"
```

Synthetic data flows every 5 minutes. Within 10 minutes, you should see searchable events in the UI.

### 12.2 Run the Zeek Demo (Full Demo Experience)

The Zeek demo downloads real Zeek network security logs from the public Zeek repository and ingests them:

```bash
INGEST_URL="$INGEST_URL" \
QUERY_URL="$QUERY_URL" \
ALERT_URL="$ALERT_URL" \
INGEST_SECRET="<your-ingest-secret>" \
ALERT_RUN_SECRET="<your-alert-run-secret>" \
QUERY_AUTH_TOKEN="<token>" \
npm run demo:zeek
```

This ingests data, runs searches, triggers alerts, and demonstrates the full operational workflow.

### 12.3 Manual Ingest Test

Send a small batch directly:

```bash
curl -X POST "$INGEST_URL/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <INGEST_SECRET>" \
  -d '[
    {
      "ts": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
      "service": "onboarding-test",
      "env": "prod",
      "host": "test-host-01",
      "level": "info",
      "message": "EdgeData onboarding test event - deployment successful"
    },
    {
      "ts": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
      "service": "onboarding-test",
      "env": "prod",
      "host": "test-host-01",
      "level": "error",
      "message": "EdgeData onboarding test error - connection refused to database"
    }
  ]'
```

Then search for it:

```bash
curl -X POST "$QUERY_URL/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <QUERY_AUTH_TOKEN>" \
  -d '{
    "time": {
      "from": "'$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)'",
      "to": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    },
    "ppl": "search onboarding | where service=\"onboarding-test\"",
    "limit": 50
  }'
```

---

## 13. Connect Real Data Sources

EdgeData supports multiple ingestion paths. Choose based on your infrastructure.

### 13.1 OpenTelemetry Collector / SDKs

Point your OTel Collector's OTLP/HTTP exporter at EdgeData:

```yaml
# otel-collector-config.yaml
exporters:
  otlphttp/edgedata:
    endpoint: "https://ingest-worker.<subdomain>.workers.dev"
    headers:
      Authorization: "Bearer <INGEST_SECRET>"
      X-Index: "my-app"

service:
  pipelines:
    logs:
      exporters: [otlphttp/edgedata]
    traces:
      exporters: [otlphttp/edgedata]
```

EdgeData accepts OTLP/HTTP JSON at `/v1/logs` and `/v1/traces`.

### 13.2 Vector Agent

```toml
# vector.toml
[sources.app_logs]
type = "file"
include = ["/var/log/myapp/*.log"]

[transforms.enrich]
type = "remap"
inputs = ["app_logs"]
source = '''
.service = "my-app"
.env = "prod"
.host = get_hostname!()
'''

[sinks.edgedata]
type = "http"
inputs = ["enrich"]
uri = "https://ingest-worker.<subdomain>.workers.dev/ingest"
method = "post"
encoding.codec = "json"
batch.max_events = 100
headers.Authorization = "Bearer <INGEST_SECRET>"
headers.Content-Type = "application/json"
```

### 13.3 Cloudflare Logpush (Platform Logs)

Connect Cloudflare's own platform signals — HTTP request logs, WAF/firewall events, and Workers trace events — directly to EdgeData. This uses Logpush with an HTTP destination pointing at the ingest worker.

Supported datasets:

| Logpush Dataset | EdgeData Index |
|---|---|
| HTTP Requests | `cf-http-requests` |
| Firewall Events | `cf-firewall-events` |
| Workers Trace Events | `cf-workers-trace` |

Example: Create an HTTP requests Logpush job:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/logpush/jobs" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "edgedata-http-requests",
    "output_options": {
      "field_names": [
        "ClientIP", "ClientRequestHost", "ClientRequestMethod",
        "ClientRequestURI", "EdgeStartTimestamp", "EdgeResponseStatus",
        "OriginResponseTime", "RayID"
      ],
      "timestamp_format": "rfc3339"
    },
    "destination_conf": "'"${INGEST_URL}/ingest?header_Authorization=Bearer%20${INGEST_SECRET}"'",
    "max_upload_bytes": 5000000,
    "max_upload_records": 1000,
    "dataset": "http_requests",
    "enabled": true
  }'
```

For full Logpush setup including firewall and Workers traces, see [`docs/source-templates/cloudflare-logpush.md`](source-templates/cloudflare-logpush.md).

### 13.4 Direct HTTP (Any Language/Framework)

Any application can POST JSON events directly:

```bash
curl -X POST "https://ingest-worker.<subdomain>.workers.dev/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <INGEST_SECRET>" \
  -d '{"events": [
    {"ts": "2026-03-14T10:00:00Z", "service": "api", "env": "prod", "level": "error", "message": "request timeout after 30s"}
  ]}'
```

Accepted payload formats:
- JSON array: `[{...}, {...}]`
- Wrapped JSON: `{"events": [{...}, {...}]}`
- OTLP JSON logs: `{"resourceLogs": [...]}`
- OTLP JSON traces: `{"resourceSpans": [...]}`
- NDJSON: one JSON object per line

---

## 14. Activate Alerts

### 14.1 Apply the Starter Alert Pack

EdgeData ships with pre-built alert templates. Apply them via the API or UI:

**Via UI:** Navigate to **Alerts** in the sidebar, then click **Apply Starter Pack**.

**Via API:**

```bash
curl -X POST "$QUERY_URL/alerts/starter-pack/apply" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <QUERY_AUTH_TOKEN>"
```

Starter alerts include:
- Service 5xx rate spike
- p95 latency regression
- Auth failure spike
- WAF block surge
- Ingestion pipeline degradation

### 14.2 Configure Notification Channels

Set Slack and/or webhook URLs as secrets on the alert worker (if not done in step 8.3):

```bash
npx wrangler secret put SLACK_WEBHOOK_URL --config workers/alert-worker/wrangler.toml
```

### 14.3 Verify Alert Evaluation

Trigger a manual alert evaluation:

```bash
curl -X POST "$ALERT_URL/run" \
  -H "Authorization: Bearer <ALERT_RUN_SECRET>"
```

The alert worker also runs on a cron schedule (every minute) automatically.

---

## 15. Onboard Your Team

### 15.1 SSO Onboarding (Recommended)

With Cloudflare Access configured:

1. Add team members to the appropriate IdP groups (e.g., add engineers to `edgedata-analysts`)
2. Map Access groups to EdgeData roles in **Settings > Access Group Mappings**
3. Invite or create the user in EdgeData before their first login unless they are using the bootstrap admin email path
4. Team members sign in via the Pages URL using the IdP connected to Cloudflare Access

Current behavior:

- Cloudflare Access authenticates the user
- EdgeData validates the Access JWT and reads email/group claims
- EdgeData authorizes the user based on its own user record, role assignments, Access group mappings, and enabled/disabled state
- Standard users are invite-first today; successful IdP login alone does not create a full EdgeData account automatically

### 15.2 Invite-Based Onboarding

For explicit per-user approval:

1. Go to **Settings > Invite Queue**
2. Enter email, select role, create invitation
3. Copy the generated invite link and send it to the user through your own email or chat tool
4. Invitee opens the link (or signs in via SSO) to activate their account

Notes:

- EdgeData currently creates invite links but does not send invite emails on its own.
- If an Access SSO user is authenticating with Cloudflare Access email OTP / One-Time PIN, Cloudflare Access owns that verification email step. Delivery behavior there is outside EdgeData's control and depends on Cloudflare Access login methods, policy, and mailbox deliverability.
- If you later wire automated invite delivery through Resend, plan on supplying a Resend API key as a worker secret and using a verified sending domain.
- Resend's default `resend.dev` sender is only for limited testing and cannot send real invites to arbitrary recipients until your domain is verified.
- Resend domain verification requires DNS setup for SPF and DKIM, and verification can take time to propagate.

Operational guidance:

- If Cloudflare Access OTP delivery is unreliable, treat that as a Cloudflare Access / identity-provider issue rather than an EdgeData invite failure.
- Use EdgeData's manual invite link and local-password flow as the fallback path when you need to unblock onboarding quickly.

### 15.3 Local Password Onboarding (Development/Break-Glass)

If `AUTH_ENABLE_LOCAL_LOGIN=true`:

1. The bootstrap superadmin signs in with the email configured in `AUTH_BOOTSTRAP_SUPERADMIN_EMAIL` and the password set as `AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD`
2. Additional users can be invited and assigned local credentials

### 15.4 RBAC Role Reference

| Role | Permissions |
|---|---|
| `superadmin` | Everything: search, dashboards, saved searches, alerts, user management, role management, audit access |
| `admin` | Search, dashboards, saved searches, alerts, user administration, role read/write |
| `analyst` | Search, dashboards, saved search write, alert read |
| `viewer` | Search, dashboards, saved search read only |

---

## 16. Post-Deploy Checklist

Use this checklist to confirm your deployment is complete:

### Infrastructure
- [ ] R2 bucket `edgedata-raw` created
- [ ] D1 database created and all migrations applied
- [ ] WAE `log_metrics` dataset active (auto-created on first ingest)

### Workers
- [ ] All 5 workers deployed and responding to `/health`
- [ ] Ingest worker authenticating agents (test with `curl`)
- [ ] Query worker returning search results
- [ ] Alert worker cron running (check **Workers > alert-worker > Triggers**)
- [ ] Synthetic worker generating demo data
- [ ] Materialize worker cron running

### Secrets
- [ ] `INGEST_SECRET` set on ingest worker and synthetic worker
- [ ] `CF_API_TOKEN` set on query worker and alert worker
- [ ] `AUTH_SESSION_SECRET` set on query worker
- [ ] `AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD` set on query worker
- [ ] `ALERT_RUN_SECRET` set on alert worker and query worker
- [ ] Notification secrets (`SLACK_WEBHOOK_URL` or `WEBHOOK_URL`) set on alert worker

### Access & Auth
- [ ] Cloudflare Access protecting query-worker and Pages URLs
- [ ] `ACCESS_AUD` and `ACCESS_ISSUER` configured on query worker
- [ ] At least one Access group mapped to an EdgeData role
- [ ] Bootstrap superadmin can sign in
- [ ] At least one additional user invited or auto-provisioned

### Data & Alerts
- [ ] Search returns recent events (synthetic or real)
- [ ] Starter alert pack applied
- [ ] At least one alert configured with a notification channel
- [ ] Dashboards rendering data

### UI
- [ ] Pages deployed with correct `VITE_QUERY_API_BASE`
- [ ] `CORS_ORIGINS` on query worker includes the Pages URL
- [ ] UI accessible at Pages URL (or custom domain)

### Verification
- [ ] `npm run test:unit` passes
- [ ] `npm run test:access-config` passes
- [ ] `npm run test:prd` passes against deployed stack

### 16.1 Performance Upgrade Path

If dashboard or search latency becomes a blocker, increase performance in this order:

1. **Stay cheap first**
   - Keep starter dashboards on cached/materialized execution.
   - Deploy `materialize-worker` and let dashboards serve precomputed results.
   - Use synthetic data and narrower dashboard time windows during evaluation.
   - Reserve live deep-search for drilldown and investigations, not every dashboard widget.

2. **Spend on the dashboard path before the deep-search path**
   - If you are willing to pay more, first prioritize the Cloudflare capacity that improves `query-worker`, `materialize-worker`, WAE-backed reads, and cache hit rates.
   - This gives the biggest UX improvement because dashboards are what new users see first.
   - Pages can usually remain on its lowest-cost tier; the bottleneck is almost never the UI hosting tier.

3. **Increase materialization aggressiveness**
   - Lower dashboard materialization intervals for important widgets.
   - Keep cached execution enabled even when materialization is on, so repeat loads stay fast.
   - Treat 1–5 minute freshness as the default performance mode for dashboards.

4. **Only then spend on deeper search acceleration**
   - If users need faster wide-window token or phrase searches, add a more expensive accelerator path for deep search rather than forcing dashboards onto live R2 scans.
   - Keep the product split clear: dashboards and alerts should be fast summaries, while deep search remains the truth layer for drilldown.

Recommended default posture:

- **Lowest-cost evaluation:** synthetic data + starter dashboards + cached/materialized execution
- **First paid performance step:** deploy `materialize-worker`, shorten materialization cadence, keep dashboard queries off the live deep-search path
- **Higher-performance path:** invest in more query/materialization capacity and optional deep-search acceleration for larger real-data workloads

---

## 17. Troubleshooting

### Workers fail to deploy

**"Script too large":** Ensure you are on Workers Paid plan. Free plan has a 1MB limit; paid plan allows 10MB.

**"D1 database not found":** Verify `D1_DATABASE_ID` is exported and matches the database you created. Run `wrangler d1 list` to confirm.

### Ingest returns 401/403

- Verify `INGEST_SECRET` matches between the sending agent and the ingest worker secret
- Check `Authorization: Bearer <token>` header format
- For HMAC mode, verify timestamp skew is within 5 minutes

### Query returns 401 "Access JWT required"

- Ensure the request passes through Cloudflare Access (browser has the `CF_Authorization` cookie)
- Verify `ACCESS_AUD` matches the Application Audience from the Access dashboard
- Verify `ACCESS_ISSUER` is `https://<team-name>.cloudflareaccess.com`
- Check `REQUIRE_ACCESS_JWT` is set correctly

### No data appears in search

- Wait 5–10 minutes for synthetic data to accumulate
- Check ingest worker logs in **Workers & Pages > ingest-worker > Logs** for errors
- Verify the R2 bucket has objects: `wrangler r2 object list edgedata-raw --prefix events/`
- Try a broad search: `search * | head 50`

### Alerts not firing

- Confirm alert worker cron is active in **Workers > alert-worker > Triggers**
- Trigger manually: `curl -X POST "$ALERT_URL/run" -H "Authorization: Bearer <ALERT_RUN_SECRET>"`
- Check alert worker logs for evaluation errors
- Verify `CF_API_TOKEN` has WAE read permission
- Confirm `SLACK_WEBHOOK_URL` or `WEBHOOK_URL` is set correctly

### Pages shows "Failed to fetch" or CORS errors

- Verify `VITE_QUERY_API_BASE` matches the deployed query worker URL exactly
- Verify `CORS_ORIGINS` on the query worker includes the Pages URL (with protocol, no trailing slash)
- If using a custom domain, add it to `CORS_ORIGINS`
- Redeploy Pages after changing `VITE_QUERY_API_BASE`: `VITE_QUERY_API_BASE=... npm run deploy:pages`

### WAE dashboard queries return empty

- WAE has a ~1 minute delay for data availability
- Verify `CF_API_TOKEN` has "Workers Analytics Engine: Read" permission
- Verify `CF_ACCOUNT_ID` is set correctly on the query and alert workers
- Check that ingest is writing WAE datapoints (look for the `log_metrics` dataset in Dashboard > Analytics Engine)

### Logpush job creation fails

- Verify the ingest worker is deployed and reachable: `curl "$INGEST_URL/health"`
- Logpush sends a validation payload during job creation — the ingest worker accepts this automatically
- Ensure the bearer token in `destination_conf` is URL-encoded: `Bearer%20<token>`

### Need help?

- Check worker logs: **Dashboard > Workers & Pages > [worker-name] > Logs**
- Run the golden activation test for a full end-to-end check:

```bash
QUERY_URL="$QUERY_URL" \
ALERT_URL="$ALERT_URL" \
DEEP_LINK_BASE="<pages-url>" \
RUNBOOK_BASE_URL="https://runbooks.yourcompany.com" \
ALERT_RUN_SECRET="<secret>" \
EMAIL="<admin-email>" PASSWORD="<admin-password>" \
npm run test:golden-path
```

---

## Quick Reference: Environment Variables

For convenience, here is every variable you will need exported during setup:

```bash
# Core IDs
export D1_DATABASE_ID="<d1-database-uuid>"
export CF_ACCOUNT_ID="<cloudflare-account-id>"

# Worker URLs (discovered after first deploy)
export INGEST_URL="https://ingest-worker.<subdomain>.workers.dev"
export QUERY_URL="https://query-worker.<subdomain>.workers.dev"
export ALERT_URL="https://alert-worker.<subdomain>.workers.dev"

# Pages build
export VITE_QUERY_API_BASE="$QUERY_URL"

# Secrets (used for CLI scripts and tests, not committed)
export INGEST_SECRET="<your-ingest-secret>"
export QUERY_AUTH_TOKEN="<your-query-admin-token>"
export ALERT_RUN_SECRET="<your-alert-run-secret>"
```

---

## What's Next?

After completing onboarding:

1. **Connect production data sources** — replace synthetic data with real application and platform logs
2. **Customize alerts** — tune thresholds and add service-specific alert rules
3. **Set up Logpush** — bring Cloudflare HTTP, WAF, and Workers logs into EdgeData
4. **Configure saved searches** — create team-shared investigation starting points
5. **Review RBAC** — refine role-to-group mappings as your team grows
6. **Set up custom domains** — serve the UI and API on branded domains for your team

For the full product specification, see [`docs/PRD.md`](PRD.md).
For auth and RBAC details, see [`docs/PRD_AUTH_RBAC.md`](PRD_AUTH_RBAC.md).
For the operational checklist, see [`docs/ONBOARDING_CHECKLIST.md`](ONBOARDING_CHECKLIST.md).
