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
const OTEL_DEMO_ROUTES = [
  '/',
  '/cart',
  '/cart/checkout',
  '/product/OLJCESPC7Z',
  '/api/recommendations',
  '/api/currency/convert',
  '/api/checkout/place-order',
  '/api/payment/charge',
  '/grpc/recommendation.GetRecommendations',
  '/grpc/cart.GetCart',
  '/grpc/shipping.GetQuote'
];
const COMPONENTS = ['api', 'auth', 'worker', 'queue', 'cache', 'db', 'scheduler', 'webhook'];
const OTEL_DEMO_SERVICES = [
  'frontend',
  'checkoutservice',
  'paymentservice',
  'shippingservice',
  'currencyservice',
  'cartservice',
  'productcatalogservice',
  'recommendationservice',
  'adservice'
];
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

const PROFILES = new Set(['basic', 'realistic', 'otel', 'otel-demo', 'mixed']);

export function parseBoolean(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function parseProfile(value, fallback = 'basic') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!PROFILES.has(normalized)) return fallback;
  return normalized === 'otel' ? 'otel-demo' : normalized;
}

export function parseBatchSize(value, fallback = 24, max = 120) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function resolveRuntimeProfile(configuredProfile, nowMs, index = '', service = '') {
  const profile = parseProfile(configuredProfile, 'basic');
  if (profile !== 'mixed') return profile;
  const bucket = Math.floor(Number(nowMs || Date.now()) / (5 * 60 * 1000));
  const seed = hashText(`${bucket}:${String(index)}:${String(service)}:mixed`);
  return ['otel-demo', 'realistic', 'basic'][seed % 3];
}

function hashText(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexId(seed, length) {
  let state = (seed >>> 0) || 1;
  let out = '';
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

export function computeSyntheticBatchSize(options = {}) {
  const nowMs = Number(options.now_ms || Date.now());
  const configuredProfile = parseProfile(options.profile, 'basic');
  const profile = resolveRuntimeProfile(
    configuredProfile,
    nowMs,
    String(options.index || ''),
    String(options.service || '')
  );
  const base = parseBatchSize(options.batch_size, 24, 400);
  const hasExplicitRange = options.batch_min !== undefined || options.batch_max !== undefined;
  if (!hasExplicitRange) return base;
  const fallbackMin = Math.max(6, Math.floor(base * 0.5));
  const fallbackMax = Math.max(fallbackMin, Math.ceil(base * 1.9));
  const min = parseBatchSize(options.batch_min, fallbackMin, 400);
  const max = parseBatchSize(options.batch_max, fallbackMax, 400);
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  if (lower === upper) return lower;

  const bucket = Math.floor(nowMs / (5 * 60 * 1000));
  const runSlice = Math.floor(nowMs / 15000);
  const wave = (Math.sin(bucket / (profile === 'otel-demo' ? 1.8 : 2.7)) + 1) / 2;
  const seed = hashText(
    `${bucket}:${runSlice}:${profile}:${String(options.index || '')}:${String(options.service || '')}`
  );
  const jitter = (seed % 1000) / 999;
  const score = Math.max(0, Math.min(1, (wave * 0.65) + (jitter * 0.35)));
  return lower + Math.round((upper - lower) * score);
}

function pick(values, seed) {
  return values[Math.abs(seed) % values.length];
}

function pickMessage(level, seed) {
  if (level === 'error') return pick(ERROR_MESSAGES, seed);
  if (level === 'warn') return pick(WARN_MESSAGES, seed);
  return pick(INFO_MESSAGES, seed);
}

function pickHttpMethod(seed) {
  return pick(['GET', 'GET', 'POST', 'GET', 'PUT'], seed);
}

function pickSpanKind(service, route, seed) {
  if (service === 'frontend') return 'server';
  if (route.startsWith('/grpc/')) return pick(['client', 'server'], seed);
  if (service.endsWith('service')) return pick(['server', 'client'], seed + 7);
  return 'internal';
}

function otelComponentForService(service) {
  if (service.includes('payment')) return 'payment-gateway';
  if (service.includes('shipping')) return 'shipping-orchestrator';
  if (service.includes('checkout')) return 'checkout';
  if (service.includes('recommendation')) return 'ranking-engine';
  if (service.includes('productcatalog')) return 'catalog-cache';
  if (service.includes('frontend')) return 'web';
  return 'backend';
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

  if (profile === 'otel-demo') {
    if (level === 'error') return pick([500, 502, 503, 504], seed);
    if (level === 'warn') return pick([409, 429, 499], seed);
    return pick([200, 201, 202, 204], seed);
  }

  if (level === 'error') return pick([500, 502, 503, 504, 521, 522], seed);
  if (level === 'warn') return pick([408, 409, 425, 429], seed);
  return pick([200, 201, 202, 204, 206], seed);
}

function routeForIndex(index, profile) {
  if (profile === 'otel-demo') return pick(OTEL_DEMO_ROUTES, index);
  return pick(profile === 'realistic' ? REALISTIC_ROUTES : BASIC_ROUTES, index);
}

function buildEventMessage(level, route, component, seed, sequence, incidentWave, profile, service, status, traceId) {
  const base = pickMessage(level, seed);
  const incidentSuffix = incidentWave ? ' incident_wave=true' : '';
  if (profile === 'otel-demo') {
    return `otel ${level} service=${service} route=${route} status=${status} trace_id=${traceId} ${base}${incidentSuffix}`;
  }
  return `synthetic ${level} component=${component} route=${route} seq=${sequence} ${base}${incidentSuffix}`;
}

function serviceForIndex(index, profile, baseService) {
  if (profile === 'otel-demo') return pick(OTEL_DEMO_SERVICES, index + 3);
  if (profile !== 'realistic') return baseService;
  return pick([baseService, `${baseService}-auth`, `${baseService}-api`, `${baseService}-worker`], index);
}

function envForIndex(index, profile, baseEnv) {
  if (profile !== 'realistic') return baseEnv;
  return pick([baseEnv, 'staging'], index + 11);
}

function hostForIndex(index, hostPrefix, profile) {
  const hostCount = profile === 'otel-demo' ? 16 : (profile === 'realistic' ? 12 : 6);
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
  if (profile === 'otel-demo') {
    if (route.startsWith('/grpc/')) {
      if (level === 'error') return 1000 + waveBias + (sequence % 1800);
      if (level === 'warn') return 350 + Math.trunc(waveBias / 2) + (sequence % 900);
      return 35 + (sequence % 220);
    }
    if (level === 'error') return 650 + routeBias + waveBias + (sequence % 2300);
    if (level === 'warn') return 180 + routeBias + Math.trunc(waveBias / 2) + (sequence % 900);
    return 25 + routeBias + (sequence % 260);
  }
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
  if (profile === 'otel-demo') {
    const minuteBucket = Math.floor(nowMs / (1000 * 60));
    return minuteBucket % 20 < 6;
  }
  if (profile !== 'realistic') return false;
  const minuteBucket = Math.floor(nowMs / (1000 * 60));
  return minuteBucket % 30 < 5;
}

function timestampShapeForProfile(profile, incidentWave) {
  if (profile === 'otel-demo') return incidentWave ? 2.8 : 1.5;
  if (profile === 'realistic') return incidentWave ? 2.2 : 1.2;
  return incidentWave ? 1.8 : 1.1;
}

export function buildSyntheticEvents(options = {}) {
  const nowMs = Number(options.now_ms || Date.now());
  const configuredProfile = parseProfile(options.profile, 'basic');
  const profile = resolveRuntimeProfile(
    configuredProfile,
    nowMs,
    String(options.index || ''),
    String(options.service || '')
  );
  const service = String(options.service || 'edgedata-demo').trim() || 'edgedata-demo';
  const index = String(options.index || 'default').trim().toLowerCase() || 'default';
  const batchSize = computeSyntheticBatchSize({
    now_ms: nowMs,
    batch_size: options.batch_size,
    batch_min: options.batch_min,
    batch_max: options.batch_max,
    profile,
    service,
    index
  });
  const env = String(options.env || 'demo').trim() || 'demo';
  const hostPrefix = String(options.host_prefix || 'edgedata-cron').trim() || 'edgedata-cron';
  const region = String(options.region || 'global').trim() || 'global';
  const incidentWave = incidentWaveForNow(nowMs, profile);
  const release = releaseForNow(nowMs);
  const tsShape = timestampShapeForProfile(profile, incidentWave);

  const events = [];
  const lookbackMs = Math.max(5 * 60 * 1000, Math.min(30 * 60 * 1000, batchSize * 20 * 1000));
  for (let i = 0; i < batchSize; i++) {
    const sequence = (nowMs % 1_000_000) + i;
    const timeSeed = hashText(`ts:${nowMs}:${i}:${profile}:${service}:${index}`);
    const u = ((timeSeed % 1000) + 0.5) / 1000;
    const skew = Math.pow(u, tsShape);
    const eventTsMs = nowMs - Math.round(skew * lookbackMs);
    const level = levelForIndex(sequence, profile, incidentWave, i);
    const route = routeForIndex(sequence, profile);
    const eventService = serviceForIndex(sequence, profile, service);
    const component = profile === 'otel-demo'
      ? otelComponentForService(eventService)
      : pick(COMPONENTS, sequence + 7);
    const status = statusForLevel(level, sequence, profile);
    const durationMs = durationForEvent(level, route, sequence, profile, incidentWave);
    const eventEnv = envForIndex(sequence, profile, env);
    const tenant = pick(TENANTS, sequence + 17);
    const userSuffix = (sequence % 350) + 1000;
    const traceId = profile === 'otel-demo'
      ? hexId(hashText(`trace:${nowMs}:${sequence}:${eventService}`), 32)
      : `syn-trace-${(sequence * 13).toString(36)}`;
    const spanId = profile === 'otel-demo'
      ? hexId(hashText(`span:${nowMs}:${sequence}:${eventService}`), 16)
      : `syn-span-${(sequence * 17).toString(36)}`;
    const method = profile === 'otel-demo' ? pickHttpMethod(sequence) : 'GET';
    const spanKind = profile === 'otel-demo' ? pickSpanKind(eventService, route, sequence) : 'internal';

    events.push({
      ts: new Date(eventTsMs).toISOString(),
      index,
      service: eventService,
      env: eventEnv,
      host: hostForIndex(sequence, hostPrefix, profile),
      level,
      message: buildEventMessage(
        level,
        route,
        component,
        sequence,
        sequence,
        incidentWave,
        profile,
        eventService,
        status,
        traceId
      ),
      status,
      duration_ms: durationMs,
      request_id: `syn-req-${sequence.toString(36)}`,
      trace_id: traceId,
      span_id: spanId,
      src_ip: ipForIndex(sequence),
      user_id: `user-${userSuffix}`,
      attrs: {
        synthetic: true,
        source: 'synthetic-worker',
        synthetic_profile: profile,
        synthetic_profile_requested: configuredProfile,
        incident_wave: incidentWave,
        route,
        region,
        tenant,
        component,
        release,
        ...(profile === 'otel-demo' ? {
          dataset: 'opentelemetry-demo',
          'otel.service.name': eventService,
          'otel.scope.name': 'io.opentelemetry.instrumentation.http',
          'otel.scope.version': '1.10.0',
          'otel.span.kind': spanKind,
          'otel.trace.flags': '01',
          'otel.deployment.environment': eventEnv,
          'otel.http.method': method,
          'otel.http.route': route,
          'otel.http.status_code': status,
          'otel.net.peer.ip': ipForIndex(sequence + 11),
          'otel.resource.host.name': hostForIndex(sequence, hostPrefix, profile)
        } : {})
      }
    });
  }
  return events;
}
