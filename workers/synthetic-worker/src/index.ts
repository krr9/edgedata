import {
  buildSyntheticEvents,
  computeSyntheticBatchSize,
  parseBatchSize,
  parseBoolean,
  parseProfile
} from './synthetic-core.mjs';
import {
  CONTROL_KEY,
  readSyntheticIngestEnabled,
  writeSyntheticIngestEnabled
} from './runtime-control.mjs';

export interface Env {
  DB?: D1Database;
  INGEST_SERVICE?: Fetcher;
  INGEST_URL?: string;
  INGEST_SECRET?: string;
  SYNTHETIC_ENABLED?: string;
  SYNTHETIC_BATCH_SIZE?: string;
  SYNTHETIC_BATCH_MIN?: string;
  SYNTHETIC_BATCH_MAX?: string;
  SYNTHETIC_PROFILE?: string;
  SYNTHETIC_INDEX?: string;
  SYNTHETIC_SERVICE?: string;
  SYNTHETIC_ENV?: string;
  SYNTHETIC_HOST_PREFIX?: string;
  SYNTHETIC_REGION?: string;
  SYNTHETIC_EXTRA_TARGETS?: string;
  SYNTHETIC_RUN_SECRET?: string;
}

interface SyntheticTarget {
  index: string;
  service: string;
  profile: string;
  env: string;
  host_prefix: string;
  region: string;
}

interface TargetRunResult {
  ok: boolean;
  status: number;
  batch_size: number;
  profile: string;
  index: string;
  service: string;
  ingest_response: string;
}

interface RunSummary {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  ingest_response?: string;
  batch_size?: number;
  profile?: string;
  target_count?: number;
  total_batch_size?: number;
  runs?: Array<{
    ok: boolean;
    status: number;
    batch_size: number;
    profile: string;
    index: string;
    service: string;
    ingest_response: string;
  }>;
}

interface RuntimeFlagRow {
  value?: string;
  updated_at?: string;
}

function isEnabled(env: Env): boolean {
  return parseBoolean(env.SYNTHETIC_ENABLED, true);
}

function sanitizeResponsePreview(input: string): string {
  return input.length <= 300 ? input : `${input.slice(0, 300)}...`;
}

function normalizeTargetIndex(value: string | undefined, fallback = 'default'): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function resolvePrimaryTarget(env: Env): SyntheticTarget {
  return {
    index: normalizeTargetIndex(env.SYNTHETIC_INDEX, 'default'),
    service: String(env.SYNTHETIC_SERVICE || 'edgedata-demo').trim() || 'edgedata-demo',
    profile: parseProfile(env.SYNTHETIC_PROFILE, 'basic'),
    env: String(env.SYNTHETIC_ENV || 'demo').trim() || 'demo',
    host_prefix: String(env.SYNTHETIC_HOST_PREFIX || 'edgedata-cron').trim() || 'edgedata-cron',
    region: String(env.SYNTHETIC_REGION || 'global').trim() || 'global'
  };
}

function parseExtraTargets(raw: string | undefined, defaults: SyntheticTarget): SyntheticTarget[] {
  const text = String(raw || '').trim();
  if (!text) return [];

  const targets: SyntheticTarget[] = [];
  for (const entry of text.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((value) => value.trim());
    const index = normalizeTargetIndex(parts[0], '');
    if (!index) continue;
    const service = parts[1] || defaults.service;
    const profile = parseProfile(parts[2], defaults.profile);
    const targetEnv = parts[3] || defaults.env;
    targets.push({
      index,
      service,
      profile,
      env: targetEnv,
      host_prefix: defaults.host_prefix,
      region: defaults.region
    });
  }
  return targets;
}

function resolveTargets(env: Env): SyntheticTarget[] {
  const primary = resolvePrimaryTarget(env);
  const extras = parseExtraTargets(env.SYNTHETIC_EXTRA_TARGETS, primary);
  return [primary, ...extras];
}

async function runTargetIngest(env: Env, target: SyntheticTarget): Promise<TargetRunResult> {
  const batchSize = parseBatchSize(env.SYNTHETIC_BATCH_SIZE, 24, 400);
  const events = buildSyntheticEvents({
    batch_size: batchSize,
    batch_min: env.SYNTHETIC_BATCH_MIN,
    batch_max: env.SYNTHETIC_BATCH_MAX,
    profile: target.profile,
    index: target.index,
    service: target.service,
    env: target.env,
    host_prefix: target.host_prefix,
    region: target.region
  });

  const request = new Request(env.INGEST_URL || 'https://ingest.internal/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.INGEST_SECRET}`,
      'x-agent-id': 'synthetic-cron',
      'x-service': target.service,
      'x-index': target.index,
      'x-env': target.env,
      'x-host': target.host_prefix
    },
    body: JSON.stringify({ events })
  });
  const response = env.INGEST_SERVICE
    ? await env.INGEST_SERVICE.fetch(request)
    : await fetch(request);
  const responseText = sanitizeResponsePreview(await response.text());
  return {
    ok: response.ok,
    status: response.status,
    batch_size: events.length,
    profile: target.profile,
    index: target.index,
    service: target.service,
    ingest_response: responseText
  };
}

async function runSyntheticIngest(env: Env): Promise<RunSummary> {
  const enabled = await readSyntheticIngestEnabled(env.DB, isEnabled(env));
  if (!enabled) {
    return { ok: true, skipped: true, reason: 'Synthetic ingestion disabled' };
  }
  if (!env.INGEST_SECRET) {
    return { ok: false, reason: 'Missing INGEST_SECRET' };
  }
  if (!env.INGEST_SERVICE && !env.INGEST_URL) {
    return { ok: false, reason: 'Missing INGEST_SERVICE or INGEST_URL' };
  }

  const targets = resolveTargets(env);
  const runs: TargetRunResult[] = [];
  for (const target of targets) {
    const run = await runTargetIngest(env, target);
    runs.push(run);
  }
  const failed = runs.find((run) => !run.ok);
  const totalBatchSize = runs.reduce((sum, run) => sum + run.batch_size, 0);
  if (failed) {
    return {
      ok: false,
      status: failed.status,
      batch_size: failed.batch_size,
      profile: failed.profile,
      ingest_response: failed.ingest_response,
      target_count: runs.length,
      total_batch_size: totalBatchSize,
      runs
    };
  }
  const first = runs[0];
  return {
    ok: true,
    status: first?.status || 200,
    batch_size: first?.batch_size || 0,
    profile: first?.profile || parseProfile(env.SYNTHETIC_PROFILE, 'basic'),
    ingest_response: first?.ingest_response || '',
    target_count: runs.length,
    total_batch_size: totalBatchSize,
    runs
  };
}

function manualRunAuthorized(request: Request, env: Env): boolean {
  const expected = String(env.SYNTHETIC_RUN_SECRET || '').trim();
  if (!expected) return false;

  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  return token === expected;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      const runtimeEnabled = await readSyntheticIngestEnabled(env.DB, isEnabled(env));
      const targets = resolveTargets(env);
      return Response.json({
        status: 'ok',
        service: 'synthetic-worker',
        version: '1.0.0',
        synthetic_enabled: isEnabled(env),
        synthetic_runtime_enabled: runtimeEnabled,
        ingest_url: env.INGEST_URL || '',
        synthetic_batch_size: parseBatchSize(env.SYNTHETIC_BATCH_SIZE, 24, 400),
        synthetic_batch_min: parseBatchSize(env.SYNTHETIC_BATCH_MIN, 12, 400),
        synthetic_batch_max: parseBatchSize(env.SYNTHETIC_BATCH_MAX, 48, 400),
        synthetic_resolved_batch_size: computeSyntheticBatchSize({
          batch_size: env.SYNTHETIC_BATCH_SIZE,
          batch_min: env.SYNTHETIC_BATCH_MIN,
          batch_max: env.SYNTHETIC_BATCH_MAX,
          profile: parseProfile(env.SYNTHETIC_PROFILE, 'basic'),
          index: env.SYNTHETIC_INDEX,
          service: env.SYNTHETIC_SERVICE
        }),
        synthetic_profile: parseProfile(env.SYNTHETIC_PROFILE, 'basic'),
        synthetic_index: String(env.SYNTHETIC_INDEX || 'default'),
        synthetic_target_count: targets.length,
        synthetic_targets: targets.map((target) => ({
          index: target.index,
          service: target.service,
          profile: target.profile,
          env: target.env
        }))
      });
    }

    if (url.pathname === '/control' && request.method === 'GET') {
      if (!manualRunAuthorized(request, env)) {
        return Response.json(
          { ok: false, error: 'Unauthorized or SYNTHETIC_RUN_SECRET is not configured' },
          { status: 401 }
        );
      }
      const configured = isEnabled(env);
      const enabled = await readSyntheticIngestEnabled(env.DB, configured);
      let row: RuntimeFlagRow | null = null;
      if (env.DB) {
        try {
          row = await env.DB.prepare(
            'SELECT value, updated_at FROM runtime_flags WHERE key = ?'
          ).bind(CONTROL_KEY).first<RuntimeFlagRow>();
        } catch {
          row = null;
        }
      }
      const persisted = row && row.value !== undefined
        ? parseBoolean(String(row.value), configured)
        : null;
      return Response.json({
        ok: true,
        enabled,
        configured_enabled: configured,
        persisted_enabled: persisted,
        updated_at: row?.updated_at || null
      });
    }

    if (url.pathname === '/control' && request.method === 'POST') {
      if (!manualRunAuthorized(request, env)) {
        return Response.json(
          { ok: false, error: 'Unauthorized or SYNTHETIC_RUN_SECRET is not configured' },
          { status: 401 }
        );
      }
      if (!env.DB) {
        return Response.json({ ok: false, error: 'DB binding is not configured' }, { status: 500 });
      }
      const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
      if (typeof body?.enabled !== 'boolean') {
        return Response.json({ ok: false, error: 'enabled boolean is required' }, { status: 400 });
      }
      const now = new Date().toISOString();
      await writeSyntheticIngestEnabled(env.DB, body.enabled, now);
      return Response.json({
        ok: true,
        enabled: body.enabled,
        configured_enabled: isEnabled(env),
        persisted_enabled: body.enabled,
        updated_at: now
      });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      if (!manualRunAuthorized(request, env)) {
        return Response.json(
          { ok: false, error: 'Unauthorized or SYNTHETIC_RUN_SECRET is not configured' },
          { status: 401 }
        );
      }
      try {
        const result = await runSyntheticIngest(env);
        const status = result.ok ? 200 : 500;
        return Response.json(result, { status });
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        );
      }
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSyntheticIngest(env).then((result) => {
        if (!result.ok) {
          console.error('synthetic ingest failed', result);
        } else if (!result.skipped) {
          console.log(`synthetic ingest ok batch_size=${result.batch_size}`);
        }
      }).catch((error) => {
        console.error('synthetic ingest error', error);
      })
    );
  }
};
