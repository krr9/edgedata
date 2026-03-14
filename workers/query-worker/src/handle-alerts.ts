/**
 * Alerts CRUD handler extracted from query-worker index.
 */

import type { Env, AuthContext, AlertRow, StarterAlertApplyRequest } from './types.js';
import { jsonResponse, textResponse, asPositiveInt, normalizeJsonInput } from './helpers.js';
import { assertPermission, writeAuditLog } from './rbac.js';
import { buildStarterAlertPackDefinitions, extractStarterIdFromParamsJson } from './starter-alert-pack.mjs';

export async function handleAlerts(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;
  const isAlertAdmin = auth.role === 'admin' || auth.role === 'superadmin';

  if (request.method === 'GET' && pathname === '/alerts/starter-pack') {
    assertPermission(auth, 'alert.read');
    const templates = buildStarterAlertPackDefinitions({}).map((template) => ({
      starter_id: template.starter_id,
      name: template.name,
      type: template.type,
      query_template: template.query_template,
      params_json: template.params_json,
      threshold_json: template.threshold_json,
      notify_json: template.notify_json,
      schedule_seconds: template.schedule_seconds,
      cooldown_seconds: template.cooldown_seconds
    }));
    return jsonResponse({ templates }, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/alerts/starter-pack/apply') {
    assertPermission(auth, 'alert.write');
    const body = await request.json().catch(() => ({})) as StarterAlertApplyRequest;
    const templates = buildStarterAlertPackDefinitions(body || {});
    const existingRows = await env.DB.prepare(
      `SELECT id, name, params_json
       FROM alerts
       ORDER BY created_at DESC
       LIMIT 1000`
    ).all<{ id: string; name: string; params_json: string }>();

    const existingByStarterId = new Map<string, { id: string; name: string }>();
    for (const row of existingRows.results || []) {
      const starterId = extractStarterIdFromParamsJson(row.params_json);
      if (!starterId) continue;
      if (!existingByStarterId.has(starterId)) {
        existingByStarterId.set(starterId, { id: row.id, name: row.name });
      }
    }

    const inserted: Array<{ starter_id: string; id: string; name: string }> = [];
    const existing: Array<{ starter_id: string; id: string; name: string }> = [];
    const now = new Date().toISOString();

    for (const template of templates) {
      const existingRow = existingByStarterId.get(template.starter_id);
      if (existingRow) {
        existing.push({ starter_id: template.starter_id, id: existingRow.id, name: existingRow.name });
        continue;
      }

      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO alerts (
          id, name, enabled, type, query_template, params_json,
          schedule_seconds, threshold_json, notify_json, cooldown_seconds, created_by,
          created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        template.name,
        template.type,
        template.query_template,
        template.params_json,
        template.schedule_seconds,
        template.threshold_json,
        template.notify_json,
        template.cooldown_seconds,
        principal,
        now,
        now
      ).run();

      inserted.push({ starter_id: template.starter_id, id, name: template.name });
    }

    await writeAuditLog(env, auth, 'alert.starter_pack.applied', 'alert', undefined, {
      inserted_count: inserted.length,
      existing_count: existing.length
    }).catch(() => undefined);

    return jsonResponse({
      ok: true,
      inserted_count: inserted.length,
      existing_count: existing.length,
      inserted,
      existing
    }, 200, requestCorsHeaders);
  }

  if (request.method === 'GET' && pathname === '/alerts') {
    assertPermission(auth, 'alert.read');
    const rows = await env.DB.prepare(
      `SELECT id, name, enabled, type, query_template, params_json, schedule_seconds,
              threshold_json, notify_json, cooldown_seconds, created_by, created_at, updated_at
       FROM alerts
       ORDER BY created_at DESC
       LIMIT 200`
    ).all<AlertRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/alerts') {
    assertPermission(auth, 'alert.write');
    const body = await request.json() as Partial<AlertRow>;
    const name = String(body.name || '').trim();
    const type = String(body.type || '').trim();
    const queryTemplate = String(body.query_template || '').trim();

    if (!name || !type || !queryTemplate) {
      return jsonResponse({ error: 'name, type, and query_template are required' }, 400, requestCorsHeaders);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const enabled = body.enabled === 0 ? 0 : 1;
    const scheduleSeconds = asPositiveInt(body.schedule_seconds, 60, 7 * 24 * 3600);
    const cooldownSeconds = asPositiveInt(body.cooldown_seconds, 300, 7 * 24 * 3600);
    const paramsJson = normalizeJsonInput(body.params_json, '{}');
    const thresholdJson = normalizeJsonInput(body.threshold_json, '{"operator":"gt","value":0}');
    const notifyJson = normalizeJsonInput(body.notify_json, '{}');

    await env.DB.prepare(
      `INSERT INTO alerts (
        id, name, enabled, type, query_template, params_json,
        schedule_seconds, threshold_json, notify_json, cooldown_seconds, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      name,
      enabled,
      type,
      queryTemplate,
      paramsJson,
      scheduleSeconds,
      thresholdJson,
      notifyJson,
      cooldownSeconds,
      principal,
      now,
      now
    ).run();

    await writeAuditLog(env, auth, 'alert.created', 'alert', id, { name, type }).catch(() => undefined);
    return jsonResponse({
      id,
      name,
      enabled,
      type,
      query_template: queryTemplate,
      params_json: paramsJson,
      schedule_seconds: scheduleSeconds,
      threshold_json: thresholdJson,
      notify_json: notifyJson,
      cooldown_seconds: cooldownSeconds,
      created_by: principal,
      created_at: now,
      updated_at: now
    }, 201, requestCorsHeaders);
  }

  if (pathname.startsWith('/alerts/')) {
    const id = pathname.split('/').pop();
    if (!id) return jsonResponse({ error: 'Invalid alert id' }, 400, requestCorsHeaders);

    if (request.method === 'PUT') {
      assertPermission(auth, 'alert.write');
      const body = await request.json() as Partial<AlertRow>;
      const existing = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?').bind(id).first<AlertRow>();
      if (!existing) {
        return jsonResponse({ error: 'Alert not found' }, 404, requestCorsHeaders);
      }
      if (!isAlertAdmin && existing.created_by && existing.created_by !== principal) throw new Error('Forbidden');

      const now = new Date().toISOString();
      const name = String(body.name ?? existing.name).trim();
      const type = String(body.type ?? existing.type).trim();
      const queryTemplate = String(body.query_template ?? existing.query_template).trim();
      const enabled = body.enabled === undefined ? existing.enabled : (body.enabled === 0 ? 0 : 1);
      const scheduleSeconds = body.schedule_seconds === undefined
        ? existing.schedule_seconds
        : asPositiveInt(body.schedule_seconds, existing.schedule_seconds, 7 * 24 * 3600);
      const cooldownSeconds = body.cooldown_seconds === undefined
        ? existing.cooldown_seconds
        : asPositiveInt(body.cooldown_seconds, existing.cooldown_seconds, 7 * 24 * 3600);
      const paramsJson = body.params_json === undefined
        ? existing.params_json
        : normalizeJsonInput(body.params_json, existing.params_json);
      const thresholdJson = body.threshold_json === undefined
        ? existing.threshold_json
        : normalizeJsonInput(body.threshold_json, existing.threshold_json);
      const notifyJson = body.notify_json === undefined
        ? existing.notify_json
        : normalizeJsonInput(body.notify_json, existing.notify_json);

      await env.DB.prepare(
        `UPDATE alerts
         SET name = ?, enabled = ?, type = ?, query_template = ?, params_json = ?,
             schedule_seconds = ?, threshold_json = ?, notify_json = ?, cooldown_seconds = ?,
             updated_at = ?
         WHERE id = ?`
      ).bind(
        name,
        enabled,
        type,
        queryTemplate,
        paramsJson,
        scheduleSeconds,
        thresholdJson,
        notifyJson,
        cooldownSeconds,
        now,
        id
      ).run();

      await writeAuditLog(env, auth, 'alert.updated', 'alert', id, { name }).catch(() => undefined);
      return jsonResponse({
        id,
        name,
        enabled,
        type,
        query_template: queryTemplate,
        params_json: paramsJson,
        schedule_seconds: scheduleSeconds,
        threshold_json: thresholdJson,
        notify_json: notifyJson,
        cooldown_seconds: cooldownSeconds,
        created_by: existing.created_by || principal,
        updated_at: now
      }, 200, requestCorsHeaders);
    }

    if (request.method === 'DELETE') {
      assertPermission(auth, 'alert.delete');
      const existing = await env.DB.prepare('SELECT id, created_by FROM alerts WHERE id = ?').bind(id).first<{ id: string; created_by?: string | null }>();
      if (existing && !isAlertAdmin && existing.created_by && existing.created_by !== principal) throw new Error('Forbidden');
      await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM alert_state WHERE alert_id = ?').bind(id).run();
      await writeAuditLog(env, auth, 'alert.deleted', 'alert', id).catch(() => undefined);
      return new Response(null, { status: 204, headers: requestCorsHeaders });
    }
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
