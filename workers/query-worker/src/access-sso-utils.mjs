import { originMatchesPattern } from './cors-utils.mjs';

function normalizeAllowedOrigins(allowedOrigins) {
  return Array.isArray(allowedOrigins)
    ? allowedOrigins.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function toAllowedUrl(candidate, requestOrigin, allowedOrigins) {
  const raw = String(candidate || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw, requestOrigin);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  if (url.origin === requestOrigin) {
    return url.toString();
  }

  if (allowedOrigins.some((pattern) => originMatchesPattern(url.origin, pattern))) {
    return url.toString();
  }

  return null;
}

export function resolveAccessStartReturnTo({
  requestUrl,
  requestedReturnTo,
  allowedOrigins,
  originHeader,
  refererHeader
}) {
  const requestOrigin = new URL(requestUrl).origin;
  const normalizedAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);

  return toAllowedUrl(requestedReturnTo, requestOrigin, normalizedAllowedOrigins)
    || toAllowedUrl(originHeader, requestOrigin, normalizedAllowedOrigins)
    || toAllowedUrl(refererHeader, requestOrigin, normalizedAllowedOrigins)
    || requestOrigin;
}
