import test from 'node:test';
import assert from 'node:assert/strict';

const RUN_INTEGRATION = process.env.RUN_SUGGESTIONS_INTEGRATION === '1';

async function runIntegrationTests() {
  const { unstable_startWorker } = await import('wrangler');
  const worker = await unstable_startWorker({
    configPath: 'workers/query-worker/wrangler.toml',
    vars: {
      REQUIRE_ACCESS_JWT: 'false',
      QUERY_ANALYST_TOKEN: 'test-suggestions-token-12345'
    }
  });

  try {
    const base = 'http://localhost';

    const resNoAuth = await worker.fetch(`${base}/search/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'se' })
    });
    assert.equal(resNoAuth.status, 401, 'no auth should return 401');

    const resOk = await worker.fetch(`${base}/search/suggestions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-suggestions-token-12345'
      },
      body: JSON.stringify({
        query: 'search timeout | where ser',
        maxItems: 5,
        context: { topTerms: ['timeout'] }
      })
    });
    assert.equal(resOk.status, 200, 'valid request should return 200');

    const data = await resOk.json();
    assert.ok(Array.isArray(data.suggestions), 'response must include suggestions array');
    assert.ok(data.suggestions.length <= 5, 'suggestions must honor maxItems');
    assert.ok(data.meta && typeof data.meta === 'object', 'response must include meta');
    assert.equal(typeof data.meta.context_stage, 'string');
    assert.equal(typeof data.meta.latency_ms, 'number');
    assert.ok(data.suggestions.some((item) => typeof item.next_query === 'string'));
  } finally {
    await worker.dispose();
  }
}

test('search suggestions endpoint - 401 and 200 (integration)', { skip: !RUN_INTEGRATION }, async () => {
  await runIntegrationTests();
});

test('search suggestions endpoint integration disabled by default', { skip: RUN_INTEGRATION }, () => {
  assert.ok(
    true,
    'Run with RUN_SUGGESTIONS_INTEGRATION=1 to execute endpoint integration checks.'
  );
});

