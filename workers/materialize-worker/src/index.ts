import {
  buildMaterializationBucket,
  buildScopeKey,
  hashQueryText
} from '../../shared/materialization-core.mjs';
import { timingSafeTokenCompare } from '../../shared/timing-safe.mjs';

export interface Env {
  DB: D1Database;
  QUERY_SERVICE?: Fetcher;
  QUERY_WORKER_URL?: string;
  QUERY_WORKER_TOKEN?: string;
  MATERIALIZE_RUN_SECRET?: string;
}

interface DashboardPanelRow {
  id: string;
  dashboard_id: string;
  title: string;
  widget_type?: string | null;
  ppl?: string | null;
  query_text?: string | null;
  time_window_minutes: number;
  execution_mode?: string | null;
  materialize_enabled?: number | null;
  materialize_interval_seconds?: number | null;
  priority?: number | null;
  last_materialized_at?: string | null;
}

interface PplSearchResponse {
  result_type: 'events' | 'table';
  results: Array<Record<string, unknown>>;
  next_cursor: { before_ts: string; before_event_id: string } | null;
  source?: string;
  computed_at?: string;
  expires_at?: string;
  materialization_status?: string;
  stats: Record<string, unknown>;
  warning?: string;
}

interface MaterializeSummary {
  evaluated: number;
  refreshed: number;
  skipped: number;
  failed: number;
}

const SERVICE_VERSION = '0.1.0';
const DEFAULT_SCOPE = { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] };
const DEFAULT_INTERVAL_SECONDS = 300;
const MAX_INLINE_BYTES = 256 * 1024;
const RETAIN_DAYS = 7;

function resolvePanelQuery(panel: DashboardPanelRow): string {
  const ppl = String(panel.ppl || '').trim();
  if (ppl) return ppl;
  return String(panel.query_text || '').trim();
}

function asPositiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.trunc(numeric), max);
}

function normalizeExecutionMode(value: unknown): 'live' | 'cached' | 'materialized' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cached' || normalized === 'materialized') return normalized;
  return 'live';
}

function resolveQueryWorkerUrl(rawUrl: string | undefined, path: string): string {
  const base = String(rawUrl || '').trim();
  if (!base) throw new Error('QUERY_WORKER_URL is not configured');
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function fetchQueryWorker(env: Env, path: string, init: RequestInit): Promise<Response> {
  if (env.QUERY_SERVICE) {
    return env.QUERY_SERVICE.fetch(`https://query-worker${path}`, init);
  }
  return fetch(resolveQueryWorkerUrl(env.QUERY_WORKER_URL, path), init);
}

function shouldMaterializePanel(panel: DashboardPanelRow, nowMs: number): boolean {
  const mode = normalizeExecutionMode(panel.execution_mode);
  const enabled = panel.materialize_enabled === 1 || mode === 'materialized';
  if (!enabled) return false;
  if (String(panel.widget_type || '').toLowerCase() === 'markdown') return false;
  if (!resolvePanelQuery(panel)) return false;

  const intervalSeconds = asPositiveInt(panel.materialize_interval_seconds, DEFAULT_INTERVAL_SECONDS, 86400);
  const bucket = buildMaterializationBucket(
    {
      from: new Date(nowMs - (asPositiveInt(panel.time_window_minutes, 60, 10080) * 60 * 1000)).toISOString(),
      to: new Date(nowMs).toISOString()
    },
    intervalSeconds
  );
  const lastMaterializedAtMs = Date.parse(String(panel.last_materialized_at || ''));
  if (!Number.isFinite(lastMaterializedAtMs)) return true;
  return lastMaterializedAtMs < Date.parse(bucket.time_bucket_end);
}

async function listMaterializablePanels(env: Env): Promise<DashboardPanelRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, dashboard_id, title, widget_type, ppl, query_text, time_window_minutes,
            execution_mode, materialize_enabled, materialize_interval_seconds, priority, last_materialized_at
     FROM dashboard_panels
     WHERE (materialize_enabled = 1 OR execution_mode = 'materialized')
       AND COALESCE(TRIM(query_text), '') != ''
     ORDER BY priority DESC, updated_at DESC
     LIMIT 200`
  ).all<DashboardPanelRow>();
  return rows.results || [];
}

async function fetchMaterializedPanelResult(
  panel: DashboardPanelRow,
  bucket: { time_bucket_start: string; time_bucket_end: string; expires_at: string },
  env: Env
): Promise<PplSearchResponse> {
  const token = String(env.QUERY_WORKER_TOKEN || '').trim();
  if (!token) {
    throw new Error('QUERY_WORKER_TOKEN is not configured');
  }
  const response = await fetchQueryWorker(env, '/dashboards/widgets/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-internal-caller': 'materialize-worker'
    },
    body: JSON.stringify({
      widget_id: panel.id,
      ppl: resolvePanelQuery(panel),
      time: {
        from: bucket.time_bucket_start,
        to: bucket.time_bucket_end
      },
      limit: 500
    })
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim();
    throw new Error(`query-worker returned ${response.status}${detail ? ` body=${detail.slice(0, 180)}` : ''}`);
  }

  return await response.json() as PplSearchResponse;
}

async function persistMaterializedPanel(
  panel: DashboardPanelRow,
  response: PplSearchResponse,
  bucket: { time_bucket_start: string; time_bucket_end: string; expires_at: string },
  env: Env
): Promise<void> {
  const now = new Date().toISOString();
  const scopeKey = buildScopeKey(DEFAULT_SCOPE);
  const queryHash = hashQueryText(resolvePanelQuery(panel));
  const payload = JSON.stringify({
    ...response,
    source: 'materialized',
    computed_at: now,
    expires_at: bucket.expires_at,
    materialization_status: 'fresh'
  });
  if (payload.length > MAX_INLINE_BYTES) {
    throw new Error(`materialized payload exceeds inline storage budget (${payload.length} bytes)`);
  }

  const resultCount = Array.isArray(response.results) ? response.results.length : 0;
  const statsJson = JSON.stringify(response.stats || {});

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM materialized_results
       WHERE entity_type = 'dashboard_panel'
         AND entity_id = ?
         AND scope_key = ?
         AND query_hash = ?
         AND time_bucket_start = ?
         AND time_bucket_end = ?`
    ).bind(panel.id, scopeKey, queryHash, bucket.time_bucket_start, bucket.time_bucket_end),
    env.DB.prepare(
      `INSERT INTO materialized_results (
         id, entity_type, entity_id, scope_key, query_hash, time_bucket_start, time_bucket_end,
         status, result_count, payload_inline_json, stats_json, computed_at, expires_at
       )
       VALUES (?, 'dashboard_panel', ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      panel.id,
      scopeKey,
      queryHash,
      bucket.time_bucket_start,
      bucket.time_bucket_end,
      resultCount,
      payload,
      statsJson,
      now,
      bucket.expires_at
    ),
    env.DB.prepare(
      `INSERT INTO materialization_runs (
         id, entity_type, entity_id, scope_key, query_hash, started_at, completed_at, status, result_count, stats_json
       )
       VALUES (?, 'dashboard_panel', ?, ?, ?, ?, ?, 'success', ?, ?)`
    ).bind(crypto.randomUUID(), panel.id, scopeKey, queryHash, now, now, resultCount, statsJson),
    env.DB.prepare(
      `UPDATE dashboard_panels
       SET last_materialized_at = ?, last_materialization_status = 'success', last_materialization_error = NULL
       WHERE id = ?`
    ).bind(now, panel.id)
  ]);
}

async function markPanelMaterializationError(panel: DashboardPanelRow, error: unknown, env: Env): Promise<void> {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const scopeKey = buildScopeKey(DEFAULT_SCOPE);
  const queryHash = hashQueryText(resolvePanelQuery(panel));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO materialization_runs (
         id, entity_type, entity_id, scope_key, query_hash, started_at, completed_at, status, result_count, stats_json, error_message
       )
       VALUES (?, 'dashboard_panel', ?, ?, ?, ?, ?, 'error', 0, '{}', ?)`
    ).bind(crypto.randomUUID(), panel.id, scopeKey, queryHash, now, now, message.slice(0, 1000)),
    env.DB.prepare(
      `UPDATE dashboard_panels
       SET last_materialization_status = 'error', last_materialization_error = ?
       WHERE id = ?`
    ).bind(message.slice(0, 1000), panel.id)
  ]);
}

async function cleanupOldMaterializations(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM materialization_runs WHERE started_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM materialized_results WHERE computed_at < ?').bind(cutoff)
  ]);
}

async function runMaterializations(env: Env): Promise<MaterializeSummary> {
  const nowMs = Date.now();
  const panels = await listMaterializablePanels(env);
  const summary: MaterializeSummary = {
    evaluated: panels.length,
    refreshed: 0,
    skipped: 0,
    failed: 0
  };

  for (const panel of panels) {
    if (!shouldMaterializePanel(panel, nowMs)) {
      summary.skipped += 1;
      continue;
    }

    const intervalSeconds = asPositiveInt(panel.materialize_interval_seconds, DEFAULT_INTERVAL_SECONDS, 86400);
    const bucket = buildMaterializationBucket(
      {
        from: new Date(nowMs - (asPositiveInt(panel.time_window_minutes, 60, 10080) * 60 * 1000)).toISOString(),
        to: new Date(nowMs).toISOString()
      },
      intervalSeconds
    );

    try {
      const response = await fetchMaterializedPanelResult(panel, bucket, env);
      await persistMaterializedPanel(panel, response, bucket, env);
      summary.refreshed += 1;
    } catch (error) {
      summary.failed += 1;
      await markPanelMaterializationError(panel, error, env);
      console.error(`materialization failed panel=${panel.id}`, error);
    }
  }

  await cleanupOldMaterializations(env).catch((error) => {
    console.error('materialization cleanup failed', error);
  });

  return summary;
}

export async function authorizeManualRun(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get('authorization') || '';
  if (!env.MATERIALIZE_RUN_SECRET || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeTokenCompare(authHeader.slice(7).trim(), env.MATERIALIZE_RUN_SECRET);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'materialize-worker', version: SERVICE_VERSION });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      if (!(await authorizeManualRun(request, env))) {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
      try {
        const summary = await runMaterializations(env);
        return Response.json({ ok: true, ...summary });
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runMaterializations(env).then((summary) => {
        if (summary.refreshed > 0 || summary.failed > 0) {
          console.log(`materializations refreshed=${summary.refreshed} skipped=${summary.skipped} failed=${summary.failed}`);
        }
      }).catch((error) => {
        console.error('materialization cycle failed', error);
      })
    );
  }
};
