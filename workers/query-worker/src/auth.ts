/**
 * Authentication and authorization utilities extracted from query-worker index.
 * Crypto primitives, session management, JWT/bearer auth, scope parsing, and RBAC resolution.
 */

import type {
  Env,
  AuthContext,
  UserRole,
  AuthMode,
  AccessJwtHeader,
  AccessJwtPayload,
  UserRow,
  DataScope,
  RoleRow,
  UserRoleAssignmentRow
} from './types.js';
import {
  PBKDF2_ITERATIONS,
  SESSION_TTL_SECONDS,
  DEFAULT_SCOPE,
  DEFAULT_INVITE_TTL_HOURS,
  ROLE_PERMISSION_DEFAULTS
} from './types.js';
import { timingSafeTokenCompare } from '../../shared/timing-safe.mjs';
import { validateQueryAccessJwtConfig } from '../../shared/access-config.mjs';
import { mergePermissionsWithDefaults } from './rbac-core.mjs';
import {
  parseJsonArray,
  parsePermissionsInput,
  parseScope,
  parseScopeInput,
  normalizeScope,
  globToRegExp,
  matchesScopedValue,
  mergeScope,
  highestRole,
  ensureRoleId
} from './auth-core.mjs';

export { parseJsonArray, parsePermissionsInput, parseScope, parseScopeInput, normalizeScope, globToRegExp, matchesScopedValue, mergeScope, highestRole, ensureRoleId };

let jwksCache: { expiresAt: number; keysByKid: Map<string, JsonWebKey> } | null = null;
let rbacInitPromise: Promise<void> | null = null;

// --- Scope parsing ---

export function parseCsvSet(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function asInviteTtlHours(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INVITE_TTL_HOURS;
  return Math.min(7 * 24, Math.max(1, Math.trunc(n)));
}

// --- Crypto primitives ---

export function bytesToHex(input: Uint8Array): string {
  return Array.from(input).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex input');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, (i * 2) + 2), 16);
  }
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (const byte of bytes) chars.push(String.fromCharCode(byte));
  return btoa(chars.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function asSessionTtlSeconds(value: string | undefined): number {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return SESSION_TTL_SECONDS;
  return Math.min(7 * 24 * 60 * 60, Math.max(300, Math.trunc(ttl)));
}

export async function pbkdf2Hash(password: string, saltHex: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: hexToBytes(saltHex),
      iterations
    },
    key,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(salt);
  const hashHex = await pbkdf2Hash(password, saltHex, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, rawIterations, saltHex, expectedHash] = stored.split('$');
  if (algo !== 'pbkdf2_sha256' || !rawIterations || !saltHex || !expectedHash) return false;
  const iterations = Number(rawIterations);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const computed = await pbkdf2Hash(password, saltHex, Math.trunc(iterations));
  return timingSafeEqual(computed, expectedHash);
}

export async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

// --- JWT helpers ---

export function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function decodeJwtPart<T>(segment: string): T {
  try {
    const bytes = base64UrlToBytes(segment);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error('Invalid Access JWT');
  }
}

export function normalizedIssuer(input: string | undefined): string | null {
  if (!input) return null;
  return input.replace(/\/+$/, '');
}

export function resolveJwksUrl(env: Env): string | null {
  if (env.ACCESS_JWKS_URL) return env.ACCESS_JWKS_URL.trim();
  const issuer = normalizedIssuer(env.ACCESS_ISSUER);
  if (!issuer) return null;
  return `${issuer}/cdn-cgi/access/certs`;
}

export async function getJwksKeysByKid(env: Env): Promise<Map<string, JsonWebKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) {
    return jwksCache.keysByKid;
  }

  const url = resolveJwksUrl(env);
  if (!url) {
    throw new Error('Access JWT verification misconfigured: ACCESS_JWKS_URL or ACCESS_ISSUER required');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Access JWKS: ${response.status}`);
  }

  const body = (await response.json()) as { keys?: JsonWebKey[] };
  const keys = body.keys || [];
  const keysByKid = new Map<string, JsonWebKey>();
  for (const key of keys) {
    if (key.kid) keysByKid.set(key.kid, key);
  }

  jwksCache = {
    expiresAt: now + 5 * 60 * 1000,
    keysByKid
  };

  return keysByKid;
}

// --- RBAC initialization ---

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
         VALUES (?, ?, 1, 1, ?, ?, ?, ?)`
      )
        .bind(
          roleId,
          roleId,
          JSON.stringify(ROLE_PERMISSION_DEFAULTS[roleId] || []),
          JSON.stringify(DEFAULT_SCOPE),
          now,
          now
        )
        .run();
    }

    const existingRoles = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles
       WHERE id IN (${roleIds.map(() => '?').join(', ')})`
    )
      .bind(...roleIds)
      .all<RoleRow>();

    for (const role of existingRoles.results || []) {
      if (role.system_role !== 1) continue;
      const currentPermissions = parseJsonArray(role.permissions_json, []);
      const mergedPermissions = mergePermissionsWithDefaults(
        currentPermissions,
        ROLE_PERMISSION_DEFAULTS[role.id] || []
      );
      if (mergedPermissions.length === currentPermissions.length) continue;
      await env.DB.prepare(
        'UPDATE roles SET permissions_json = ?, updated_at = ? WHERE id = ?'
      )
        .bind(JSON.stringify(mergedPermissions), now, role.id)
        .run();
    }

    const seedGroupMappings = async (csv: string | undefined, roleId: string) => {
      const groups = Array.from(parseCsvSet(csv));
      for (const group of groups) {
        const existing = await env.DB.prepare(
          'SELECT id FROM access_group_role_mappings WHERE access_group = ? AND role_id = ? LIMIT 1'
        )
          .bind(group, roleId)
          .first<{ id?: string }>();
        if (existing?.id) continue;
        await env.DB.prepare(
          'INSERT INTO access_group_role_mappings (id, access_group, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
          .bind(crypto.randomUUID(), group, roleId, now, now)
          .run();
      }
    };
    await seedGroupMappings(env.ACCESS_SUPERADMIN_GROUPS, 'superadmin');
    await seedGroupMappings(env.ACCESS_ADMIN_GROUPS, 'admin');
    await seedGroupMappings(env.ACCESS_ANALYST_GROUPS, 'analyst');
    await seedGroupMappings(env.ACCESS_VIEWER_GROUPS, 'viewer');

    const usersCountRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count?: number }>();
    const usersCount = Number(usersCountRow?.count || 0);
    if (usersCount === 0) {
      const bootstrapEmail = (env.AUTH_BOOTSTRAP_SUPERADMIN_EMAIL || env.AUTH_BOOTSTRAP_EMAIL || '')
        .trim()
        .toLowerCase();
      if (bootstrapEmail) {
        const bootstrapPassword = env.AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD || env.AUTH_BOOTSTRAP_PASSWORD || '';
        const passwordHash = bootstrapPassword ? await hashPassword(bootstrapPassword) : '!access-sso-only!';
        const userId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
           VALUES (?, ?, ?, 'superadmin', 1, ?, ?)`
        )
          .bind(userId, bootstrapEmail, passwordHash, now, now)
          .run();

        await env.DB.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
           VALUES (?, 'superadmin', 'bootstrap', ?)`
        )
          .bind(userId, now)
          .run();
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
      )
        .bind(user.id, fallback, now)
        .run();
    }
  })();

  try {
    await rbacInitPromise;
  } catch (error) {
    rbacInitPromise = null;
    throw error;
  }
}

// --- Role resolution ---

export function roleDefinitionFromRow(row: RoleRow): { id: string; permissions: string[]; scope: DataScope } {
  return {
    id: row.id,
    permissions: parseJsonArray(row.permissions_json, ROLE_PERMISSION_DEFAULTS[row.id] || []),
    scope: normalizeScope(parseScope(row.scope_json))
  };
}

export async function resolveAuthFromRoleIds(
  env: Env,
  principal: string,
  email: string | undefined,
  groups: string[],
  roleIds: string[],
  authMode: AuthMode
): Promise<AuthContext> {
  const normalizedRoleIds = Array.from(new Set(roleIds.map(ensureRoleId))).filter(Boolean);
  if (normalizedRoleIds.length === 0) {
    throw new Error('Access denied');
  }

  const placeholders = normalizedRoleIds.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
     FROM roles
     WHERE id IN (${placeholders}) AND enabled = 1`
  )
    .bind(...normalizedRoleIds)
    .all<RoleRow>();

  const resolved = (rows.results || []).map(roleDefinitionFromRow);
  if (resolved.length === 0) {
    throw new Error('Access denied');
  }

  const permissions = new Set<string>();
  const scopes: DataScope[] = [];
  for (const role of resolved) {
    for (const permission of role.permissions) permissions.add(permission);
    scopes.push(role.scope);
  }

  const effectiveRoleIds = resolved.map((role) => role.id);
  return {
    principal,
    email,
    role: highestRole(effectiveRoleIds),
    roleIds: effectiveRoleIds,
    permissions,
    scope: mergeScope(scopes),
    authMode,
    groups
  };
}

// --- Session management ---

export async function createSessionToken(
  auth: AuthContext,
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret) {
    throw new Error('Auth session secret is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = asSessionTtlSeconds(env.SESSION_TTL_SECONDS);
  const payload = {
    sub: auth.principal,
    email: auth.email || '',
    mode: 'session',
    iat: now,
    exp: now + ttl
  };
  const payloadSegment = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(payloadSegment, secret);
  return {
    token: `${payloadSegment}.${signature}`,
    expiresAt: new Date((now + ttl) * 1000).toISOString()
  };
}

export async function issueSessionTokenForBrowserAuth(
  auth: AuthContext,
  request: Request,
  env: Env
): Promise<{ token: string; expiresAt: string } | null> {
  const authHeader = request.headers.get('authorization') || '';
  if (auth.authMode !== 'access_sso' || authHeader.startsWith('Bearer ')) {
    return null;
  }
  if (!env.AUTH_SESSION_SECRET) {
    return null;
  }
  return createSessionToken(auth, env);
}

export async function verifySessionToken(token: string, env: Env): Promise<AuthContext | null> {
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadSegment, signatureSegment] = parts;
  if (!payloadSegment || !signatureSegment) return null;

  const expected = await hmacSign(payloadSegment, secret);
  if (!timingSafeEqual(expected, signatureSegment)) return null;

  let payload: { sub?: string; email?: string; exp?: number };
  try {
    payload = decodeJwtPart<{ sub?: string; email?: string; exp?: number }>(payloadSegment);
  } catch {
    return null;
  }

  if (!payload.sub) return null;
  if (!payload.exp || !Number.isFinite(payload.exp)) return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;

  await ensureRbacInitialized(env);
  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
     FROM users
     WHERE id = ?`
  )
    .bind(payload.sub)
    .first<UserRow>();
  if (!user || user.enabled !== 1) return null;
  const roleIds = await resolveRoleIdsForUser(env, user, []);
  if (roleIds.length === 0) return null;

  try {
    return await resolveAuthFromRoleIds(env, user.id, user.email || payload.email || undefined, [], roleIds, 'local_password');
  } catch {
    return null;
  }
}

export async function authenticateCredentials(
  email: string,
  password: string,
  env: Env
): Promise<UserRow | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) return null;
  await ensureRbacInitialized(env);

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
     FROM users
     WHERE email = ?`
  )
    .bind(normalizedEmail)
    .first<UserRow>();

  if (!user || user.enabled !== 1) return null;
  if (!user.password_hash || user.password_hash === '!access-sso-only!') return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;

  return user;
}

// --- JWT verification ---

export async function verifyAccessJwt(jwt: string, env: Env): Promise<AccessJwtPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Access JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart<AccessJwtHeader>(encodedHeader);
  const payload = decodeJwtPart<AccessJwtPayload>(encodedPayload);

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported Access JWT algorithm: ${header.alg || 'unknown'}`);
  }
  if (!header.kid) {
    throw new Error('Missing Access JWT kid');
  }

  const keysByKid = await getJwksKeysByKid(env);
  const jwk = keysByKid.get(header.kid);
  if (!jwk) {
    jwksCache = null;
    throw new Error('Unknown Access JWT key id');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlToBytes(encodedSignature);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signed);
  if (!ok) {
    throw new Error('Invalid Access JWT signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && now >= payload.exp) {
    throw new Error('Access JWT expired');
  }
  if (payload.nbf !== undefined && now < payload.nbf) {
    throw new Error('Access JWT not yet valid');
  }

  const expectedIssuer = normalizedIssuer(env.ACCESS_ISSUER);
  if (expectedIssuer) {
    const tokenIssuer = normalizedIssuer(payload.iss);
    if (!tokenIssuer || tokenIssuer !== expectedIssuer) {
      throw new Error('Invalid Access JWT issuer');
    }
  }

  if (env.ACCESS_AUD) {
    const aud = payload.aud;
    const okAud = Array.isArray(aud) ? aud.includes(env.ACCESS_AUD) : aud === env.ACCESS_AUD;
    if (!okAud) {
      throw new Error('Invalid Access JWT audience');
    }
  }

  return payload;
}

// --- Bearer token auth ---

export async function authenticateWithBearerToken(
  request: Request,
  env: Env
): Promise<AuthContext | null> {
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  if (env.QUERY_ADMIN_TOKEN && timingSafeTokenCompare(token, env.QUERY_ADMIN_TOKEN)) {
    return resolveAuthFromRoleIds(env, 'token:admin', undefined, [], ['admin'], 'local_password');
  }
  if (env.QUERY_ANALYST_TOKEN && timingSafeTokenCompare(token, env.QUERY_ANALYST_TOKEN)) {
    return resolveAuthFromRoleIds(env, 'token:analyst', undefined, [], ['analyst'], 'local_password');
  }
  if (env.QUERY_VIEWER_TOKEN && timingSafeTokenCompare(token, env.QUERY_VIEWER_TOKEN)) {
    return resolveAuthFromRoleIds(env, 'token:viewer', undefined, [], ['viewer'], 'local_password');
  }

  const sessionAuth = await verifySessionToken(token, env);
  if (sessionAuth) return sessionAuth;

  return null;
}

export function hasConfiguredQueryBearerTokens(env: Env): boolean {
  return Boolean(env.QUERY_VIEWER_TOKEN || env.QUERY_ANALYST_TOKEN || env.QUERY_ADMIN_TOKEN);
}

export function assertAccessJwtRuntimeConfig(env: Env): void {
  const errors = validateQueryAccessJwtConfig(env as unknown as Record<string, string | undefined>);
  if (errors.length === 0) return;
  throw new Error(`Access JWT configuration misconfigured: ${errors.join('; ')}`);
}

export function localLoginEnabled(env: Env): boolean {
  const raw = (env.AUTH_ENABLE_LOCAL_LOGIN || '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return Boolean(env.AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD || env.AUTH_BOOTSTRAP_PASSWORD);
}

export async function resolveRoleIdsForUser(
  env: Env,
  user: UserRow,
  jwtGroups: string[]
): Promise<string[]> {
  const roleIds = new Set<string>();

  const directRoles = await env.DB.prepare(
    `SELECT role_id
     FROM user_roles
     WHERE user_id = ?`
  )
    .bind(user.id)
    .all<UserRoleAssignmentRow>();
  for (const row of directRoles.results || []) {
    roleIds.add(row.role_id);
  }

  if (jwtGroups.length > 0) {
    const placeholders = jwtGroups.map(() => '?').join(', ');
    const mapped = await env.DB.prepare(
      `SELECT role_id
       FROM access_group_role_mappings
       WHERE access_group IN (${placeholders})`
    )
      .bind(...jwtGroups)
      .all<{ role_id: string }>();
    for (const row of mapped.results || []) {
      roleIds.add(row.role_id);
    }
  }

  const email = String(user.email || '').toLowerCase();
  const adminEmails = parseCsvSet(env.ACCESS_ADMIN_EMAILS);
  if (email && adminEmails.has(email)) {
    roleIds.add('superadmin');
  }

  if (roleIds.size === 0 && user.role) {
    const legacyRole = ensureRoleId(String(user.role));
    roleIds.add(ROLE_PERMISSION_DEFAULTS[legacyRole] ? legacyRole : 'viewer');
  }

  return Array.from(roleIds);
}

// --- Main auth entry point ---

export async function authenticateRequest(request: Request, env: Env): Promise<AuthContext> {
  assertAccessJwtRuntimeConfig(env);
  await ensureRbacInitialized(env);

  const tokenAuth = await authenticateWithBearerToken(request, env);
  if (tokenAuth) {
    return tokenAuth;
  }

  const requireJwt = (env.REQUIRE_ACCESS_JWT || '').toLowerCase() === 'true';
  if (requireJwt) {
    const jwt = request.headers.get('CF-Access-Jwt-Assertion');
    if (!jwt) {
      throw new Error('Missing Access JWT');
    }

    const payload = await verifyAccessJwt(jwt, env);
    const emailHeader = request.headers.get('CF-Access-Authenticated-User-Email') || undefined;
    const email = String(payload.email || emailHeader || '').toLowerCase() || undefined;
    const groups = Array.isArray(payload.groups) ? payload.groups.map((item) => String(item)) : [];
    if (!email) {
      throw new Error('Access JWT missing email');
    }

    let user = await env.DB.prepare(
      `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
       FROM users
       WHERE email = ?`
    )
      .bind(email)
      .first<UserRow>();

    if (!user) {
      const adminEmails = parseCsvSet(env.ACCESS_ADMIN_EMAILS);
      if (!adminEmails.has(email)) {
        throw new Error('User is not invited');
      }
      const now = new Date().toISOString();
      const userId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
         VALUES (?, ?, '!access-sso-only!', 'superadmin', 1, ?, ?)`
      )
        .bind(userId, email, now, now)
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
         VALUES (?, 'superadmin', 'auto-admin-email', ?)`
      )
        .bind(userId, now)
        .run();

      user = await env.DB.prepare(
        `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
         FROM users
         WHERE id = ?`
      )
        .bind(userId)
        .first<UserRow>();
    }
    if (!user || user.enabled !== 1) {
      throw new Error('Access denied');
    }

    const roleIds = await resolveRoleIdsForUser(env, user, groups);
    const auth = await resolveAuthFromRoleIds(env, user.id, email, groups, roleIds, 'access_sso');
    await env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), new Date().toISOString(), user.id)
      .run();

    return auth;
  }

  if (hasConfiguredQueryBearerTokens(env)) {
    throw new Error('Unauthorized');
  }

  return resolveAuthFromRoleIds(env, 'dev-admin', 'dev-admin@local', [], ['superadmin'], 'local_password');
}
