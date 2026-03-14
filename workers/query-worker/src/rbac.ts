/**
 * RBAC initialization, permissions, ops metrics, and user role management.
 * Extracted from query-worker index.
 */

import type {
  Env,
  AuthContext,
  UserRow,
  RoleRow,
  UserRoleAssignmentRow,
  AccessGroupRoleMappingRow,
  InvitationRow,
  OpsMetricRow,
  ListingStatsSnapshot,
  TimingStatsSnapshot
} from './types.js';
import {
  ROLE_PERMISSION_DEFAULTS,
  ALL_PERMISSIONS,
  DEFAULT_SCOPE,
  DEFAULT_INVITE_TTL_HOURS,
  PBKDF2_ITERATIONS
} from './types.js';
import {
  ensureRoleId,
  parsePermissionsInput,
  parseScopeInput,
  hashPassword,
  sha256Hex,
  asInviteTtlHours
} from './auth.js';
import {
  mergePermissionsWithDefaults,
  hasPermission,
  assertPermission,
  assertCanAssignRoles,
  PRIVILEGED_ROLES
} from './rbac-core.mjs';
import {
  validateQueryAccessJwtConfig,
  isAccessJwtRequired,
  parseCsvSet
} from '../../shared/access-config.mjs';

export type AuthMode = 'access_sso' | 'local_password';

let rbacInitPromise: Promise<void> | null = null;

function parseJsonArray(input: string | undefined, fallback: string[] = []): string[] {
  if (!input) return [...fallback];
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return [...fallback];
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return [...fallback];
  }
}

export async function ensureRbacInitialized(env: Env): Promise<void> {
  if (rbacInitPromise) {
    return rbacInitPromise;
  }

  rbacInitPromise = (async () => {
    const bootstrapStatements = [
      `CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        system_role INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        permissions_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        assigned_by TEXT,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      )`,
      `CREATE TABLE IF NOT EXISTS access_group_role_mappings (
        id TEXT PRIMARY KEY,
        access_group TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        role_ids_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor_principal TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_roles_enabled ON roles(enabled)',
      'CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_role_map_group ON access_group_role_mappings(access_group)',
      'CREATE INDEX IF NOT EXISTS idx_invites_email ON invitations(email)',
      'CREATE INDEX IF NOT EXISTS idx_invites_status ON invitations(status)',
      'CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC)'
    ];
    for (const statement of bootstrapStatements) {
      await env.DB.prepare(statement).run();
    }

    const now = new Date().toISOString();
    const roleIds = ['superadmin', 'admin', 'analyst', 'viewer'];
    for (const roleId of roleIds) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO roles (id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
      ).bind(
        roleId,
        roleId,
        JSON.stringify(ROLE_PERMISSION_DEFAULTS[roleId] || []),
        JSON.stringify(DEFAULT_SCOPE),
        now,
        now
      ).run();
    }

    const existingRoles = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles
       WHERE id IN (${roleIds.map(() => '?').join(', ')})`
    ).bind(...roleIds).all<RoleRow>();

    for (const role of existingRoles.results || []) {
      if (role.system_role !== 1) continue;
      const currentPermissions = parseJsonArray(role.permissions_json, []);
      const mergedPermissions = mergePermissionsWithDefaults(currentPermissions, ROLE_PERMISSION_DEFAULTS[role.id] || []);
      if (mergedPermissions.length === currentPermissions.length) continue;
      await env.DB.prepare(
        'UPDATE roles SET permissions_json = ?, updated_at = ? WHERE id = ?'
      ).bind(JSON.stringify(mergedPermissions), now, role.id).run();
    }

    const seedGroupMappings = async (csv: string | undefined, roleId: string) => {
      const groups = Array.from(parseCsvSet(csv));
      for (const group of groups) {
        const existing = await env.DB.prepare(
          'SELECT id FROM access_group_role_mappings WHERE access_group = ? AND role_id = ? LIMIT 1'
        ).bind(group, roleId).first<{ id?: string }>();
        if (existing?.id) continue;
        await env.DB.prepare(
          'INSERT INTO access_group_role_mappings (id, access_group, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), group, roleId, now, now).run();
      }
    };
    await seedGroupMappings(env.ACCESS_SUPERADMIN_GROUPS, 'superadmin');
    await seedGroupMappings(env.ACCESS_ADMIN_GROUPS, 'admin');
    await seedGroupMappings(env.ACCESS_ANALYST_GROUPS, 'analyst');
    await seedGroupMappings(env.ACCESS_VIEWER_GROUPS, 'viewer');

    const usersCountRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count?: number }>();
    const usersCount = Number(usersCountRow?.count || 0);
    if (usersCount === 0) {
      const bootstrapEmail = (env.AUTH_BOOTSTRAP_SUPERADMIN_EMAIL || env.AUTH_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
      if (bootstrapEmail) {
        const bootstrapPassword = env.AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD || env.AUTH_BOOTSTRAP_PASSWORD || '';
        const passwordHash = bootstrapPassword
          ? await hashPassword(bootstrapPassword)
          : '!access-sso-only!';
        const userId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
           VALUES (?, ?, ?, 'superadmin', 1, ?, ?)`
        ).bind(userId, bootstrapEmail, passwordHash, now, now).run();

        await env.DB.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
           VALUES (?, 'superadmin', 'bootstrap', ?)`
        ).bind(userId, now).run();
      }
    }

    const legacyUsers = await env.DB.prepare(
      `SELECT u.id, u.role
       FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`
    ).all<{ id: string; role?: string | null }>();

    for (const user of legacyUsers.results || []) {
      const roleId = ensureRoleId(String(user.role || 'viewer'));
      const fallback = ROLE_PERMISSION_DEFAULTS[roleId] ? roleId : 'viewer';
      await env.DB.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
         VALUES (?, ?, 'legacy', ?)`
      ).bind(user.id, fallback, now).run();
    }
  })();

  try {
    await rbacInitPromise;
  } catch (error) {
    rbacInitPromise = null;
    throw error;
  }
}

export async function writeAuditLog(
  env: Env,
  auth: AuthContext | null,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO audit_log (
      id, actor_principal, actor_email, action, target_type, target_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    auth?.principal || null,
    auth?.email || null,
    action,
    targetType || null,
    targetId || null,
    metadata ? JSON.stringify(metadata) : null,
    now
  ).run();
}

export { hasPermission, assertPermission, assertCanAssignRoles, PRIVILEGED_ROLES };

export async function assertNotLastSuperadmin(env: Env, userId: string): Promise<void> {
  const superadminCount = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     WHERE ur.role_id = 'superadmin' AND u.enabled = 1`
  ).first<{ cnt: number }>();
  if (!superadminCount || superadminCount.cnt <= 1) {
    const userHasSuperadmin = await env.DB.prepare(
      `SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = 'superadmin' LIMIT 1`
    ).bind(userId).first();
    if (userHasSuperadmin) {
      throw new Error('Cannot disable or demote the last superadmin');
    }
  }
}

export async function writeOpsMetric(
  env: Env,
  metric: string,
  value = 1,
  dimension = 'query-worker'
): Promise<void> {
  if (!env.OPS_WAE) return;
  const row: OpsMetricRow = {
    blobs: [metric, dimension],
    doubles: [value],
    timestamp: new Date()
  };
  await env.OPS_WAE.writeData([row]);
}

export async function writeScanMetrics(
  env: Env,
  namespace: 'search' | 'search_summary' | 'dashboard_widget',
  stats: ListingStatsSnapshot & {
    scanned_objects: number;
    scanned_partitions: number;
    timing_ms?: Partial<TimingStatsSnapshot>;
  }
): Promise<void> {
  const metricValue = (value: unknown): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  await Promise.allSettled([
    writeOpsMetric(env, `${namespace}_scanned_partitions`, metricValue(stats.scanned_partitions)),
    writeOpsMetric(env, `${namespace}_scanned_objects`, metricValue(stats.scanned_objects)),
    writeOpsMetric(env, `${namespace}_listed_prefixes`, metricValue(stats.listed_prefixes)),
    writeOpsMetric(env, `${namespace}_listing_calls`, metricValue(stats.listing_calls)),
    writeOpsMetric(env, `${namespace}_listed_objects`, metricValue(stats.listed_objects)),
    writeOpsMetric(env, `${namespace}_listing_fallbacks`, metricValue(stats.listing_fallbacks)),
    writeOpsMetric(env, `${namespace}_listing_ms`, metricValue(stats.timing_ms?.listing)),
    writeOpsMetric(env, `${namespace}_object_read_ms`, metricValue(stats.timing_ms?.object_read)),
    writeOpsMetric(env, `${namespace}_parse_filter_ms`, metricValue(stats.timing_ms?.parse_filter)),
    writeOpsMetric(env, `${namespace}_post_pipeline_ms`, metricValue(stats.timing_ms?.post_pipeline)),
    writeOpsMetric(env, `${namespace}_total_ms`, metricValue(stats.timing_ms?.total))
  ]);
}

export async function getUserRoleIds(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT role_id FROM user_roles WHERE user_id = ?'
  ).bind(userId).all<UserRoleAssignmentRow>();
  return (rows.results || []).map((row) => row.role_id);
}

export async function setUserRoles(env: Env, userId: string, roleIds: string[], actor: string): Promise<void> {
  const normalized = Array.from(new Set(roleIds.map(ensureRoleId))).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error('At least one role is required');
  }

  const placeholders = normalized.map(() => '?').join(', ');
  const existingRoles = await env.DB.prepare(
    `SELECT id FROM roles WHERE enabled = 1 AND id IN (${placeholders})`
  ).bind(...normalized).all<{ id: string }>();
  const existingIds = new Set((existingRoles.results || []).map((row) => row.id));
  for (const roleId of normalized) {
    if (!existingIds.has(roleId)) {
      throw new Error(`Unknown role: ${roleId}`);
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(userId).run();
  for (const roleId of normalized) {
    await env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?)`
    ).bind(userId, roleId, actor, now).run();
  }
}

export function parseInvitationRoleIds(roleIdsJson: string): string[] {
  return Array.from(new Set(parseJsonArray(roleIdsJson, []).map((roleId) => ensureRoleId(String(roleId))).filter(Boolean)));
}

export async function expirePendingInvitations(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE invitations
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < ?`
  ).bind(new Date().toISOString()).run();
}

export async function ensureInvitedUser(env: Env, email: string, authMode: AuthMode): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
     FROM users
     WHERE email = ?`
  ).bind(email).first<UserRow>();

  const now = new Date().toISOString();
  let userId = existing?.id || crypto.randomUUID();
  if (!existing) {
    const placeholderHash = authMode === 'local_password' ? '!invite-pending!' : '!access-sso-only!';
    const enabled = authMode === 'access_sso' ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'viewer', ?, ?, ?)`
    ).bind(userId, email, placeholderHash, enabled, now, now).run();
  } else if (authMode === 'access_sso' && existing.enabled !== 1) {
    await env.DB.prepare('UPDATE users SET enabled = 1, updated_at = ? WHERE id = ?').bind(now, existing.id).run();
    userId = existing.id;
  }

  return userId;
}

export async function createInvitation(
  env: Env,
  email: string,
  authMode: AuthMode,
  roleIds: string[],
  invitedBy: string
): Promise<{ invitationId: string; expiresAt: string; inviteToken: string }> {
  const inviteToken = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const tokenHash = await sha256Hex(inviteToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (asInviteTtlHours(env.AUTH_INVITE_TTL_HOURS) * 60 * 60 * 1000)).toISOString();
  const invitationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO invitations (
      id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
  ).bind(
    invitationId,
    email,
    authMode,
    tokenHash,
    JSON.stringify(roleIds.map(ensureRoleId)),
    expiresAt,
    invitedBy,
    now
  ).run();
  return { invitationId, expiresAt, inviteToken };
}
