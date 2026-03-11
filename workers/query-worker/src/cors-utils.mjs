function parseOriginUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function originMatchesPattern(origin, pattern) {
  const normalizedOrigin = String(origin || '').trim();
  const normalizedPattern = String(pattern || '').trim();
  if (!normalizedOrigin || !normalizedPattern) return false;

  if (normalizedPattern === normalizedOrigin) return true;

  const wildcard = normalizedPattern.match(/^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/i);
  if (!wildcard) return false;

  const [, expectedProtocol, domainSuffix, expectedPort] = wildcard;
  const originUrl = parseOriginUrl(normalizedOrigin);
  if (!originUrl) return false;
  if (originUrl.protocol !== `${expectedProtocol.toLowerCase()}:`) return false;
  if (expectedPort && originUrl.port !== expectedPort) return false;

  const host = originUrl.hostname.toLowerCase();
  const suffix = domainSuffix.toLowerCase();
  if (host === suffix) return false;
  return host.endsWith(`.${suffix}`);
}

export function resolveCorsOriginFromPatterns(origin, patterns) {
  const allowed = Array.isArray(patterns) ? patterns.map((item) => String(item).trim()).filter(Boolean) : [];
  if (allowed.length === 0) return '*';

  const requested = String(origin || '').trim();
  if (requested && allowed.some((pattern) => originMatchesPattern(requested, pattern))) {
    return requested;
  }

  return allowed[0];
}

export function allowsCredentialedCors(origin) {
  const normalized = String(origin || '').trim();
  return normalized.length > 0 && normalized !== '*';
}
