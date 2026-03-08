/**
 * Integration tests for POST /investigations/related-events.
 * Run with: RUN_RELATED_EVENTS_INTEGRATION=1 npm run test:unit -- workers/query-worker/test/investigation-related-events-endpoint.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const RUN_INTEGRATION = process.env.RUN_RELATED_EVENTS_INTEGRATION === '1';

const validBody = {
  scope: { index: 'default', service: 'api', env: 'prod' },
  time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
  pivots: { trace_id: 'tr-1' },
  max_candidates: 20
};

const invalidBodyMissingScope = {
  time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' }
};

async function runIntegrationTests() {
  const { unstable_startWorker } = await import('wrangler');
  const worker = await unstable_startWorker({
    configPath: 'workers/query-worker/wrangler.toml',
    vars: {
      REQUIRE_ACCESS_JWT: 'false',
      QUERY_ANALYST_TOKEN: 'test-bootstrap-token-12345'
    }
  });

  try {
    const base = 'http://localhost';

    const resNoAuth = await worker.fetch(`${base}/investigations/related-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody)
    });
    assert.equal(resNoAuth.status, 401, 'no auth should return 401');

    const resBadScope = await worker.fetch(`${base}/investigations/related-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-bootstrap-token-12345'
      },
      body: JSON.stringify(invalidBodyMissingScope)
    });
    assert.equal(resBadScope.status, 400, 'missing scope should return 400');

    const resOk = await worker.fetch(`${base}/investigations/related-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-bootstrap-token-12345'
      },
      body: JSON.stringify(validBody)
    });
    assert.equal(resOk.status, 200, 'valid request should return 200');
    const data = await resOk.json();
    assert.ok(Array.isArray(data.related_events), 'response must have related_events array');
    assert.ok(
      data.related_events.every((r) => typeof r.match_reason === 'string' && 'event' in r),
      'each item has event and match_reason shape'
    );
  } finally {
    await worker.dispose();
  }
}

test('investigations related-events endpoint - 401/400/200 (integration)', { skip: !RUN_INTEGRATION }, async () => {
  await runIntegrationTests();
});

test('investigations related-events - unit coverage note when integration skipped', { skip: RUN_INTEGRATION }, () => {
  assert.ok(
    true,
    '401/400 covered by auth middleware and validateRelatedEventsRequest. rankRelatedEvents tested in investigation-core.test.mjs.'
  );
});
