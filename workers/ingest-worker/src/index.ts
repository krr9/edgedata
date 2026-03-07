import { listIngestParsers, parseIngestPayload } from './ingest-framework.mjs';

export interface Env {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  WAE: AnalyticsEngineDataset;
  OPS_WAE?: AnalyticsEngineDataset;
  INGEST_SECRET: string;
  INGEST_HMAC_SECRET?: string;
  INGEST_RATE_LIMIT_PER_MIN?: string;
  REPROCESS_SECRET?: string;
  QUERY_SERVICE?: Fetcher;
}

interface LogEvent {
  ts?: string;
  timestamp?: string;
  index?: string;
  service?: string;
  env?: string;
  host?: string;
  level?: string;
  message?: string;
  msg?: string;
  trace_id?: string;
  request_id?: string;
  status?: number | string;
  duration_ms?: number | string;
  src_ip?: string;
  user_id?: string;
  attrs_json?: string;
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
}

interface NormalizedEvent {
  event_id: string;
  ts: string;
  date: string;
  hour: number;
  index: string;
  service: string;
  env: string;
  host: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  message_lc: string;
  msg_hash: string;
  trace_id?: string;
  request_id?: string;
  status?: number;
  duration_ms?: number;
  src_ip?: string;
  user_id?: string;
  attrs_json?: string;
}

interface TokenRecord {
  date: string;
  hour: number;
  index: string;
  service: string;
  env: string;
  token: string;
  event_id: string;
}

interface AnalyticsEngineRow {
  blobs: string[];
  doubles: number[];
  timestamp: Date;
}

interface OpsMetricRow {
  blobs: string[];
  doubles: number[];
  indexes?: string[];
  timestamp: Date;
}

interface ReprocessRequest {
  from?: string;
  to?: string;
  index?: string;
  service?: string;
  env?: string;
  max_objects?: number;
  dry_run?: boolean;
}

interface ReprocessSummary {
  from: string;
  to: string;
  index?: string;
  service?: string;
  env?: string;
  scanned_objects: number;
  matched_objects: number;
  reindexed_events: number;
  reindexed_tokens: number;
  skipped_lines: number;
  dry_run: boolean;
}

interface ParsedIngestPayload {
  parser: string;
  events: LogEvent[];
  defaults?: Partial<{ index: string; service: string; env: string; host: string }>;
}

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_BATCH_EVENTS = 1000;
const MAX_ATTRS_BYTES = 16 * 1024;
const MAX_TOKENS_PER_EVENT = 12;
const REPROCESS_MAX_DAYS = 31;
const REPROCESS_MAX_OBJECTS = 2000;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'from',
  'of', 'in', 'on', 'at', 'by', 'with', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'as', 'it', 'this', 'that', 'these', 'those', 'not'
]);

const WHITELIST_STATUS_CODES = new Set(['400', '401', '403', '404', '429', '500', '502', '503', '504']);

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown-ip';
}

function asRateLimitPerMinute(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

async function enforceRateLimit(
  env: Env,
  scope: string,
  key: string,
  perMinute: number
): Promise<void> {
  if (perMinute <= 0) return;

  const now = Date.now();
  const windowStartMs = Math.floor(now / 60000) * 60000;
  const nowIso = new Date(now).toISOString();

  await env.DB.prepare(
    `INSERT INTO rate_limits (scope, limit_key, window_start_ms, count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, limit_key, window_start_ms) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at`
  ).bind(scope, key, windowStartMs, nowIso).run();

  const row = await env.DB.prepare(
    `SELECT count
     FROM rate_limits
     WHERE scope = ? AND limit_key = ? AND window_start_ms = ?`
  ).bind(scope, key, windowStartMs).first<{ count?: number }>();

  if (Number(row?.count || 0) > perMinute) {
    throw new Error('Rate limit exceeded');
  }
}

function generateULID(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let str = '';
  let ts = Date.now();
  for (let i = 10; i >= 0; i--) {
    str = ENCODING[ts % 32] + str;
    ts = Math.floor(ts / 32);
  }
  for (let i = 0; i < 16; i++) {
    str += ENCODING[Math.floor(Math.random() * 32)];
  }
  return str;
}

function hash40(value: string): string {
  // FNV-1a variant is sufficient for message grouping and deterministic hashes.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return (hex + hex + hex + hex + hex).slice(0, 40);
}

function normalizeTimestamp(ts: string | undefined): string {
  if (!ts) {
    return new Date().toISOString();
  }
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function normalizeLevel(level: string | undefined): 'debug' | 'info' | 'warn' | 'error' {
  if (!level) return 'info';
  const l = level.toLowerCase();
  if (l === 'warning') return 'warn';
  if (l === 'debug' || l === 'info' || l === 'warn' || l === 'error') return l;
  return 'info';
}

function normalizeIndex(index: string | undefined): string {
  const value = String(index || 'default').trim().toLowerCase();
  if (!value) return 'default';
  return clampString(value.replace(/[^a-z0-9_.-]/g, '-'), 64);
}

function clampString(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeEvent(
  event: LogEvent,
  defaults: { index: string; service: string; env: string; host: string }
): NormalizedEvent {
  const ts = normalizeTimestamp((event.ts as string | undefined) || (event.timestamp as string | undefined));
  const dt = new Date(ts);
  const date = dt.toISOString().split('T')[0];
  const hour = dt.getUTCHours();

  const message = clampString(String(event.message ?? event.msg ?? ''), 16 * 1024);
  const message_lc = message.toLowerCase();

  let attrsJson: string | undefined;
  if (typeof event.attrs_json === 'string') {
    attrsJson = clampString(event.attrs_json, MAX_ATTRS_BYTES);
  } else if (event.attrs && typeof event.attrs === 'object') {
    attrsJson = clampString(JSON.stringify(event.attrs), MAX_ATTRS_BYTES);
  }

  return {
    event_id: generateULID(),
    ts,
    date,
    hour,
    index: normalizeIndex(event.index || defaults.index),
    service: clampString(String(event.service || defaults.service || 'unknown'), 128),
    env: clampString(String(event.env || defaults.env || 'prod'), 64),
    host: clampString(String(event.host || defaults.host || 'unknown'), 256),
    level: normalizeLevel(event.level as string | undefined),
    message,
    message_lc,
    msg_hash: hash40(message_lc),
    trace_id: event.trace_id ? clampString(String(event.trace_id), 256) : undefined,
    request_id: event.request_id ? clampString(String(event.request_id), 256) : undefined,
    status: toNumber(event.status),
    duration_ms: toNumber(event.duration_ms),
    src_ip: event.src_ip ? clampString(String(event.src_ip), 128) : undefined,
    user_id: event.user_id ? clampString(String(event.user_id), 256) : undefined,
    attrs_json: attrsJson
  };
}

function tokenizeMessage(messageLc: string): string[] {
  const normalized = messageLc.normalize('NFKD').replace(/[-_]/g, ' ');
  const pieces = normalized.split(/[^a-z0-9:]+/).map((t) => t.trim()).filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const token of pieces) {
    if (token.length < 2 || token.length > 32) continue;
    if (seen.has(token)) continue;

    const digitCount = (token.match(/[0-9]/g) || []).length;
    if (digitCount / token.length > 0.6 && !WHITELIST_STATUS_CODES.has(token)) continue;
    if (STOPWORDS.has(token)) continue;

    seen.add(token);
    unique.push(token);
  }

  const alphaFirst = unique.sort((a, b) => {
    const aHasAlpha = /[a-z]/.test(a);
    const bHasAlpha = /[a-z]/.test(b);
    if (aHasAlpha !== bHasAlpha) return aHasAlpha ? -1 : 1;
    return b.length - a.length;
  });

  return alphaFirst.slice(0, MAX_TOKENS_PER_EVENT);
}

function extractTokens(event: NormalizedEvent): string[] {
  const tokens = new Set<string>();

  for (const token of tokenizeMessage(event.message_lc)) {
    tokens.add(token);
  }

  tokens.add(`level:${event.level}`);
  tokens.add(`idx:${event.index}`);
  tokens.add(`svc:${event.service}`);
  if (typeof event.status === 'number') {
    tokens.add(`status:${Math.trunc(event.status)}`);
  }

  return Array.from(tokens).slice(0, MAX_TOKENS_PER_EVENT);
}

async function authenticate(request: Request, env: Env, rawBody: string): Promise<{ ok: boolean; agentId: string }> {
  const agentId = request.headers.get('X-Agent-Id') || 'unknown-agent';
  const auth = request.headers.get('Authorization') || '';

  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (token && token === env.INGEST_SECRET) return { ok: true, agentId };
  }

  const timestamp = request.headers.get('X-Timestamp');
  const signature = request.headers.get('X-Signature');

  if (!timestamp || !signature || !env.INGEST_HMAC_SECRET) {
    return { ok: false, agentId };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, agentId };

  const skewMs = Math.abs(Date.now() - ts);
  if (skewMs > 5 * 60 * 1000) {
    return { ok: false, agentId };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.INGEST_HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(signed), (b) => b.toString(16).padStart(2, '0')).join('');

  return { ok: signature === expected, agentId };
}

async function writeRawR2(events: NormalizedEvent[], env: Env): Promise<void> {
  const groups = new Map<string, NormalizedEvent[]>();

  for (const event of events) {
    const hour = String(event.hour).padStart(2, '0');
    const groupKey = `${event.date}|${event.index}|${hour}|${event.service}|${event.env}`;
    const group = groups.get(groupKey) || [];
    group.push(event);
    groups.set(groupKey, group);
  }

  for (const [groupKey, groupEvents] of groups) {
    const [date, index, hour, service, envName] = groupKey.split('|');
    const key = `raw/date=${date}/index=${index}/hour=${hour}/service=${service}/env=${envName}/part-${generateULID()}.ndjson`;
    const ndjson = groupEvents.map((event) => JSON.stringify(event)).join('\n');

    const sorted = [...groupEvents].sort((a, b) => a.ts.localeCompare(b.ts));
    await env.RAW_BUCKET.put(key, ndjson, {
      httpMetadata: { contentType: 'application/x-ndjson' },
      customMetadata: {
        min_ts: sorted[0]?.ts || '',
        max_ts: sorted[sorted.length - 1]?.ts || '',
        count: String(groupEvents.length),
        index,
        service,
        env: envName
      }
    });
  }
}

async function writeEventsR2(events: NormalizedEvent[], env: Env): Promise<void> {
  const groups = new Map<string, NormalizedEvent[]>();

  for (const event of events) {
    const groupKey = `${event.date}|${event.index}|${event.service}|${event.env}`;
    const group = groups.get(groupKey) || [];
    group.push(event);
    groups.set(groupKey, group);
  }

  for (const [groupKey, groupEvents] of groups) {
    const [date, index, service, envName] = groupKey.split('|');
    const key = `events/date=${date}/index=${index}/service=${service}/env=${envName}/part-${generateULID()}.jsonl`;
    await env.RAW_BUCKET.put(
      key,
      groupEvents.map((event) => JSON.stringify(event)).join('\n'),
      {
        httpMetadata: { contentType: 'application/x-ndjson' },
        customMetadata: {
          count: String(groupEvents.length),
          index,
          service,
          env: envName
        }
      }
    );
  }
}

async function writeWAE(events: NormalizedEvent[], env: Env): Promise<void> {
  const datapoints: AnalyticsEngineRow[] = events.map((event) => ({
    blobs: [event.service, event.env, event.host, event.level, event.msg_hash],
    doubles: [1, event.status || 0, event.duration_ms || 0],
    timestamp: new Date(event.ts)
  }));

  for (let i = 0; i < datapoints.length; i += 200) {
    await env.WAE.writeData(datapoints.slice(i, i + 200));
  }
}

async function writeOpsMetric(
  env: Env,
  metric: string,
  value = 1,
  dimension = 'ingest-worker'
): Promise<void> {
  if (!env.OPS_WAE) return;
  const row: OpsMetricRow = {
    blobs: [metric, dimension],
    doubles: [value],
    timestamp: new Date()
  };
  await env.OPS_WAE.writeData([row]);
}

async function writeTokens(events: NormalizedEvent[], env: Env): Promise<void> {
  const tokenGroups = new Map<string, TokenRecord[]>();

  for (const event of events) {
    const groupKey = `${event.date}|${event.index}|${event.service}|${event.env}`;
    const group = tokenGroups.get(groupKey) || [];

    for (const token of extractTokens(event)) {
      group.push({
        date: event.date,
        hour: event.hour,
        index: event.index,
        service: event.service,
        env: event.env,
        token,
        event_id: event.event_id
      });
    }

    tokenGroups.set(groupKey, group);
  }

  for (const [groupKey, records] of tokenGroups) {
    if (records.length === 0) continue;
    const [date, index, service, envName] = groupKey.split('|');
    const key = `tokens/date=${date}/index=${index}/service=${service}/env=${envName}/part-${generateULID()}.jsonl`;

    await env.RAW_BUCKET.put(
      key,
      records.map((record) => JSON.stringify(record)).join('\n'),
      {
        httpMetadata: { contentType: 'application/x-ndjson' },
        customMetadata: {
          count: String(records.length),
          index,
          service,
          env: envName
        }
      }
    );
  }
}

async function pushToTailHub(events: NormalizedEvent[], env: Env): Promise<void> {
  if (!env.QUERY_SERVICE) return;
  await env.QUERY_SERVICE.fetch(
    new Request('https://internal/internal/tail-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events)
    })
  );
}

async function processBatch(events: NormalizedEvent[], env: Env, requestId: string): Promise<void> {
  const results = await Promise.allSettled([
    writeEventsR2(events, env),
    writeWAE(events, env),
    writeTokens(events, env),
    pushToTailHub(events, env)
  ]);

  const targets = ['events', 'WAE', 'tokens', 'tail_push'];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      const target = targets[i];
      console.error(`[${requestId}] ${target} write failed`, result.reason);
      await writeOpsMetric(env, `${target.toLowerCase()}_write_failures`, 1).catch(() => undefined);
      if (target === 'events' || target === 'tokens') {
        await writeOpsMetric(env, 'iceberg_write_failures', 1).catch(() => undefined);
      }
    }
  }
}

function parseDateOnly(input: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`Invalid date format: ${input} (expected YYYY-MM-DD)`);
  }
  const parsed = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${input}`);
  }
  return parsed;
}

function dateRangeInclusive(fromDate: string, toDate: string): string[] {
  const from = parseDateOnly(fromDate);
  const to = parseDateOnly(toDate);
  if (from > to) {
    throw new Error('Invalid date range: from must be before to');
  }

  const dates: string[] = [];
  const cursor = new Date(from.getTime());
  while (cursor <= to) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (dates.length > REPROCESS_MAX_DAYS) {
      throw new Error(`Date range too large: max ${REPROCESS_MAX_DAYS} days`);
    }
  }
  return dates;
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      keys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

function extractRawKeyMeta(key: string): { index: string; service: string; env: string } {
  const indexMatch = key.match(/\/index=([^/]+)\//);
  const serviceMatch = key.match(/\/service=([^/]+)\//);
  const envMatch = key.match(/\/env=([^/]+)\//);
  return {
    index: indexMatch ? normalizeIndex(decodeURIComponent(indexMatch[1])) : 'default',
    service: serviceMatch ? decodeURIComponent(serviceMatch[1]) : 'unknown',
    env: envMatch ? decodeURIComponent(envMatch[1]) : 'prod'
  };
}

function normalizeReprocessEvent(
  record: LogEvent,
  defaults: { index: string; service: string; env: string; host: string }
): NormalizedEvent {
  const hasCanonicalShape = Boolean(
    typeof (record as { event_id?: unknown }).event_id === 'string' &&
    typeof record.ts === 'string' &&
    typeof record.message === 'string'
  );

  if (!hasCanonicalShape) {
    return normalizeEvent(record, defaults);
  }

  const ts = normalizeTimestamp(record.ts);
  const dt = new Date(ts);
  const date = dt.toISOString().slice(0, 10);
  const hour = dt.getUTCHours();
  const message = clampString(String(record.message || record.msg || ''), 16 * 1024);
  const messageLc = clampString(String((record as { message_lc?: unknown }).message_lc || message.toLowerCase()), 16 * 1024);
  const attrsJson = typeof record.attrs_json === 'string'
    ? clampString(record.attrs_json, MAX_ATTRS_BYTES)
    : (record.attrs && typeof record.attrs === 'object'
      ? clampString(JSON.stringify(record.attrs), MAX_ATTRS_BYTES)
      : undefined);

  return {
    event_id: String((record as { event_id?: unknown }).event_id),
    ts,
    date,
    hour,
    index: normalizeIndex(record.index || defaults.index),
    service: clampString(String(record.service || defaults.service || 'unknown'), 128),
    env: clampString(String(record.env || defaults.env || 'prod'), 64),
    host: clampString(String(record.host || defaults.host || 'unknown'), 256),
    level: normalizeLevel(record.level as string | undefined),
    message,
    message_lc: messageLc,
    msg_hash: clampString(String(record.msg_hash || hash40(messageLc)), 40),
    trace_id: record.trace_id ? clampString(String(record.trace_id), 256) : undefined,
    request_id: record.request_id ? clampString(String(record.request_id), 256) : undefined,
    status: toNumber(record.status),
    duration_ms: toNumber(record.duration_ms),
    src_ip: record.src_ip ? clampString(String(record.src_ip), 128) : undefined,
    user_id: record.user_id ? clampString(String(record.user_id), 256) : undefined,
    attrs_json: attrsJson
  };
}

async function reprocessRawObject(
  key: string,
  env: Env,
  dryRun: boolean
): Promise<{ events: number; tokens: number; skippedLines: number }> {
  const object = await env.RAW_BUCKET.get(key);
  if (!object) return { events: 0, tokens: 0, skippedLines: 0 };

  const text = await object.text();
  const defaultsFromKey = extractRawKeyMeta(key);
  const defaults = {
    index: defaultsFromKey.index,
    service: defaultsFromKey.service,
    env: defaultsFromKey.env,
    host: 'reprocess'
  };
  const dedupe = new Set<string>();
  const events: NormalizedEvent[] = [];
  let skippedLines = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LogEvent;
      const normalized = normalizeReprocessEvent(parsed, defaults);
      if (dedupe.has(normalized.event_id)) continue;
      dedupe.add(normalized.event_id);
      events.push(normalized);
    } catch {
      skippedLines += 1;
    }
  }

  if (events.length === 0) {
    return { events: 0, tokens: 0, skippedLines };
  }

  const tokenCount = events.reduce((sum, event) => sum + extractTokens(event).length, 0);
  if (!dryRun) {
    await Promise.all([writeEventsR2(events, env), writeTokens(events, env)]);
  }

  return { events: events.length, tokens: tokenCount, skippedLines };
}

function keyIndexFromPath(key: string): string {
  const match = key.match(/\/index=([^/]+)\//);
  if (!match) return 'default';
  return normalizeIndex(decodeURIComponent(match[1]));
}

function normalizeMetricSuffix(value: string): string {
  const normalized = String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return normalized.replace(/^_+|_+$/g, '') || 'unknown';
}

function isIngestEndpoint(pathname: string): boolean {
  return pathname === '/ingest' || pathname === '/v1/logs' || pathname === '/otlp/v1/logs';
}

async function reprocessRawRange(env: Env, request: ReprocessRequest): Promise<ReprocessSummary> {
  const today = new Date().toISOString().slice(0, 10);
  const from = (request.from || today).trim();
  const to = (request.to || from).trim();
  const indexFilter = request.index ? normalizeIndex(request.index) : undefined;
  const service = request.service?.trim();
  const envFilter = request.env?.trim();
  const dryRun = request.dry_run !== false;
  const maxObjects = Math.max(1, Math.min(Number(request.max_objects || 200), REPROCESS_MAX_OBJECTS));

  const dates = dateRangeInclusive(from, to);
  const keys: string[] = [];
  let scannedObjects = 0;
  for (const date of dates) {
    const dateKeys = await listAllObjects(env.RAW_BUCKET, `raw/date=${date}/`);
    for (const key of dateKeys) {
      scannedObjects += 1;
      if (indexFilter && keyIndexFromPath(key) !== indexFilter) continue;
      if (service && !key.includes(`/service=${service}/`)) continue;
      if (envFilter && !key.includes(`/env=${envFilter}/`)) continue;
      keys.push(key);
      if (keys.length >= maxObjects) break;
    }
    if (keys.length >= maxObjects) break;
  }

  let reindexedEvents = 0;
  let reindexedTokens = 0;
  let skippedLines = 0;
  for (const key of keys) {
    const result = await reprocessRawObject(key, env, dryRun);
    reindexedEvents += result.events;
    reindexedTokens += result.tokens;
    skippedLines += result.skippedLines;
  }

  return {
    from,
    to,
    index: indexFilter,
    service,
    env: envFilter,
    scanned_objects: scannedObjects,
    matched_objects: keys.length,
    reindexed_events: reindexedEvents,
    reindexed_tokens: reindexedTokens,
    skipped_lines: skippedLines,
    dry_run: dryRun
  };
}

function isReprocessAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;
  const expected = env.REPROCESS_SECRET || env.INGEST_SECRET;
  return token === expected;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = generateULID();
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({
        status: 'ok',
        service: 'ingest-worker',
        version: '1.4.0',
        parsers: listIngestParsers()
      });
    }

    if (url.pathname === '/reprocess' && request.method === 'POST') {
      if (!isReprocessAuthorized(request, env)) {
        return Response.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 });
      }

      ctx.waitUntil(writeOpsMetric(env, 'reprocess_requests_total', 1).catch(() => undefined));

      let body: ReprocessRequest = {};
      const raw = await request.text();
      if (raw.trim()) {
        try {
          body = JSON.parse(raw) as ReprocessRequest;
        } catch {
          ctx.waitUntil(writeOpsMetric(env, 'reprocess_failures', 1).catch(() => undefined));
          return Response.json({ error: 'Invalid JSON body', request_id: requestId }, { status: 400 });
        }
      }

      try {
        const summary = await reprocessRawRange(env, body);
        return Response.json({ request_id: requestId, ...summary });
      } catch (error) {
        ctx.waitUntil(writeOpsMetric(env, 'reprocess_failures', 1).catch(() => undefined));
        return Response.json(
          { error: error instanceof Error ? error.message : String(error), request_id: requestId },
          { status: 400 }
        );
      }
    }

    if (!isIngestEndpoint(url.pathname) || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    ctx.waitUntil(writeOpsMetric(env, 'ingest_requests_total', 1).catch(() => undefined));

    try {
      const ipLimit = asRateLimitPerMinute(env.INGEST_RATE_LIMIT_PER_MIN, 2400);
      await enforceRateLimit(env, 'ingest_ip', clientIp(request), ipLimit);
    } catch (error) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_rate_limited', 1).catch(() => undefined));
      return Response.json({ error: 'Rate limit exceeded', request_id: requestId }, { status: 429 });
    }

    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_BODY_BYTES) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_parse_errors', 1).catch(() => undefined));
      return Response.json({ error: 'Payload too large', request_id: requestId }, { status: 413 });
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_parse_errors', 1).catch(() => undefined));
      return Response.json({ error: 'Payload too large', request_id: requestId }, { status: 413 });
    }

    const auth = await authenticate(request, env, rawBody);
    if (!auth.ok) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_auth_failures', 1).catch(() => undefined));
      return Response.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 });
    }

    try {
      const agentLimit = asRateLimitPerMinute(env.INGEST_RATE_LIMIT_PER_MIN, 2400);
      await enforceRateLimit(env, 'ingest_agent', auth.agentId, agentLimit);
    } catch (error) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_rate_limited', 1).catch(() => undefined));
      return Response.json({ error: 'Rate limit exceeded', request_id: requestId }, { status: 429 });
    }

    let parsedBody: unknown = undefined;
    let jsonParseFailed = false;
    const trimmedBody = rawBody.trim();
    const contentType = request.headers.get('content-type') || '';
    const likelyJsonPayload = /json/i.test(contentType) || trimmedBody.startsWith('{') || trimmedBody.startsWith('[');
    if (likelyJsonPayload) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        jsonParseFailed = true;
      }
    }

    const parserResult = parseIngestPayload({
      path: url.pathname,
      contentType,
      headers: Object.fromEntries(request.headers.entries()),
      rawBody,
      parsedBody
    }) as ParsedIngestPayload;

    const incomingEvents = parserResult.events;
    if (incomingEvents.length === 0) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_parse_errors', 1).catch(() => undefined));
      if (jsonParseFailed) {
        return Response.json({ error: 'Invalid JSON body', request_id: requestId }, { status: 400 });
      }
      return Response.json(
        {
          error: 'Unsupported body format. Expected EdgeData JSON array, { events: [...] }, OTLP JSON logs payload, or NDJSON.',
          request_id: requestId
        },
        { status: 400 }
      );
    }
    if (incomingEvents.length > MAX_BATCH_EVENTS) {
      ctx.waitUntil(writeOpsMetric(env, 'ingest_parse_errors', 1).catch(() => undefined));
      return Response.json({ error: `Too many events: max ${MAX_BATCH_EVENTS}`, request_id: requestId }, { status: 400 });
    }

    const parserDefaults = parserResult.defaults || {};
    const defaults = {
      index: request.headers.get('X-Index') || parserDefaults.index || 'default',
      service: request.headers.get('X-Service') || parserDefaults.service || 'unknown',
      env: request.headers.get('X-Env') || parserDefaults.env || 'prod',
      host: request.headers.get('X-Host') || parserDefaults.host || 'unknown'
    };

    const normalizedEvents = incomingEvents.map((event) => normalizeEvent(event, defaults));
    ctx.waitUntil(
      writeOpsMetric(env, `ingest_parser_${normalizeMetricSuffix(parserResult.parser)}`, normalizedEvents.length).catch(() => undefined)
    );

    // Raw storage is source-of-truth, so fail request when this write fails.
    try {
      await writeRawR2(normalizedEvents, env);
    } catch (error) {
      console.error(`[${requestId}] raw write failed`, error);
      ctx.waitUntil(writeOpsMetric(env, 'r2_write_failures', 1).catch(() => undefined));
      return Response.json({ error: 'Raw storage write failed', request_id: requestId }, { status: 500 });
    }

    ctx.waitUntil(processBatch(normalizedEvents, env, requestId));

    return Response.json({
      ingested: normalizedEvents.length,
      request_id: requestId,
      agent_id: auth.agentId,
      parser: parserResult.parser
    });
  }
};
