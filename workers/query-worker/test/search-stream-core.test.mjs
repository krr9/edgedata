import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isIncrementalStreamPipeline,
  resolvePipelineLimit,
  rowMatchesWhereStages,
  executeStatsPipeline
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

test('executeStatsPipeline computes sum and avg', () => {
  const events = [
    { service: 'api', duration_ms: 100 },
    { service: 'api', duration_ms: 200 },
    { service: 'web', duration_ms: 50 },
  ];
  const stage = {
    command: 'stats',
    aggregations: [
      { fn: 'sum', field: 'duration_ms', as: 'total_ms' },
      { fn: 'avg', field: 'duration_ms', as: 'avg_ms' },
      { fn: 'count', field: null, as: 'count' }
    ],
    by: ['service']
  };
  const result = executeStatsPipeline(events, stage);
  const api = result.find(r => r.service === 'api');
  assert.strictEqual(api.total_ms, 300);
  assert.strictEqual(api.avg_ms, 150);
  assert.strictEqual(api.count, 2);
  const web = result.find(r => r.service === 'web');
  assert.strictEqual(web.total_ms, 50);
  assert.strictEqual(web.count, 1);
});

test('executeStatsPipeline computes dc', () => {
  const events = [
    { service: 'api', src_ip: '1.1.1.1' },
    { service: 'api', src_ip: '1.1.1.1' },
    { service: 'api', src_ip: '2.2.2.2' },
  ];
  const stage = {
    command: 'stats',
    aggregations: [{ fn: 'dc', field: 'src_ip', as: 'unique_ips' }],
    by: ['service']
  };
  const result = executeStatsPipeline(events, stage);
  assert.strictEqual(result[0].unique_ips, 2);
});
