/**
 * Admin handlers: synthetic ingest control and service fetchers.
 * Extracted from query-worker index.
 */

import type { Env, AuthContext } from './types.js';
import { jsonResponse, textResponse } from './helpers.js';
import { assertPermission, writeAuditLog } from './rbac.js';

export async function fetchSyntheticControl(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!env.SYNTHETIC_SERVICE) {
    throw new Error('Synthetic control is not configured (missing SYNTHETIC_SERVICE binding)');
  }
  if (!env.SYNTHETIC_RUN_SECRET) {
    throw new Error('Synthetic control is not configured (missing SYNTHETIC_RUN_SECRET secret)');
  }
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.SYNTHETIC_RUN_SECRET}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return env.SYNTHETIC_SERVICE.fetch(
    new Request(`https://internal${path}`, { ...init, headers })
  );
}

export async function fetchAlertControl(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!env.ALERT_SERVICE) {
    throw new Error('Alert control is not configured (missing ALERT_SERVICE binding)');
  }
  if (!env.ALERT_RUN_SECRET) {
    throw new Error('Alert control is not configured (missing ALERT_RUN_SECRET secret)');
  }
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.ALERT_RUN_SECRET}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return env.ALERT_SERVICE.fetch(
    new Request(`https://internal${path}`, { ...init, headers })
  );
}

export async function handleSyntheticIngestAdmin(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (!pathname.startsWith('/admin/synthetic-ingest')) {
    return textResponse('Not found', 404, requestCorsHeaders);
  }
  assertPermission(auth, 'role.write');

  if (request.method === 'POST' && pathname === '/admin/synthetic-ingest/run') {
    const runResponse = await fetchSyntheticControl(env, '/run', { method: 'POST' });
    const runBody = await runResponse.json() as Record<string, unknown>;
    if (!runResponse.ok || runBody.error) {
      return jsonResponse(
        { error: String(runBody.error || `Synthetic run failed (${runResponse.status})`) },
        runResponse.status >= 400 ? runResponse.status : 500,
        requestCorsHeaders
      );
    }
    await writeAuditLog(env, auth, 'synthetic.ingest.run.triggered', 'runtime_flags', 'synthetic_ingest_enabled', {
      source: 'admin'
    }).catch(() => undefined);
    return jsonResponse({ ok: true, run: runBody }, 200, requestCorsHeaders);
  }

  if (request.method === 'GET') {
    const response = await fetchSyntheticControl(env, '/control');
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || body.error) {
      return jsonResponse(
        { error: String(body.error || `Synthetic control request failed (${response.status})`) },
        response.status >= 400 ? response.status : 500,
        requestCorsHeaders
      );
    }
    return jsonResponse(body, 200, requestCorsHeaders);
  }

  if (request.method === 'POST') {
    const body = await request.json() as { enabled?: unknown; trigger_run?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return jsonResponse({ error: 'enabled boolean is required' }, 400, requestCorsHeaders);
    }

    const controlResponse = await fetchSyntheticControl(env, '/control', {
      method: 'POST',
      body: JSON.stringify({ enabled: body.enabled })
    });
    const controlBody = await controlResponse.json() as Record<string, unknown>;
    if (!controlResponse.ok || controlBody.error) {
      return jsonResponse(
        { error: String(controlBody.error || `Synthetic control update failed (${controlResponse.status})`) },
        controlResponse.status >= 400 ? controlResponse.status : 500,
        requestCorsHeaders
      );
    }

    let runBody: Record<string, unknown> | null = null;
    const triggerRun = body.trigger_run !== false;
    if (body.enabled && triggerRun) {
      const runResponse = await fetchSyntheticControl(env, '/run', { method: 'POST' });
      runBody = await runResponse.json() as Record<string, unknown>;
      if (!runResponse.ok || runBody.error) {
        return jsonResponse(
          {
            error: String(runBody.error || `Synthetic run failed (${runResponse.status})`),
            control: controlBody
          },
          runResponse.status >= 400 ? runResponse.status : 500,
          requestCorsHeaders
        );
      }
    }

    await writeAuditLog(env, auth, 'synthetic.ingest.control.updated', 'runtime_flags', 'synthetic_ingest_enabled', {
      enabled: body.enabled,
      trigger_run: body.enabled && triggerRun
    }).catch(() => undefined);

    return jsonResponse(
      {
        ok: true,
        control: controlBody,
        run: runBody
      },
      200,
      requestCorsHeaders
    );
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}
