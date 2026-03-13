# EdgeData AuthN/AuthZ PRD
## Cloudflare-Customer-First RBAC (SSO-First)
**Version:** 2.0  
**Date:** 2026-02-18  
**Status:** Proposed (implementation-ready)  
**Supersedes:** Auth/RBAC portions of `docs/PRD.md` section 10

---

## 1) Product context

EdgeData is deployed into the customer's Cloudflare account. The target customer already uses Cloudflare services and typically has Cloudflare Access connected to an IdP (Okta, Entra ID, Google Workspace, etc.).

### Core assumption
Most human users authenticate with SSO via Cloudflare Access and IdP-backed groups.

### Design implication
Auth must be SSO-first with low operational lift. Local credentials exist only as optional fallback for break-glass and non-SSO scenarios.

---

## 2) Goals

1. Provide first-class, configurable RBAC for logs, dashboards, saved searches, alerts, and admin APIs.
2. Bootstrap exactly one `superadmin` on first deployment.
3. Support invite-based user onboarding with role assignment.
4. Enforce authorization in backend APIs, not only in UI.
5. Enforce data access scope (service/env/host) in search and dashboard queries.
6. Keep Cloudflare-native setup simple for existing Access customers.

## 3) Non-goals

1. Full enterprise IAM replacement (SCIM lifecycle, approval workflows) in v1.
2. Multi-tenant SaaS org hierarchy (deployment remains single-tenant per Cloudflare account).
3. Complex policy language beyond role permissions + scoped filters in v1.

---

## 4) Personas and jobs-to-be-done

### Platform Superadmin
- Owns deployment and security baseline.
- Needs to bootstrap admin access, map Access groups, and control privileges.

### Security/Operations Admin
- Manages users, roles, and auditability.
- Needs invite, disable, and role change workflows with traceability.

### Analyst/On-call Engineer
- Uses search and dashboards daily.
- Needs fast access to only authorized services/environments.

### Auditor
- Needs immutable history of access and privileged operations.

---

## 5) Principles

1. SSO-first: Cloudflare Access JWT is default for human auth.
2. Least privilege by default: narrow permissions and data scope.
3. API-enforced policy: every endpoint evaluates effective permissions.
4. Configurable roles with safe system defaults.
5. Fail closed on authorization checks.
6. Full auditability for security-sensitive events.

---

## 6) Authentication model

### 6.1 Human authentication modes

1. `access_sso` (default)
- User reaches Pages protected by Cloudflare Access.
- Worker validates `CF-Access-Jwt-Assertion`.
- Identity derived from JWT subject/email and optional group claims.

2. `local_password` (optional)
- Email/password login via `/auth/login`.
- Used only when enabled by config.
- Intended for break-glass or customers without Access rollout for some users.

### 6.2 Machine authentication

1. Ingestion: bearer/HMAC secrets (existing model).
2. Automation/API clients: role-scoped API tokens or service principals (phase 2).

### 6.3 First-deploy bootstrap

1. On first startup with empty users table, system creates one `superadmin`.
2. Bootstrap identity must be explicit and secure:
- `AUTH_BOOTSTRAP_SUPERADMIN_EMAIL` required.
- `AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD` required only when local auth is enabled.
3. Bootstrap path is disabled once first superadmin exists.

---

## 7) Authorization model (RBAC + Data Scope)

### 7.1 Role types

1. System roles (non-deletable): `superadmin`, `admin`, `analyst`, `viewer`.
2. Custom roles: created and managed by `superadmin` (and optionally admin if allowed).

### 7.2 Permission model

Permissions are explicit capability keys, for example:
- `search.read`
- `dashboard.read`
- `saved_search.read`
- `saved_search.write`
- `saved_search.delete`
- `alert.read`
- `alert.write`
- `alert.delete`
- `user.read`
- `user.invite`
- `user.disable`
- `role.read`
- `role.write`
- `audit.read`
- `settings.write`

### 7.3 Data scope model

Each role includes scope constraints:
- `services` (exact or wildcard pattern support)
- `envs`
- `hosts`

Effective scope = union of allowed scopes across assigned roles, minus explicit denies if deny rules are enabled in phase 2.

### 7.4 Effective access evaluation

For each request:
1. Authenticate principal.
2. Resolve assigned roles from direct assignment and/or Access-group mapping.
3. Compute effective permissions and effective data scope.
4. Authorize route action.
5. Inject data scope filters into search/dashboard queries.
6. Reject requests that attempt to exceed scope.

---

## 8) Cloudflare Access group mapping

### 8.1 Why this is first-class

Target customers already manage identity in IdP + Access. Role mapping must integrate this directly.

### 8.2 Mapping behavior

1. Admin config maps Access groups to one or more EdgeData roles.
2. Mapping is stored in D1 (not only environment variables).
3. Environment variables remain bootstrap defaults/fallback:
- `ACCESS_AUD`
- `ACCESS_*_GROUPS` optional seed
4. Runtime role resolution merges static mapping and DB mapping.

### 8.3 Safety requirements

1. `ACCESS_AUD` must be set in production.
2. JWT issuer and audience validation required when SSO mode is on.
3. Missing valid mapping yields deny (except explicit `superadmin` allow list).

---

## 9) User lifecycle and invitations

### 9.1 Invite flows

1. Access-backed invite (recommended):
- Admin invites email with assigned role(s).
- User must authenticate via Access with matching identity.
- First successful login activates user.

2. Local invite (optional):
- Admin invites email with role(s).
- Invitee sets password through one-time token.

### 9.2 Invite token requirements

1. One-time token, hashed at rest.
2. Expiration 24 to 72 hours.
3. Revocable and resendable.

### 9.3 User states

`invited`, `active`, `disabled`, `locked`.

### 9.4 Admin actions

1. Invite user.
2. Resend/revoke invite.
3. Assign/remove roles.
4. Disable/enable user.
5. Force logout/session revoke (phase 2).

---

## 10) API scope

### 10.1 Auth

- `POST /auth/login` (local mode only or explicitly enabled)
- `GET /auth/access/start`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/invite`
- `POST /auth/invite/accept`

### 10.2 Admin: users and roles

- `GET /users`
- `POST /users`
- `PATCH /users/:id`
- `GET /roles`
- `POST /roles`
- `PATCH /roles/:id`
- `GET /rbac/mappings`
- `POST /rbac/mappings`

### 10.3 Audit

- `GET /audit` (filterable by actor/action/time)

### 10.4 Existing domain APIs under RBAC

- `POST /search`
- `POST /search/summary`
- `POST /dashboards/query`
- `POST /saved-searches/*`
- `POST /alerts/*`

All existing APIs must enforce permission and data-scope checks.

---

## 11) Data model additions (D1)

### 11.1 New/expanded tables

1. `roles`
- id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at

2. `user_roles`
- user_id, role_id, assigned_by, assigned_at

3. `access_group_role_mappings`
- id, access_group, role_id, created_at, updated_at

4. `invitations`
- id, email, auth_mode, token_hash, expires_at, invited_by, status, created_at, accepted_at

5. `audit_log`
- id, actor_principal, actor_email, action, target_type, target_id, metadata_json, created_at

6. `sessions` (phase 2)
- token_hash, user_id, issued_at, expires_at, revoked_at

### 11.2 Existing tables

`users` remains source for local identities and profile metadata. Add fields if needed:
- `auth_mode` (`access_sso` or `local_password`)
- `status`

---

## 12) UI requirements

### 12.1 Admin console

1. Users page: invite, disable, role assignment.
2. Roles page: view system roles, create/edit custom roles, set permission keys, set data scopes.
3. Access mapping page: map Access groups to roles.
4. Audit page: searchable stream of privileged events.

### 12.2 Explorer and dashboards

1. Show effective role and scope indicator.
2. Hide/disable unauthorized actions.
3. Display authorization errors with actionable reason (permission or scope denied).

---

## 13) Security requirements

1. Password hashing: PBKDF2/Argon2 with strong parameters.
2. Login rate limiting and lockout policy.
3. Session TTL + optional revocation.
4. All auth/admin events logged to `audit_log`.
5. Sensitive config and secrets only in secret bindings.
6. CORS restricted to approved Pages origins.

---

## 14) Deployment and configuration

### 14.1 Required production configuration

1. `REQUIRE_ACCESS_JWT=true`
2. `ACCESS_AUD` set to application audience.
3. `ACCESS_ISSUER` and JWKS resolution configured.
4. At least one admin/superadmin Access group mapping configured.

### 14.2 Optional local-auth configuration

1. `AUTH_ENABLE_LOCAL_LOGIN=true|false`
2. `AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD` only if local login enabled.

---

## 15) Rollout plan

### Phase 1 (P0): SSO-first hardening

1. Add RBAC schema (`roles`, `user_roles`, mappings, audit, invites).
2. Implement policy engine in query worker.
3. Enforce permission + scope checks on existing APIs.
4. Add superadmin bootstrap and Access mapping seed logic.
5. Add audit logging for auth/admin actions.

### Phase 2 (P1): Admin workflows

1. Invite and accept flows.
2. Admin UI for users/roles/mappings/audit.
3. Custom role CRUD and scope editor.

### Phase 3 (P2): Enterprise hardening

1. Session revocation and service principals.
2. Optional SCIM/JIT sync.
3. Deny rules and richer policy semantics.

---

## 16) Acceptance criteria

1. New deployment creates exactly one superadmin and no open registration path.
2. Access SSO user with mapped role can authenticate and receives expected permissions.
3. User without mapped/assigned role is denied all protected APIs.
4. Scoped user cannot query unauthorized `service/env/host` even via crafted requests.
5. Role changes are reflected on next request.
6. Every admin operation produces an audit record.
7. Local login can be fully disabled while SSO remains functional.

---

## 17) Test plan

1. Unit tests:
- Permission evaluator.
- Scope evaluator.
- Access-group mapping resolution.

2. Integration tests:
- Access JWT valid/invalid audience handling.
- Invite lifecycle.
- API-level deny/allow matrix by role.
- Search/dashboard scope injection correctness.

3. Security tests:
- Rate limit behavior.
- Token/session expiry handling.
- Audit log completeness checks.

4. Operational tests:
- Bootstrap path works only once.
- Misconfigured Access settings fail closed.

---

## 18) Open decisions

1. Should admins be allowed to create roles, or superadmin only?
2. Should wildcard scope matching use glob or regex?
3. Should local login be disabled by default in all production templates?
4. Phase-2 priority: service principals vs SCIM sync first?
