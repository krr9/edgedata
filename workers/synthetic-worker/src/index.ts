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
  SYNTHETIC_RUN_SECRET?: string;
}

interface RunSummary {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  ingest_response?: string;
  batch_size?: number;
  profile?: string;
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

  const batchSize = parseBatchSize(env.SYNTHETIC_BATCH_SIZE, 24, 400);
  const profile = parseProfile(env.SYNTHETIC_PROFILE, 'basic');
  const events = buildSyntheticEvents({
    batch_size: batchSize,
    batch_min: env.SYNTHETIC_BATCH_MIN,
    batch_max: env.SYNTHETIC_BATCH_MAX,
    profile,
    index: env.SYNTHETIC_INDEX,
    service: env.SYNTHETIC_SERVICE,
    env: env.SYNTHETIC_ENV,
    host_prefix: env.SYNTHETIC_HOST_PREFIX,
    region: env.SYNTHETIC_REGION
  });

  const request = new Request(env.INGEST_URL || 'https://ingest.internal/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.INGEST_SECRET}`,
      'x-agent-id': 'synthetic-cron',
      'x-service': String(env.SYNTHETIC_SERVICE || 'edgedata-demo'),
      'x-index': String(env.SYNTHETIC_INDEX || 'default'),
      'x-env': String(env.SYNTHETIC_ENV || 'demo'),
      'x-host': String(env.SYNTHETIC_HOST_PREFIX || 'edgedata-cron')
    },
    body: JSON.stringify({ events })
  });
  const response = env.INGEST_SERVICE
    ? await env.INGEST_SERVICE.fetch(request)
    : await fetch(request);

  const responseText = sanitizeResponsePreview(await response.text());
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      batch_size: events.length,
      profile,
      ingest_response: responseText
    };
  }

  return {
    ok: true,
    status: response.status,
    batch_size: events.length,
    profile,
    ingest_response: responseText
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
        synthetic_index: String(env.SYNTHETIC_INDEX || 'default')
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
