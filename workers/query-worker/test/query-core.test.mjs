import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enforceTimeGuardrails,
  getDateRange,
  inferSearchMode,
  mergeFilters,
  parseISODate,
  parseQueryInput,
  tokenize
} from '../src/query-core.mjs';

test('tokenize removes stopwords, deduplicates, and normalizes', () => {
  const tokens = tokenize('The timeout timeout-db on PAYMENTS_api failed with 500 and the timeout');
  assert.deepEqual(tokens, ['timeout', 'db', 'payments', 'api', 'failed', '500']);
});

test('parseQueryInput extracts phrase, comparators, filters, and free-text tokens', () => {
  const parsed = parseQueryInput('index=security service=api env=prod status>=500 duration_ms<1200 phrase="Connection Refused" timeout postgres');
  assert.equal(parsed.phrase, 'connection refused');
  assert.equal(parsed.extractedFilters.index, 'security');
  assert.equal(parsed.extractedFilters.service, 'api');
  assert.equal(parsed.extractedFilters.env, 'prod');
  assert.equal(parsed.extractedFilters.status__gte, '500');
  assert.equal(parsed.extractedFilters.duration_ms__lt, '1200');
  assert.deepEqual(parsed.tokens, ['timeout', 'postgres']);
});

test('mergeFilters applies raw filters and lets parsed filters override', () => {
  const merged = mergeFilters(
    { index: 'SECURITY', service: 'payments', env: 'prod', status: 200 },
    { service: 'api', status__gte: '500', duration_ms__lt: '1500' }
  );

  assert.equal(merged.index, 'security');
  assert.equal(merged.service, 'api');
  assert.equal(merged.env, 'prod');
  assert.equal(merged.status, 200);
  assert.equal(merged.status_gte, 500);
  assert.equal(merged.duration_lt, 1500);
});

test('inferSearchMode chooses phrase > token > structured', () => {
  assert.equal(inferSearchMode({ phrase: null, tokens: [], extractedFilters: {} }, null), 'structured');
  assert.equal(inferSearchMode({ phrase: null, tokens: ['timeout'], extractedFilters: {} }, null), 'token');
  assert.equal(inferSearchMode({ phrase: 'connection refused', tokens: [], extractedFilters: {} }, null), 'phrase');
  assert.equal(inferSearchMode({ phrase: null, tokens: [], extractedFilters: {} }, 'manual phrase'), 'phrase');
});

test('parseISODate and getDateRange validate timestamps and range ordering', () => {
  assert.throws(() => parseISODate('not-a-date'), /Invalid timestamp/);
  assert.throws(
    () => getDateRange('2026-02-18T10:00:00Z', '2026-02-17T10:00:00Z'),
    /from must be before to/
  );

  const dates = getDateRange('2026-02-16T22:00:00Z', '2026-02-18T01:00:00Z');
  assert.deepEqual(dates, ['2026-02-16', '2026-02-17', '2026-02-18']);
});

test('enforceTimeGuardrails enforces phrase/token/structured windows', () => {
  assert.throws(
    () => enforceTimeGuardrails('2026-02-16T00:00:00Z', '2026-02-16T08:00:00Z', 'phrase'),
    /Phrase search limited to 6 hours/
  );
  assert.throws(
    () => enforceTimeGuardrails('2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z', 'token'),
    /token search limited to 14 days/
  );
  assert.doesNotThrow(() =>
    enforceTimeGuardrails('2026-02-16T00:00:00Z', '2026-02-16T05:59:59Z', 'phrase')
  );
});
