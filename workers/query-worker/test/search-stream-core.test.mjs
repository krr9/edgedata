import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isIncrementalStreamPipeline,
  resolvePipelineLimit,
  rowMatchesWhereStages,
  executeStatsPipeline,
  executeTimechartPipeline,
  executeTopPipeline,
  executeRarePipeline,
  executeDedupPipeline,
  executeEvalPipeline,
  executeLookupPipeline,
  executeRexPipeline,
  executeRenamePipeline,
  executeTransactionPipeline
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

test('executeTimechartPipeline buckets events by 5m span', () => {
  const events = [
    { ts: '2026-03-05T10:01:00Z', level: 'error' },
    { ts: '2026-03-05T10:03:00Z', level: 'error' },
    { ts: '2026-03-05T10:06:00Z', level: 'info' },
    { ts: '2026-03-05T10:08:00Z', level: 'error' },
  ];
  const stage = {
    command: 'timechart',
    spanMs: 300000,
    aggregations: [{ fn: 'count', field: null, as: 'count' }],
    by: 'level'
  };
  const result = executeTimechartPipeline(events, stage);
  assert.ok(result.length > 0);
  assert.ok(result[0]._time);
  const errorBucket1 = result.find(r => r._time === '2026-03-05T10:00:00.000Z' && r.level === 'error');
  assert.strictEqual(errorBucket1.count, 2);
});

test('executeTimechartPipeline without by field', () => {
  const events = [
    { ts: '2026-03-05T10:01:00Z', duration_ms: 100 },
    { ts: '2026-03-05T10:03:00Z', duration_ms: 200 },
  ];
  const stage = {
    command: 'timechart',
    spanMs: 300000,
    aggregations: [{ fn: 'avg', field: 'duration_ms', as: 'avg_ms' }],
    by: null
  };
  const result = executeTimechartPipeline(events, stage);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].avg_ms, 150);
});

test('executeTopPipeline returns most frequent values', () => {
  const events = [
    { msg_hash: 'aaa' }, { msg_hash: 'aaa' }, { msg_hash: 'aaa' },
    { msg_hash: 'bbb' }, { msg_hash: 'bbb' },
    { msg_hash: 'ccc' },
  ];
  const stage = { command: 'top', count: 2, field: 'msg_hash', by: null };
  const result = executeTopPipeline(events, stage);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].msg_hash, 'aaa');
  assert.strictEqual(result[0].count, 3);
  assert.strictEqual(result[1].msg_hash, 'bbb');
});

test('executeRarePipeline returns least frequent values', () => {
  const events = [
    { src_ip: '1.1.1.1' }, { src_ip: '1.1.1.1' }, { src_ip: '1.1.1.1' },
    { src_ip: '2.2.2.2' }, { src_ip: '2.2.2.2' },
    { src_ip: '3.3.3.3' },
  ];
  const stage = { command: 'rare', count: 2, field: 'src_ip', by: null };
  const result = executeRarePipeline(events, stage);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].src_ip, '3.3.3.3');
  assert.strictEqual(result[0].count, 1);
});

test('executeDedupPipeline removes duplicate trace_ids', () => {
  const events = [
    { event_id: '1', trace_id: 'aaa', ts: '2026-03-05T10:01:00Z' },
    { event_id: '2', trace_id: 'aaa', ts: '2026-03-05T10:02:00Z' },
    { event_id: '3', trace_id: 'bbb', ts: '2026-03-05T10:03:00Z' },
  ];
  const stage = { command: 'dedup', fields: ['trace_id'] };
  const result = executeDedupPipeline(events, stage);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].event_id, '1');
  assert.strictEqual(result[1].event_id, '3');
});

test('executeEvalPipeline computes arithmetic', () => {
  const events = [{ duration_ms: 1500 }];
  const stage = { command: 'eval', field: 'duration_sec', expression: 'duration_ms/1000' };
  const result = executeEvalPipeline(events, stage);
  assert.strictEqual(result[0].duration_sec, 1.5);
});

test('executeEvalPipeline computes if expression', () => {
  const events = [{ status: 503 }, { status: 200 }];
  const stage = { command: 'eval', field: 'is_error', expression: 'if(status>=500, "yes", "no")' };
  const result = executeEvalPipeline(events, stage);
  assert.strictEqual(result[0].is_error, 'yes');
  assert.strictEqual(result[1].is_error, 'no');
});

test('executeEvalPipeline computes string functions', () => {
  const events = [{ message: 'Connection Refused' }];
  const stage = { command: 'eval', field: 'msg_lower', expression: 'lower(message)' };
  const result = executeEvalPipeline(events, stage);
  assert.strictEqual(result[0].msg_lower, 'connection refused');
});

test('executeLookupPipeline enriches events from lookup map', () => {
  const events = [
    { service: 'auth', message: 'login' },
    { service: 'billing', message: 'charge' },
    { service: 'unknown', message: 'test' }
  ];
  const lookupMap = new Map([
    ['auth', { team: 'identity', oncall: '#auth-oncall' }],
    ['billing', { team: 'payments', oncall: '#billing-oncall' }]
  ]);
  const stage = { command: 'lookup', table: 'services', field: 'service', outputFields: null };
  const result = executeLookupPipeline(events, stage, lookupMap);
  assert.strictEqual(result[0].team, 'identity');
  assert.strictEqual(result[1].oncall, '#billing-oncall');
  assert.strictEqual(result[2].team, undefined);
});

test('executeLookupPipeline respects output field filter', () => {
  const events = [{ service: 'auth', message: 'login' }];
  const lookupMap = new Map([
    ['auth', { team: 'identity', oncall: '#auth-oncall', manager: 'alice' }]
  ]);
  const stage = { command: 'lookup', table: 'services', field: 'service', outputFields: ['team'] };
  const result = executeLookupPipeline(events, stage, lookupMap);
  assert.strictEqual(result[0].team, 'identity');
  assert.strictEqual(result[0].oncall, undefined);
  assert.strictEqual(result[0].manager, undefined);
});

test('executeRexPipeline extracts named groups from regex', () => {
  const events = [
    { message: 'Error E1234 occurred in module X' },
    { message: 'No error code here' },
  ];
  const stage = { command: 'rex', sourceField: 'message', pattern: '(?<error_code>E[0-9]{4})' };
  const result = executeRexPipeline(events, stage);
  assert.strictEqual(result[0].error_code, 'E1234');
  assert.strictEqual(result[1].error_code, undefined);
});

test('executeRexPipeline extracts multiple groups', () => {
  const events = [
    { message: 'user=alice action=login' },
  ];
  const stage = { command: 'rex', sourceField: 'message', pattern: 'user=(?<user>\\w+) action=(?<action>\\w+)' };
  const result = executeRexPipeline(events, stage);
  assert.strictEqual(result[0].user, 'alice');
  assert.strictEqual(result[0].action, 'login');
});

test('executeRenamePipeline renames field', () => {
  const events = [
    { duration_ms: 150, service: 'api' },
  ];
  const stage = { command: 'rename', oldField: 'duration_ms', newField: 'latency' };
  const result = executeRenamePipeline(events, stage);
  assert.strictEqual(result[0].latency, 150);
  assert.strictEqual(result[0].duration_ms, undefined);
  assert.strictEqual(result[0].service, 'api');
});

test('executeTransactionPipeline groups events by field', () => {
  const events = [
    { trace_id: 'aaa', ts: '2026-03-05T10:00:00Z', message: 'start' },
    { trace_id: 'aaa', ts: '2026-03-05T10:00:03Z', message: 'end' },
    { trace_id: 'bbb', ts: '2026-03-05T10:00:01Z', message: 'only' },
  ];
  const stage = { command: 'transaction', field: 'trace_id', maxSpanMs: 300000, maxEvents: 1000 };
  const result = executeTransactionPipeline(events, stage);
  assert.strictEqual(result.length, 2);
  const aaa = result.find(r => r.trace_id === 'aaa');
  assert.strictEqual(aaa.eventcount, 2);
  assert.strictEqual(aaa.duration, 3000);
  const bbb = result.find(r => r.trace_id === 'bbb');
  assert.strictEqual(bbb.eventcount, 1);
  assert.strictEqual(bbb.duration, 0);
});

test('executeTransactionPipeline respects maxevents', () => {
  const events = [
    { trace_id: 'aaa', ts: '2026-03-05T10:00:00Z' },
    { trace_id: 'aaa', ts: '2026-03-05T10:00:01Z' },
    { trace_id: 'aaa', ts: '2026-03-05T10:00:02Z' },
  ];
  const stage = { command: 'transaction', field: 'trace_id', maxSpanMs: 300000, maxEvents: 2 };
  const result = executeTransactionPipeline(events, stage);
  assert.strictEqual(result[0].eventcount, 2);
});
