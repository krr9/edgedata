/**
 * Scheduled searches CRUD handler extracted from query-worker index.
 */

import type {
  Env,
  AuthContext,
  ScheduledSearchRow,
  ScheduledSearchResultRow,
  MaterializedResultRow
} from './types.js';
import {
  jsonResponse,
  textResponse,
  parseJsonObject,
  parseJsonRecordArray,
  normalizeScheduledSearchRow,
  normalizeScheduledSearchResultRow,
  DEFAULT_EXECUTION_POLICY
} from './helpers.js';
import { assertPermission, writeAuditLog } from './rbac.js';
import {
  normalizeExecutionMode,
  normalizeCacheTtlSeconds,
  normalizeMaterializeIntervalSeconds,
  normalizeMaxStalenessSeconds,
  normalizeBooleanFlag
} from './performance-policy.mjs';
import { fetchAlertControl } from './handle-admin.js';

export async function handleScheduledSearches(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;
  const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
  const loadAccessibleScheduledSearch = async (id: string): Promise<ScheduledSearchRow | null> => {
    const search = await env.DB.prepare('SELECT * FROM scheduled_searches WHERE id = ?')
      .bind(id)
      .first<ScheduledSearchRow>();
    if (!search) return null;
    if (!isAdmin && search.created_by && search.created_by !== principal) {
      throw new Error('Forbidden');
    }
    return search;
  };

  const loadScheduledSearchRun = async (searchId: string, runId: string): Promise<ScheduledSearchResultRow | null> => {
    const row = await env.DB.prepare(
      'SELECT * FROM scheduled_search_results WHERE id = ? AND scheduled_search_id = ?'
    ).bind(runId, searchId).first<ScheduledSearchResultRow>();
    return row || null;
  };

  if (request.method === 'GET' && pathname === '/scheduled-searches') {
    assertPermission(auth, 'scheduled_search.read');
    const rows = isAdmin
      ? await env.DB.prepare(
          'SELECT * FROM scheduled_searches ORDER BY created_at DESC LIMIT 100'
        ).all<ScheduledSearchRow>()
      : await env.DB.prepare(
          'SELECT * FROM scheduled_searches WHERE created_by = ? OR created_by IS NULL ORDER BY created_at DESC LIMIT 100'
        ).bind(principal).all<ScheduledSearchRow>();
    return jsonResponse((rows.results || []).map(normalizeScheduledSearchRow), 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/scheduled-searches') {
    assertPermission(auth, 'scheduled_search.write');
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const ppl = String(body.ppl || '').trim();
    if (!name || !ppl) {
      return jsonResponse({ error: 'name and ppl are required' }, 400, requestCorsHeaders);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const timeWindowMinutes = Math.max(1, Math.min(10080, Number(body.time_window_minutes) || 60));
    const scheduleCron = String(body.schedule_cron || '0 * * * *').trim();
    const enabled = body.enabled === 0 || body.enabled === false ? 0 : 1;
    const actionsJson = JSON.stringify(Array.isArray(body.actions) ? body.actions : []);
    const maxResults = Math.max(1, Math.min(5000, Number(body.max_results) || 500));
    const executionMode = normalizeExecutionMode(body.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode);
    const cacheTtlSeconds = normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds);
    const materializeEnabled = normalizeBooleanFlag(body.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled) ? 1 : 0;
    const materializeIntervalSeconds = normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds);
    const maxStalenessSeconds = normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds);

    await env.DB.prepare(
      `INSERT INTO scheduled_searches (
         id, name, ppl, time_window_minutes, schedule_cron, enabled, actions_json, max_results,
         execution_mode, cache_ttl_seconds, materialize_enabled, materialize_interval_seconds, max_staleness_seconds,
         created_by, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, name, ppl, timeWindowMinutes, scheduleCron, enabled, actionsJson, maxResults,
      executionMode, cacheTtlSeconds, materializeEnabled, materializeIntervalSeconds, maxStalenessSeconds,
      principal, now, now
    ).run();

    return jsonResponse(normalizeScheduledSearchRow({
      id,
      name,
      ppl,
      time_window_minutes: timeWindowMinutes,
      schedule_cron: scheduleCron,
      enabled,
      actions_json: actionsJson,
      max_results: maxResults,
      execution_mode: executionMode,
      cache_ttl_seconds: cacheTtlSeconds,
      materialize_enabled: materializeEnabled,
      materialize_interval_seconds: materializeIntervalSeconds,
      max_staleness_seconds: maxStalenessSeconds,
      created_by: principal,
      created_at: now,
      updated_at: now
    } satisfies ScheduledSearchRow), 201, requestCorsHeaders);
  }

  const runResultsMatch = pathname.match(/^\/scheduled-searches\/([^/]+)\/runs\/([^/]+)\/results$/);
  if (request.method === 'GET' && runResultsMatch) {
    assertPermission(auth, 'scheduled_search.read');
    const [, searchId, runId] = runResultsMatch;
    const search = await loadAccessibleScheduledSearch(searchId);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const run = await loadScheduledSearchRun(searchId, runId);
    if (!run) return jsonResponse({ error: 'Run not found' }, 404, requestCorsHeaders);

    const artifact = run.materialized_result_id
      ? await env.DB.prepare('SELECT * FROM materialized_results WHERE id = ?')
          .bind(run.materialized_result_id)
          .first<MaterializedResultRow>()
      : null;
    const preview = parseJsonRecordArray(run.preview_json || run.results_json);
    let payload = artifact?.payload_inline_json ? parseJsonObject(artifact.payload_inline_json, {}) : {};
    let results = parseJsonRecordArray(payload.results);
    if (results.length === 0) {
      results = preview;
    }

    return jsonResponse({
      run_id: run.id,
      scheduled_search_id: searchId,
      result_type: payload.result_type === 'events' ? 'events' : 'table',
      results,
      total_results: run.result_count,
      partial: !artifact,
      warning: typeof payload.warning === 'string' ? payload.warning : null,
      stats: Object.keys(payload).length > 0 ? parseJsonObject(payload.stats, {}) : parseJsonObject(run.stats_json, {})
    }, 200, requestCorsHeaders);
  }

  const runDetailMatch = pathname.match(/^\/scheduled-searches\/([^/]+)\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runDetailMatch) {
    assertPermission(auth, 'scheduled_search.read');
    const [, searchId, runId] = runDetailMatch;
    const search = await loadAccessibleScheduledSearch(searchId);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const run = await loadScheduledSearchRun(searchId, runId);
    if (!run) return jsonResponse({ error: 'Run not found' }, 404, requestCorsHeaders);
    const artifact = run.materialized_result_id
      ? await env.DB.prepare('SELECT id, status, result_count, computed_at, expires_at FROM materialized_results WHERE id = ?')
          .bind(run.materialized_result_id)
          .first<Pick<MaterializedResultRow, 'id' | 'status' | 'result_count' | 'computed_at' | 'expires_at'>>()
      : null;

    return jsonResponse({
      ...normalizeScheduledSearchResultRow(run, { includePreview: true }),
      search: normalizeScheduledSearchRow(search),
      query_request: parseJsonObject(run.query_request_json, {}),
      artifact: artifact ? {
        id: artifact.id,
        status: artifact.status,
        result_count: artifact.result_count,
        computed_at: artifact.computed_at,
        expires_at: artifact.expires_at
      } : null
    }, 200, requestCorsHeaders);
  }

  const idMatch = pathname.match(/^\/scheduled-searches\/([^/]+)/);
  if (!idMatch) return textResponse('Not found', 404, requestCorsHeaders);
  const id = idMatch[1];

  if (request.method === 'GET' && pathname.endsWith('/results')) {
    assertPermission(auth, 'scheduled_search.read');
    const search = await loadAccessibleScheduledSearch(id);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const rows = await env.DB.prepare(
      'SELECT * FROM scheduled_search_results WHERE scheduled_search_id = ? ORDER BY run_at DESC LIMIT 50'
    ).bind(id).all<ScheduledSearchResultRow>();
    return jsonResponse((rows.results || []).map((row) => normalizeScheduledSearchResultRow(row)), 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname.endsWith('/run')) {
    assertPermission(auth, 'scheduled_search.write');
    const search = await loadAccessibleScheduledSearch(id);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const runResponse = await fetchAlertControl(env, `/internal/scheduled-searches/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ requested_by: principal })
    });
    const responseText = await runResponse.text();
    const runBody = responseText ? parseJsonObject(responseText, {}) : {};
    if (!runResponse.ok || runBody.error) {
      return jsonResponse(
        { error: String(runBody.error || `Scheduled search run failed (${runResponse.status})`) },
        runResponse.status >= 400 ? runResponse.status : 500,
        requestCorsHeaders
      );
    }
    await writeAuditLog(env, auth, 'scheduled_search.run.triggered', 'scheduled_search', id, {
      trigger_type: 'manual'
    }).catch(() => undefined);
    return jsonResponse(runBody, 200, requestCorsHeaders);
  }

  if (request.method === 'PUT') {
    assertPermission(auth, 'scheduled_search.write');
    const existing = await loadAccessibleScheduledSearch(id);
    if (!existing) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).trim()); }
    if (body.ppl !== undefined) { updates.push('ppl = ?'); values.push(String(body.ppl).trim()); }
    if (body.time_window_minutes !== undefined) { updates.push('time_window_minutes = ?'); values.push(Math.max(1, Math.min(10080, Number(body.time_window_minutes) || 60))); }
    if (body.schedule_cron !== undefined) { updates.push('schedule_cron = ?'); values.push(String(body.schedule_cron).trim()); }
    if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
    if (body.actions !== undefined) { updates.push('actions_json = ?'); values.push(JSON.stringify(Array.isArray(body.actions) ? body.actions : [])); }
    if (body.max_results !== undefined) { updates.push('max_results = ?'); values.push(Math.max(1, Math.min(5000, Number(body.max_results) || 500))); }
    if (body.execution_mode !== undefined) { updates.push('execution_mode = ?'); values.push(normalizeExecutionMode(body.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode)); }
    if (body.cache_ttl_seconds !== undefined) { updates.push('cache_ttl_seconds = ?'); values.push(normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds)); }
    if (body.materialize_enabled !== undefined) { updates.push('materialize_enabled = ?'); values.push(normalizeBooleanFlag(body.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled) ? 1 : 0); }
    if (body.materialize_interval_seconds !== undefined) { updates.push('materialize_interval_seconds = ?'); values.push(normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds)); }
    if (body.max_staleness_seconds !== undefined) { updates.push('max_staleness_seconds = ?'); values.push(normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds)); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);
    await env.DB.prepare(`UPDATE scheduled_searches SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    const updated = await env.DB.prepare('SELECT * FROM scheduled_searches WHERE id = ?').bind(id).first<ScheduledSearchRow>();
    return jsonResponse(updated ? normalizeScheduledSearchRow(updated) : { id, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'DELETE') {
    assertPermission(auth, 'scheduled_search.delete');
    const existing = await loadAccessibleScheduledSearch(id);
    if (!existing) return new Response(null, { status: 204, headers: requestCorsHeaders });
    await env.DB.prepare('DELETE FROM scheduled_search_results WHERE scheduled_search_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM scheduled_searches WHERE id = ?').bind(id).run();
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
