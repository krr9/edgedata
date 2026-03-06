import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isIncrementalStreamPipeline,
  resolvePipelineLimit,
  rowMatchesWhereStages
} from '../src/search-stream-core.mjs';

test('isIncrementalStreamPipeline accepts search/where/head only', () => {
  assert.equal(isIncrementalStreamPipeline([
    { command: 'search', expression: 'timeout' },
    { command: 'where', conditions: [{ field: 'status', operator: '>=', value: 500 }] },
    { command: 'head', count: 50 }
  ]), true);

  assert.equal(isIncrementalStreamPipeline([
    { command: 'search', expression: 'timeout' },
    { command: 'sort', keys: [{ field: 'ts', direction: 'desc' }] }
  ]), false);
});

test('resolvePipelineLimit applies head and caps', () => {
  assert.equal(resolvePipelineLimit([{ command: 'head', count: 25 }], 200, 5000), 25);
  assert.equal(resolvePipelineLimit([{ command: 'head', count: 9999 }], 200, 300), 200);
  assert.equal(resolvePipelineLimit([], 0, 5000), 200);
});

test('rowMatchesWhereStages evaluates simple predicates', () => {
  const row = { index: 'default', service: 'payments', status: 502, duration_ms: 1800 };
  const stages = [
    {
      command: 'where',
      conditions: [
        { field: 'index', operator: '=', value: 'default' },
        { field: 'status', operator: '>=', value: 500 },
        { field: 'duration_ms', operator: '>', value: 1200 }
      ]
    }
  ];
  assert.equal(rowMatchesWhereStages(row, stages), true);

  const failing = [
    {
      command: 'where',
      conditions: [{ field: 'service', operator: '!=', value: 'payments' }]
    }
  ];
  assert.equal(rowMatchesWhereStages(row, failing), false);
});
