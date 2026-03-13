function clampPositiveInt(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.trunc(numeric), max);
}

function fnv1a32(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function normalizeQueryText(queryText) {
  return String(queryText || '').trim().replace(/\s+/g, ' ');
}

export function hashQueryText(queryText) {
  return fnv1a32(normalizeQueryText(queryText)).toString(16).padStart(8, '0');
}

export function buildScopeKey(scope) {
  const safe = scope || {};
  const indexes = Array.isArray(safe.indexes) && safe.indexes.length > 0 ? safe.indexes : ['*'];
  const services = Array.isArray(safe.services) && safe.services.length > 0 ? safe.services : ['*'];
  const envs = Array.isArray(safe.envs) && safe.envs.length > 0 ? safe.envs : ['*'];
  const hosts = Array.isArray(safe.hosts) && safe.hosts.length > 0 ? safe.hosts : ['*'];
  return [
    `i:${indexes.slice().sort().join(',')}`,
    `s:${services.slice().sort().join(',')}`,
    `e:${envs.slice().sort().join(',')}`,
    `h:${hosts.slice().sort().join(',')}`
  ].join('|');
}

export function buildMaterializationBucket(timeRange, cadenceSeconds = 300) {
  const fromMs = Date.parse(String(timeRange?.from || ''));
  const toMs = Date.parse(String(timeRange?.to || ''));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return {
      time_bucket_start: String(timeRange?.from || ''),
      time_bucket_end: String(timeRange?.to || ''),
      expires_at: String(timeRange?.to || '')
    };
  }

  const cadenceMs = clampPositiveInt(cadenceSeconds, 300, 86400) * 1000;
  const bucketEndMs = Math.floor(toMs / cadenceMs) * cadenceMs;
  const bucketStartMs = bucketEndMs - (toMs - fromMs);
  return {
    time_bucket_start: new Date(bucketStartMs).toISOString(),
    time_bucket_end: new Date(bucketEndMs).toISOString(),
    expires_at: new Date(bucketEndMs + cadenceMs).toISOString()
  };
}
