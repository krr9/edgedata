/**
 * Query worker: slim router that delegates to extracted modules.
 */

export { TailHub } from './tail-hub.js';
export { DashboardCache } from './dashboard-cache.js';

import type { Env, AuthContext, PplSearchRequest, PplSuggestionsRequest, GuardrailExplanation } from './types.js';
import { BASE_CORS_HEADERS } from './types.js';
import { jsonResponse, textResponse } from './helpers.js';
import { parseCsvSet } from './auth.js';
import {
  ensureRbacInitialized,
  assertPermission,
  writeOpsMetric,
  writeScanMetrics
} from './rbac.js';
import { authenticateRequest } from './auth.js';
import {
  performPplSearch,
  streamPplSearch,
  performPplSearchSummary
} from './search-ppl.js';
import {
  handleDashboardQuery,
  handleDashboardWidgetQuery,
  handleDashboardWidgetBatchQuery
} from './dashboard-query.js';
import { handleAuth, handleUsers } from './handle-users.js';
import { handleSyntheticIngestAdmin } from './handle-admin.js';
import { handleRoles, handleRbacMappings, handleAudit } from './handle-roles.js';
import { handleAlerts } from './handle-alerts.js';
import { handleSavedSearches } from './handle-saved-searches.js';
import { handleLookupTables } from './handle-lookup-tables.js';
import { handleDashboards } from './handle-dashboards.js';
import { handleScheduledSearches } from './handle-scheduled-searches.js';
import { getPplSuggestions } from './ppl-suggestions.mjs';
import { allowsCredentialedCors, resolveCorsOriginFromPatterns } from './cors-utils.mjs';
import {
  validateBootstrapRequest,
  buildBootstrapPayload,
  validateRelatedEventsRequest,
  normalizePivots,
  rankRelatedEvents,
  buildSessionRecord,
  validateSessionSaveRequest,
  canAccessInvestigationSession
} from './investigation-core.mjs';
import { statusFromError } from './error-utils.mjs';
import { classifyGuardrailError } from './query-core.mjs';
import { sanitizeErrorMessage } from '../../shared/sanitize-error.mjs';
import { clientIp as sharedClientIp } from '../../shared/request-utils.mjs';
import {
  enforceRateLimit as sharedEnforceRateLimit,
  asRateLimitPerMinute as sharedAsRateLimitPerMinute
} from '../../shared/rate-limit.mjs';

const clientIp = sharedClientIp as (request: Request) => string;
const asRateLimitPerMinute = sharedAsRateLimitPerMinute as (
  value: string | undefined,
  fallback: number
) => number;

function enforceRateLimit(env: Env, scope: string, key: string, perMinute: number): Promise<void> {
  return sharedEnforceRateLimit(env.DB, scope, key, perMinute);
}

function resolveCorsOrigin(request: Request, env: Env): string {
  return resolveCorsOriginFromPatterns(
    request.headers.get('origin') || '',
    Array.from(parseCsvSet(env.CORS_ORIGINS))
  );
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = resolveCorsOrigin(request, env);
  return {
    'access-control-allow-origin': origin,
    ...(allowsCredentialedCors(origin) ? { 'access-control-allow-credentials': 'true' } : {}),
    ...BASE_CORS_HEADERS
  };
}

function errorResponse(
  error: unknown,
  requestCorsHeaders: Record<string, string>,
  fallback = 500
): Response {
  const status = statusFromError(error, fallback);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const guardrail = classifyGuardrailError(rawMessage);
  const message = status >= 500 ? sanitizeErrorMessage(error) : rawMessage;
  return jsonResponse(
    {
      error: message,
      ...(guardrail ? { guardrail: guardrail as GuardrailExplanation } : {})
    },
    status,
    requestCorsHeaders
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const startedAt = Date.now();
    const requestCorsHeaders = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: requestCorsHeaders });
    }

    if (url.pathname === '/health') {
      return jsonResponse(
        { status: 'ok', service: 'query-worker', version: '1.3.0' },
        200,
        requestCorsHeaders
      );
    }

    if (url.pathname === '/tail' && request.headers.get('Upgrade') === 'websocket') {
      try {
        const tokenParam = url.searchParams.get('token');
        const authRequest = tokenParam
          ? new Request(request.url, {
              headers: new Headers([
                ...Array.from(request.headers.entries()),
                ['Authorization', `Bearer ${tokenParam}`]
              ])
            })
          : request;
        await ensureRbacInitialized(env);
        const auth = await authenticateRequest(authRequest, env);
        assertPermission(auth, 'search.read');

        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/ws';
        const doRequest = new Request(doUrl.toString(), {
          headers: new Headers([
            ['Upgrade', 'websocket'],
            ['X-Tail-Scope', JSON.stringify(auth.scope)]
          ])
        });
        return stub.fetch(doRequest);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Auth failed' },
          { status: 401 }
        );
      }
    }

    if (url.pathname === '/internal/tail-push' && request.method === 'POST') {
      const internalCaller = request.headers.get('X-Internal-Caller') || '';
      if (!internalCaller) {
        return Response.json({ error: 'Forbidden' }, { status: 403, headers: requestCorsHeaders });
      }
      try {
        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        const doRequest = new Request(new URL('/push', request.url).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body
        });
        return stub.fetch(doRequest);
      } catch (error) {
        return Response.json({ error: 'Push failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/tail/stats' && request.method === 'GET') {
      try {
        await ensureRbacInitialized(env);
        const auth = await authenticateRequest(request, env);
        assertPermission(auth, 'search.read');
        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        return stub.fetch(new Request(new URL('/stats', request.url).toString()));
      } catch (error) {
        return errorResponse(error, requestCorsHeaders, 401);
      }
    }

    await ensureRbacInitialized(env);

    if (url.pathname.startsWith('/auth/')) {
      try {
        return await handleAuth(request, env, url.pathname, requestCorsHeaders);
      } catch (error) {
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    try {
      const ipLimit = asRateLimitPerMinute(env.QUERY_RATE_LIMIT_PER_MIN, 600);
      await enforceRateLimit(env, 'query_ip', clientIp(request), ipLimit);
    } catch (error) {
      await writeOpsMetric(env, 'query_rate_limited', 1).catch(() => undefined);
      return errorResponse(error, requestCorsHeaders, 429);
    }

    let auth: AuthContext;
    try {
      auth = await authenticateRequest(request, env);
    } catch (error) {
      await writeOpsMetric(env, 'query_auth_failures', 1).catch(() => undefined);
      return errorResponse(error, requestCorsHeaders, 401);
    }

    try {
      const principalLimit = asRateLimitPerMinute(env.QUERY_RATE_LIMIT_PER_MIN, 600);
      await enforceRateLimit(env, 'query_principal', auth.email || auth.principal, principalLimit);
    } catch (error) {
      await writeOpsMetric(env, 'query_rate_limited', 1).catch(() => undefined);
      return errorResponse(error, requestCorsHeaders, 429);
    }

    if (url.pathname === '/search' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = (await request.json()) as PplSearchRequest;
        const response = await performPplSearch(req, env, auth);
        await writeOpsMetric(env, 'r2sql_calls_total', response.stats.scanned_objects).catch(
          () => undefined
        );
        await writeScanMetrics(env, 'search', {
          scanned_partitions: response.stats.scanned_partitions,
          scanned_objects: response.stats.scanned_objects,
          listed_prefixes: response.stats.listed_prefixes,
          listing_calls: response.stats.listing_calls,
          listed_objects: response.stats.listed_objects,
          listing_fallbacks: response.stats.listing_fallbacks,
          timing_ms: response.stats.timing_ms
        }).catch(() => undefined);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return jsonResponse(response, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/search/stream' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_stream_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = (await request.json()) as PplSearchRequest;
        return await streamPplSearch(req, env, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/search/summary' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_summary_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = (await request.json()) as PplSearchRequest;
        const summary = await performPplSearchSummary(req, env, auth);
        await writeOpsMetric(env, 'r2sql_calls_total', summary.scanned_objects).catch(() => undefined);
        await writeScanMetrics(env, 'search_summary', {
          scanned_partitions: summary.scanned_partitions,
          scanned_objects: summary.scanned_objects,
          listed_prefixes: summary.listed_prefixes,
          listing_calls: summary.listing_calls,
          listed_objects: summary.listed_objects,
          listing_fallbacks: summary.listing_fallbacks,
          timing_ms: summary.timing_ms
        }).catch(() => undefined);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return jsonResponse(summary, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/search/suggestions' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_suggestions_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = (await request.json().catch(() => ({}))) as PplSuggestionsRequest;
        const response = getPplSuggestions({
          query: String(req.query || ''),
          cursorPos: typeof req.cursorPos === 'number' ? req.cursorPos : undefined,
          maxItems: typeof req.maxItems === 'number' ? req.maxItems : undefined,
          context: {
            topTerms: Array.isArray(req.context?.topTerms)
              ? req.context.topTerms
                  .map((item) => String(item || '').trim())
                  .filter(Boolean)
                  .slice(0, 50)
              : []
          }
        });
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return jsonResponse(
          {
            suggestions: response.suggestions,
            meta: {
              context_stage: response.contextStage,
              latency_ms: Date.now() - startedAt
            }
          },
          200,
          requestCorsHeaders
        );
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/dashboards/query' && request.method === 'POST') {
      await writeOpsMetric(env, 'dashboard_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'dashboard.read');
        const response = await handleDashboardQuery(request, env, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname === '/dashboards/widgets/query' && request.method === 'POST') {
      await writeOpsMetric(env, 'dashboard_widget_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'dashboard.read');
        const response = await handleDashboardWidgetQuery(request, env, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname === '/dashboards/widgets/query-batch' && request.method === 'POST') {
      await writeOpsMetric(env, 'dashboard_widget_batch_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'dashboard.read');
        const response = await handleDashboardWidgetBatchQuery(request, env, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname === '/investigations/demo-scenarios' && request.method === 'GET') {
      try {
        assertPermission(auth, 'search.read');
        const demoEnabled = env.DEMO_SCENARIOS_ENABLED === 'true';
        if (!demoEnabled) {
          return jsonResponse({ demo_mode: false, scenarios: [] }, 200, requestCorsHeaders);
        }
        const to = new Date();
        const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
        const timeRange = { from: from.toISOString(), to: to.toISOString() };
        const scenarios = [
          {
            id: 'synthetic-errors',
            label: 'Synthetic errors (frontend)',
            scope: { index: 'otel-demo', service: 'frontend', env: 'demo' },
            time: timeRange,
            pivot_chips: [],
            starter_queries: [
              {
                id: 'errors',
                title: 'Errors',
                ppl: 'search * | where level="error" | where index="otel-demo" and service="frontend" and env="demo" | head 50'
              },
              {
                id: 'volume',
                title: 'Volume',
                ppl: 'search * | where index="otel-demo" and service="frontend" and env="demo" | timechart span=5m count() | head 100'
              }
            ]
          },
          {
            id: 'checkout-service',
            label: 'Checkout service anomalies',
            scope: { index: 'otel-checkout', service: 'checkoutservice', env: 'demo' },
            time: timeRange,
            pivot_chips: [],
            starter_queries: [
              {
                id: 'errors',
                title: 'Errors',
                ppl: 'search * | where level="error" | where index="otel-checkout" and service="checkoutservice" and env="demo" | head 50'
              },
              {
                id: 'volume',
                title: 'Volume',
                ppl: 'search * | where index="otel-checkout" and service="checkoutservice" and env="demo" | timechart span=5m count() | head 100'
              }
            ]
          },
          {
            id: 'payment-service',
            label: 'Payment service failures',
            scope: { index: 'otel-payments', service: 'paymentservice', env: 'demo' },
            time: timeRange,
            pivot_chips: [],
            starter_queries: [
              {
                id: 'http-errors',
                title: 'HTTP 4xx/5xx',
                ppl: 'search * | where index="otel-payments" and service="paymentservice" and env="demo" and status>=400 | head 50'
              },
              {
                id: 'volume',
                title: 'Volume',
                ppl: 'search * | where index="otel-payments" and service="paymentservice" and env="demo" | timechart span=5m count() | head 100'
              }
            ]
          }
        ];
        return jsonResponse({ demo_mode: true, scenarios }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/bootstrap' && request.method === 'POST') {
      try {
        assertPermission(auth, 'search.read');
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const validation = validateBootstrapRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        const payload = buildBootstrapPayload(body);
        return jsonResponse(payload, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/related-events' && request.method === 'POST') {
      try {
        assertPermission(auth, 'search.read');
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const validation = validateRelatedEventsRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        const pivots = normalizePivots(body.pivots);
        const pivotTokens = Array.isArray(body.pivot_tokens) ? body.pivot_tokens : [];
        const maxCandidates =
          body.max_candidates != null ? Math.min(Number(body.max_candidates), 100) : 100;

        const scope = body.scope as { index?: string; service?: string; env?: string } | undefined;
        const time = body.time as { from: string; to: string };
        const conditions: string[] = [];
        if (scope?.index && scope.index !== '*') conditions.push(`index="${scope.index}"`);
        if (scope?.service && scope.service !== '*') conditions.push(`service="${scope.service}"`);
        if (scope?.env && scope.env !== '*') conditions.push(`env="${scope.env}"`);
        const pivotConditions: string[] = [];
        if (pivots.trace_id) pivotConditions.push(`trace_id="${pivots.trace_id}"`);
        if (pivots.request_id) pivotConditions.push(`request_id="${pivots.request_id}"`);
        if (pivots.user_id) pivotConditions.push(`user_id="${pivots.user_id}"`);
        if (pivots.msg_hash) pivotConditions.push(`msg_hash="${pivots.msg_hash}"`);
        const allConditions = [...conditions, ...(pivotConditions.length > 0 ? [pivotConditions.join(' or ')] : [])];
        const ppl = allConditions.length > 0
          ? `search * | where ${allConditions.join(' and ')} | sort -ts | head ${maxCandidates}`
          : `search * | sort -ts | head ${maxCandidates}`;

        let candidates: Array<Record<string, unknown>> = [];
        try {
          const searchResult = await performPplSearch({ time, ppl, limit: maxCandidates, cursor: null }, env, auth);
          if (searchResult.results) {
            candidates = searchResult.results as Array<Record<string, unknown>>;
          }
        } catch {
          // fall through with empty candidates
        }

        const ranked = rankRelatedEvents(pivots, pivotTokens, candidates, { maxCandidates });
        return jsonResponse({ related_events: ranked }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/sessions' && request.method === 'GET') {
      try {
        assertPermission(auth, 'search.read');
        const principal = auth.email || auth.principal;
        const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
        const rows = isAdmin
          ? await env.DB.prepare(
              'SELECT id, name, owner_user_id, source_type, scope_json, created_at FROM investigation_sessions ORDER BY created_at DESC LIMIT 100'
            ).all<{ id: string; name: string | null; owner_user_id: string | null; source_type: string | null; scope_json: string; created_at: string }>()
          : await env.DB.prepare(
              'SELECT id, name, owner_user_id, source_type, scope_json, created_at FROM investigation_sessions WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 100'
            ).bind(principal).all<{ id: string; name: string | null; owner_user_id: string | null; source_type: string | null; scope_json: string; created_at: string }>();
        return jsonResponse({ sessions: rows.results || [] }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/session' && request.method === 'POST') {
      try {
        assertPermission(auth, 'search.read');
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const validation = validateSessionSaveRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const principal = auth.email || auth.principal;
        const recordInput = {
          id,
          name: validation.name ?? null,
          owner_user_id: principal,
          source_type: validation.source_type,
          scope_json: validation.scope_json,
          state_json: validation.state_json,
          created_at: now,
          expires_at: validation.expires_at
        };
        const built = buildSessionRecord(recordInput);
        if (!built.ok) {
          return jsonResponse({ error: built.error }, 400, requestCorsHeaders);
        }
        await env.DB.prepare(
          `INSERT INTO investigation_sessions (id, name, owner_user_id, source_type, scope_json, state_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            built.id,
            built.name ?? null,
            built.owner_user_id ?? null,
            built.source_type ?? null,
            built.scope_json,
            built.state_json,
            built.created_at,
            built.expires_at ?? null
          )
          .run();
        return jsonResponse({ id: built.id, name: built.name ?? null, created_at: built.created_at }, 201, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    const sessionMatch = url.pathname.match(/^\/investigations\/session\/([^/]+)$/);

    if (sessionMatch && request.method === 'GET') {
      try {
        assertPermission(auth, 'search.read');
        const sessionId = sessionMatch[1];
        if (!sessionId) {
          return jsonResponse({ error: 'Session id required' }, 400, requestCorsHeaders);
        }
        const row = await env.DB.prepare(
          'SELECT id, name, owner_user_id, source_type, scope_json, state_json, created_at, expires_at FROM investigation_sessions WHERE id = ?'
        )
          .bind(sessionId)
          .first<{
            id: string;
            name: string | null;
            owner_user_id: string | null;
            source_type: string | null;
            scope_json: string;
            state_json: string;
            created_at: string;
            expires_at: string | null;
          }>();
        if (!row) {
          return jsonResponse({ error: 'Session not found' }, 404, requestCorsHeaders);
        }
        const principal = auth.email || auth.principal;
        const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
        if (!canAccessInvestigationSession(row.owner_user_id, principal, isAdmin)) {
          throw new Error('Forbidden');
        }
        return jsonResponse(row, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (sessionMatch && request.method === 'PUT') {
      try {
        assertPermission(auth, 'search.read');
        const sessionId = sessionMatch[1];
        if (!sessionId) {
          return jsonResponse({ error: 'Session id required' }, 400, requestCorsHeaders);
        }
        const existing = await env.DB.prepare(
          'SELECT owner_user_id FROM investigation_sessions WHERE id = ?'
        ).bind(sessionId).first<{ owner_user_id: string | null }>();
        if (!existing) {
          return jsonResponse({ error: 'Session not found' }, 404, requestCorsHeaders);
        }
        const principal = auth.email || auth.principal;
        const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
        if (!canAccessInvestigationSession(existing.owner_user_id, principal, isAdmin)) {
          throw new Error('Forbidden');
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const validation = validateSessionSaveRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        await env.DB.prepare(
          `UPDATE investigation_sessions SET name = ?, scope_json = ?, state_json = ?, source_type = ? WHERE id = ?`
        )
          .bind(
            validation.name ?? null,
            validation.scope_json,
            validation.state_json,
            validation.source_type ?? null,
            sessionId
          )
          .run();
        return jsonResponse({ id: sessionId, updated: true }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (sessionMatch && request.method === 'DELETE') {
      try {
        assertPermission(auth, 'search.read');
        const sessionId = sessionMatch[1];
        if (!sessionId) {
          return jsonResponse({ error: 'Session id required' }, 400, requestCorsHeaders);
        }
        const existing = await env.DB.prepare(
          'SELECT owner_user_id FROM investigation_sessions WHERE id = ?'
        ).bind(sessionId).first<{ owner_user_id: string | null }>();
        if (!existing) {
          return jsonResponse({ error: 'Session not found' }, 404, requestCorsHeaders);
        }
        const principal = auth.email || auth.principal;
        const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
        if (!canAccessInvestigationSession(existing.owner_user_id, principal, isAdmin)) {
          throw new Error('Forbidden');
        }
        await env.DB.prepare('DELETE FROM investigation_sessions WHERE id = ?').bind(sessionId).run();
        return jsonResponse({ id: sessionId, deleted: true }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname.startsWith('/users')) {
      try {
        return await handleUsers(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/admin/synthetic-ingest')) {
      try {
        return await handleSyntheticIngestAdmin(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/roles')) {
      try {
        return await handleRoles(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/rbac/mappings')) {
      try {
        return await handleRbacMappings(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/audit')) {
      try {
        return await handleAudit(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/alerts')) {
      try {
        const response = await handleAlerts(request, env, url.pathname, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/saved-searches')) {
      try {
        return await handleSavedSearches(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/lookup-tables')) {
      try {
        return await handleLookupTables(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/dashboards')) {
      try {
        return await handleDashboards(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/scheduled-searches')) {
      try {
        return await handleScheduledSearches(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    return textResponse('Not found', 404, requestCorsHeaders);
  }
};
