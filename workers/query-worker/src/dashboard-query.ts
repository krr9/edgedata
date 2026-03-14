/**
 * Dashboard query handlers and cache/policy helpers.
 * Extracted from query-worker index.
 */

import type {
  AuthContext,
  DashboardBatchWidgetRequest,
  DashboardBatchWidgetResult,
  DashboardPanelRow,
  DataScope,
  Env,
  ExecutionPolicy,
  MaterializedResultRow,
  PplPipeline,
  PplSearchRequest,
  PplSearchResponse,
  SearchEvent,
  SearchFilters,
  SearchRequest
} from './types.js';
import { MAX_SUMMARY_EVENTS, PPL_MAX_LIMIT } from './types.js';
import { jsonResponse } from './helpers.js';
import {
  DEFAULT_DASHBOARD_EXECUTION_POLICY
} from './helpers.js';
import { asPositiveInt, clampLimit } from './helpers.js';
import {
  buildSearchContext,
  createTimingTracker,
  nextCursor,
  normalizeIndexValue,
  snapshotTimingTracker
} from './search-engine.js';
import { buildScopeKey } from '../../shared/materialization-core.mjs';
import {
  buildMaterializationBucket,
  hashQueryText
} from '../../shared/materialization-core.mjs';
import {
  cacheShardNameForKey,
  normalizeBooleanFlag,
  normalizeCacheTtlSeconds,
  normalizeExecutionMode,
  normalizeMaterializeIntervalSeconds,
  normalizeMaxStalenessSeconds
} from './performance-policy.mjs';
import {
  applyPplPipelineStages,
  buildSearchRequestFromPpl,
  buildWaeScopeWhere,
  computeDashboardFallback,
  executeSearchWithContext,
  executeWAESQL,
  isPplTableQuery,
  loadLookupCache,
  performPplSearch
} from './search-ppl.js';
import { parsePplPipeline } from './ppl-core.mjs';
import { matchesScopedValue } from './auth.js';
import { writeScanMetrics } from './rbac.js';

const DASHBOARD_QUERY_CACHE_TTL_SECONDS = 120;
const DASHBOARD_QUERY_CACHE_BUCKET_SECONDS = 120;

export function buildScopeCacheKey(scope: DataScope): string {
  return buildScopeKey(scope);
}

export function asDashboardCacheShardCount(env: Env): number {
  const parsed = Number(env.DASHBOARD_CACHE_SHARDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 16;
  return Math.min(256, Math.max(1, Math.trunc(parsed)));
}

export function getDashboardCacheStub(env: Env, key: string): DurableObjectStub {
  const shardName = cacheShardNameForKey(key, asDashboardCacheShardCount(env));
  return env.DASHBOARD_CACHE.get(env.DASHBOARD_CACHE.idFromName(shardName));
}

export function normalizeExecutionPolicyRow(row: {
  execution_mode?: string | null;
  cache_ttl_seconds?: number | null;
  materialize_enabled?: number | boolean | null;
  materialize_interval_seconds?: number | null;
  max_staleness_seconds?: number | null;
  priority?: number | null;
}): ExecutionPolicy {
  return {
    execution_mode: normalizeExecutionMode(row.execution_mode, DEFAULT_DASHBOARD_EXECUTION_POLICY.execution_mode) as import('./types.js').ExecutionMode,
    cache_ttl_seconds: normalizeCacheTtlSeconds(row.cache_ttl_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.cache_ttl_seconds),
    materialize_enabled: normalizeBooleanFlag(row.materialize_enabled, DEFAULT_DASHBOARD_EXECUTION_POLICY.materialize_enabled),
    materialize_interval_seconds: normalizeMaterializeIntervalSeconds(row.materialize_interval_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.materialize_interval_seconds),
    max_staleness_seconds: normalizeMaxStalenessSeconds(row.max_staleness_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.max_staleness_seconds),
    priority: Number.isFinite(Number(row.priority)) ? Math.max(0, Math.trunc(Number(row.priority))) : DEFAULT_DASHBOARD_EXECUTION_POLICY.priority
  };
}

export function isWidgetCacheEnabled(policy: ExecutionPolicy): boolean {
  return policy.execution_mode !== 'live' || policy.materialize_enabled;
}

export async function loadDashboardPanelPolicies(
  env: Env,
  widgetIds: string[]
): Promise<Map<string, ExecutionPolicy>> {
  const ids = Array.from(new Set(widgetIds.map((value) => String(value || '').trim()).filter(Boolean)));
  const policies = new Map<string, ExecutionPolicy>();
  if (ids.length === 0) return policies;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT id, execution_mode, cache_ttl_seconds, materialize_enabled, materialize_interval_seconds, max_staleness_seconds, priority
     FROM dashboard_panels
     WHERE id IN (${placeholders})`
  ).bind(...ids).all<DashboardPanelRow>();

  for (const row of rows.results || []) {
    policies.set(row.id, normalizeExecutionPolicyRow(row));
  }

  return policies;
}

export async function readMaterializedWidgetResult(
  env: Env,
  req: PplSearchRequest,
  scope: DataScope,
  widgetId: string,
  policy: ExecutionPolicy
): Promise<PplSearchResponse | null> {
  if (!policy.materialize_enabled && policy.execution_mode !== 'materialized') {
    return null;
  }

  const bucket = buildMaterializationBucket(req.time, policy.materialize_interval_seconds);
  const scopeKey = buildScopeCacheKey(scope);
  const queryHash = hashQueryText(req.ppl);
  const row = await env.DB.prepare(
    `SELECT *
     FROM materialized_results
     WHERE entity_type = 'dashboard_panel'
       AND entity_id = ?
       AND scope_key = ?
       AND query_hash = ?
       AND time_bucket_start = ?
       AND time_bucket_end = ?
     ORDER BY computed_at DESC
     LIMIT 1`
  ).bind(widgetId, scopeKey, queryHash, bucket.time_bucket_start, bucket.time_bucket_end).first<MaterializedResultRow>();

  if (!row?.payload_inline_json) return null;

  let payload: PplSearchResponse;
  try {
    payload = JSON.parse(row.payload_inline_json) as PplSearchResponse;
  } catch {
    return null;
  }

  const computedAtMs = Date.parse(row.computed_at);
  const expiresAtMs = Date.parse(row.expires_at);
  const now = Date.now();
  if (!Number.isFinite(computedAtMs) || !Number.isFinite(expiresAtMs)) return null;

  const freshnessBudgetMs = policy.max_staleness_seconds * 1000;
  const isFresh = expiresAtMs > now;
  const isStaleButAllowed = computedAtMs + freshnessBudgetMs > now;
  if (!isFresh && !isStaleButAllowed) return null;

  return {
    ...payload,
    source: isFresh ? 'materialized' : 'stale_materialized',
    computed_at: row.computed_at,
    expires_at: row.expires_at,
    materialization_status: isFresh ? 'fresh' : 'stale'
  };
}

export function normalizePplForCache(ppl: string): string {
  return ppl.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildDashboardWidgetCacheKey(req: PplSearchRequest, scope: DataScope, widgetId: string | null): string {
  const fromMs = Date.parse(req.time.from);
  const toMs = Date.parse(req.time.to);
  const windowMs = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs ? toMs - fromMs : 0;
  const toBucket = Number.isFinite(toMs) ? Math.floor(toMs / (DASHBOARD_QUERY_CACHE_BUCKET_SECONDS * 1000)) : 0;
  return [
    `wid:${widgetId || '_'}`,
    `ppl:${normalizePplForCache(req.ppl)}`,
    `wm:${windowMs}`,
    `tb:${toBucket}`,
    `sc:${buildScopeCacheKey(scope)}`
  ].join('|');
}

export function intersectSharedFilters(filtersList: SearchFilters[]): SearchFilters {
  if (filtersList.length === 0) return {};
  const keys = new Set<string>(Object.keys(filtersList[0]));
  for (let i = 1; i < filtersList.length; i++) {
    for (const key of Array.from(keys)) {
      if (!(key in filtersList[i]) || filtersList[i][key as keyof SearchFilters] !== filtersList[0][key as keyof SearchFilters]) {
        keys.delete(key);
      }
    }
  }
  const shared: SearchFilters = {};
  for (const key of keys) {
    const value = filtersList[0][key as keyof SearchFilters];
    if (value !== undefined) {
      shared[key as keyof SearchFilters] = value as never;
    }
  }
  return shared;
}

export function canShareDashboardWidgetBase(
  compiledRequests: SearchRequest[],
  sharedFilters: SearchFilters
): boolean {
  if (compiledRequests.length <= 1) return false;
  const firstQ = compiledRequests[0]?.q || '';
  if (!compiledRequests.every((req) => (req.q || '') === firstQ)) return false;
  return Boolean(sharedFilters.index || sharedFilters.service || firstQ.trim());
}

export async function executeSharedDashboardWidgetGroup(
  widgets: Array<{ widgetId: string; request: PplSearchRequest; pipeline: PplPipeline; compiled: SearchRequest }>,
  env: Env,
  auth: AuthContext
): Promise<Record<string, DashboardBatchWidgetResult>> {
  const results: Record<string, DashboardBatchWidgetResult> = {};
  const sharedFilters = intersectSharedFilters(widgets.map((widget) => widget.compiled.filters || {}));
  if (!canShareDashboardWidgetBase(widgets.map((widget) => widget.compiled), sharedFilters)) {
    for (const widget of widgets) {
      try {
        results[widget.widgetId] = { response: await performPplSearch(widget.request, env, auth) };
      } catch (error) {
        results[widget.widgetId] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return results;
  }

  const baseRequest: SearchRequest = {
    time: widgets[0].request.time,
    q: widgets[0].compiled.q,
    filters: sharedFilters,
    limit: MAX_SUMMARY_EVENTS,
    cursor: null
  };
  const sharedStartedAt = Date.now();
  const timing = createTimingTracker();
  const baseContext = buildSearchContext(baseRequest, auth);
  const baseExecution = await executeSearchWithContext(baseContext, env, auth, null, MAX_SUMMARY_EVENTS, timing);

  for (const widget of widgets) {
    try {
      const postPipelineStartedAt = Date.now();
      const lookupCache = await loadLookupCache(widget.pipeline, env);
      const transformed = applyPplPipelineStages(baseExecution.results, widget.pipeline, lookupCache);
      const widgetTiming = {
        ...timing,
        postPipelineMs: timing.postPipelineMs + (Date.now() - postPipelineStartedAt)
      };
      const requestedLimit = clampLimit(widget.request.limit, PPL_MAX_LIMIT);
      const rows = transformed.rows.slice(0, requestedLimit);
      const nextCursorValue = transformed.resultType === 'events'
        ? nextCursor(rows as SearchEvent[])
        : null;
      results[widget.widgetId] = {
        response: {
          result_type: transformed.resultType,
          results: rows,
          next_cursor: nextCursorValue,
          source: 'live',
          materialization_status: 'disabled',
          stats: {
            mode: baseContext.mode,
            scanned_partitions: baseContext.dates.length,
            scanned_objects: baseExecution.scannedObjects,
            listed_prefixes: baseExecution.listing.listed_prefixes,
            listing_calls: baseExecution.listing.listing_calls,
            listed_objects: baseExecution.listing.listed_objects,
            listing_fallbacks: baseExecution.listing.listing_fallbacks,
            candidates: baseExecution.candidates,
            returned: rows.length,
            execution_path: 'shared_base',
            timing_ms: snapshotTimingTracker(widgetTiming, Date.now() - sharedStartedAt),
            language: 'ppl',
            stage_count: widget.pipeline.stages.length
          },
          warning: baseExecution.results.length >= MAX_SUMMARY_EVENTS && isPplTableQuery(widget.pipeline.stages)
            ? `PPL pipeline evaluated on first ${MAX_SUMMARY_EVENTS} matched events`
            : undefined
        }
      };
    } catch (error) {
      results[widget.widgetId] = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return results;
}

export function hashCacheKey(raw: string): string {
  // Deterministic lightweight hash for debug visibility.
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function getDashboardCachePayload(
  env: Env,
  key: string
): Promise<{ hit: boolean; payload?: PplSearchResponse }> {
  try {
    const stub = getDashboardCacheStub(env, key);
    const response = await stub.fetch(`https://dashboard-cache/cache/get?key=${encodeURIComponent(key)}`);
    if (!response.ok) return { hit: false };
    const body = await response.json() as { hit?: boolean; payload?: PplSearchResponse };
    if (!body.hit || !body.payload) return { hit: false };
    return { hit: true, payload: body.payload };
  } catch {
    return { hit: false };
  }
}

export async function setDashboardCachePayload(
  env: Env,
  key: string,
  payload: PplSearchResponse,
  ttlSeconds = DASHBOARD_QUERY_CACHE_TTL_SECONDS
): Promise<void> {
  try {
    const stub = getDashboardCacheStub(env, key);
    await stub.fetch('https://dashboard-cache/cache/set', {
      method: 'POST',
      body: JSON.stringify({
        key,
        ttl_seconds: normalizeCacheTtlSeconds(ttlSeconds, DASHBOARD_QUERY_CACHE_TTL_SECONDS),
        payload
      })
    });
  } catch {
    // cache failures are non-fatal
  }
}

export async function handleDashboardQuery(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { query: string; params?: Record<string, unknown> };
  const query = String(body.query || '').trim();
  const params = body.params || {};
  const windowMinutes = asPositiveInt(params.window_minutes, 60, 24 * 60);
  const requestedIndex = typeof params.index === 'string'
    ? normalizeIndexValue(params.index)
    : undefined;
  const scope: DataScope = requestedIndex
    ? { ...auth.scope, indexes: [requestedIndex] }
    : auth.scope;

  if (requestedIndex && !matchesScopedValue(requestedIndex, auth.scope.indexes)) {
    return jsonResponse({ error: 'Forbidden: index outside role scope', results: [] }, 403, requestCorsHeaders);
  }

  if (!query) {
    return jsonResponse({ error: 'query is required', results: [] }, 400, requestCorsHeaders);
  }

  const scopeCacheKey = buildScopeCacheKey(scope);
  const cacheApi = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = '/__cache/dashboard-query';
  cacheKeyUrl.searchParams.set('query', query);
  cacheKeyUrl.searchParams.set('window_minutes', String(windowMinutes));
  if (requestedIndex) cacheKeyUrl.searchParams.set('index', requestedIndex);
  cacheKeyUrl.searchParams.set('scope', scopeCacheKey);
  const cacheRequest = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  if (cacheApi) {
    const cached = await cacheApi.match(cacheRequest);
    if (cached) {
      const cachedBody = await cached.json() as {
        results: Array<Record<string, unknown>>;
        source?: string;
        warning?: string;
      };
      return jsonResponse({
        ...cachedBody,
        cache: 'hit'
      }, 200, requestCorsHeaders);
    }
  }

  const scopeSql = buildWaeScopeWhere(scope);

  const templates: Record<string, string> = {
    error_rate_by_service: `
      SELECT
        blob1 AS service,
        SUM(CASE WHEN blob4 = 'error' THEN double1 ELSE 0 END) AS errors,
        SUM(double1) AS total,
        100.0 * SUM(CASE WHEN blob4 = 'error' THEN double1 ELSE 0 END) / NULLIF(SUM(double1), 0) AS error_rate
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${scopeSql.whereSql}
      GROUP BY service
      ORDER BY error_rate DESC
      LIMIT 20
    `,
    latency_p95_by_service: `
      SELECT
        blob1 AS service,
        APPROX_PERCENTILE(double3, 0.95) AS p95_latency
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
        AND double3 > 0
      ${scopeSql.whereSql}
      GROUP BY service
      ORDER BY p95_latency DESC
      LIMIT 20
    `,
    top_errors: `
      SELECT
        blob1 AS service,
        blob5 AS msg_hash,
        SUM(double1) AS count
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
        AND blob4 = 'error'
      ${scopeSql.whereSql}
      GROUP BY service, msg_hash
      ORDER BY count DESC
      LIMIT 20
    `,
    throughput: `
      SELECT
        blob1 AS service,
        SUM(double1) AS count
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${scopeSql.whereSql}
      GROUP BY service
      ORDER BY count DESC
      LIMIT 20
    `,
    top_hosts: `
      SELECT
        blob3 AS host,
        SUM(double1) AS count
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${scopeSql.whereSql}
      GROUP BY host
      ORDER BY count DESC
      LIMIT 20
    `
  };

  const sql = templates[query];
  if (!sql) {
    return jsonResponse({ error: 'Unknown query', results: [] }, 400, requestCorsHeaders);
  }

  try {
    if (scopeSql.requiresFallback) {
      throw new Error('Scope requires fallback execution');
    }
    const results = await executeWAESQL(sql, env);
    const payload = { results, source: 'wae', cache: 'miss' };
    if (cacheApi) {
      await cacheApi.put(cacheRequest, new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${DASHBOARD_QUERY_CACHE_TTL_SECONDS}`
        }
      })).catch(() => undefined);
    }
    return jsonResponse(payload, 200, requestCorsHeaders);
  } catch (error) {
    const fallbackResults = await computeDashboardFallback(query, windowMinutes, env, scope);
    const payload = {
      results: fallbackResults,
      source: 'events_fallback',
      warning: String(error),
      cache: 'miss'
    };
    if (cacheApi) {
      await cacheApi.put(cacheRequest, new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${DASHBOARD_QUERY_CACHE_TTL_SECONDS}`
        }
      })).catch(() => undefined);
    }
    return jsonResponse(payload, 200, requestCorsHeaders);
  }
}

export async function handleDashboardWidgetQuery(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as (PplSearchRequest & { widget_id?: string });
  const req: PplSearchRequest = {
    time: body.time,
    ppl: String(body.ppl || '').trim(),
    limit: Math.max(1, Math.min(2000, Number(body.limit) || 500)),
    cursor: body.cursor || null
  };
  if (!req.time || !req.time.from || !req.time.to || !req.ppl) {
    return jsonResponse({ error: 'time.from, time.to, and ppl are required' }, 400, requestCorsHeaders);
  }
  const widgetId = body.widget_id ? String(body.widget_id) : null;
  const policy = widgetId
    ? (await loadDashboardPanelPolicies(env, [widgetId])).get(widgetId) || DEFAULT_DASHBOARD_EXECUTION_POLICY
    : DEFAULT_DASHBOARD_EXECUTION_POLICY;
  const cacheKey = buildDashboardWidgetCacheKey(req, auth.scope, widgetId);
  const cacheKeyHash = hashCacheKey(cacheKey);
  const toMs = Date.parse(req.time.to);
  const cacheBucket = Number.isFinite(toMs) ? Math.floor(toMs / (DASHBOARD_QUERY_CACHE_BUCKET_SECONDS * 1000)) : null;
  const materialized = widgetId ? await readMaterializedWidgetResult(env, req, auth.scope, widgetId, policy) : null;
  if (materialized) {
    return jsonResponse(
      {
        ...materialized,
        cache: 'miss',
        cache_debug: {
          key_hash: cacheKeyHash,
          bucket: cacheBucket,
          bucket_seconds: DASHBOARD_QUERY_CACHE_BUCKET_SECONDS,
          ttl_seconds: policy.cache_ttl_seconds
        }
      },
      200,
      { ...requestCorsHeaders, 'x-edgedata-cache': 'materialized' }
    );
  }
  if (isWidgetCacheEnabled(policy)) {
    const cached = await getDashboardCachePayload(env, cacheKey);
    if (cached.hit && cached.payload) {
      await writeScanMetrics(env, 'dashboard_widget', {
        scanned_partitions: cached.payload.stats.scanned_partitions,
        scanned_objects: cached.payload.stats.scanned_objects,
        listed_prefixes: cached.payload.stats.listed_prefixes,
        listing_calls: cached.payload.stats.listing_calls,
        listed_objects: cached.payload.stats.listed_objects,
        listing_fallbacks: cached.payload.stats.listing_fallbacks,
        timing_ms: cached.payload.stats.timing_ms
      }).catch(() => undefined);
      return jsonResponse(
        {
          ...cached.payload,
          source: cached.payload.source || 'cache',
          cache: 'hit',
          cache_debug: {
            key_hash: cacheKeyHash,
            bucket: cacheBucket,
            bucket_seconds: DASHBOARD_QUERY_CACHE_BUCKET_SECONDS,
            ttl_seconds: policy.cache_ttl_seconds
          }
        },
        200,
        { ...requestCorsHeaders, 'x-edgedata-cache': 'hit' }
      );
    }
  }
  const response = await performPplSearch(req, env, auth);
  response.source = 'live';
  response.materialization_status = policy.materialize_enabled ? 'miss' : 'disabled';
  await writeScanMetrics(env, 'dashboard_widget', {
    scanned_partitions: response.stats.scanned_partitions,
    scanned_objects: response.stats.scanned_objects,
    listed_prefixes: response.stats.listed_prefixes,
    listing_calls: response.stats.listing_calls,
    listed_objects: response.stats.listed_objects,
    listing_fallbacks: response.stats.listing_fallbacks,
    timing_ms: response.stats.timing_ms
  }).catch(() => undefined);
  if (isWidgetCacheEnabled(policy)) {
    await setDashboardCachePayload(env, cacheKey, response, policy.cache_ttl_seconds);
  }
  return jsonResponse(
    {
      ...response,
      cache: 'miss',
      cache_debug: {
        key_hash: cacheKeyHash,
        bucket: cacheBucket,
        bucket_seconds: DASHBOARD_QUERY_CACHE_BUCKET_SECONDS,
        ttl_seconds: policy.cache_ttl_seconds
      }
    },
    200,
    { ...requestCorsHeaders, 'x-edgedata-cache': 'miss' }
  );
}

export async function handleDashboardWidgetBatchQuery(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { time?: { from?: string; to?: string }; widgets?: DashboardBatchWidgetRequest[] };
  const time = body.time;
  const widgets = Array.isArray(body.widgets) ? body.widgets : [];
  if (!time?.from || !time?.to || widgets.length === 0) {
    return jsonResponse({ error: 'time.from, time.to, and widgets are required' }, 400, requestCorsHeaders);
  }

  const payloads: Record<string, DashboardBatchWidgetResult> = {};
  const pendingGroups = new Map<string, Array<{ widgetId: string; request: PplSearchRequest; pipeline: PplPipeline; compiled: SearchRequest }>>();
  const policyByWidgetId = await loadDashboardPanelPolicies(
    env,
    widgets.map((widget) => String(widget.widget_id || '').trim())
  );

  for (const widget of widgets) {
    const widgetId = String(widget.widget_id || '').trim();
    const ppl = String(widget.ppl || '').trim();
    if (!widgetId || !ppl) {
      if (widgetId) payloads[widgetId] = { error: 'widget_id and ppl are required' };
      continue;
    }
    const req: PplSearchRequest = {
      time,
      ppl,
      limit: Math.max(1, Math.min(2000, Number(widget.limit) || 500)),
      cursor: null
    };
    const policy = policyByWidgetId.get(widgetId) || DEFAULT_DASHBOARD_EXECUTION_POLICY;
    const cacheKey = buildDashboardWidgetCacheKey(req, auth.scope, widgetId);
    const materialized = await readMaterializedWidgetResult(env, req, auth.scope, widgetId, policy);
    if (materialized) {
      payloads[widgetId] = { response: materialized };
      continue;
    }
    if (isWidgetCacheEnabled(policy)) {
      const cached = await getDashboardCachePayload(env, cacheKey);
      if (cached.hit && cached.payload) {
        payloads[widgetId] = {
          response: {
            ...cached.payload,
            source: cached.payload.source || 'cache'
          }
        };
        continue;
      }
    }

    try {
      const pipeline = parsePplPipeline(req.ppl) as PplPipeline;
      const compiled = buildSearchRequestFromPpl(req, pipeline);
      const groupKey = JSON.stringify({
        q: compiled.q || '',
        index: compiled.filters?.index || '',
        service: compiled.filters?.service || '',
        env: compiled.filters?.env || ''
      });
      const group = pendingGroups.get(groupKey) || [];
      group.push({ widgetId, request: req, pipeline, compiled });
      pendingGroups.set(groupKey, group);
    } catch (error) {
      payloads[widgetId] = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  for (const group of pendingGroups.values()) {
    const groupResults = await executeSharedDashboardWidgetGroup(group, env, auth);
    for (const [widgetId, result] of Object.entries(groupResults)) {
      payloads[widgetId] = result;
      if (result.response) {
        const req = group.find((item) => item.widgetId === widgetId)?.request;
        const policy = policyByWidgetId.get(widgetId) || DEFAULT_DASHBOARD_EXECUTION_POLICY;
        if (req) {
          const cacheKey = buildDashboardWidgetCacheKey(req, auth.scope, widgetId);
          result.response.source = result.response.source || 'live';
          result.response.materialization_status = result.response.materialization_status || (policy.materialize_enabled ? 'miss' : 'disabled');
          if (isWidgetCacheEnabled(policy)) {
            await setDashboardCachePayload(env, cacheKey, result.response, policy.cache_ttl_seconds);
          }
        }
        await writeScanMetrics(env, 'dashboard_widget', {
          scanned_partitions: result.response.stats.scanned_partitions,
          scanned_objects: result.response.stats.scanned_objects,
          listed_prefixes: result.response.stats.listed_prefixes,
          listing_calls: result.response.stats.listing_calls,
          listed_objects: result.response.stats.listed_objects,
          listing_fallbacks: result.response.stats.listing_fallbacks,
          timing_ms: result.response.stats.timing_ms
        }).catch(() => undefined);
      }
    }
  }

  return jsonResponse({ widgets: payloads }, 200, requestCorsHeaders);
}
