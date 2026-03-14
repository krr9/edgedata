/**
 * Pure auth/scope utilities for unit testing. Used by auth.ts and rbac-core.mjs.
 */

const DEFAULT_SCOPE = { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] };

function normalizeStringArray(input, fallback = []) {
  if (!Array.isArray(input)) return [...fallback];

  const normalized = [];
  const seen = new Set();
  for (const item of input) {
    const value = String(item ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized.length > 0 ? normalized : [...fallback];
}

export function parseJsonArray(input, fallback = []) {
  if (!input) return [...fallback];
  try {
    const parsed = JSON.parse(input);
    return normalizeStringArray(parsed, fallback);
  } catch {
    return [...fallback];
  }
}

export function parsePermissionsInput(input, fallback = []) {
  if (typeof input === 'string' || input === undefined) {
    return parseJsonArray(input, fallback);
  }
  if (Array.isArray(input)) {
    return normalizeStringArray(input, fallback);
  }
  return [...fallback];
}

export function parseScope(input) {
  if (!input) return { ...DEFAULT_SCOPE };
  try {
    const parsed = JSON.parse(input);
    return {
      indexes: normalizeStringArray(parsed.indexes, ['*']),
      services: normalizeStringArray(parsed.services, ['*']),
      envs: normalizeStringArray(parsed.envs, ['*']),
      hosts: normalizeStringArray(parsed.hosts, ['*'])
    };
  } catch {
    return { ...DEFAULT_SCOPE };
  }
}

export function parseScopeInput(input) {
  if (typeof input === 'string' || input === undefined) {
    return parseScope(input);
  }
  if (input && typeof input === 'object') {
    const scope = input;
    return {
      indexes: normalizeStringArray(scope.indexes, ['*']),
      services: normalizeStringArray(scope.services, ['*']),
      envs: normalizeStringArray(scope.envs, ['*']),
      hosts: normalizeStringArray(scope.hosts, ['*'])
    };
  }
  return { ...DEFAULT_SCOPE };
}

export function normalizeScope(scope) {
  return {
    indexes: normalizeStringArray(scope?.indexes, ['*']),
    services: normalizeStringArray(scope?.services, ['*']),
    envs: normalizeStringArray(scope?.envs, ['*']),
    hosts: normalizeStringArray(scope?.hosts, ['*'])
  };
}

export function globToRegExp(glob) {
  const escaped = String(glob || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesScopedValue(value, patterns) {
  if (patterns.length === 0 || patterns.includes('*')) return true;
  if (!value) return false;
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) continue;
    if (pattern === '*') return true;
    if (!pattern.includes('*') && pattern.toLowerCase() === value.toLowerCase()) return true;
    if (pattern.includes('*') && globToRegExp(pattern).test(value)) return true;
  }
  return false;
}

export function mergeScope(scopes) {
  if (scopes.length === 0) return { ...DEFAULT_SCOPE };
  const mergeDimension = (extractor) => {
    const union = new Set();
    for (const scope of scopes) {
      const values = extractor(scope);
      if (values.includes('*')) return ['*'];
      for (const value of values) union.add(value);
    }
    return union.size > 0 ? Array.from(union) : ['*'];
  };
  return {
    indexes: mergeDimension((scope) => scope.indexes),
    services: mergeDimension((scope) => scope.services),
    envs: mergeDimension((scope) => scope.envs),
    hosts: mergeDimension((scope) => scope.hosts)
  };
}

export function highestRole(roleIds) {
  if (roleIds.includes('superadmin')) return 'superadmin';
  if (roleIds.includes('admin')) return 'admin';
  if (roleIds.includes('analyst')) return 'analyst';
  return 'viewer';
}

export function ensureRoleId(role) {
  return String(role || '').trim().toLowerCase();
}
