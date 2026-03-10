import { validateAlertAccessJwtConfig } from '../../shared/access-config.mjs';
import {
  buildScheduledSearchQueryRequest,
  resolveQueryWorkerSearchUrl
} from './scheduled-search-core.mjs';

export interface Env {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  ACCESS_AUD?: string;
  ACCESS_ISSUER?: string;
  ACCESS_JWKS_URL?: string;
  ACCESS_ADMIN_GROUPS?: string;
  ACCESS_ADMIN_EMAILS?: string;
  REQUIRE_ACCESS_JWT?: string;
  ALERT_RUN_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
  WEBHOOK_URL?: string;
  QUERY_WORKER_URL?: string;
  QUERY_WORKER_TOKEN?: string;
}

interface AccessJwtHeader {
  alg?: string;
  kid?: string;
}

interface AccessJwtPayload {
  sub?: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  groups?: string[];
}

interface Alert {
  id: string;
  name: string;
  enabled: number;
  type: string;
  query_template: string;
  params_json: string;
  schedule_seconds: number;
  threshold_json: string;
  notify_json: string;
  cooldown_seconds: number;
  created_at: string;
  updated_at?: string | null;
}

interface AlertState {
  alert_id: string;
  last_evaluated_at: string;
  last_fired_at: string | null;
  is_firing: number;
  last_value_json: string;
  fingerprint: string | null;
}

interface Threshold {
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  value: number;
}

interface NotifyConfig {
  slack?: boolean;
  webhook?: boolean;
  severity?: 'info' | 'warn' | 'critical';
  dashboard_url?: string;
  deep_link?: string;
  runbook_url?: string;
  owner_team?: string;
}

interface EvaluationResult {
  value: number;
  triggered: boolean;
  fingerprint?: string;
  details?: Record<string, unknown>;
}

interface WAERow {
  [key: string]: string | number | null;
}

const DEFAULT_THRESHOLD: Threshold = {
  operator: 'gt',
  value: 0
};
const DEFAULT_EVENT_INDEX = 'default';

let jwksCache: { expiresAt: number; keysByKid: Map<string, JsonWebKey> } | null = null;

function safeJsonParse<T>(input: string | undefined, fallback: T): T {
  if (!input) return fallback;
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function compareThreshold(value: number, threshold: Threshold): boolean {
  switch (threshold.operator) {
    case 'gt': return value > threshold.value;
    case 'gte': return value >= threshold.value;
    case 'lt': return value < threshold.value;
    case 'lte': return value <= threshold.value;
    case 'eq': return value === threshold.value;
    default: return false;
  }
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIndexValue(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || DEFAULT_EVENT_INDEX;
}

function parseCsvSet(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart<T>(segment: string): T {
  try {
    const bytes = base64UrlToBytes(segment);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error('Invalid Access JWT');
  }
}

function normalizedIssuer(input: string | undefined): string | null {
  if (!input) return null;
  return input.replace(/\/+$/, '');
}

function resolveJwksUrl(env: Env): string | null {
  if (env.ACCESS_JWKS_URL) return env.ACCESS_JWKS_URL.trim();
  const issuer = normalizedIssuer(env.ACCESS_ISSUER);
  if (!issuer) return null;
  return `${issuer}/cdn-cgi/access/certs`;
}

async function getJwksKeysByKid(env: Env): Promise<Map<string, JsonWebKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keysByKid;

  const url = resolveJwksUrl(env);
  if (!url) {
    throw new Error('Access JWT verification misconfigured');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Access JWKS: ${response.status}`);
  }

  const body = await response.json() as { keys?: JsonWebKey[] };
  const keysByKid = new Map<string, JsonWebKey>();
  for (const key of body.keys || []) {
    if (key.kid) keysByKid.set(key.kid, key);
  }

  jwksCache = {
    expiresAt: now + (5 * 60 * 1000),
    keysByKid
  };

  return keysByKid;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<AccessJwtPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Invalid Access JWT');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart<AccessJwtHeader>(encodedHeader);
  const payload = decodeJwtPart<AccessJwtPayload>(encodedPayload);

  if (header.alg !== 'RS256') throw new Error('Unsupported Access JWT algorithm');
  if (!header.kid) throw new Error('Missing Access JWT kid');

  const keysByKid = await getJwksKeysByKid(env);
  const jwk = keysByKid.get(header.kid);
  if (!jwk) {
    jwksCache = null;
    throw new Error('Unknown Access JWT key id');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlToBytes(encodedSignature);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signed);
  if (!ok) throw new Error('Invalid Access JWT signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && now >= payload.exp) throw new Error('Access JWT expired');
  if (payload.nbf !== undefined && now < payload.nbf) throw new Error('Access JWT not yet valid');

  const expectedIssuer = normalizedIssuer(env.ACCESS_ISSUER);
  if (expectedIssuer) {
    const tokenIssuer = normalizedIssuer(payload.iss);
    if (!tokenIssuer || tokenIssuer !== expectedIssuer) throw new Error('Invalid Access JWT issuer');
  }

  if (env.ACCESS_AUD) {
    const aud = payload.aud;
    const okAud = Array.isArray(aud) ? aud.includes(env.ACCESS_AUD) : aud === env.ACCESS_AUD;
    if (!okAud) throw new Error('Invalid Access JWT audience');
  }

  return payload;
}

function hasIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function isAdminPrincipal(payload: AccessJwtPayload, env: Env): boolean {
  const adminGroups = parseCsvSet(env.ACCESS_ADMIN_GROUPS);
  const adminEmails = parseCsvSet(env.ACCESS_ADMIN_EMAILS);
  const email = String(payload.email || '').toLowerCase();
  const groups = new Set((payload.groups || []).map((item) => String(item).toLowerCase()));

  if (email && adminEmails.has(email)) return true;
  if (adminGroups.size > 0 && hasIntersection(groups, adminGroups)) return true;

  return false;
}

function assertAccessJwtRuntimeConfig(env: Env): void {
  const errors = validateAlertAccessJwtConfig(env as unknown as Record<string, string | undefined>);
  if (errors.length === 0) return;
  throw new Error(`Access JWT configuration misconfigured: ${errors.join('; ')}`);
}

async function authorizeManualRun(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get('authorization') || '';
  if (env.ALERT_RUN_SECRET && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token && token === env.ALERT_RUN_SECRET) return true;
  }

  const requireJwt = (env.REQUIRE_ACCESS_JWT || '').toLowerCase() === 'true';
  if (!requireJwt) {
    return !env.ALERT_RUN_SECRET;
  }
  assertAccessJwtRuntimeConfig(env);

  const jwt = request.headers.get('CF-Access-Jwt-Assertion');
  if (!jwt) return false;

  try {
    const payload = await verifyAccessJwt(jwt, env);
    return isAdminPrincipal(payload, env);
  } catch {
    return false;
  }
}

async function executeWAESQL(sql: string, env: Env): Promise<WAERow[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return [];
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql })
    }
  );

  if (!response.ok) {
    throw new Error(`WAE SQL request failed (${response.status})`);
  }

  const body = await response.json() as { data?: WAERow[] };
  return body.data || [];
}

function maybeFilter(field: string, value?: string): string {
  if (!value) return '';
  return ` AND ${field} = '${value.replace(/'/g, "''")}'`;
}

function resolveAlertSQL(alert: Alert, params: Record<string, unknown>): string {
  const template = (alert.query_template || '').trim();
  if (/^select\s+/i.test(template)) {
    return template;
  }

  const windowMinutes = asPositiveInt(params.window_minutes ?? params.window ?? 5, 5);
  const service = typeof params.service === 'string' ? params.service : undefined;
  const env = typeof params.env === 'string' ? params.env : undefined;

  if (template === 'error_rate_over_threshold') {
    return `
      SELECT
        blob1 AS service,
        100.0 * SUM(CASE WHEN blob4 = 'error' THEN double1 ELSE 0 END) / NULLIF(SUM(double1), 0) AS value
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${maybeFilter('blob1', service)}
      ${maybeFilter('blob2', env)}
      GROUP BY service
      ORDER BY value DESC
      LIMIT 1
    `;
  }

  if (template === 'latency_p95_over_threshold') {
    return `
      SELECT
        blob1 AS service,
        APPROX_PERCENTILE(double3, 0.95) AS value
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
        AND double3 > 0
      ${maybeFilter('blob1', service)}
      ${maybeFilter('blob2', env)}
      GROUP BY service
      ORDER BY value DESC
      LIMIT 1
    `;
  }

  return template;
}

function numericValueFromRows(rows: WAERow[]): number {
  for (const row of rows) {
    if (typeof row.value === 'number' && Number.isFinite(row.value)) return row.value;

    for (const [key, candidate] of Object.entries(row)) {
      if (key === 'service' || key === 'env' || key === 'host') continue;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }
  }
  return 0;
}

function inferFingerprint(alertId: string, rows: WAERow[]): string {
  const top = rows[0] || {};
  const service = typeof top.service === 'string' ? top.service : 'global';
  return `${alertId}:${service}`;
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
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

async function tokenSpikeFromR2(alert: Alert, env: Env, params: Record<string, unknown>): Promise<EvaluationResult> {
  const token = String(params.token || '').toLowerCase().trim();
  if (!token) {
    return { value: 0, triggered: false };
  }

  const index = typeof params.index === 'string' ? normalizeIndexValue(params.index) : undefined;
  const service = typeof params.service === 'string' ? params.service : undefined;
  const envName = typeof params.env === 'string' ? params.env : undefined;
  const windowMinutes = asPositiveInt(params.window_minutes ?? 5, 5);

  const now = Date.now();
  const from = now - windowMinutes * 60 * 1000;

  const dateStrings = new Set<string>();
  for (const t of [from, now]) {
    dateStrings.add(new Date(t).toISOString().slice(0, 10));
  }

  let count = 0;
  for (const date of dateStrings) {
    const keys = await listAllKeys(env.RAW_BUCKET, `tokens/date=${date}/`);

    for (const key of keys) {
      if (index) {
        const keyIndexMatch = key.match(/\/index=([^/]+)\//);
        const keyIndex = normalizeIndexValue(keyIndexMatch ? decodeURIComponent(keyIndexMatch[1]) : DEFAULT_EVENT_INDEX);
        if (keyIndex !== index) continue;
      }
      if (service && !key.includes(`/service=${service}/`)) continue;
      if (envName && !key.includes(`/env=${envName}/`)) continue;

      const object = await env.RAW_BUCKET.get(key);
      if (!object) continue;

      const body = await object.text();
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;

        let row: { token?: string; index?: string; service?: string; env?: string; hour?: number };
        try {
          row = JSON.parse(line) as { token?: string; index?: string; service?: string; env?: string; hour?: number };
        } catch {
          continue;
        }

        if ((row.token || '').toLowerCase() !== token) continue;
        if (index && normalizeIndexValue(row.index) !== index) continue;
        if (service && row.service !== service) continue;
        if (envName && row.env !== envName) continue;

        // Token index stores date/hour but no exact timestamp; count hour buckets intersecting the window day.
        if (row.hour !== undefined) {
          const eventHour = Number(row.hour);
          const fromHour = new Date(from).getUTCHours();
          const toHour = new Date(now).getUTCHours();

          if (date === new Date(now).toISOString().slice(0, 10) && eventHour > toHour) continue;
          if (date === new Date(from).toISOString().slice(0, 10) && eventHour < fromHour) continue;
        }

        count += 1;
      }
    }
  }

  const threshold = safeJsonParse<Threshold>(alert.threshold_json, DEFAULT_THRESHOLD);
  const triggered = compareThreshold(count, threshold);
  const fingerprint = `${alert.id}:${token}:${service || 'all'}:${envName || 'all'}`;

  return {
    value: count,
    triggered,
    fingerprint,
    details: {
      index: index || null,
      token,
      service: service || null,
      env: envName || null,
      window_minutes: windowMinutes
    }
  };
}

async function evaluateAlert(alert: Alert, env: Env): Promise<EvaluationResult> {
  const params = safeJsonParse<Record<string, unknown>>(alert.params_json, {});
  const threshold = safeJsonParse<Threshold>(alert.threshold_json, DEFAULT_THRESHOLD);

  if (alert.type === 'r2sql_token_spike') {
    return tokenSpikeFromR2(alert, env, params);
  }

  const sql = resolveAlertSQL(alert, params);
  const rows = await executeWAESQL(sql, env);

  const value = numericValueFromRows(rows);
  const triggered = compareThreshold(value, threshold);

  return {
    value,
    triggered,
    fingerprint: inferFingerprint(alert.id, rows),
    details: {
      rows: rows.slice(0, 3)
    }
  };
}

async function getAlertState(alertId: string, env: Env): Promise<AlertState | null> {
  const state = await env.DB.prepare('SELECT * FROM alert_state WHERE alert_id = ?')
    .bind(alertId)
    .first<AlertState>();
  return state || null;
}

async function upsertAlertState(alertId: string, state: {
  lastEvaluatedAt: string;
  lastFiredAt: string | null;
  isFiring: number;
  value: number;
  fingerprint: string | null;
}, env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO alert_state (alert_id, last_evaluated_at, last_fired_at, is_firing, last_value_json, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(alert_id) DO UPDATE SET
      last_evaluated_at = excluded.last_evaluated_at,
      last_fired_at = excluded.last_fired_at,
      is_firing = excluded.is_firing,
      last_value_json = excluded.last_value_json,
      fingerprint = excluded.fingerprint
  `)
    .bind(
      alertId,
      state.lastEvaluatedAt,
      state.lastFiredAt,
      state.isFiring,
      JSON.stringify({ value: state.value }),
      state.fingerprint
    )
    .run();
}

function shouldRunNow(alert: Alert, state: AlertState | null, nowMs: number): boolean {
  const baseline = state?.last_evaluated_at || alert.created_at;
  const last = baseline ? new Date(baseline).getTime() : 0;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= Math.max(1, alert.schedule_seconds) * 1000;
}

async function sendNotification(alert: Alert, result: EvaluationResult, env: Env, resolved: boolean): Promise<void> {
  const notify = safeJsonParse<NotifyConfig>(alert.notify_json, {});
  const threshold = safeJsonParse<Threshold>(alert.threshold_json, DEFAULT_THRESHOLD);

  const payload = {
    alert_id: alert.id,
    alert: alert.name,
    state: resolved ? 'resolved' : 'firing',
    severity: notify.severity || 'warn',
    value: result.value,
    threshold,
    timestamp: nowIso(),
    deep_link: notify.deep_link || notify.dashboard_url || '',
    runbook_url: notify.runbook_url || '',
    owner_team: notify.owner_team || ''
  };

  if (notify.slack && env.SLACK_WEBHOOK_URL) {
    const text = `${resolved ? 'RESOLVED' : 'ALERT'} ${alert.name} value=${result.value}`;
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, payload })
    });
  }

  if (notify.webhook && env.WEBHOOK_URL) {
    await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
}

async function processAlert(alert: Alert, env: Env): Promise<void> {
  const state = await getAlertState(alert.id, env);
  const nowMs = Date.now();

  if (!shouldRunNow(alert, state, nowMs)) {
    return;
  }

  const evaluatedAt = nowIso();
  const result = await evaluateAlert(alert, env);

  const wasFiring = (state?.is_firing || 0) === 1;
  const lastFiredAtMs = state?.last_fired_at ? new Date(state.last_fired_at).getTime() : 0;
  const cooldownMs = Math.max(0, alert.cooldown_seconds) * 1000;
  const cooldownElapsed = !lastFiredAtMs || (nowMs - lastFiredAtMs >= cooldownMs);

  if (result.triggered) {
    const shouldNotify = !wasFiring || cooldownElapsed || (state?.fingerprint !== (result.fingerprint || null));

    if (shouldNotify) {
      await sendNotification(alert, result, env, false);
    }

    await upsertAlertState(
      alert.id,
      {
        lastEvaluatedAt: evaluatedAt,
        lastFiredAt: shouldNotify ? evaluatedAt : state?.last_fired_at || evaluatedAt,
        isFiring: 1,
        value: result.value,
        fingerprint: result.fingerprint || null
      },
      env
    );
    return;
  }

  if (wasFiring) {
    await sendNotification(alert, result, env, true);
  }

  await upsertAlertState(
    alert.id,
    {
      lastEvaluatedAt: evaluatedAt,
      lastFiredAt: state?.last_fired_at || null,
      isFiring: 0,
      value: result.value,
      fingerprint: result.fingerprint || null
    },
    env
  );
}

async function runAlertEvaluation(env: Env): Promise<{ evaluated: number; failed: number }> {
  const rows = await env.DB.prepare('SELECT * FROM alerts WHERE enabled = 1').all<Alert>();
  const alerts = rows.results || [];

  let evaluated = 0;
  let failed = 0;

  for (const alert of alerts) {
    try {
      await processAlert(alert, env);
      evaluated += 1;
    } catch (error) {
      failed += 1;
      console.error(`Alert ${alert.id} evaluation failed`, error);
    }
  }

  return { evaluated, failed };
}

interface ScheduledSearch {
  id: string;
  name: string;
  ppl: string;
  time_window_minutes: number;
  schedule_cron: string;
  enabled: number;
  actions_json: string;
  max_results: number;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface ScheduledSearchAction {
  type: 'summary' | 'slack' | 'webhook';
  retain_days?: number;
  webhook_url?: string;
  url?: string;
  method?: string;
  template?: string;
}

function cronMatchesNow(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minPart, hourPart, , , ] = parts;
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();

  const matchesPart = (part: string, value: number): boolean => {
    if (part === '*') return true;
    if (part.includes('/')) {
      const [, step] = part.split('/');
      return value % (parseInt(step, 10) || 1) === 0;
    }
    if (part.includes(',')) {
      return part.split(',').some(p => parseInt(p, 10) === value);
    }
    return parseInt(part, 10) === value;
  };

  return matchesPart(minPart, minute) && matchesPart(hourPart, hour);
}

async function processScheduledSearch(search: ScheduledSearch, env: Env): Promise<void> {
  const now = new Date();
  const timeTo = now.toISOString();
  const timeFrom = new Date(now.getTime() - search.time_window_minutes * 60 * 1000).toISOString();
  const queryWorkerSearchUrl = resolveQueryWorkerSearchUrl(env.QUERY_WORKER_URL);
  const resultId = crypto.randomUUID();
  const actions = safeJsonParse<ScheduledSearchAction[]>(search.actions_json, []);

  let results: Record<string, unknown>[] = [];
  let status = 'success';
  let errorMessage: string | null = null;

  try {
    const queryWorkerToken = String(env.QUERY_WORKER_TOKEN || '').trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Internal-Caller': 'alert-worker'
    };
    if (queryWorkerToken) {
      headers.Authorization = `Bearer ${queryWorkerToken}`;
    }

    const response = await fetch(queryWorkerSearchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildScheduledSearchQueryRequest({
        ppl: search.ppl,
        maxResults: search.max_results,
        from: timeFrom,
        to: timeTo
      }))
    });
    if (response.ok) {
      const body = await response.json() as { results?: Record<string, unknown>[]; events?: Record<string, unknown>[] };
      results = (body.results || body.events || []).slice(0, search.max_results);
    } else {
      const responseText = (await response.text().catch(() => '')).trim();
      const detail = responseText ? ` body=${responseText.slice(0, 180)}` : '';
      throw new Error(`Query worker returned ${response.status} url=${queryWorkerSearchUrl}${detail}`);
    }
  } catch (err) {
    status = 'error';
    errorMessage = String(err);
  }

  const resultCount = results.length;
  const statsJson = JSON.stringify({ duration_ms: Date.now() - now.getTime(), scanned: resultCount });

  await env.DB.prepare(
    `INSERT INTO scheduled_search_results (id, scheduled_search_id, run_at, time_from, time_to, status, result_count, results_json, stats_json, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    resultId, search.id, timeTo, timeFrom, timeTo, status, resultCount,
    JSON.stringify(results.slice(0, 100)),
    statsJson, errorMessage, timeTo
  ).run();

  for (const action of actions) {
    try {
      if (action.type === 'slack' && action.webhook_url) {
        const text = (action.template || 'Scheduled search "{{name}}" found {{result_count}} results')
          .replace(/\{\{name\}\}/g, search.name)
          .replace(/\{\{result_count\}\}/g, String(resultCount));
        await fetch(action.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
      } else if (action.type === 'webhook' && action.url) {
        await fetch(action.url, {
          method: action.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduled_search_id: search.id,
            name: search.name,
            run_at: timeTo,
            result_count: resultCount,
            results: results.slice(0, 10)
          })
        });
      }
    } catch {
      // action dispatch is best-effort
    }
  }

  const retainDays = actions.find(a => a.retain_days)?.retain_days || 30;
  const cutoff = new Date(now.getTime() - retainDays * 86400000).toISOString();
  await env.DB.prepare(
    'DELETE FROM scheduled_search_results WHERE scheduled_search_id = ? AND created_at < ?'
  ).bind(search.id, cutoff).run();
}

async function runScheduledSearches(env: Env): Promise<{ ran: number; failed: number }> {
  const now = new Date();
  const rows = await env.DB.prepare('SELECT * FROM scheduled_searches WHERE enabled = 1').all<ScheduledSearch>();
  const searches = rows.results || [];

  let ran = 0;
  let failed = 0;

  for (const search of searches) {
    if (!cronMatchesNow(search.schedule_cron, now)) continue;

    const lastRun = await env.DB.prepare(
      'SELECT run_at FROM scheduled_search_results WHERE scheduled_search_id = ? ORDER BY run_at DESC LIMIT 1'
    ).bind(search.id).first<{ run_at: string }>();

    if (lastRun) {
      const lastMs = new Date(lastRun.run_at).getTime();
      if (now.getTime() - lastMs < 55000) continue;
    }

    try {
      await processScheduledSearch(search, env);
      ran += 1;
    } catch (error) {
      failed += 1;
      console.error(`Scheduled search ${search.id} failed`, error);
    }
  }

  return { ran, failed };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'alert-worker', version: '1.2.0' });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      let authorized = false;
      try {
        authorized = await authorizeManualRun(request, env);
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 });
      }
      if (!authorized) {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
      try {
        const result = await runAlertEvaluation(env);
        return Response.json({ ok: true, ...result });
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        runAlertEvaluation(env).then((result) => {
          console.log(`alerts evaluated=${result.evaluated} failed=${result.failed}`);
        }),
        runScheduledSearches(env).then((result) => {
          if (result.ran > 0 || result.failed > 0) {
            console.log(`scheduled_searches ran=${result.ran} failed=${result.failed}`);
          }
        }).catch((err) => {
          console.error('scheduled search cycle failed', err);
        })
      ])
    );
  }
};
