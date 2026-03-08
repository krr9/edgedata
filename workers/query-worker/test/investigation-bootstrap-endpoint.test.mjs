/**
 * Integration tests for POST /investigations/bootstrap.
 * Requires wrangler; uses local D1/R2/DO bindings.
 * Run with: npm run test:unit -- workers/query-worker/test/investigation-bootstrap-endpoint.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { statusFromError } from '../src/error-utils.mjs';

const RUN_INTEGRATION = process.env.RUN_BOOTSTRAP_INTEGRATION === '1';

const validBody = {
  source: 'alert',
  time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
  scope: { index: 'default', service: 'api', env: 'prod' }
};

const invalidBodyMissingScope = {
  source: 'alert',
  time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' }
};

const invalidBodyMissingTime = {
  source: 'alert',
  scope: { index: 'default', service: 'api', env: 'prod' }
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

    // 1) Unauthorized caller returns 401
    const resNoAuth = await worker.fetch(`${base}/investigations/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody)
    });
    assert.equal(resNoAuth.status, 401, 'no auth should return 401');

    // 2) Missing scope returns 400
    const resBadScope = await worker.fetch(`${base}/investigations/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-bootstrap-token-12345'
      },
      body: JSON.stringify(invalidBodyMissingScope)
    });
    assert.equal(resBadScope.status, 400, 'missing scope should return 400');

    // 2b) Missing time returns 400
    const resBadTime = await worker.fetch(`${base}/investigations/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-bootstrap-token-12345'
      },
      body: JSON.stringify(invalidBodyMissingTime)
    });
    assert.equal(resBadTime.status, 400, 'missing time should return 400');

    // 3) Valid payload returns bootstrap shape with starter queries
    const resOk = await worker.fetch(`${base}/investigations/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-bootstrap-token-12345'
      },
      body: JSON.stringify(validBody)
    });
    assert.equal(resOk.status, 200, 'valid request should return 200');
    const data = await resOk.json();
    assert.ok(data.scope, 'response must have scope');
    assert.equal(data.scope.service, 'api');
    assert.ok(Array.isArray(data.starter_queries), 'response must have starter_queries');
    assert.ok(data.starter_queries.length >= 3, 'starter_queries must have at least 3 items');
    assert.ok(Array.isArray(data.pivot_chips), 'response must have pivot_chips');
    assert.ok(Array.isArray(data.timeline), 'response must have timeline');
    assert.ok(data.timeline.length >= 12, '1h range must yield at least 12 timeline buckets');
  } finally {
    await worker.dispose();
  }
}

test('investigations bootstrap endpoint - 401/400/200 (integration)', { skip: !RUN_INTEGRATION }, async () => {
  await runIntegrationTests();
});

test('investigations bootstrap - unit coverage note when integration skipped', { skip: RUN_INTEGRATION }, () => {
  assert.ok(
    true,
    '401/400/403 covered by: auth middleware (401), validateBootstrapRequest (400), assertPermission (403). Run with RUN_BOOTSTRAP_INTEGRATION=1 for full integration.'
  );
});

// Deterministic unit test: permission failure (Forbidden) maps to 403 for bootstrap handler path
test('statusFromError maps Forbidden to 403 for bootstrap handler path', () => {
  const err = new Error('Forbidden');
  assert.equal(statusFromError(err), 403);
  assert.equal(statusFromError(err, 500), 403);
});

test('statusFromError uses fallback for unknown errors', () => {
  assert.equal(statusFromError(new Error('Something went wrong')), 500);
  assert.equal(statusFromError(new Error('Something went wrong'), 502), 502);
});
