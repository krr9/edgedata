/**
 * Lookup tables CRUD handler extracted from query-worker index.
 */

import type { Env, AuthContext, LookupTableRow } from './types.js';
import { jsonResponse, textResponse } from './helpers.js';
import { assertPermission } from './rbac.js';

const MAX_LOOKUP_ROWS = 10000;
const MAX_LOOKUP_TABLES = 50;

export async function handleLookupTables(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const lookupPrincipal = auth.email || auth.principal;
  const isLookupAdmin = auth.role === 'admin' || auth.role === 'superadmin';
  if (request.method === 'GET' && pathname === '/lookup-tables') {
    assertPermission(auth, 'lookup.read');
    const rows = await env.DB.prepare('SELECT * FROM lookup_tables ORDER BY created_at DESC LIMIT 100').all<LookupTableRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/lookup-tables') {
    assertPermission(auth, 'lookup.write');
    const tableCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM lookup_tables').first<{ cnt: number }>();
    if (tableCount && tableCount.cnt >= MAX_LOOKUP_TABLES) {
      return jsonResponse({ error: `Maximum ${MAX_LOOKUP_TABLES} lookup tables allowed` }, 400, requestCorsHeaders);
    }
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const keyField = String(body.key_field || '').trim();
    if (!name || !keyField) return jsonResponse({ error: 'name and key_field are required' }, 400, requestCorsHeaders);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const principal = auth.email || auth.principal;
    const schemaJson = JSON.stringify(Array.isArray(body.schema) ? body.schema : []);
    await env.DB.prepare(
      `INSERT INTO lookup_tables (id, name, description, key_field, schema_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, String(body.description || ''), keyField, schemaJson, principal, now, now).run();

    if (Array.isArray(body.rows)) {
      const rowsToInsert = (body.rows as Array<Record<string, unknown>>).slice(0, MAX_LOOKUP_ROWS);
      for (const row of rowsToInsert) {
        const kv = String(row[keyField] ?? '');
        if (!kv) continue;
        const data = { ...row };
        delete data[keyField];
        await env.DB.prepare(
          'INSERT OR REPLACE INTO lookup_rows (lookup_id, key_value, data_json) VALUES (?, ?, ?)'
        ).bind(id, kv, JSON.stringify(data)).run();
      }
    }

    return jsonResponse({ id, name, key_field: keyField, created_at: now }, 201, requestCorsHeaders);
  }

  const idMatch = pathname.match(/^\/lookup-tables\/([^/]+)/);
  if (!idMatch) return textResponse('Not found', 404, requestCorsHeaders);
  const tableId = idMatch[1];

  if (request.method === 'GET' && pathname === `/lookup-tables/${tableId}`) {
    assertPermission(auth, 'lookup.read');
    const table = await env.DB.prepare('SELECT * FROM lookup_tables WHERE id = ?').bind(tableId).first<LookupTableRow>();
    if (!table) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const rows = await env.DB.prepare('SELECT key_value, data_json FROM lookup_rows WHERE lookup_id = ? LIMIT ?')
      .bind(tableId, MAX_LOOKUP_ROWS).all<{ key_value: string; data_json: string }>();
    return jsonResponse({
      ...table,
      rows: (rows.results || []).map(r => ({ key: r.key_value, ...JSON.parse(r.data_json) }))
    }, 200, requestCorsHeaders);
  }

  if (request.method === 'PATCH' && pathname.endsWith('/rows')) {
    assertPermission(auth, 'lookup.write');
    const table = await env.DB.prepare('SELECT id, key_field FROM lookup_tables WHERE id = ?').bind(tableId).first<{ id: string; key_field: string }>();
    if (!table) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const body = await request.json() as { rows?: Array<Record<string, unknown>>; delete_keys?: string[] };

    if (Array.isArray(body.delete_keys)) {
      for (const key of body.delete_keys) {
        await env.DB.prepare('DELETE FROM lookup_rows WHERE lookup_id = ? AND key_value = ?').bind(tableId, String(key)).run();
      }
    }

    if (Array.isArray(body.rows)) {
      const currentCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM lookup_rows WHERE lookup_id = ?').bind(tableId).first<{ cnt: number }>();
      const remaining = MAX_LOOKUP_ROWS - (currentCount?.cnt || 0);
      const rowsToInsert = body.rows.slice(0, Math.max(0, remaining + (body.delete_keys?.length || 0)));
      for (const row of rowsToInsert) {
        const kv = String(row[table.key_field] ?? '');
        if (!kv) continue;
        const data = { ...row };
        delete data[table.key_field];
        await env.DB.prepare(
          'INSERT OR REPLACE INTO lookup_rows (lookup_id, key_value, data_json) VALUES (?, ?, ?)'
        ).bind(tableId, kv, JSON.stringify(data)).run();
      }
    }

    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE lookup_tables SET updated_at = ? WHERE id = ?').bind(now, tableId).run();
    return jsonResponse({ id: tableId, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'PUT') {
    assertPermission(auth, 'lookup.write');
    const existing = await env.DB.prepare('SELECT id, created_by FROM lookup_tables WHERE id = ?').bind(tableId).first<{ id: string; created_by?: string | null }>();
    if (!existing) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    if (!isLookupAdmin && existing.created_by && existing.created_by !== lookupPrincipal) throw new Error('Forbidden');
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).trim()); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(String(body.description)); }
    if (body.schema !== undefined) { updates.push('schema_json = ?'); values.push(JSON.stringify(Array.isArray(body.schema) ? body.schema : [])); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(tableId);
    await env.DB.prepare(`UPDATE lookup_tables SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    return jsonResponse({ id: tableId, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'DELETE') {
    assertPermission(auth, 'lookup.delete');
    const existing = await env.DB.prepare('SELECT id, created_by FROM lookup_tables WHERE id = ?').bind(tableId).first<{ id: string; created_by?: string | null }>();
    if (existing && !isLookupAdmin && existing.created_by && existing.created_by !== lookupPrincipal) throw new Error('Forbidden');
    await env.DB.prepare('DELETE FROM lookup_rows WHERE lookup_id = ?').bind(tableId).run();
    await env.DB.prepare('DELETE FROM lookup_tables WHERE id = ?').bind(tableId).run();
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
