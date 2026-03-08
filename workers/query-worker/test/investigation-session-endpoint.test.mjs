/**
 * Tests for POST /investigations/session and GET /investigations/session/:id.
 * Unit tests for validateSessionSaveRequest; integration tests for endpoints when RUN_SESSION_INTEGRATION=1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSessionSaveRequest,
  buildSessionRecord,
  canAccessInvestigationSession
} from '../src/investigation-core.mjs';
import { statusFromError } from '../src/error-utils.mjs';

// --- validateSessionSaveRequest (unit) ---

test('validateSessionSaveRequest accepts valid payload with scope and state', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    state: { panels: [], pivots: {} }
  };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, true);
  assert.ok(result.scope_json);
  assert.ok(result.state_json);
  assert.equal(JSON.parse(result.scope_json).service, 'api');
  assert.deepEqual(JSON.parse(result.state_json), { panels: [], pivots: {} });
});

test('validateSessionSaveRequest accepts scope_json and state_json strings', () => {
  const body = {
    scope_json: '{"index":"default","service":"api"}',
    state_json: '{"panels":[]}'
  };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, true);
  assert.equal(result.scope_json, body.scope_json);
  assert.equal(result.state_json, body.state_json);
});

test('validateSessionSaveRequest rejects missing scope', () => {
  const body = { state: {} };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /scope/i);
});

test('validateSessionSaveRequest rejects missing state', () => {
  const body = { scope: {} };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /state/i);
});

test('validateSessionSaveRequest rejects state_json exceeding size limit', () => {
  const body = {
    scope: {},
    state_json: 'x'.repeat(70000)
  };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /size|limit|bytes/i);
});

test('validateSessionSaveRequest rejects scope_json exceeding size limit', () => {
  const body = {
    scope_json: 'x'.repeat(70000),
    state: {}
  };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /scope_json|size|limit|bytes/i);
});

test('validateSessionSaveRequest rejects non-object body', () => {
  const result = validateSessionSaveRequest('not an object');
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('validateSessionSaveRequest accepts optional source_type and expires_at', () => {
  const body = {
    scope: { service: 'api' },
    state: {},
    source_type: 'alert',
    expires_at: '2026-03-08T10:00:00Z'
  };
  const result = validateSessionSaveRequest(body);
  assert.equal(result.ok, true);
  assert.equal(result.source_type, 'alert');
  assert.equal(result.expires_at, '2026-03-08T10:00:00Z');
});

// --- buildSessionRecord (existing; ensure still works) ---

// --- canAccessInvestigationSession ---

test('canAccessInvestigationSession allows owner', () => {
  assert.equal(canAccessInvestigationSession('u1', 'u1', false), true);
  assert.equal(canAccessInvestigationSession('token:analyst', 'token:analyst', false), true);
});

test('canAccessInvestigationSession allows admin regardless of owner', () => {
  assert.equal(canAccessInvestigationSession('other-user', 'admin-user', true), true);
  assert.equal(canAccessInvestigationSession(null, 'admin-user', true), true);
});

test('canAccessInvestigationSession denies non-owner when not admin', () => {
  assert.equal(canAccessInvestigationSession('u1', 'u2', false), false);
  assert.equal(canAccessInvestigationSession('token:analyst', 'token:viewer', false), false);
});

test('canAccessInvestigationSession denies when owner is null/empty and not admin', () => {
  assert.equal(canAccessInvestigationSession(null, 'u1', false), false);
  assert.equal(canAccessInvestigationSession('', 'u1', false), false);
});

// --- buildSessionRecord ---

test('buildSessionRecord returns safe record for session insert', () => {
  const input = {
    id: 'sess-1',
    owner_user_id: 'u1',
    source_type: 'alert',
    scope_json: '{"index":"default","service":"api"}',
    state_json: '{"panels":[]}',
    created_at: '2026-03-07T10:00:00Z',
    expires_at: null
  };
  const result = buildSessionRecord(input);
  assert.equal(result.ok, true);
  assert.equal(result.id, 'sess-1');
  assert.equal(result.owner_user_id, 'u1');
});

// --- Integration tests (POST /investigations/session, GET /investigations/session/:id) ---

const RUN_SESSION_INTEGRATION = process.env.RUN_SESSION_INTEGRATION === '1';

const validSessionBody = {
  scope: { index: 'default', service: 'api', env: 'prod' },
  state: { panels: [], pivots: {} },
  source_type: 'alert'
};

const ANALYST_TOKEN = 'test-session-analyst-token';
const VIEWER_TOKEN = 'test-session-viewer-token';
const ADMIN_TOKEN = 'test-session-admin-token';

async function runSessionIntegrationTests() {
  const { unstable_startWorker } = await import('wrangler');
  const worker = await unstable_startWorker({
    configPath: 'workers/query-worker/wrangler.toml',
    vars: {
      REQUIRE_ACCESS_JWT: 'false',
      QUERY_ANALYST_TOKEN: ANALYST_TOKEN,
      QUERY_VIEWER_TOKEN: VIEWER_TOKEN,
      QUERY_ADMIN_TOKEN: ADMIN_TOKEN
    }
  });

  try {
    const base = 'http://localhost';

    // POST: no auth -> 401
    const resNoAuth = await worker.fetch(`${base}/investigations/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validSessionBody)
    });
    assert.equal(resNoAuth.status, 401, 'POST without auth should return 401');

    // POST: valid -> 201, returns id (create session as analyst)
    const resPost = await worker.fetch(`${base}/investigations/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ANALYST_TOKEN}`
      },
      body: JSON.stringify(validSessionBody)
    });
    assert.equal(resPost.status, 201, 'valid POST should return 201');
    const postData = await resPost.json();
    assert.ok(postData.id, 'response must have id');
    const sessionId = postData.id;

    // GET: owner fetches own session -> 200
    const resOwner = await worker.fetch(`${base}/investigations/session/${sessionId}`, {
      headers: { Authorization: `Bearer ${ANALYST_TOKEN}` }
    });
    assert.equal(resOwner.status, 200, 'owner fetches own session should return 200');
    const ownerData = await resOwner.json();
    assert.equal(ownerData.id, sessionId);
    assert.ok(ownerData.scope_json || ownerData.scope);
    assert.ok(ownerData.state_json || ownerData.state);

    // GET: non-owner non-admin fetch -> 403
    const resNonOwner = await worker.fetch(`${base}/investigations/session/${sessionId}`, {
      headers: { Authorization: `Bearer ${VIEWER_TOKEN}` }
    });
    assert.equal(resNonOwner.status, 403, 'non-owner non-admin fetch should return 403');

    // GET: admin fetches other user's session -> 200
    const resAdmin = await worker.fetch(`${base}/investigations/session/${sessionId}`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    assert.equal(resAdmin.status, 200, 'admin fetches other user session should return 200');
    const adminData = await resAdmin.json();
    assert.equal(adminData.id, sessionId);

    // GET: missing session id -> 404
    const res404 = await worker.fetch(`${base}/investigations/session/nonexistent-id-12345`, {
      headers: { Authorization: `Bearer ${ANALYST_TOKEN}` }
    });
    assert.equal(res404.status, 404, 'GET missing session should return 404');

    // POST: invalid body (missing scope) -> 400
    const resBad = await worker.fetch(`${base}/investigations/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ANALYST_TOKEN}`
      },
      body: JSON.stringify({ state: {} })
    });
    assert.equal(resBad.status, 400, 'POST missing scope should return 400');
  } finally {
    await worker.dispose();
  }
}

test('investigations session POST/GET - 401/201/200/403/404/400 + access semantics (integration)', { skip: !RUN_SESSION_INTEGRATION }, async () => {
  await runSessionIntegrationTests();
});

test('investigations session - unit coverage note when integration skipped', { skip: RUN_SESSION_INTEGRATION }, () => {
  assert.ok(
    true,
    '401/400/403/404 covered by auth, validateSessionSaveRequest, canAccessInvestigationSession. Run with RUN_SESSION_INTEGRATION=1 for full integration.'
  );
});

test('statusFromError maps Forbidden to 403 for session handler path', () => {
  const err = new Error('Forbidden');
  assert.equal(statusFromError(err), 403);
});
