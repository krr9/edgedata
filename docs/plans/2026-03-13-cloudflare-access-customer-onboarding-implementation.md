# Cloudflare Access Customer Onboarding Implementation Plan

**Goal:** Make EdgeData customer onboarding operationally clean for real teams by using Cloudflare Access for authentication and entry policy, while keeping EdgeData as the source of truth for RBAC, data scope, auditability, and application-level user state.

**Architecture:** Keep Cloudflare Access as the front door for the Pages app and query API. Use IdP-backed Access groups for coarse-grained app entry and EdgeData RBAC role mappings for product authorization. Add a predictable user lifecycle in EdgeData so customers can choose between strict invite mode and group-driven auto-provisioning on first SSO login.

**Tech Stack:** Cloudflare Access, Zero Trust policies, Workers (`workers/query-worker`), D1 auth/RBAC tables, Pages React UI, existing invitation and role-mapping flows, current `CF-Access-Jwt-Assertion` validation path.

**Product decision:** The recommended customer operating model is group-first SSO onboarding:
- Customers manage people in their IdP groups.
- Cloudflare Access decides who may reach EdgeData at all.
- EdgeData auto-creates or activates users on first login when they match approved Access groups.
- Strict invite-only onboarding remains available for customers who want explicit per-user approval before first access.

---

### Current gaps to fix

- The repo validates Access JWTs, but the customer admin story is still ambiguous: it is not clear when a user should be invited versus auto-created.
- Customers with many users should not have to maintain a manual per-user list in Cloudflare Access or EdgeData for routine onboarding.
- The current docs describe group mapping and invitations, but do not clearly define the supported onboarding modes or recommended default.
- There is no explicit deployment/runtime contract for "Access allowed user, but no matching EdgeData role/user state exists".
- The UI/admin experience does not yet clearly distinguish:
  - who can reach the app because of Access
  - who has an EdgeData account
  - who is active, invited, auto-provisioned, or disabled

---

### Target user experience

For a customer deployment, the intended setup should feel like this:

1. Customer connects their IdP to Cloudflare Access.
2. Customer creates Access groups such as `edgedata-viewers`, `edgedata-analysts`, and `edgedata-admins`.
3. Customer protects the EdgeData query API hostname with Cloudflare Access and allows those groups.
4. Customer maps Access groups to EdgeData roles in EdgeData settings.
5. A user signs in with SSO.
6. EdgeData either:
   - auto-provisions the user on first login because their Access groups map to a valid role, or
   - denies entry with a clear "awaiting invitation/approval" message if strict invite mode is enabled.
7. EdgeData records the user, effective roles, and audit trail in D1.

For larger organizations, day-to-day user management should happen in the customer's IdP groups, not by editing a long application user list by hand.

---

### Operating model

#### Layer 1: Cloudflare Access

Cloudflare Access answers:
- Can this identity reach the EdgeData API at all?
- Did the user authenticate with the customer's IdP?
- Does the user satisfy entry policy requirements like group membership or MFA?

Recommended customer setup:
- Protect the query-worker hostname with Cloudflare Access.
- Use IdP groups or email-domain rules for `Allow` policies.
- Avoid per-user manual allowlists except for early pilots or break-glass cases.

#### Layer 2: EdgeData

EdgeData answers:
- What role does this authenticated user have inside EdgeData?
- What services/envs/hosts may they query?
- Are they active, disabled, invited, or awaiting approval?
- What audit trail exists for access and role changes?

Recommended default:
- Map Access groups to EdgeData roles.
- Auto-provision users on first successful SSO login when they match a mapped Access group.
- Keep strict invite mode as an explicit tenant option.

---

### Supported onboarding modes

#### Mode A: Group-first auto-provisioning (recommended default)

Behavior:
- User is allowed by Cloudflare Access.
- User presents valid Access JWT.
- EdgeData resolves one or more mapped Access groups to EdgeData role IDs.
- If at least one valid role is resolved, EdgeData creates the user record on first login and marks them `active`.

Best for:
- Mid-size and enterprise teams.
- Customers already managing groups in Okta, Entra ID, or Google Workspace.
- Low-friction rollout.

Operational model:
- Admins add/remove users from IdP groups.
- EdgeData access changes take effect on next login or token refresh.

#### Mode B: Invite-required SSO onboarding

Behavior:
- User is allowed by Cloudflare Access and can authenticate.
- EdgeData only permits product access if the email already exists in EdgeData in `invited` or `active` state.
- First successful SSO login activates invited users.

Best for:
- Customers who require explicit app-level approval for every user.
- High-control or regulated environments.

Operational model:
- Admin invites users in EdgeData.
- Customer may still use Access groups for perimeter control, but EdgeData remains approval-gated.

#### Mode C: Hybrid

Behavior:
- Specific admin/privileged roles require invites.
- Lower-privilege viewer/analyst roles may auto-provision from approved Access groups.

Best for:
- Customers who want self-service read access but controlled admin elevation.

---

### Product contract

#### Proposed runtime setting

Add an explicit onboarding mode setting, for example:
- `AUTH_SSO_ONBOARDING_MODE=auto_provision|invite_required|hybrid`

Optional hybrid companion settings:
- `AUTH_AUTO_PROVISION_ROLE_IDS`
- `AUTH_AUTO_PROVISION_EMAIL_DOMAINS`
- `AUTH_REQUIRE_INVITE_FOR_ADMIN_ROLES=true`

#### Authentication result states

When a valid Access JWT reaches EdgeData, authentication should end in one of these states:

1. `allowed_active`
- Existing active user found or newly auto-provisioned user created.

2. `awaiting_invite`
- Valid identity, but tenant is invite-required and no matching invited/active user exists.

3. `no_role_mapping`
- Valid identity, but no Access group maps to any EdgeData role.

4. `disabled`
- Matching user exists but is disabled.

5. `bootstrap_admin`
- Explicit bootstrap/admin-email path used for first secure entry.

Each state should produce a clear UI/API message and audit event.

---

### Task 1: Lock the customer onboarding contract

**Files:**
- Modify: `docs/PRD_AUTH_RBAC.md`
- Optional: `README.md`
- Optional: `docs/ONBOARDING_CHECKLIST.md`

**Step 1: Make the recommended operating model explicit**

Document clearly:
- Cloudflare Access manages authentication and entry policy.
- EdgeData manages RBAC and user lifecycle.
- Group-first auto-provisioning is the recommended default.
- Invite-only remains supported.

**Step 2: Define onboarding modes**

Add an explicit section for:
- `auto_provision`
- `invite_required`
- `hybrid`

**Step 3: Define failure states**

Document exact behavior for:
- valid Access JWT but no group mapping
- valid Access JWT but no invited user in invite-only mode
- disabled users
- unmatched email/domain/group

**Step 4: Verify docs stay internally consistent**

Ensure PRD, README, and onboarding checklist all describe the same customer admin model.

---

### Task 2: Extend the user lifecycle schema and semantics

**Files:**
- Modify: `schema.sql`
- Create: migration in `deploy/migrations/`

**Step 1: Add onboarding metadata to users**

Suggested fields:
- `auth_source` TEXT (`access_sso`, `local_password`)
- `provisioning_mode` TEXT (`auto_provision`, `invite`, `bootstrap`)
- `first_seen_at` TEXT
- `last_access_jwt_at` TEXT
- `last_access_groups_json` TEXT

**Step 2: Preserve explicit user state**

Retain and formalize:
- `invited`
- `active`
- `disabled`
- optional `awaiting_approval`

**Step 3: Add tenant/runtime onboarding config storage**

If not environment-only, add a small runtime settings table or config record for:
- SSO onboarding mode
- default allowed role mappings
- whether invite-only applies to admin roles

**Step 4: Add auditability**

Audit events should cover:
- auto-provisioned user created
- invited user activated by SSO
- access denied due to no mapping
- access denied due to invite-required mode
- role mapping changes

---

### Task 3: Refactor Access SSO authentication flow in query-worker

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Optional: create `workers/query-worker/src/auth-sso-core.mjs`
- Test: `workers/query-worker/test/*.test.mjs`

**Step 1: Split identity resolution from user admission**

Refactor auth flow into:
- validate Access JWT
- extract identity/email/groups
- resolve mapped role IDs
- evaluate onboarding mode
- load/create/update EdgeData user record
- build final auth context

**Step 2: Implement auto-provision mode**

Behavior:
- If Access JWT is valid and mapped roles are found, create user when missing.
- Save email, role IDs, audit data, and last-seen groups.
- Mark user `active`.

**Step 3: Implement invite-required mode**

Behavior:
- If user is missing, deny with a clear `awaiting_invite` error.
- If invitation exists, activate on first successful Access login.

**Step 4: Implement hybrid mode**

Behavior:
- Auto-provision for configured low-privilege roles.
- Require invite for privileged roles such as `admin` or `superadmin`.

**Step 5: Make errors operator-friendly**

Return explicit structured errors such as:
- `no_role_mapping`
- `awaiting_invite`
- `user_disabled`

This allows the Pages app to render actionable guidance instead of a generic `401`.

---

### Task 4: Add admin APIs and views for onboarding operations

**Files:**
- Modify: `workers/query-worker/src/index.ts`
- Modify: `pages/src/App.tsx`
- Optional: create dedicated admin components in `pages/src/`

**Step 1: Expose onboarding settings**

Add endpoints/UI for:
- current onboarding mode
- current Access group mappings
- whether invite-only is enabled for privileged roles

**Step 2: Improve user directory UX**

Admin UI should show:
- email
- source (`access_sso`, `local_password`)
- state
- assigned roles
- last login
- provisioning mode
- last observed Access groups

**Step 3: Support explicit approval flows**

In invite-required or hybrid mode:
- admin can approve a pending SSO user
- admin can convert an auto-provisioned user to disabled
- admin can promote/demote role assignments

**Step 4: Add onboarding diagnostics**

Add an operator-facing diagnostics card for:
- Access enabled on API hostname
- `ACCESS_AUD` configured
- Access group mappings present
- onboarding mode
- counts of active/invited/disabled users

---

### Task 5: Update the Pages sign-in experience for real onboarding states

**Files:**
- Modify: `pages/src/AuthContext.tsx`
- Modify: `pages/src/AuthScreen.tsx`

**Step 1: Distinguish authentication from authorization**

If Access succeeds but EdgeData denies admission, show targeted messages:
- "Your organization has not granted you an EdgeData role yet."
- "Your admin must invite you before first use."
- "Your account is disabled."

**Step 2: Keep the Access redirect flow explicit**

Continue using:
- browser redirect to `/auth/access/start`
- return-to app flow
- `/auth/me` for final user resolution

**Step 3: Make onboarding self-explanatory**

Recommended UI copy:
- Explain that the user is authenticated with the organization's SSO provider.
- Explain whether the next step is invite approval, group assignment, or admin contact.

---

### Task 6: Seed and migrate customers safely

**Files:**
- Modify: migration scripts
- Optional: add a backfill/ops script in `scripts/`

**Step 1: Preserve existing invited and active users**

Do not break current user records. Existing invited/active users should keep working.

**Step 2: Backfill legacy users**

For existing Access SSO users:
- populate `auth_source`
- populate `provisioning_mode` where inferable
- mark currently active users appropriately

**Step 3: Keep bootstrap safe**

Ensure:
- bootstrap superadmin path is still explicit
- `ACCESS_ADMIN_EMAILS` remains a safe break-glass path
- bootstrap cannot silently recreate privileged users after initial setup

---

### Task 7: Add tests for customer-operable onboarding

**Files:**
- Test: `workers/query-worker/test/*.test.mjs`
- Optional: Pages tests if introduced later

**Step 1: Add auth-path tests**

Cover:
- valid Access JWT + mapped group + auto-provision => success
- valid Access JWT + no mapping => deny
- valid Access JWT + invite-required + no invite => deny with structured reason
- valid Access JWT + existing invited user => activate and succeed
- disabled user => deny

**Step 2: Add admin config tests**

Cover:
- onboarding mode parsing and defaults
- hybrid privileged-role gate behavior
- role mapping resolution precedence

**Step 3: Add regression tests for current guarantees**

Protect:
- JWT issuer/audience validation
- RBAC scope enforcement
- owner scoping for non-admin saved searches

---

### Recommended default rollout

For the next implementation cycle, use this default:

1. Access-protected query-worker hostname is mandatory for SSO deployments.
2. `auto_provision` is the default onboarding mode.
3. At least one Access group mapping is required before onboarding is considered complete.
4. `admin` and `superadmin` roles may optionally require explicit invite even in hybrid mode.
5. Local password login remains optional break-glass only.

This gives customers the lowest-friction production story:
- manage people in IdP groups
- let Cloudflare Access handle sign-in
- let EdgeData create user records and enforce RBAC on first use

---

### Open product decisions

1. Should `auto_provision` be the product default, or should customers explicitly opt into it?
2. Should `admin` and `superadmin` always require invite, regardless of onboarding mode?
3. Should EdgeData create a persistent user row for every valid SSO login, or only for those with mapped roles?
4. Should unmatched but Access-allowed users appear in a pending-approval queue for admins?
5. Do we want per-tenant toggles for "allow any user from approved email domain" in addition to Access groups?

---

### Definition of done

This work is done when:

1. Customer docs clearly explain that Cloudflare Access manages authentication and EdgeData manages authorization.
2. A customer can onboard a team by editing IdP/Access groups rather than maintaining a manual user list.
3. EdgeData supports explicit onboarding modes with predictable behavior.
4. Admins can see and manage user state, mappings, and onboarding diagnostics in the product.
5. SSO login failures return actionable reasons instead of generic unauthorized responses.
6. Existing auth/RBAC guarantees remain intact and tested.
