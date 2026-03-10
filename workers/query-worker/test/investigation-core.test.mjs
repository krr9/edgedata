import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBootstrapRequest,
  buildBootstrapPayload,
  normalizePivots,
  validateRelatedEventsRequest,
  buildSessionRecord,
  rankRelatedEvents
} from '../src/investigation-core.mjs';

// --- validateBootstrapRequest ---

test('validateBootstrapRequest accepts valid payload with source, time, scope', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, true);
  assert.ok(!result.error);
});

test('validateBootstrapRequest rejects missing source', () => {
  const body = {
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /source/i);
});

test('validateBootstrapRequest rejects missing time', () => {
  const body = {
    source: 'alert',
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /time/i);
});

test('validateBootstrapRequest rejects missing scope', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /scope/i);
});

test('validateBootstrapRequest rejects invalid time range (from after to)', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T12:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /time|from|to|range/i);
});

test('validateBootstrapRequest rejects time window exceeding 6 hours', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T00:00:00Z', to: '2026-03-07T07:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /6 hours|window|bounds/i);
});

test('validateBootstrapRequest rejects scope without service', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /service|scope/i);
});

test('validateBootstrapRequest rejects non-object body', () => {
  const result = validateBootstrapRequest('not an object');
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('validateBootstrapRequest rejects empty or whitespace source', () => {
  const bodyEmpty = {
    source: '',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  assert.equal(validateBootstrapRequest(bodyEmpty).ok, false);
  const bodyWhitespace = {
    source: '   ',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  assert.equal(validateBootstrapRequest(bodyWhitespace).ok, false);
});

test('validateBootstrapRequest rejects empty or whitespace scope.service', () => {
  const bodyEmpty = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: '', env: 'prod' }
  };
  assert.equal(validateBootstrapRequest(bodyEmpty).ok, false);
  const bodyWhitespace = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: '   ', env: 'prod' }
  };
  assert.equal(validateBootstrapRequest(bodyWhitespace).ok, false);
});

test('validateBootstrapRequest rejects invalid ISO time strings', () => {
  const body = {
    source: 'alert',
    time: { from: 'not-a-date', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid|timestamp|time/i);
});

test('validateBootstrapRequest rejects unsafe scope values (PPL injection)', () => {
  const withQuote = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api" | head 100', env: 'prod' }
  };
  const resultQuote = validateBootstrapRequest(withQuote);
  assert.equal(resultQuote.ok, false);
  assert.match(resultQuote.error, /invalid|scope\.service/i);

  const withBackslash = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api\\x', env: 'prod' }
  };
  const resultBackslash = validateBootstrapRequest(withBackslash);
  assert.equal(resultBackslash.ok, false);

  const withPipe = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api|malicious', env: 'prod' }
  };
  const resultPipe = validateBootstrapRequest(withPipe);
  assert.equal(resultPipe.ok, false);

  const withNewline = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api\ninject', env: 'prod' }
  };
  const resultNewline = validateBootstrapRequest(withNewline);
  assert.equal(resultNewline.ok, false);
});

test('validateBootstrapRequest rejects unsafe scope.index and scope.env', () => {
  const badIndex = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'idx"; drop table', service: 'api', env: 'prod' }
  };
  const r1 = validateBootstrapRequest(badIndex);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /scope\.index|invalid/i);

  const badEnv = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod;rm -rf' }
  };
  const r2 = validateBootstrapRequest(badEnv);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /scope\.env|invalid/i);
});

test('validateBootstrapRequest accepts safe scope values with dots and hyphens', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'my-api_v2.1', env: 'prod-east' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, true);
});

// --- buildBootstrapPayload ---

test('buildBootstrapPayload returns bootstrap shape with starter queries for valid body', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' },
    pivots: { trace_id: 'tr-1', request_id: 'req-2' }
  };
  const result = buildBootstrapPayload(body);

  assert.ok(result.scope);
  assert.equal(result.scope.index, 'default');
  assert.equal(result.scope.service, 'api');
  assert.equal(result.scope.env, 'prod');

  assert.ok(Array.isArray(result.starter_queries));
  assert.ok(result.starter_queries.length >= 3);
  for (const q of result.starter_queries) {
    assert.equal(typeof q.id, 'string');
    assert.equal(typeof q.title, 'string');
    assert.equal(typeof q.ppl, 'string');
    assert.match(q.ppl, /service="api"/);
    assert.match(q.ppl, /env="prod"/);
  }

  assert.ok(Array.isArray(result.pivot_chips));
  assert.equal(result.pivot_chips.length, 2);
  assert.deepEqual(
    result.pivot_chips.map((c) => c.key).sort(),
    ['request_id', 'trace_id']
  );

  assert.ok(Array.isArray(result.timeline));
  assert.ok(result.timeline.length > 0);
  for (const p of result.timeline) {
    assert.equal(typeof p.minute, 'string');
    assert.equal(typeof p.count, 'number');
  }
});

test('buildBootstrapPayload returns deterministic timeline from time range', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: 'default', service: 'api', env: 'prod' }
  };
  const result = buildBootstrapPayload(body);
  assert.ok(Array.isArray(result.timeline));
  assert.ok(result.timeline.length >= 12, '1h range = 12 x 5-min buckets');
  assert.ok(result.timeline.length <= 72, 'capped at 72 buckets');
  const first = result.timeline[0];
  assert.match(first.minute, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.equal(first.count, 0);
});

test('buildBootstrapPayload returns empty pivot_chips when no pivots', () => {
  const body = {
    source: 'alert',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { service: 'payments', env: 'staging' }
  };
  const result = buildBootstrapPayload(body);
  assert.deepEqual(result.pivot_chips, []);
  assert.equal(result.scope.index, 'otel-demo');
  assert.equal(result.scope.service, 'payments');
  assert.equal(result.scope.env, 'staging');
  assert.ok(Array.isArray(result.timeline));
});

test('buildBootstrapPayload applies bounded defaults when scope is missing', () => {
  const body = {
    source: 'workspace',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' }
  };
  const result = buildBootstrapPayload(body);
  assert.deepEqual(result.scope, {
    index: 'otel-demo',
    service: 'frontend',
    env: 'demo'
  });
  assert.ok(result.starter_queries.every((q) => q.ppl.includes('index="otel-demo"')));
  assert.ok(result.starter_queries.every((q) => q.ppl.includes('service="frontend"')));
  assert.ok(result.starter_queries.every((q) => q.ppl.includes('env="demo"')));
});

test('validateBootstrapRequest accepts wildcard scope values', () => {
  const body = {
    source: 'workspace',
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    scope: { index: '*', service: '*', env: 'demo' }
  };
  const result = validateBootstrapRequest(body);
  assert.equal(result.ok, true);
});

// --- normalizePivots ---

test('normalizePivots returns only trace_id, request_id, user_id, msg_hash', () => {
  const input = {
    trace_id: 'abc-123',
    request_id: 'req-456',
    user_id: 'u789',
    msg_hash: 'h1a2b3',
    extra_field: 'ignored'
  };
  const result = normalizePivots(input);
  assert.deepEqual(result, {
    trace_id: 'abc-123',
    request_id: 'req-456',
    user_id: 'u789',
    msg_hash: 'h1a2b3'
  });
  assert.ok(!('extra_field' in result));
});

test('normalizePivots trims whitespace and drops empty strings', () => {
  const input = {
    trace_id: '  tr-1  ',
    request_id: '',
    user_id: 'u1',
    msg_hash: '   '
  };
  const result = normalizePivots(input);
  assert.equal(result.trace_id, 'tr-1');
  assert.equal(result.request_id, undefined);
  assert.equal(result.user_id, 'u1');
  assert.equal(result.msg_hash, undefined);
});

test('normalizePivots converts non-strings to strings', () => {
  const input = {
    trace_id: 12345,
    request_id: null,
    user_id: undefined,
    msg_hash: 'h1'
  };
  const result = normalizePivots(input);
  assert.equal(result.trace_id, '12345');
  assert.equal(result.request_id, undefined);
  assert.equal(result.user_id, undefined);
  assert.equal(result.msg_hash, 'h1');
});

test('normalizePivots returns empty object for null/undefined input', () => {
  assert.deepEqual(normalizePivots(null), {});
  assert.deepEqual(normalizePivots(undefined), {});
});

test('normalizePivots returns empty object for array input', () => {
  assert.deepEqual(normalizePivots([]), {});
});

// --- validateRelatedEventsRequest ---

test('validateRelatedEventsRequest accepts valid payload with scope and time bounds', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, true);
  assert.ok(!result.error);
});

test('validateRelatedEventsRequest rejects missing scope', () => {
  const body = {
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /scope/i);
});

test('validateRelatedEventsRequest rejects time window exceeding 6 hours', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T00:00:00Z', to: '2026-03-07T07:00:00Z' },
    max_candidates: 50
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /6 hours|window|bounds/i);
});

test('validateRelatedEventsRequest rejects max_candidates above cap', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 500
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /candidate|cap|limit/i);
});

test('validateRelatedEventsRequest rejects max_candidates below 1 (0)', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 0
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /candidate|between|1/i);
});

test('validateRelatedEventsRequest rejects max_candidates below 1 (-1)', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: -1
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /candidate|between|1/i);
});

test('validateRelatedEventsRequest rejects invalid time range (from after to)', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T12:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /time|from|to|range/i);
});

test('validateRelatedEventsRequest rejects invalid ISO time strings', () => {
  const body = {
    scope: { index: 'default', service: 'api', env: 'prod' },
    time: { from: 'invalid-iso', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const result = validateRelatedEventsRequest(body);
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid|timestamp|time/i);
});

test('validateRelatedEventsRequest rejects unsafe scope.service (PPL injection)', () => {
  const withQuote = {
    scope: { index: 'default', service: 'api" | head 100', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const result = validateRelatedEventsRequest(withQuote);
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid|scope\.service/i);

  const withPipe = {
    scope: { index: 'default', service: 'api|malicious', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  assert.equal(validateRelatedEventsRequest(withPipe).ok, false);
});

test('validateRelatedEventsRequest rejects unsafe scope.index and scope.env', () => {
  const badIndex = {
    scope: { index: 'idx"; drop table', service: 'api', env: 'prod' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const r1 = validateRelatedEventsRequest(badIndex);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /scope\.index|invalid/i);

  const badEnv = {
    scope: { index: 'default', service: 'api', env: 'prod;rm -rf' },
    time: { from: '2026-03-07T10:00:00Z', to: '2026-03-07T11:00:00Z' },
    max_candidates: 50
  };
  const r2 = validateRelatedEventsRequest(badEnv);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /scope\.env|invalid/i);
});

// --- rankRelatedEvents ---

test('rankRelatedEvents ranks exact pivot match above token overlap', () => {
  const pivots = { trace_id: 'tr-1', request_id: 'req-a' };
  const pivotTokens = ['error', 'timeout', 'payment'];
  const candidates = [
    { id: 'e1', trace_id: 'tr-other', tokens: ['error', 'timeout'] },
    { id: 'e2', trace_id: 'tr-1', request_id: 'req-a', tokens: [] },
    { id: 'e3', trace_id: 'tr-other', tokens: ['payment', 'retry'] }
  ];
  const result = rankRelatedEvents(pivots, pivotTokens, candidates, { maxCandidates: 10 });
  assert.equal(result.length, 3);
  assert.equal(result[0].event.id, 'e2', 'exact pivot match must rank first');
  assert.equal(result[0].match_reason, 'exact_pivot_match');
  assert.equal(result[1].match_reason, 'token_overlap');
  assert.equal(result[2].match_reason, 'token_overlap');
});

test('rankRelatedEvents enforces candidate cap', () => {
  const pivots = {};
  const pivotTokens = ['x'];
  const candidates = Array.from({ length: 50 }, (_, i) => ({
    id: `e${i}`,
    tokens: i < 10 ? ['x'] : []
  }));
  const result = rankRelatedEvents(pivots, pivotTokens, candidates, { maxCandidates: 5 });
  assert.equal(result.length, 5, 'must cap at maxCandidates');
});

test('rankRelatedEvents includes match_reason for each result', () => {
  const pivots = { trace_id: 'tr-1' };
  const pivotTokens = ['err'];
  const candidates = [
    { id: 'e1', trace_id: 'tr-1' },
    { id: 'e2', trace_id: 'tr-2', tokens: ['err'] }
  ];
  const result = rankRelatedEvents(pivots, pivotTokens, candidates, { maxCandidates: 10 });
  assert.equal(result.length, 2);
  assert.equal(result[0].match_reason, 'exact_pivot_match');
  assert.equal(result[1].match_reason, 'token_overlap');
  assert.ok('event' in result[0]);
  assert.ok('match_reason' in result[0]);
});

// --- buildSessionRecord ---

test('buildSessionRecord returns safe record with required fields', () => {
  const input = {
    id: 'sess-1',
    owner_user_id: 'u1',
    source_type: 'alert',
    scope_json: '{"index":"default","service":"api"}',
    state_json: '{"panels":[]}',
    created_at: '2026-03-07T10:00:00Z',
    expires_at: '2026-03-08T10:00:00Z'
  };
  const result = buildSessionRecord(input);
  assert.equal(result.ok, true);
  assert.equal(result.id, 'sess-1');
  assert.equal(result.owner_user_id, 'u1');
  assert.equal(result.source_type, 'alert');
  assert.equal(result.scope_json, '{"index":"default","service":"api"}');
  assert.equal(result.state_json, '{"panels":[]}');
  assert.equal(result.created_at, '2026-03-07T10:00:00Z');
  assert.equal(result.expires_at, '2026-03-08T10:00:00Z');
});

test('buildSessionRecord rejects state_json exceeding size limit', () => {
  const input = {
    id: 'sess-1',
    owner_user_id: 'u1',
    source_type: 'alert',
    scope_json: '{}',
    state_json: 'x'.repeat(70000),
    created_at: '2026-03-07T10:00:00Z',
    expires_at: null
  };
  const result = buildSessionRecord(input);
  assert.equal(result.ok, false);
  assert.match(result.error, /size|limit|too large/i);
});

test('buildSessionRecord rejects missing required fields', () => {
  const input = {
    id: 'sess-1',
    owner_user_id: 'u1'
    // missing scope_json, state_json, created_at
  };
  const result = buildSessionRecord(input);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('buildSessionRecord strips disallowed keys from input', () => {
  const input = {
    id: 'sess-1',
    owner_user_id: 'u1',
    source_type: 'alert',
    scope_json: '{}',
    state_json: '{}',
    created_at: '2026-03-07T10:00:00Z',
    expires_at: null,
    _internal: 'secret',
    extra: 'ignored'
  };
  const result = buildSessionRecord(input);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, '_internal'), false);
  assert.equal(Object.hasOwn(result, 'extra'), false);
});
