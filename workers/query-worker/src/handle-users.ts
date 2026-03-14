/**
 * Users and auth CRUD handlers extracted from query-worker index.
 * Includes handleUsers and handleAuth which share user/invite helpers.
 */

import type { Env, AuthContext, AuthMode, UserRow, InvitationRow, InvitationViewRow } from './types.js';
import type { GuardrailExplanation } from './types.js';
import {
  jsonResponse,
  textResponse,
  htmlResponse,
  clampLimit,
  escapeHtml
} from './helpers.js';
import {
  assertPermission,
  hasPermission,
  writeAuditLog,
  getUserRoleIds,
  setUserRoles,
  assertCanAssignRoles,
  assertNotLastSuperadmin,
  createInvitation,
  ensureInvitedUser,
  expirePendingInvitations,
  parseInvitationRoleIds
} from './rbac.js';
import {
  ensureRoleId,
  hashPassword,
  sha256Hex,
  authenticateRequest,
  authenticateCredentials,
  createSessionToken,
  localLoginEnabled,
  parseCsvSet
} from './auth.js';
import { resolveRoleIdsForUser, resolveAuthFromRoleIds } from './auth.js';
import { resolveAccessStartReturnTo } from './access-sso-utils.mjs';
import { statusFromError } from './error-utils.mjs';
import { classifyGuardrailError } from './query-core.mjs';
import { sanitizeErrorMessage } from '../../shared/sanitize-error.mjs';
import { clientIp } from '../../shared/request-utils.mjs';
import { enforceRateLimit as sharedEnforceRateLimit, asRateLimitPerMinute as sharedAsRateLimitPerMinute } from '../../shared/rate-limit.mjs';

function resolveAccessReturnTo(request: Request, env: Env): string {
  const url = new URL(request.url);
  return resolveAccessStartReturnTo({
    requestUrl: request.url,
    requestedReturnTo: url.searchParams.get('return_to') || '',
    allowedOrigins: Array.from(parseCsvSet(env.CORS_ORIGINS)),
    originHeader: request.headers.get('origin') || '',
    refererHeader: request.headers.get('referer') || ''
  });
}

async function enforceRateLimit(env: Env, scope: string, key: string, perMinute: number): Promise<void> {
  return sharedEnforceRateLimit(env.DB, scope, key, perMinute);
}

function errorResponse(
  error: unknown,
  requestCorsHeaders: Record<string, string>,
  fallback = 500
): Response {
  const status = statusFromError(error, fallback);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const guardrail = classifyGuardrailError(rawMessage);
  const message = status >= 500 ? sanitizeErrorMessage(error) : rawMessage;
  return jsonResponse(
    {
      error: message,
      ...(guardrail ? { guardrail: guardrail as GuardrailExplanation } : {})
    },
    status,
    requestCorsHeaders
  );
}

export async function handleUsers(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/users') {
    assertPermission(auth, 'user.read');
    const users = await env.DB.prepare(
      `SELECT id, email, role, enabled, created_at, updated_at, last_login_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 300`
    ).all<UserRow>();

    const out = [];
    for (const user of users.results || []) {
      const roleIds = await getUserRoleIds(env, user.id);
      out.push({
        id: user.id,
        email: user.email,
        enabled: user.enabled,
        legacy_role: user.role,
        role_ids: roleIds,
        created_at: user.created_at,
        updated_at: user.updated_at || null,
        last_login_at: user.last_login_at || null
      });
    }
    return jsonResponse(out, 200, requestCorsHeaders);
  }

  if (pathname.startsWith('/users/') && request.method === 'PATCH') {
    assertPermission(auth, 'user.disable');
    const id = pathname.split('/').pop();
    if (!id) return jsonResponse({ error: 'Invalid user id' }, 400, requestCorsHeaders);

    const existing = await env.DB.prepare(
      'SELECT id, email, role, enabled, created_at, updated_at, last_login_at FROM users WHERE id = ?'
    ).bind(id).first<UserRow>();
    if (!existing) return jsonResponse({ error: 'User not found' }, 404, requestCorsHeaders);

    const body = await request.json() as { enabled?: number; role_ids?: string[] };
    const enabled = body.enabled === undefined ? existing.enabled : (body.enabled === 0 ? 0 : 1);

    if (enabled === 0 && existing.enabled === 1) {
      await assertNotLastSuperadmin(env, id);
    }

    if (Array.isArray(body.role_ids)) {
      if (!hasPermission(auth, 'role.write')) {
        throw new Error('Forbidden');
      }
      assertCanAssignRoles(auth, body.role_ids);
      const currentRoles = await getUserRoleIds(env, id);
      const removingSuperadmin = currentRoles.includes('superadmin') && !body.role_ids.map(ensureRoleId).includes('superadmin');
      if (removingSuperadmin) {
        await assertNotLastSuperadmin(env, id);
      }
    }

    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled, now, id)
      .run();

    if (Array.isArray(body.role_ids)) {
      await setUserRoles(env, id, body.role_ids, auth.email || auth.principal);
    }

    await writeAuditLog(env, auth, 'user.updated', 'user', id, { enabled, role_ids: body.role_ids || null }).catch(() => undefined);
    return jsonResponse({ id, enabled, updated_at: now }, 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

export async function handleAuth(
  request: Request,
  env: Env,
  pathname: string,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/auth/access/start') {
    const returnTo = resolveAccessReturnTo(request, env);

    try {
      await authenticateRequest(request, env);
      return new Response(null, {
        status: 302,
        headers: {
          location: returnTo,
          'cache-control': 'no-store'
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      const escapedMessage = escapeHtml(message);
      const escapedReturnTo = escapeHtml(returnTo);
      return htmlResponse(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>EdgeData Access Sign-In</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f5f3ef; color: #1f2937; }
      main { max-width: 640px; margin: 64px auto; padding: 32px; background: #fffdf9; border: 1px solid #e7ded1; border-radius: 18px; box-shadow: 0 18px 50px rgba(36, 30, 18, 0.08); }
      h1 { margin: 0 0 12px; font-size: 1.75rem; }
      p { line-height: 1.6; margin: 0 0 14px; }
      code { background: #f3eee6; padding: 0.15rem 0.35rem; border-radius: 6px; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
      a { color: #8a3b12; font-weight: 600; }
      .button { display: inline-block; padding: 12px 16px; border-radius: 10px; text-decoration: none; background: #8a3b12; color: #fffdf9; }
      .muted { color: #5b6472; font-size: 0.95rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Cloudflare Access session not available</h1>
      <p>This login flow expects the browser to reach an Access-protected query API origin first, then return to the app.</p>
      <p><strong>Current result:</strong> ${escapedMessage}</p>
      <p class="muted">If you are using a <code>workers.dev</code> API URL, point <code>VITE_QUERY_API_BASE</code> at the Access-protected query-worker hostname or custom domain, then try again.</p>
      <div class="actions">
        <a class="button" href="${escapedReturnTo}">Back to EdgeData</a>
        <a href="${escapedReturnTo}">Retry from app</a>
      </div>
    </main>
  </body>
</html>`,
        401,
        {
          ...requestCorsHeaders,
          'cache-control': 'no-store'
        }
      );
    }
  }

  if (request.method === 'POST' && pathname === '/auth/login') {
    if (!localLoginEnabled(env)) {
      return jsonResponse({ error: 'Local login is disabled' }, 403, requestCorsHeaders);
    }

    const loginLimit = sharedAsRateLimitPerMinute(env.AUTH_LOGIN_RATE_LIMIT_PER_MIN, 60);
    await enforceRateLimit(env, 'auth_login_ip', clientIp(request), loginLimit);

    const body = await request.json() as { email?: string; password?: string };
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) {
      return jsonResponse({ error: 'email and password are required' }, 400, requestCorsHeaders);
    }

    const user = await authenticateCredentials(email, password, env);
    if (!user) {
      return jsonResponse({ error: 'Invalid credentials' }, 401, requestCorsHeaders);
    }

    const roleIds = await resolveRoleIdsForUser(env, user, []);
    const auth = await resolveAuthFromRoleIds(env, user.id, user.email, [], roleIds, 'local_password');

    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, user.id)
      .run();
    await writeAuditLog(env, auth, 'auth.login.local', 'user', user.id).catch(() => undefined);

    const session = await createSessionToken(auth, env);
    return jsonResponse({
      token: session.token,
      expires_at: session.expiresAt,
      user: {
        id: user.id,
        email: user.email,
        role: auth.role,
        role_ids: auth.roleIds,
        permissions: Array.from(auth.permissions),
        scope: auth.scope
      },
      auth_mode: 'local_password'
    }, 200, requestCorsHeaders);
  }

  if (request.method === 'GET' && pathname === '/auth/me') {
    try {
      const auth = await authenticateRequest(request, env);
      return jsonResponse({
        authenticated: true,
        user: {
          id: auth.principal,
          email: auth.email,
          role: auth.role,
          role_ids: auth.roleIds,
          permissions: Array.from(auth.permissions),
          scope: auth.scope
        },
        auth_mode: auth.authMode
      }, 200, requestCorsHeaders);
    } catch (error) {
      return errorResponse(error, requestCorsHeaders, 401);
    }
  }

  if (request.method === 'GET' && pathname === '/auth/invites') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');
    await expirePendingInvitations(env);

    const url = new URL(request.url);
    const limit = clampLimit(Number(url.searchParams.get('limit') || 200), 500);
    const requestedStatus = String(url.searchParams.get('status') || 'pending').trim().toLowerCase();
    const allowedStatuses = new Set(['pending', 'accepted', 'revoked', 'expired', 'all']);
    const status = allowedStatuses.has(requestedStatus) ? requestedStatus : 'pending';

    const rows = status === 'all'
      ? await env.DB.prepare(
        `SELECT id, email, auth_mode, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
         FROM invitations
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(limit).all<InvitationViewRow>()
      : await env.DB.prepare(
        `SELECT id, email, auth_mode, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
         FROM invitations
         WHERE status = ?
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(status, limit).all<InvitationViewRow>();

    const out = (rows.results || []).map((row) => ({
      id: row.id,
      email: row.email,
      auth_mode: row.auth_mode,
      role_ids: parseInvitationRoleIds(row.role_ids_json),
      expires_at: row.expires_at,
      invited_by: row.invited_by,
      status: row.status,
      created_at: row.created_at,
      accepted_at: row.accepted_at || null
    }));

    return jsonResponse(out, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');

    const body = await request.json() as { email?: string; auth_mode?: AuthMode; role_ids?: string[] };
    const email = String(body.email || '').trim().toLowerCase();
    const authMode = body.auth_mode === 'local_password' ? 'local_password' : 'access_sso';
    const roleIds = Array.isArray(body.role_ids) && body.role_ids.length > 0 ? body.role_ids : ['viewer'];
    if (!email) {
      return jsonResponse({ error: 'email is required' }, 400, requestCorsHeaders);
    }
    assertCanAssignRoles(auth, roleIds);

    const userId = await ensureInvitedUser(env, email, authMode);
    await setUserRoles(env, userId, roleIds, auth.email || auth.principal);
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE email = ? AND status = 'pending'`
    ).bind(email).run();
    const invite = await createInvitation(env, email, authMode, roleIds, auth.email || auth.principal);

    await writeAuditLog(env, auth, 'auth.invite.created', 'user', userId, { email, auth_mode: authMode, role_ids: roleIds }).catch(() => undefined);
    return jsonResponse({
      email,
      auth_mode: authMode,
      role_ids: roleIds,
      expires_at: invite.expiresAt,
      invite_token: invite.inviteToken
    }, 201, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite/resend') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');
    await expirePendingInvitations(env);

    const body = await request.json() as { id?: string; auth_mode?: AuthMode; role_ids?: string[] };
    const invitationId = String(body.id || '').trim();
    if (!invitationId) {
      return jsonResponse({ error: 'id is required' }, 400, requestCorsHeaders);
    }

    const existingInvite = await env.DB.prepare(
      `SELECT id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
       FROM invitations
       WHERE id = ?`
    ).bind(invitationId).first<InvitationRow>();
    if (!existingInvite) {
      return jsonResponse({ error: 'Invitation not found' }, 404, requestCorsHeaders);
    }
    if (existingInvite.status === 'accepted') {
      return jsonResponse({ error: 'Invitation already accepted' }, 400, requestCorsHeaders);
    }

    const authMode = body.auth_mode === 'local_password' ? 'local_password' : existingInvite.auth_mode;
    let roleIds = Array.isArray(body.role_ids) && body.role_ids.length > 0
      ? body.role_ids.map(ensureRoleId).filter(Boolean)
      : parseInvitationRoleIds(existingInvite.role_ids_json);
    if (roleIds.length === 0) {
      const user = await env.DB.prepare(
        `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
         FROM users
         WHERE email = ?`
      ).bind(existingInvite.email).first<UserRow>();
      roleIds = user ? await getUserRoleIds(env, user.id) : ['viewer'];
    }
    assertCanAssignRoles(auth, roleIds);

    const userId = await ensureInvitedUser(env, existingInvite.email, authMode);
    await setUserRoles(env, userId, roleIds, auth.email || auth.principal);
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE email = ? AND status = 'pending'`
    ).bind(existingInvite.email).run();

    const invite = await createInvitation(env, existingInvite.email, authMode, roleIds, auth.email || auth.principal);
    await writeAuditLog(env, auth, 'auth.invite.resent', 'user', userId, {
      email: existingInvite.email,
      auth_mode: authMode,
      role_ids: roleIds,
      previous_invitation_id: existingInvite.id
    }).catch(() => undefined);

    return jsonResponse({
      id: invite.invitationId,
      email: existingInvite.email,
      auth_mode: authMode,
      role_ids: roleIds,
      expires_at: invite.expiresAt,
      invite_token: invite.inviteToken
    }, 201, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite/revoke') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');
    await expirePendingInvitations(env);

    const body = await request.json() as { id?: string };
    const invitationId = String(body.id || '').trim();
    if (!invitationId) {
      return jsonResponse({ error: 'id is required' }, 400, requestCorsHeaders);
    }

    const invitation = await env.DB.prepare(
      `SELECT id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
       FROM invitations
       WHERE id = ?`
    ).bind(invitationId).first<InvitationRow>();
    if (!invitation) {
      return jsonResponse({ error: 'Invitation not found' }, 404, requestCorsHeaders);
    }
    if (invitation.status !== 'pending') {
      return jsonResponse({ error: `Invitation is already ${invitation.status}` }, 400, requestCorsHeaders);
    }

    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE id = ?`
    ).bind(invitation.id).run();
    await writeAuditLog(env, auth, 'auth.invite.revoked', 'user', undefined, {
      invitation_id: invitation.id,
      email: invitation.email
    }).catch(() => undefined);
    return jsonResponse({ ok: true, id: invitation.id, status: 'revoked' }, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite/accept') {
    try {
      await enforceRateLimit(env, 'invite_accept', clientIp(request), 10);
    } catch {
      return jsonResponse({ error: 'Too many attempts. Please try again later.' }, 429, requestCorsHeaders);
    }
    await expirePendingInvitations(env);
    const body = await request.json() as { token?: string; password?: string };
    const token = String(body.token || '').trim();
    if (!token) {
      return jsonResponse({ error: 'token is required' }, 400, requestCorsHeaders);
    }

    const tokenHash = await sha256Hex(token);
    const invitation = await env.DB.prepare(
      `SELECT id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
       FROM invitations
       WHERE token_hash = ?`
    ).bind(tokenHash).first<InvitationRow>();
    if (!invitation || invitation.status !== 'pending') {
      return jsonResponse({ error: 'Invalid invitation token' }, 400, requestCorsHeaders);
    }
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      return jsonResponse({ error: 'Invitation expired' }, 400, requestCorsHeaders);
    }
    if (invitation.auth_mode === 'access_sso') {
      return jsonResponse({ error: 'Access SSO invitations are activated on first SSO login' }, 400, requestCorsHeaders);
    }

    const password = String(body.password || '');
    if (!password || password.length < 10) {
      return jsonResponse({ error: 'password must be at least 10 characters' }, 400, requestCorsHeaders);
    }

    const user = await env.DB.prepare(
      `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
       FROM users
       WHERE email = ?`
    ).bind(invitation.email).first<UserRow>();
    if (!user) {
      return jsonResponse({ error: 'Invitation user not found' }, 400, requestCorsHeaders);
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      `UPDATE users
       SET password_hash = ?, enabled = 1, updated_at = ?
       WHERE id = ?`
    ).bind(passwordHash, now, user.id).run();
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'accepted', accepted_at = ?
       WHERE id = ?`
    ).bind(now, invitation.id).run();
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE email = ? AND status = 'pending' AND id != ?`
    ).bind(invitation.email, invitation.id).run();

    await writeAuditLog(env, null, 'auth.invite.accepted', 'user', user.id, { email: invitation.email }).catch(() => undefined);
    return jsonResponse({ ok: true, email: invitation.email }, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/logout') {
    return jsonResponse({ ok: true }, 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
