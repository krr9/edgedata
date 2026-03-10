#!/usr/bin/env node

const INGEST_URL = process.env.INGEST_URL || '';
const QUERY_URL = process.env.QUERY_URL || '';
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const QUERY_AUTH_TOKEN = process.env.QUERY_AUTH_TOKEN || '';

const INGEST_BATCHES = Number(process.env.LOADTEST_INGEST_BATCHES || 50);
const EVENTS_PER_BATCH = Number(process.env.LOADTEST_EVENTS_PER_BATCH || 200);
const INGEST_CONCURRENCY = Number(process.env.LOADTEST_INGEST_CONCURRENCY || 8);

const QUERY_REQUESTS = Number(process.env.LOADTEST_QUERY_REQUESTS || 40);
const QUERY_CONCURRENCY = Number(process.env.LOADTEST_QUERY_CONCURRENCY || 8);
const QUERY_LIMIT = Number(process.env.LOADTEST_QUERY_LIMIT || 120);

const MAX_ACCEPTABLE_QUERY_P95_MS = Number(process.env.LOADTEST_MAX_QUERY_P95_MS || 5000);
const MIN_QUERY_SUCCESS_RATE = Number(process.env.LOADTEST_MIN_QUERY_SUCCESS_RATE || 0.95);

if (!INGEST_SECRET) {
  console.error('Missing INGEST_SECRET');
  process.exit(1);
}
if (!INGEST_URL) {
  console.error('Missing INGEST_URL');
  process.exit(1);
}
if (!QUERY_URL) {
  console.error('Missing QUERY_URL');
  process.exit(1);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildBatch(batchIndex, size) {
  const now = Date.now();
  const events = [];
  for (let i = 0; i < size; i++) {
    const n = (batchIndex * size) + i;
    const ts = new Date(now - ((n % 7200) * 1000)).toISOString();
    const level = n % 15 === 0 ? 'error' : (n % 5 === 0 ? 'warn' : 'info');
    const status = level === 'error' ? 500 : (level === 'warn' ? 429 : 200);
    events.push({
      ts,
      service: 'loadtest-api',
      env: 'loadtest',
      host: `lt-${(n % 24) + 1}`,
      level,
      message: `loadtest event ${n} route=/checkout status=${status} timeout ${(n % 31) + 20}ms`,
      status,
      duration_ms: (n % 1000) + 5
    });
  }
  return events;
}

async function runPool(items, concurrency, handler) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await handler(item);
    }
  });
  await Promise.all(workers);
}

async function runIngestPhase() {
  const latencies = [];
  let success = 0;
  let failed = 0;
  const startedAt = Date.now();

  await runPool(
    Array.from({ length: INGEST_BATCHES }, (_, index) => index),
    INGEST_CONCURRENCY,
    async (batchIndex) => {
      const payload = { events: buildBatch(batchIndex, EVENTS_PER_BATCH) };
      const t0 = Date.now();
      try {
        const response = await fetch(`${INGEST_URL}/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${INGEST_SECRET}`,
            'x-agent-id': 'loadtest'
          },
          body: JSON.stringify(payload)
        });
        const body = await response.json().catch(() => ({}));
        latencies.push(Date.now() - t0);
        if (response.ok) {
          success += Number(body.ingested || 0);
        } else {
          failed += payload.events.length;
        }
      } catch {
        latencies.push(Date.now() - t0);
        failed += payload.events.length;
      }
    }
  );

  const elapsedMs = Date.now() - startedAt;
  const totalSent = INGEST_BATCHES * EVENTS_PER_BATCH;
  return {
    total_sent: totalSent,
    success_events: success,
    failed_events: failed,
    elapsed_ms: elapsedMs,
    events_per_minute: elapsedMs > 0 ? Math.round((success / elapsedMs) * 60000) : 0,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95)
  };
}

async function runQueryPhase() {
  const headers = { 'content-type': 'application/json' };
  if (QUERY_AUTH_TOKEN) {
    headers.authorization = `Bearer ${QUERY_AUTH_TOKEN}`;
  }

  const latencies = [];
  let ok = 0;
  let fail = 0;
  const to = new Date();
  const from = new Date(Date.now() - (3 * 60 * 60 * 1000));
  const payload = {
    time: { from: from.toISOString(), to: to.toISOString() },
    ppl: 'search timeout | where index="default" and service="loadtest-api" and env="loadtest" and status>=429 | head 200',
    limit: QUERY_LIMIT,
    cursor: null
  };

  await runPool(
    Array.from({ length: QUERY_REQUESTS }, (_, index) => index),
    QUERY_CONCURRENCY,
    async () => {
      const t0 = Date.now();
      try {
        const response = await fetch(`${QUERY_URL}/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });
        const body = await response.json().catch(() => ({}));
        latencies.push(Date.now() - t0);
        if (response.ok && Array.isArray(body.results)) {
          ok += 1;
        } else {
          fail += 1;
        }
      } catch {
        latencies.push(Date.now() - t0);
        fail += 1;
      }
    }
  );

  const successRate = QUERY_REQUESTS > 0 ? ok / QUERY_REQUESTS : 0;
  return {
    total_requests: QUERY_REQUESTS,
    ok_requests: ok,
    failed_requests: fail,
    success_rate: Number(successRate.toFixed(4)),
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95)
  };
}

async function main() {
  console.log('Running ingest load phase...');
  const ingest = await runIngestPhase();
  console.log(JSON.stringify({ ingest }, null, 2));

  console.log('Running query load phase...');
  const query = await runQueryPhase();
  console.log(JSON.stringify({ query }, null, 2));

  const failed =
    query.success_rate < MIN_QUERY_SUCCESS_RATE ||
    query.p95_ms > MAX_ACCEPTABLE_QUERY_P95_MS;

  const summary = {
    pass: !failed,
    thresholds: {
      min_query_success_rate: MIN_QUERY_SUCCESS_RATE,
      max_query_p95_ms: MAX_ACCEPTABLE_QUERY_P95_MS
    },
    ingest,
    query
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
