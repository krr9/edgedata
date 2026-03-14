/**
 * Pure auth/scope utilities for unit testing. Used by auth.ts and rbac-core.mjs.
 */

const DEFAULT_SCOPE = { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] };

export function parseJsonArray(input, fallback = []) {
  if (!input) return [...fallback];
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [...fallback];
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return [...fallback];
  }
}

export function parsePermissionsInput(input, fallback = []) {
  if (typeof input === 'string' || input === undefined) {
    return parseJsonArray(input, fallback);
  }
  if (Array.isArray(input)) {
    return input.map((item) => String(item)).filter(Boolean);
  }
  return [...fallback];
}

export function parseScope(input) {
  if (!input) return { ...DEFAULT_SCOPE };
  try {
    const parsed = JSON.parse(input);
    return {
      indexes: Array.isArray(parsed.indexes) && parsed.indexes.length > 0 ? parsed.indexes.map(String) : ['*'],
      services: Array.isArray(parsed.services) && parsed.services.length > 0 ? parsed.services.map(String) : ['*'],
      envs: Array.isArray(parsed.envs) && parsed.envs.length > 0 ? parsed.envs.map(String) : ['*'],
      hosts: Array.isArray(parsed.hosts) && parsed.hosts.length > 0 ? parsed.hosts.map(String) : ['*']
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
      indexes: Array.isArray(scope.indexes) && scope.indexes.length > 0 ? scope.indexes.map(String) : ['*'],
      services: Array.isArray(scope.services) && scope.services.length > 0 ? scope.services.map(String) : ['*'],
      envs: Array.isArray(scope.envs) && scope.envs.length > 0 ? scope.envs.map(String) : ['*'],
      hosts: Array.isArray(scope.hosts) && scope.hosts.length > 0 ? scope.hosts.map(String) : ['*']
    };
  }
  return { ...DEFAULT_SCOPE };
}

export function normalizeScope(scope) {
  return {
    indexes: scope.indexes.length > 0 ? scope.indexes : ['*'],
    services: scope.services.length > 0 ? scope.services : ['*'],
    envs: scope.envs.length > 0 ? scope.envs : ['*'],
    hosts: scope.hosts.length > 0 ? scope.hosts : ['*']
  };
}

export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesScopedValue(value, patterns) {
  if (patterns.length === 0 || patterns.includes('*')) return true;
  if (!value) return false;
  for (const pattern of patterns) {
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
  return role.trim().toLowerCase();
}
