const BASIC_ROUTES = ['/login', '/checkout', '/search', '/profile', '/api/orders', '/api/alerts'];
const REALISTIC_ROUTES = [
  '/login',
  '/checkout',
  '/search',
  '/profile',
  '/api/orders',
  '/api/alerts',
  '/api/auth/refresh',
  '/api/payments/authorize',
  '/api/webhooks/stripe',
  '/api/inventory/reserve',
  '/api/session/validate',
  '/api/reports/daily'
];
const COMPONENTS = ['api', 'auth', 'worker', 'queue', 'cache', 'db', 'scheduler', 'webhook'];
const TENANTS = ['acme', 'northwind', 'globex', 'initech', 'umbrella'];

const ERROR_MESSAGES = [
  'database timeout while processing request',
  'upstream connection refused',
  'token validation failed',
  'rate limiter saturated',
  'cache backend unavailable',
  'dead letter queue threshold exceeded'
];
const WARN_MESSAGES = [
  'slow query detected',
  'retrying upstream request',
  'cache miss on hot key',
  'latency above warning threshold',
  'worker queue delay increased'
];
const INFO_MESSAGES = [
  'request completed',
  'user action processed',
  'background job executed',
  'health probe ok',
  'checkpoint persisted'
];

const PROFILES = new Set(['basic', 'realistic']);

export function parseBoolean(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function parseProfile(value, fallback = 'basic') {
  const normalized = String(value || '').trim().toLowerCase();
  if (PROFILES.has(normalized)) return normalized;
  return fallback;
}

export function parseBatchSize(value, fallback = 24, max = 120) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function pick(values, seed) {
  return values[Math.abs(seed) % values.length];
}

function pickMessage(level, seed) {
  if (level === 'error') return pick(ERROR_MESSAGES, seed);
  if (level === 'warn') return pick(WARN_MESSAGES, seed);
  return pick(INFO_MESSAGES, seed);
}

function levelForIndex(index, profile, incidentWave, position = 0) {
  if (profile === 'basic') {
    if (index % 17 === 0) return 'error';
    if (index % 5 === 0) return 'warn';
    return 'info';
  }

  const score = Math.abs((index + (position * 31)) % 100);
  if (incidentWave) {
    if (score < 18) return 'error';
    if (score < 45) return 'warn';
    return 'info';
  }
  if (score < 5) return 'error';
  if (score < 25) return 'warn';
  return 'info';
}

function statusForLevel(level, seed, profile) {
  if (profile === 'basic') {
    if (level === 'error') return [500, 502, 503, 504][seed % 4];
    if (level === 'warn') return [408, 429][seed % 2];
    return [200, 201, 204][seed % 3];
  }

  if (level === 'error') return pick([500, 502, 503, 504, 521, 522], seed);
  if (level === 'warn') return pick([408, 409, 425, 429], seed);
  return pick([200, 201, 202, 204, 206], seed);
}

function routeForIndex(index, profile) {
  return pick(profile === 'realistic' ? REALISTIC_ROUTES : BASIC_ROUTES, index);
}

function buildEventMessage(level, route, component, seed, sequence, incidentWave) {
  const base = pickMessage(level, seed);
  const incidentSuffix = incidentWave ? ' incident_wave=true' : '';
  return `synthetic ${level} component=${component} route=${route} seq=${sequence} ${base}${incidentSuffix}`;
}

function serviceForIndex(index, profile, baseService) {
  if (profile !== 'realistic') return baseService;
  return pick([baseService, `${baseService}-auth`, `${baseService}-api`, `${baseService}-worker`], index);
}

function envForIndex(index, profile, baseEnv) {
  if (profile !== 'realistic') return baseEnv;
  return pick([baseEnv, 'staging'], index + 11);
}

function hostForIndex(index, hostPrefix, profile) {
  const hostCount = profile === 'realistic' ? 12 : 6;
  return `${hostPrefix}-${(Math.abs(index) % hostCount) + 1}`;
}

function ipForIndex(index) {
  const a = 10;
  const b = 20 + (index % 12);
  const c = 1 + (index % 48);
  const d = 1 + (index % 220);
  return `${a}.${b}.${c}.${d}`;
}

function durationForEvent(level, route, sequence, profile, incidentWave) {
  const routeBias = route.includes('/api') ? 120 : 45;
  const waveBias = incidentWave ? 350 : 0;
  if (profile === 'basic') {
    if (level === 'error') return 1500 + (sequence % 2200);
    if (level === 'warn') return 450 + (sequence % 950);
    return 40 + (sequence % 320);
  }
  if (level === 'error') return 900 + routeBias + waveBias + (sequence % 3000);
  if (level === 'warn') return 250 + routeBias + Math.trunc(waveBias / 2) + (sequence % 1400);
  return 20 + routeBias + (sequence % 480);
}

function releaseForNow(nowMs) {
  const hourBucket = Math.floor(nowMs / (1000 * 60 * 60)) % 24;
  return `2026.02.${String(hourBucket + 1).padStart(2, '0')}`;
}

function incidentWaveForNow(nowMs, profile) {
  if (profile !== 'realistic') return false;
  const minuteBucket = Math.floor(nowMs / (1000 * 60));
  return minuteBucket % 30 < 5;
}

export function buildSyntheticEvents(options = {}) {
  const nowMs = Number(options.now_ms || Date.now());
  const batchSize = parseBatchSize(options.batch_size, 24, 120);
  const profile = parseProfile(options.profile, 'basic');
  const service = String(options.service || 'edgedata-demo').trim() || 'edgedata-demo';
  const index = String(options.index || 'default').trim().toLowerCase() || 'default';
  const env = String(options.env || 'demo').trim() || 'demo';
  const hostPrefix = String(options.host_prefix || 'edgedata-cron').trim() || 'edgedata-cron';
  const region = String(options.region || 'global').trim() || 'global';
  const incidentWave = incidentWaveForNow(nowMs, profile);
  const release = releaseForNow(nowMs);

  const events = [];
  for (let i = 0; i < batchSize; i++) {
    const sequence = (nowMs % 1_000_000) + i;
    const eventTsMs = nowMs - ((batchSize - i) * 15 * 1000);
    const level = levelForIndex(sequence, profile, incidentWave, i);
    const route = routeForIndex(sequence, profile);
    const component = pick(COMPONENTS, sequence + 7);
    const status = statusForLevel(level, sequence, profile);
    const durationMs = durationForEvent(level, route, sequence, profile, incidentWave);
    const eventService = serviceForIndex(sequence, profile, service);
    const eventEnv = envForIndex(sequence, profile, env);
    const tenant = pick(TENANTS, sequence + 17);
    const userSuffix = (sequence % 350) + 1000;

    events.push({
      ts: new Date(eventTsMs).toISOString(),
      index,
      service: eventService,
      env: eventEnv,
      host: hostForIndex(sequence, hostPrefix, profile),
      level,
      message: buildEventMessage(level, route, component, sequence, sequence, incidentWave),
      status,
      duration_ms: durationMs,
      request_id: `syn-req-${sequence.toString(36)}`,
      trace_id: `syn-trace-${(sequence * 13).toString(36)}`,
      src_ip: ipForIndex(sequence),
      user_id: `user-${userSuffix}`,
      attrs: {
        synthetic: true,
        source: 'synthetic-worker',
        synthetic_profile: profile,
        incident_wave: incidentWave,
        route,
        region,
        tenant,
        component,
        release
      }
    });
  }
  return events;
}
