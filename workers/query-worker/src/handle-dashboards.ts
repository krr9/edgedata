/**
 * Dashboards and panels CRUD handler extracted from query-worker index.
 */

import type { Env, AuthContext, DashboardRow, DashboardPanelRow } from './types.js';
import {
  jsonResponse,
  textResponse,
  normalizeJsonInput,
  normalizeDashboardPanelRow,
  normalizeDashboardRow,
  normalizeWidgetType,
  mapWidgetTypeToLegacyViz,
  defaultLayoutForPanel,
  DEFAULT_DASHBOARD_EXECUTION_POLICY
} from './helpers.js';
import { assertPermission } from './rbac.js';
import {
  normalizePerformanceProfile,
  normalizeExecutionMode,
  normalizeCacheTtlSeconds,
  normalizeMaterializeIntervalSeconds,
  normalizeMaxStalenessSeconds,
  normalizeBooleanFlag
} from './performance-policy.mjs';
import { seedStarterDashboards } from './starter-dashboards.mjs';

export async function handleDashboards(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;
  const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';

  if (request.method === 'GET' && pathname === '/dashboards') {
    assertPermission(auth, 'dashboard.read');
    await seedStarterDashboards(env.DB).catch(() => undefined);
    const rows = await env.DB.prepare('SELECT * FROM dashboards ORDER BY is_default DESC, created_at DESC LIMIT 100').all<DashboardRow>();
    return jsonResponse((rows.results || []).map(normalizeDashboardRow), 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/dashboards') {
    assertPermission(auth, 'dashboard.write');
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    if (!name) return jsonResponse({ error: 'name is required' }, 400, requestCorsHeaders);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const performanceProfile = normalizePerformanceProfile(body.performance_profile, 'economy');
    const defaultExecutionMode = normalizeExecutionMode(body.default_execution_mode, DEFAULT_DASHBOARD_EXECUTION_POLICY.execution_mode);
    await env.DB.prepare(
      `INSERT INTO dashboards (id, name, description, layout_json, is_default, performance_profile, default_execution_mode, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 0, ?, ?, ?, ?, ?)`
    ).bind(id, name, String(body.description || ''), performanceProfile, defaultExecutionMode, principal, now, now).run();
    return jsonResponse(normalizeDashboardRow({
      id,
      name,
      description: String(body.description || ''),
      layout_json: '[]',
      is_default: 0,
      performance_profile: performanceProfile,
      default_execution_mode: defaultExecutionMode,
      created_by: principal,
      created_at: now,
      updated_at: now
    } satisfies DashboardRow), 201, requestCorsHeaders);
  }

  const dashMatch = pathname.match(/^\/dashboards\/([^/]+)/);
  if (!dashMatch) return textResponse('Not found', 404, requestCorsHeaders);
  const dashboardId = dashMatch[1];
  const layoutMatch = pathname.match(/^\/dashboards\/[^/]+\/layout$/);

  if (layoutMatch !== null) {
    if (request.method !== 'PUT') return textResponse('Method not allowed', 405, requestCorsHeaders);
    assertPermission(auth, 'dashboard.write');
    const body = await request.json().catch(() => ({})) as { items?: Array<{ id?: string; layout_json?: unknown; layout?: unknown }> };
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return jsonResponse({ error: 'items is required' }, 400, requestCorsHeaders);
    const now = new Date().toISOString();
    let updated = 0;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const panelId = String(item.id || '').trim();
      if (!panelId) continue;
      const layoutInput = item.layout_json ?? item.layout ?? {};
      const layoutJson = normalizeJsonInput(layoutInput, defaultLayoutForPanel(index, 'table'));
      await env.DB.prepare(
        `UPDATE dashboard_panels
         SET layout_json = ?, position = ?, updated_at = ?
         WHERE id = ? AND dashboard_id = ?`
      ).bind(layoutJson, index, now, panelId, dashboardId).run();
      updated++;
    }
    return jsonResponse({ dashboard_id: dashboardId, updated, updated_at: now }, 200, requestCorsHeaders);
  }

  const panelMatch = pathname.match(/^\/dashboards\/[^/]+\/panels(?:\/([^/]+))?$/);

  if (panelMatch !== null) {
    const panelId = panelMatch[1] || null;

    if (request.method === 'GET' && !panelId) {
      assertPermission(auth, 'dashboard.read');
      const rows = await env.DB.prepare(
        'SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position ASC'
      ).bind(dashboardId).all<DashboardPanelRow>();
      return jsonResponse((rows.results || []).map(normalizeDashboardPanelRow), 200, requestCorsHeaders);
    }

    if (request.method === 'POST' && !panelId) {
      assertPermission(auth, 'dashboard.write');
      const body = await request.json() as Record<string, unknown>;
      const title = String(body.title || '').trim();
      const widgetType = normalizeWidgetType(body.widget_type ?? body.viz_type);
      const queryText = String(body.query_text ?? body.ppl ?? '').trim();
      if (!title) return jsonResponse({ error: 'title is required' }, 400, requestCorsHeaders);
      if (widgetType !== 'markdown' && !queryText) {
        return jsonResponse({ error: 'query_text is required for data widgets' }, 400, requestCorsHeaders);
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const vizType = mapWidgetTypeToLegacyViz(widgetType);
      const dashboardDefaults = await env.DB.prepare(
        'SELECT default_execution_mode FROM dashboards WHERE id = ?'
      ).bind(dashboardId).first<{ default_execution_mode?: string | null }>();
      const defaultExecutionMode = normalizeExecutionMode(
        dashboardDefaults?.default_execution_mode,
        DEFAULT_DASHBOARD_EXECUTION_POLICY.execution_mode
      );
      const timeWindow = Math.max(1, Math.min(10080, Number(body.time_window_minutes) || 60));
      const refreshSec = Math.max(0, Math.min(3600, Number(body.refresh_seconds) || 0));
      const position = Math.max(0, Number(body.position) || 0);
      const queryMode = String(body.query_mode || 'ppl');
      const executionMode = normalizeExecutionMode(body.execution_mode, defaultExecutionMode);
      const cacheTtlSeconds = normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.cache_ttl_seconds);
      const materializeEnabled = normalizeBooleanFlag(body.materialize_enabled, DEFAULT_DASHBOARD_EXECUTION_POLICY.materialize_enabled) ? 1 : 0;
      const materializeIntervalSeconds = normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.materialize_interval_seconds);
      const maxStalenessSeconds = normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.max_staleness_seconds);
      const priority = Math.max(0, Math.min(100, Number(body.priority) || 0));
      const vizConfigJson = normalizeJsonInput(body.viz_config_json ?? body.viz_config ?? body.options_json, '{}');
      const layoutJson = normalizeJsonInput(body.layout_json ?? body.layout, defaultLayoutForPanel(position, widgetType));
      const bindingsJson = normalizeJsonInput(body.bindings_json ?? body.bindings, '{}');
      const displayOptionsJson = normalizeJsonInput(body.display_options_json ?? body.display_options, '{}');
      await env.DB.prepare(
        `INSERT INTO dashboard_panels (
          id, dashboard_id, title, ppl, viz_type, widget_type, query_text, query_mode,
          viz_config_json, layout_json, bindings_json, display_options_json,
          time_window_minutes, refresh_seconds, execution_mode, cache_ttl_seconds,
          materialize_enabled, materialize_interval_seconds, max_staleness_seconds, priority,
          options_json, position, created_at, updated_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        dashboardId,
        title,
        queryText,
        vizType,
        widgetType,
        queryText,
        queryMode,
        vizConfigJson,
        layoutJson,
        bindingsJson,
        displayOptionsJson,
        timeWindow,
        refreshSec,
        executionMode,
        cacheTtlSeconds,
        materializeEnabled,
        materializeIntervalSeconds,
        maxStalenessSeconds,
        priority,
        vizConfigJson,
        position,
        now,
        now
      ).run();
      return jsonResponse(
        normalizeDashboardPanelRow({
          id,
          dashboard_id: dashboardId,
          title,
          ppl: queryText,
          viz_type: vizType,
          widget_type: widgetType,
          query_text: queryText,
          query_mode: queryMode,
          viz_config_json: vizConfigJson,
          layout_json: layoutJson,
          bindings_json: bindingsJson,
          display_options_json: displayOptionsJson,
          time_window_minutes: timeWindow,
          refresh_seconds: refreshSec,
          execution_mode: executionMode,
          cache_ttl_seconds: cacheTtlSeconds,
          materialize_enabled: materializeEnabled,
          materialize_interval_seconds: materializeIntervalSeconds,
          max_staleness_seconds: maxStalenessSeconds,
          priority,
          options_json: vizConfigJson,
          position,
          created_at: now,
          updated_at: now
        }),
        201,
        requestCorsHeaders
      );
    }

    if (request.method === 'PUT' && panelId) {
      assertPermission(auth, 'dashboard.write');
      const body = await request.json() as Record<string, unknown>;
      const now = new Date().toISOString();
      const updates: string[] = [];
      const values: unknown[] = [];
      if (body.title !== undefined) { updates.push('title = ?'); values.push(String(body.title).trim()); }
      if (body.ppl !== undefined) { updates.push('ppl = ?'); values.push(String(body.ppl).trim()); }
      if (body.viz_type !== undefined) { updates.push('viz_type = ?'); values.push(String(body.viz_type)); }
      if (body.widget_type !== undefined) {
        const widgetType = normalizeWidgetType(body.widget_type);
        updates.push('widget_type = ?');
        values.push(widgetType);
        updates.push('viz_type = ?');
        values.push(mapWidgetTypeToLegacyViz(widgetType));
      }
      if (body.query_text !== undefined) {
        const queryText = String(body.query_text || '').trim();
        updates.push('query_text = ?');
        values.push(queryText);
        updates.push('ppl = ?');
        values.push(queryText);
      }
      if (body.query_mode !== undefined) { updates.push('query_mode = ?'); values.push(String(body.query_mode || 'ppl')); }
      if (body.execution_mode !== undefined) {
        updates.push('execution_mode = ?');
        values.push(normalizeExecutionMode(body.execution_mode, DEFAULT_DASHBOARD_EXECUTION_POLICY.execution_mode));
      }
      if (body.cache_ttl_seconds !== undefined) {
        updates.push('cache_ttl_seconds = ?');
        values.push(normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.cache_ttl_seconds));
      }
      if (body.materialize_enabled !== undefined) {
        updates.push('materialize_enabled = ?');
        values.push(normalizeBooleanFlag(body.materialize_enabled, DEFAULT_DASHBOARD_EXECUTION_POLICY.materialize_enabled) ? 1 : 0);
      }
      if (body.materialize_interval_seconds !== undefined) {
        updates.push('materialize_interval_seconds = ?');
        values.push(normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.materialize_interval_seconds));
      }
      if (body.max_staleness_seconds !== undefined) {
        updates.push('max_staleness_seconds = ?');
        values.push(normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_DASHBOARD_EXECUTION_POLICY.max_staleness_seconds));
      }
      if (body.priority !== undefined) {
        updates.push('priority = ?');
        values.push(Math.max(0, Math.min(100, Number(body.priority) || 0)));
      }
      if (body.viz_config_json !== undefined || body.viz_config !== undefined) {
        const configJson = normalizeJsonInput(body.viz_config_json ?? body.viz_config, '{}');
        updates.push('viz_config_json = ?');
        values.push(configJson);
        updates.push('options_json = ?');
        values.push(configJson);
      }
      if (body.layout_json !== undefined || body.layout !== undefined) {
        updates.push('layout_json = ?');
        values.push(normalizeJsonInput(body.layout_json ?? body.layout, '{}'));
      }
      if (body.bindings_json !== undefined || body.bindings !== undefined) {
        updates.push('bindings_json = ?');
        values.push(normalizeJsonInput(body.bindings_json ?? body.bindings, '{}'));
      }
      if (body.display_options_json !== undefined || body.display_options !== undefined) {
        updates.push('display_options_json = ?');
        values.push(normalizeJsonInput(body.display_options_json ?? body.display_options, '{}'));
      }
      if (body.time_window_minutes !== undefined) { updates.push('time_window_minutes = ?'); values.push(Number(body.time_window_minutes) || 60); }
      if (body.refresh_seconds !== undefined) { updates.push('refresh_seconds = ?'); values.push(Number(body.refresh_seconds) || 0); }
      if (body.position !== undefined) { updates.push('position = ?'); values.push(Number(body.position) || 0); }
      if (body.options_json !== undefined) { updates.push('options_json = ?'); values.push(typeof body.options_json === 'string' ? body.options_json : JSON.stringify(body.options_json)); }
      updates.push('updated_at = ?');
      values.push(now);
      values.push(panelId);
      if (updates.length > 1) {
        await env.DB.prepare(`UPDATE dashboard_panels SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      }
      const updatedRow = await env.DB.prepare(
        'SELECT * FROM dashboard_panels WHERE id = ? AND dashboard_id = ?'
      ).bind(panelId, dashboardId).first<DashboardPanelRow>();
      return jsonResponse(updatedRow ? normalizeDashboardPanelRow(updatedRow) : { id: panelId, updated_at: now }, 200, requestCorsHeaders);
    }

    if (request.method === 'DELETE' && panelId) {
      assertPermission(auth, 'dashboard.write');
      await env.DB.prepare('DELETE FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').bind(panelId, dashboardId).run();
      return new Response(null, { status: 204, headers: requestCorsHeaders });
    }

    return textResponse('Method not allowed', 405, requestCorsHeaders);
  }

  if (request.method === 'PUT') {
    assertPermission(auth, 'dashboard.write');
    const existing = await env.DB.prepare('SELECT id, is_default, created_by FROM dashboards WHERE id = ?')
      .bind(dashboardId).first<{ id: string; is_default: number; created_by?: string | null }>();
    if (!existing) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    if (existing.is_default && !isAdmin) throw new Error('Forbidden');
    if (!isAdmin && existing.created_by && existing.created_by !== principal) throw new Error('Forbidden');
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).trim()); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(String(body.description)); }
    if (body.layout_json !== undefined) { updates.push('layout_json = ?'); values.push(typeof body.layout_json === 'string' ? body.layout_json : JSON.stringify(body.layout_json)); }
    if (body.performance_profile !== undefined) { updates.push('performance_profile = ?'); values.push(normalizePerformanceProfile(body.performance_profile, 'economy')); }
    if (body.default_execution_mode !== undefined) { updates.push('default_execution_mode = ?'); values.push(normalizeExecutionMode(body.default_execution_mode, DEFAULT_DASHBOARD_EXECUTION_POLICY.execution_mode)); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(dashboardId);
    await env.DB.prepare(`UPDATE dashboards SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    const updated = await env.DB.prepare('SELECT * FROM dashboards WHERE id = ?').bind(dashboardId).first<DashboardRow>();
    return jsonResponse(updated ? normalizeDashboardRow(updated) : { id: dashboardId, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'DELETE') {
    assertPermission(auth, 'dashboard.delete');
    const existing = await env.DB.prepare('SELECT id, is_default, created_by FROM dashboards WHERE id = ?')
      .bind(dashboardId).first<{ id: string; is_default: number; created_by?: string | null }>();
    if (!existing) return new Response(null, { status: 204, headers: requestCorsHeaders });
    if (existing.is_default) return jsonResponse({ error: 'Cannot delete default dashboard' }, 403, requestCorsHeaders);
    if (!isAdmin && existing.created_by && existing.created_by !== principal) throw new Error('Forbidden');
    await env.DB.prepare('DELETE FROM dashboard_panels WHERE dashboard_id = ?').bind(dashboardId).run();
    await env.DB.prepare('DELETE FROM dashboards WHERE id = ?').bind(dashboardId).run();
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
