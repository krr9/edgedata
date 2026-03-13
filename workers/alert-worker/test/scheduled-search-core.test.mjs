import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScheduledSearchPreview,
  buildScheduledSearchRunSummary,
  buildScheduledSearchQueryRequest,
  resolveQueryWorkerSearchUrl
} from '../src/scheduled-search-core.mjs';

test('resolveQueryWorkerSearchUrl throws when URL is not configured', () => {
  assert.throws(
    () => resolveQueryWorkerSearchUrl(''),
    /QUERY_WORKER_URL is not configured/
  );
});

test('resolveQueryWorkerSearchUrl appends search path and trims slashes', () => {
  assert.equal(
    resolveQueryWorkerSearchUrl('https://query-worker.example.com/'),
    'https://query-worker.example.com/search'
  );
});

test('resolveQueryWorkerSearchUrl does not double-append search path', () => {
  assert.equal(
    resolveQueryWorkerSearchUrl('https://query-worker.example.com/search'),
    'https://query-worker.example.com/search'
  );
});

test('buildScheduledSearchQueryRequest emits query-worker compatible shape', () => {
  const payload = buildScheduledSearchQueryRequest({
    ppl: 'search * | head 25',
    maxResults: 250,
    from: '2026-03-09T10:00:00.000Z',
    to: '2026-03-09T11:00:00.000Z'
  });

  assert.deepEqual(payload, {
    ppl: 'search * | head 25',
    time: {
      from: '2026-03-09T10:00:00.000Z',
      to: '2026-03-09T11:00:00.000Z'
    },
    limit: 250
  });
});

test('buildScheduledSearchPreview returns bounded preview rows', () => {
  const preview = buildScheduledSearchPreview(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    2
  );
  assert.deepEqual(preview, [{ id: 1 }, { id: 2 }]);
});

test('buildScheduledSearchRunSummary returns operator-friendly success summary', () => {
  const summary = buildScheduledSearchRunSummary({
    name: 'Errors by Service',
    status: 'success',
    resultCount: 3,
    results: [{ service: 'api', count: 2 }]
  });

  assert.equal(summary.status, 'success');
  assert.equal(summary.result_count, 3);
  assert.equal(summary.headline, 'Errors by Service: 3 results captured');
  assert.deepEqual(summary.preview_fields, ['service', 'count']);
  assert.equal(summary.has_results, true);
});

test('buildScheduledSearchRunSummary returns failure headline and error', () => {
  const summary = buildScheduledSearchRunSummary({
    name: 'Latency sampler',
    status: 'error',
    resultCount: 0,
    errorMessage: 'Query worker returned 500'
  });

  assert.equal(summary.status, 'error');
  assert.equal(summary.headline, 'Latency sampler run failed');
  assert.equal(summary.error_message, 'Query worker returned 500');
  assert.deepEqual(summary.preview_fields, []);
});
