/**
 * Investigation acceleration pack: request validation and normalization helpers.
 * Used by bootstrap, related-events, and session endpoints.
 */

import { parseISODate } from './query-core.mjs';

const BOOTSTRAP_MAX_WINDOW_HOURS = 6;
const RELATED_EVENTS_MAX_WINDOW_HOURS = 6;
const RELATED_EVENTS_MAX_CANDIDATES = 100;
const SESSION_STATE_MAX_BYTES = 65536; // 64KB
const SESSION_SCOPE_MAX_BYTES = 65536; // 64KB

/** Safe pattern for PPL interpolation: alphanumeric, dot, underscore, hyphen. Max 64 chars. */
const SCOPE_VALUE_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Validates a scope value for safe use in PPL string interpolation.
 * Rejects quotes, backslash, pipe, semicolon, newlines, and other unsafe chars.
 * @param {string} value
 * @param {string} fieldName
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
function validateScopeValue(value, fieldName) {
  const s = String(value || '').trim();
  if (!s) return { ok: false, error: `${fieldName} is required` };
  if (!SCOPE_VALUE_PATTERN.test(s)) {
    return { ok: false, error: `${fieldName} contains invalid characters (allowed: a-z, A-Z, 0-9, ., _, -)` };
  }
  return { ok: true };
}

const ALLOWED_SESSION_KEYS = new Set([
  'id', 'owner_user_id', 'source_type', 'scope_json', 'state_json', 'created_at', 'expires_at'
]);

function parseTimeWindow(fromIso, toIso, maxHours) {
  const from = parseISODate(fromIso).getTime();
  const to = parseISODate(toIso).getTime();
  if (from > to) {
    throw new Error('Invalid time range: from must be before to');
  }
  const hours = (to - from) / (1000 * 60 * 60);
  if (hours > maxHours) {
    throw new Error(`Time window limited to ${maxHours} hours`);
  }
}

/**
 * Validates bootstrap request body. Required: source, time (from/to), scope (service).
 * Time window capped at 6 hours.
 * @param {unknown} body
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
export function validateBootstrapRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object' };
  }

  const b = /** @type {Record<string, unknown>} */ (body);

  if (!b.source || typeof b.source !== 'string' || !String(b.source).trim()) {
    return { ok: false, error: 'source is required' };
  }

  const time = b.time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) {
    return { ok: false, error: 'time is required with from and to' };
  }
  const t = /** @type {Record<string, unknown>} */ (time);
  const from = t.from;
  const to = t.to;
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
    return { ok: false, error: 'time must have from and to ISO strings' };
  }
  try {
    parseTimeWindow(String(from), String(to), BOOTSTRAP_MAX_WINDOW_HOURS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid time range' };
  }

  const scope = b.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return { ok: false, error: 'scope is required' };
  }
  const s = /** @type {Record<string, unknown>} */ (scope);
  if (!s.service || typeof s.service !== 'string' || !String(s.service).trim()) {
    return { ok: false, error: 'scope.service is required' };
  }

  const serviceResult = validateScopeValue(s.service, 'scope.service');
  if (!serviceResult.ok) return serviceResult;

  if (s.index !== undefined && s.index !== null && String(s.index).trim()) {
    const indexResult = validateScopeValue(String(s.index).trim(), 'scope.index');
    if (!indexResult.ok) return indexResult;
  }
  if (s.env !== undefined && s.env !== null && String(s.env).trim()) {
    const envResult = validateScopeValue(String(s.env).trim(), 'scope.env');
    if (!envResult.ok) return envResult;
  }

  return { ok: true };
}

/**
 * Builds the bootstrap response payload from a validated request body.
 * Returns normalized scope, starter panel query definitions, and recommended pivot chips.
 * @param {Record<string, unknown>} body - Validated body (source, time, scope, optional pivots)
 * @returns {{ scope: object; starter_queries: object[]; pivot_chips: object[] }}
 */
export function buildBootstrapPayload(body) {
  const scope = body.scope && typeof body.scope === 'object' && !Array.isArray(body.scope)
    ? body.scope
    : {};
  const index = String(scope.index || 'default').trim() || 'default';
  const service = String(scope.service || '').trim() || 'unknown';
  const env = String(scope.env || '').trim() || 'prod';

  const normalizedScope = { index, service, env };

  const pivots = normalizePivots(body.pivots);
  const pivotChips = [];
  for (const [key, value] of Object.entries(pivots)) {
    if (value) pivotChips.push({ key, value });
  }

  const starterQueries = [
    { id: 'errors', title: 'Errors', ppl: `search * | where level="error" | where index="${index}" and service="${service}" and env="${env}" | head 50` },
    { id: 'latency', title: 'Latency', ppl: `search * | where duration_ms>0 | where index="${index}" and service="${service}" and env="${env}" | stats avg(duration_ms) by host | sort -avg_duration_ms | head 20` },
    { id: 'volume', title: 'Volume', ppl: `search * | where index="${index}" and service="${service}" and env="${env}" | timechart span=5m count() | head 100` }
  ];

  const timeline = buildBootstrapTimeline(body.time);

  return {
    scope: normalizedScope,
    starter_queries: starterQueries,
    pivot_chips: pivotChips,
    timeline
  };
}

/**
 * Builds a lightweight placeholder timeline from time range.
 * Deterministic: 5-minute buckets, count 0. Max 72 buckets.
 * @param {{ from?: string; to?: string }} time - Time range from validated request
 * @returns {Array<{ minute: string; count: number }>}
 */
function buildBootstrapTimeline(time) {
  if (!time || typeof time !== 'object' || !time.from || !time.to) {
    return [];
  }
  const fromMs = parseISODate(String(time.from)).getTime();
  const toMs = parseISODate(String(time.to)).getTime();
  if (fromMs >= toMs) return [];
  const BUCKET_MS = 5 * 60 * 1000;
  const MAX_BUCKETS = 72;
  const buckets = [];
  let t = Math.floor(fromMs / BUCKET_MS) * BUCKET_MS;
  while (t < toMs && buckets.length < MAX_BUCKETS) {
    const d = new Date(t);
    const minute = d.toISOString().slice(0, 16) + ':00Z';
    buckets.push({ minute, count: 0 });
    t += BUCKET_MS;
  }
  return buckets;
}

/**
 * Normalizes pivot fields for trace_id, request_id, user_id, msg_hash.
 * Trims whitespace, drops empty strings, ignores extra keys.
 * @param {unknown} input
 * @returns {{ trace_id?: string; request_id?: string; user_id?: string; msg_hash?: string }}
 */
export function normalizePivots(input) {
  if (input === null || input === undefined) {
    return {};
  }
  const obj = typeof input === 'object' && !Array.isArray(input) ? input : {};
  const keys = ['trace_id', 'request_id', 'user_id', 'msg_hash'];
  const result = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) result[k] = s;
  }
  return result;
}

/**
 * Validates related-events request body. Required: scope, time (from/to).
 * Time window capped at 6 hours, max_candidates capped at 100.
 * @param {unknown} body
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
export function validateRelatedEventsRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object' };
  }

  const b = /** @type {Record<string, unknown>} */ (body);

  const scope = b.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return { ok: false, error: 'scope is required' };
  }
  const s = /** @type {Record<string, unknown>} */ (scope);
  if (!s.service || typeof s.service !== 'string' || !String(s.service).trim()) {
    return { ok: false, error: 'scope.service is required' };
  }

  const serviceResult = validateScopeValue(s.service, 'scope.service');
  if (!serviceResult.ok) return serviceResult;

  if (s.index !== undefined && s.index !== null && String(s.index).trim()) {
    const indexResult = validateScopeValue(String(s.index).trim(), 'scope.index');
    if (!indexResult.ok) return indexResult;
  }
  if (s.env !== undefined && s.env !== null && String(s.env).trim()) {
    const envResult = validateScopeValue(String(s.env).trim(), 'scope.env');
    if (!envResult.ok) return envResult;
  }

  const time = b.time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) {
    return { ok: false, error: 'time is required with from and to' };
  }
  const t = /** @type {Record<string, unknown>} */ (time);
  const from = t.from;
  const to = t.to;
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
    return { ok: false, error: 'time must have from and to ISO strings' };
  }
  try {
    parseTimeWindow(String(from), String(to), RELATED_EVENTS_MAX_WINDOW_HOURS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid time range' };
  }

  const maxCandidates = b.max_candidates;
  if (maxCandidates !== undefined) {
    const n = Number(maxCandidates);
    if (!Number.isFinite(n) || n < 1 || n > RELATED_EVENTS_MAX_CANDIDATES) {
      return { ok: false, error: `max_candidates must be between 1 and ${RELATED_EVENTS_MAX_CANDIDATES}` };
    }
  }

  return { ok: true };
}

/** Pivot keys used for exact matching. */
const PIVOT_KEYS = ['trace_id', 'request_id', 'user_id', 'msg_hash'];

/**
 * Ranks candidate events by relatedness to pivots. Exact pivot match ranks above token overlap.
 * Enforces candidate cap. Deterministic and bounded.
 * @param {{ trace_id?: string; request_id?: string; user_id?: string; msg_hash?: string }} pivots
 * @param {string[]} pivotTokens - Tokens from pivot event for overlap scoring
 * @param {Array<{ id?: string; trace_id?: string; request_id?: string; user_id?: string; msg_hash?: string; tokens?: string[] }>} candidates
 * @param {{ maxCandidates?: number }} options
 * @returns {Array<{ event: object; match_reason: 'exact_pivot_match' | 'token_overlap' }>}
 */
export function rankRelatedEvents(pivots, pivotTokens, candidates, options = {}) {
  const maxCandidates = Math.min(
    options.maxCandidates ?? RELATED_EVENTS_MAX_CANDIDATES,
    RELATED_EVENTS_MAX_CANDIDATES
  );
  const pivotTokenSet = new Set((pivotTokens || []).filter(Boolean));

  const scored = [];
  for (const ev of candidates || []) {
    let matchReason = null;

    for (const k of PIVOT_KEYS) {
      const pv = pivots?.[k];
      if (!pv) continue;
      const evVal = ev[k];
      if (evVal != null && String(evVal).trim() === String(pv).trim()) {
        matchReason = 'exact_pivot_match';
        break;
      }
    }

    if (!matchReason && pivotTokenSet.size > 0) {
      const evTokens = ev.tokens || [];
      for (const t of evTokens) {
        if (pivotTokenSet.has(t)) {
          matchReason = 'token_overlap';
          break;
        }
      }
    }

    if (matchReason) {
      scored.push({ event: ev, match_reason: matchReason });
    }
  }

  scored.sort((a, b) => {
    const order = { exact_pivot_match: 0, token_overlap: 1 };
    return (order[a.match_reason] ?? 2) - (order[b.match_reason] ?? 2);
  });

  return scored.slice(0, maxCandidates);
}

/**
 * Validates session save request body. Accepts scope/scope_json and state/state_json.
 * Enforces state_json size limit (64KB). Returns normalized scope_json, state_json, source_type, expires_at.
 * @param {unknown} body
 * @returns {{ ok: true; scope_json: string; state_json: string; source_type?: string; expires_at?: string | null } | { ok: false; error: string }}
 */
export function validateSessionSaveRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object' };
  }

  const b = /** @type {Record<string, unknown>} */ (body);

  let scopeJson;
  if (b.scope_json !== undefined && b.scope_json !== null) {
    scopeJson = typeof b.scope_json === 'string' ? b.scope_json : JSON.stringify(b.scope_json);
  } else if (b.scope !== undefined && b.scope !== null && typeof b.scope === 'object' && !Array.isArray(b.scope)) {
    scopeJson = JSON.stringify(b.scope);
  } else {
    return { ok: false, error: 'scope or scope_json is required' };
  }

  const scopeByteLength = new TextEncoder().encode(scopeJson).length;
  if (scopeByteLength > SESSION_SCOPE_MAX_BYTES) {
    return { ok: false, error: `scope_json exceeds size limit (${SESSION_SCOPE_MAX_BYTES} bytes)` };
  }

  let stateJson;
  if (b.state_json !== undefined && b.state_json !== null) {
    stateJson = typeof b.state_json === 'string' ? b.state_json : JSON.stringify(b.state_json);
  } else if (b.state !== undefined && b.state !== null) {
    stateJson = typeof b.state === 'object' ? JSON.stringify(b.state) : String(b.state);
  } else {
    return { ok: false, error: 'state or state_json is required' };
  }

  const byteLength = new TextEncoder().encode(stateJson).length;
  if (byteLength > SESSION_STATE_MAX_BYTES) {
    return { ok: false, error: `state_json exceeds size limit (${SESSION_STATE_MAX_BYTES} bytes)` };
  }

  const result = { ok: true, scope_json: scopeJson, state_json: stateJson };
  if (b.source_type !== undefined && b.source_type !== null) {
    result.source_type = String(b.source_type);
  }
  if (b.expires_at !== undefined) {
    result.expires_at = b.expires_at === null ? null : String(b.expires_at);
  }
  return result;
}

/**
 * Checks if a principal can access an investigation session (owner or admin).
 * @param {string | null | undefined} ownerUserId - Session owner
 * @param {string} principal - Current user principal
 * @param {boolean} isAdmin - Whether user has admin/superadmin role
 * @returns {boolean}
 */
export function canAccessInvestigationSession(ownerUserId, principal, isAdmin) {
  if (isAdmin) return true;
  if (ownerUserId == null || !String(ownerUserId).trim()) return false;
  return String(ownerUserId).trim() === String(principal).trim();
}

/**
 * Builds a safe session record for D1 insert. Enforces allowed keys and state_json size.
 * @param {unknown} input
 * @returns {{ ok: true; id: string; owner_user_id?: string; source_type?: string; scope_json: string; state_json: string; created_at: string; expires_at?: string | null } | { ok: false; error: string }}
 */
export function buildSessionRecord(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Input must be an object' };
  }

  const obj = /** @type {Record<string, unknown>} */ (input);

  const id = obj.id;
  if (!id || typeof id !== 'string' || !String(id).trim()) {
    return { ok: false, error: 'id is required' };
  }

  const scopeJson = obj.scope_json;
  if (scopeJson === undefined || scopeJson === null) {
    return { ok: false, error: 'scope_json is required' };
  }
  const scopeStr = typeof scopeJson === 'string' ? scopeJson : JSON.stringify(scopeJson);

  const stateJson = obj.state_json;
  if (stateJson === undefined || stateJson === null) {
    return { ok: false, error: 'state_json is required' };
  }
  const stateStr = typeof stateJson === 'string' ? stateJson : JSON.stringify(stateJson);

  const byteLength = new TextEncoder().encode(stateStr).length;
  if (byteLength > SESSION_STATE_MAX_BYTES) {
    return { ok: false, error: `state_json exceeds size limit (${SESSION_STATE_MAX_BYTES} bytes)` };
  }

  const createdAt = obj.created_at;
  if (!createdAt || typeof createdAt !== 'string' || !String(createdAt).trim()) {
    return { ok: false, error: 'created_at is required' };
  }

  const record = {};
  for (const k of ALLOWED_SESSION_KEYS) {
    const v = obj[k];
    if (v === undefined) continue;
    if (k === 'scope_json') record[k] = scopeStr;
    else if (k === 'state_json') record[k] = stateStr;
    else if (k === 'expires_at') record[k] = v === null ? null : String(v);
    else record[k] = v;
  }
  record.id = String(id).trim();
  record.scope_json = scopeStr;
  record.state_json = stateStr;
  record.created_at = String(createdAt).trim();
  record.owner_user_id = obj.owner_user_id !== undefined ? String(obj.owner_user_id) : undefined;
  record.source_type = obj.source_type !== undefined ? String(obj.source_type) : undefined;
  record.expires_at = obj.expires_at === null ? null : (obj.expires_at !== undefined ? String(obj.expires_at) : undefined);

  return { ok: true, ...record };
}
