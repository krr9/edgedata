const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function normalizeString(value) {
  return String(value || '').trim();
}

export function isAccessJwtRequired(value) {
  return TRUTHY.has(normalizeString(value).toLowerCase());
}

export function parseCsvSet(value) {
  const set = new Set();
  const raw = normalizeString(value);
  if (!raw) return set;

  for (const item of raw.split(',')) {
    const normalized = item.trim().toLowerCase();
    if (normalized) set.add(normalized);
  }
  return set;
}

function hasAnyConfiguredGroups(env, keys) {
  return keys.some((key) => parseCsvSet(env[key]).size > 0);
}

function missingMessage(name) {
  return `${name} must be configured when REQUIRE_ACCESS_JWT=true`;
}

export function validateQueryAccessJwtConfig(env) {
  if (!isAccessJwtRequired(env.REQUIRE_ACCESS_JWT)) return [];

  const errors = [];

  if (!normalizeString(env.ACCESS_ISSUER)) {
    errors.push(missingMessage('ACCESS_ISSUER'));
  }
  if (!normalizeString(env.ACCESS_AUD)) {
    errors.push(missingMessage('ACCESS_AUD'));
  }

  const roleGroupKeys = [
    'ACCESS_SUPERADMIN_GROUPS',
    'ACCESS_ADMIN_GROUPS',
    'ACCESS_ANALYST_GROUPS',
    'ACCESS_VIEWER_GROUPS'
  ];
  if (!hasAnyConfiguredGroups(env, roleGroupKeys)) {
    errors.push('At least one ACCESS_*_GROUPS mapping is required when REQUIRE_ACCESS_JWT=true');
  }

  return errors;
}

export function validateAlertAccessJwtConfig(env) {
  if (!isAccessJwtRequired(env.REQUIRE_ACCESS_JWT)) return [];

  const errors = [];

  if (!normalizeString(env.ACCESS_ISSUER)) {
    errors.push(missingMessage('ACCESS_ISSUER'));
  }
  if (!normalizeString(env.ACCESS_AUD)) {
    errors.push(missingMessage('ACCESS_AUD'));
  }
  if (parseCsvSet(env.ACCESS_ADMIN_GROUPS).size === 0) {
    errors.push('ACCESS_ADMIN_GROUPS must be configured when REQUIRE_ACCESS_JWT=true');
  }

  return errors;
}

