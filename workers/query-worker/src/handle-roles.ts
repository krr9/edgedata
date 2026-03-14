/**
 * Roles, RBAC mappings, and audit handlers extracted from query-worker index.
 */

import type {
  Env,
  AuthContext,
  RoleRow,
  AccessGroupRoleMappingRow,
  AuditLogRow
} from './types.js';
import { jsonResponse, textResponse, clampLimit } from './helpers.js';
import { assertPermission, writeAuditLog } from './rbac.js';
import {
  ensureRoleId,
  parsePermissionsInput,
  parseScopeInput,
  parseScope,
  parseJsonArray,
  normalizeScope
} from './auth.js';

export async function handleRoles(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/roles') {
    assertPermission(auth, 'role.read');
    const rows = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles
       ORDER BY system_role DESC, id ASC`
    ).all<RoleRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/roles') {
    assertPermission(auth, 'role.write');
    const body = await request.json() as Partial<RoleRow>;
    const id = ensureRoleId(String(body.id || body.name || '').replace(/\s+/g, '-'));
    const name = String(body.name || id).trim();
    if (!id || !name) {
      return jsonResponse({ error: 'id/name required' }, 400, requestCorsHeaders);
    }
    const permissions = parsePermissionsInput(body.permissions_json, []);
    if (permissions.length === 0) {
      return jsonResponse({ error: 'permissions_json must contain at least one permission' }, 400, requestCorsHeaders);
    }
    const scope = normalizeScope(parseScopeInput(body.scope_json));
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO roles (id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at)
       VALUES (?, ?, 0, 1, ?, ?, ?, ?)`
    ).bind(id, name, JSON.stringify(permissions), JSON.stringify(scope), now, now).run();
    await writeAuditLog(env, auth, 'role.created', 'role', id, { permissions_count: permissions.length }).catch(() => undefined);
    return jsonResponse({ id, name, permissions_json: JSON.stringify(permissions), scope_json: JSON.stringify(scope) }, 201, requestCorsHeaders);
  }

  if (pathname.startsWith('/roles/') && request.method === 'PATCH') {
    assertPermission(auth, 'role.write');
    const id = ensureRoleId(pathname.split('/').pop() || '');
    if (!id) return jsonResponse({ error: 'Invalid role id' }, 400, requestCorsHeaders);
    const existing = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles WHERE id = ?`
    ).bind(id).first<RoleRow>();
    if (!existing) return jsonResponse({ error: 'Role not found' }, 404, requestCorsHeaders);

    const body = await request.json() as Partial<RoleRow>;
    const name = String(body.name ?? existing.name).trim();
    const enabled = body.enabled === undefined ? existing.enabled : (body.enabled === 0 ? 0 : 1);
    const permissions = body.permissions_json === undefined
      ? parseJsonArray(existing.permissions_json, [])
      : parsePermissionsInput(body.permissions_json, []);
    const scope = body.scope_json === undefined
      ? normalizeScope(parseScope(existing.scope_json))
      : normalizeScope(parseScopeInput(body.scope_json));

    if (existing.system_role === 1 && auth.role !== 'superadmin') {
      return jsonResponse({ error: 'Only superadmin can modify system roles' }, 403, requestCorsHeaders);
    }

    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE roles
       SET name = ?, enabled = ?, permissions_json = ?, scope_json = ?, updated_at = ?
       WHERE id = ?`
    ).bind(name, enabled, JSON.stringify(permissions), JSON.stringify(scope), now, id).run();
    await writeAuditLog(env, auth, 'role.updated', 'role', id, { enabled, permissions_count: permissions.length }).catch(() => undefined);
    return jsonResponse({ id, name, enabled, permissions_json: JSON.stringify(permissions), scope_json: JSON.stringify(scope), updated_at: now }, 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

export async function handleRbacMappings(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/rbac/mappings') {
    assertPermission(auth, 'role.read');
    const rows = await env.DB.prepare(
      `SELECT id, access_group, role_id, created_at, updated_at
       FROM access_group_role_mappings
       ORDER BY access_group ASC, role_id ASC`
    ).all<AccessGroupRoleMappingRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/rbac/mappings') {
    assertPermission(auth, 'role.write');
    const body = await request.json() as { access_group?: string; role_id?: string };
    const group = String(body.access_group || '').trim();
    const roleId = ensureRoleId(String(body.role_id || ''));
    if (!group || !roleId) {
      return jsonResponse({ error: 'access_group and role_id required' }, 400, requestCorsHeaders);
    }
    const role = await env.DB.prepare('SELECT id FROM roles WHERE id = ? AND enabled = 1').bind(roleId).first<{ id?: string }>();
    if (!role?.id) {
      return jsonResponse({ error: `Unknown role: ${roleId}` }, 400, requestCorsHeaders);
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO access_group_role_mappings (id, access_group, role_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), group, roleId, now, now).run();
    await writeAuditLog(env, auth, 'rbac.mapping.created', 'mapping', group, { role_id: roleId }).catch(() => undefined);
    return jsonResponse({ access_group: group, role_id: roleId }, 201, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

export async function handleAudit(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/audit') {
    assertPermission(auth, 'audit.read');
    const url = new URL(request.url);
    const limit = clampLimit(Number(url.searchParams.get('limit') || 200), 500);
    const rows = await env.DB.prepare(
      `SELECT id, actor_principal, actor_email, action, target_type, target_id, metadata_json, created_at
       FROM audit_log
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(limit).all<AuditLogRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
