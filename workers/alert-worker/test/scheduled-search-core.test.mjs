import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
