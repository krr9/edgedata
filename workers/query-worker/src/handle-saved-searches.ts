/**
 * Saved searches CRUD handler extracted from query-worker index.
 */

import type { Env, AuthContext, SavedSearchRow } from './types.js';
import { jsonResponse, textResponse } from './helpers.js';
import { assertPermission } from './rbac.js';

export async function handleSavedSearches(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;

  if (request.method === 'GET' && pathname === '/saved-searches') {
    assertPermission(auth, 'saved_search.read');
    if (auth.role === 'admin' || auth.role === 'superadmin') {
      const rows = await env.DB.prepare(
        'SELECT id, name, query, created_by, created_at, updated_at FROM saved_searches ORDER BY created_at DESC LIMIT 100'
      ).all<SavedSearchRow>();
      return jsonResponse(rows.results || [], 200, requestCorsHeaders);
    }

    const rows = await env.DB.prepare(
      `SELECT id, name, query, created_by, created_at, updated_at
       FROM saved_searches
       WHERE created_by = ? OR created_by IS NULL
       ORDER BY created_at DESC
       LIMIT 100`
    ).bind(principal).all<SavedSearchRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/saved-searches') {
    assertPermission(auth, 'saved_search.write');
    const body = await request.json() as { name?: string; query?: string };
    const name = (body.name || '').trim();
    const query = (body.query || '').trim();

    if (!name || !query) {
      return jsonResponse({ error: 'name and query are required' }, 400, requestCorsHeaders);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      'INSERT INTO saved_searches (id, name, query, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, name, query, principal, now, now).run();

    return jsonResponse({ id, name, query, created_by: principal, created_at: now, updated_at: now }, 201, requestCorsHeaders);
  }

  if (pathname.startsWith('/saved-searches/')) {
    const id = pathname.split('/').pop();
    if (!id) return jsonResponse({ error: 'Invalid saved search id' }, 400, requestCorsHeaders);

    if (request.method === 'PUT') {
      assertPermission(auth, 'saved_search.write');
      const body = await request.json() as { name?: string; query?: string };
      const name = (body.name || '').trim();
      const query = (body.query || '').trim();
      if (!name || !query) {
        return jsonResponse({ error: 'name and query are required' }, 400, requestCorsHeaders);
      }

      const existing = await env.DB.prepare('SELECT id, created_by FROM saved_searches WHERE id = ?')
        .bind(id)
        .first<{ id: string; created_by?: string | null }>();
      if (!existing) {
        return jsonResponse({ error: 'Saved search not found' }, 404, requestCorsHeaders);
      }
      if (auth.role !== 'admin' && auth.role !== 'superadmin' && existing.created_by && existing.created_by !== principal) {
        throw new Error('Forbidden');
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE saved_searches SET name = ?, query = ?, updated_at = ? WHERE id = ?'
      ).bind(name, query, now, id).run();

      return jsonResponse({ id, name, query, updated_at: now }, 200, requestCorsHeaders);
    }

    if (request.method === 'DELETE') {
      assertPermission(auth, 'saved_search.delete');
      const existing = await env.DB.prepare('SELECT id, created_by FROM saved_searches WHERE id = ?')
        .bind(id)
        .first<{ id: string; created_by?: string | null }>();
      if (!existing) {
        return new Response(null, { status: 204, headers: requestCorsHeaders });
      }
      if (auth.role !== 'admin' && auth.role !== 'superadmin' && existing.created_by && existing.created_by !== principal) {
        throw new Error('Forbidden');
      }

      await env.DB.prepare('DELETE FROM saved_searches WHERE id = ?').bind(id).run();
      return new Response(null, { status: 204, headers: requestCorsHeaders });
    }
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
