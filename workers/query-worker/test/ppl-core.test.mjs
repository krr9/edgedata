import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePplPipeline } from '../src/ppl-core.mjs';

test('parsePplPipeline supports implicit search with where/sort/head', () => {
  const parsed = parsePplPipeline('timeout postgres | where idx="security" and service="api" and status>=500 | sort -ts | head 25');
  assert.equal(parsed.stages.length, 4);
  assert.equal(parsed.stages[0].command, 'search');
  assert.equal(parsed.stages[0].implicit, true);
  assert.equal(parsed.stages[1].command, 'where');
  assert.deepEqual(parsed.stages[1].conditions[0], { field: 'index', operator: '=', value: 'security' });
  assert.deepEqual(parsed.stages[1].conditions[1], { field: 'service', operator: '=', value: 'api' });
  assert.deepEqual(parsed.stages[1].conditions[2], { field: 'status', operator: '>=', value: 500 });
  assert.equal(parsed.stages[2].command, 'sort');
  assert.deepEqual(parsed.stages[2].keys[0], { field: 'ts', direction: 'desc' });
  assert.equal(parsed.stages[3].command, 'head');
  assert.equal(parsed.stages[3].count, 25);
});

test('parsePplPipeline parses stats count by fields', () => {
  const parsed = parsePplPipeline('search error | where level="error" | stats count() as total by service, env');
  assert.equal(parsed.stages.length, 3);
  assert.equal(parsed.stages[2].command, 'stats');
  assert.equal(parsed.stages[2].fn, 'count');
  assert.equal(parsed.stages[2].as, 'total');
  assert.deepEqual(parsed.stages[2].by, ['service', 'env']);
});

test('stats parses sum aggregation', () => {
  const result = parsePplPipeline('search * | stats sum(duration_ms) by service');
  const stats = result.stages[1];
  assert.strictEqual(stats.command, 'stats');
  assert.deepStrictEqual(stats.aggregations, [
    { fn: 'sum', field: 'duration_ms', as: 'sum_duration_ms' }
  ]);
  assert.deepStrictEqual(stats.by, ['service']);
});

test('stats parses multiple aggregations', () => {
  const result = parsePplPipeline('search * | stats count() avg(duration_ms) max(status) by service, env');
  const stats = result.stages[1];
  assert.strictEqual(stats.aggregations.length, 3);
  assert.strictEqual(stats.aggregations[0].fn, 'count');
  assert.strictEqual(stats.aggregations[1].fn, 'avg');
  assert.strictEqual(stats.aggregations[1].field, 'duration_ms');
  assert.strictEqual(stats.aggregations[2].fn, 'max');
  assert.deepStrictEqual(stats.by, ['service', 'env']);
});

test('stats parses dc aggregation', () => {
  const result = parsePplPipeline('search * | stats dc(src_ip) by service');
  const stats = result.stages[1];
  assert.deepStrictEqual(stats.aggregations, [
    { fn: 'dc', field: 'src_ip', as: 'dc_src_ip' }
  ]);
});

test('stats parses with custom alias', () => {
  const result = parsePplPipeline('search * | stats count() as total by service');
  const stats = result.stages[1];
  assert.deepStrictEqual(stats.aggregations, [
    { fn: 'count', field: null, as: 'total' }
  ]);
});

test('timechart parses span and count by field', () => {
  const result = parsePplPipeline('search * | timechart span=5m count() by level');
  const tc = result.stages[1];
  assert.strictEqual(tc.command, 'timechart');
  assert.strictEqual(tc.span, '5m');
  assert.strictEqual(tc.spanMs, 300000);
  assert.deepStrictEqual(tc.aggregations, [{ fn: 'count', field: null, as: 'count' }]);
  assert.strictEqual(tc.by, 'level');
});

test('timechart parses span with avg', () => {
  const result = parsePplPipeline('search * | timechart span=1h avg(duration_ms)');
  const tc = result.stages[1];
  assert.strictEqual(tc.spanMs, 3600000);
  assert.strictEqual(tc.aggregations[0].fn, 'avg');
  assert.strictEqual(tc.aggregations[0].field, 'duration_ms');
  assert.strictEqual(tc.by, null);
});

test('top parses count and field', () => {
  const result = parsePplPipeline('search * | top 10 msg_hash');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'top');
  assert.strictEqual(stage.count, 10);
  assert.strictEqual(stage.field, 'msg_hash');
  assert.strictEqual(stage.by, null);
});

test('top parses with by field', () => {
  const result = parsePplPipeline('search * | top 5 host by service');
  const stage = result.stages[1];
  assert.strictEqual(stage.count, 5);
  assert.strictEqual(stage.field, 'host');
  assert.strictEqual(stage.by, 'service');
});

test('rare parses count and field', () => {
  const result = parsePplPipeline('search * | rare 10 src_ip');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'rare');
  assert.strictEqual(stage.count, 10);
  assert.strictEqual(stage.field, 'src_ip');
});

test('dedup parses single field', () => {
  const result = parsePplPipeline('search * | dedup trace_id');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'dedup');
  assert.deepStrictEqual(stage.fields, ['trace_id']);
});

test('dedup parses multiple fields', () => {
  const result = parsePplPipeline('search * | dedup service, host');
  const stage = result.stages[1];
  assert.deepStrictEqual(stage.fields, ['service', 'host']);
});

test('eval parses simple arithmetic', () => {
  const result = parsePplPipeline('search * | eval duration_sec=duration_ms/1000');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'eval');
  assert.strictEqual(stage.field, 'duration_sec');
  assert.strictEqual(stage.expression, 'duration_ms/1000');
});

test('eval parses if expression', () => {
  const result = parsePplPipeline('search * | eval is_error=if(status>=500, "yes", "no")');
  const stage = result.stages[1];
  assert.strictEqual(stage.field, 'is_error');
  assert.ok(stage.expression.includes('if('));
});

test('timechart rejects invalid span', () => {
  assert.throws(() => parsePplPipeline('search * | timechart span=abc count()'), /Invalid timechart span/);
});

test('parsePplPipeline parses lookup command', () => {
  const pipeline = parsePplPipeline('search * | lookup service_owners service');
  const lookup = pipeline.stages.find(s => s.command === 'lookup');
  assert.ok(lookup);
  assert.strictEqual(lookup.table, 'service_owners');
  assert.strictEqual(lookup.field, 'service');
  assert.strictEqual(lookup.outputFields, null);
});

test('parsePplPipeline parses lookup with output fields', () => {
  const pipeline = parsePplPipeline('search * | lookup hosts hostname output team, oncall');
  const lookup = pipeline.stages.find(s => s.command === 'lookup');
  assert.ok(lookup);
  assert.strictEqual(lookup.table, 'hosts');
  assert.strictEqual(lookup.field, 'hostname');
  assert.deepStrictEqual(lookup.outputFields, ['team', 'oncall']);
});

test('rex parses field and regex with named groups', () => {
  const result = parsePplPipeline('search * | rex field=message "(?<error_code>E[0-9]{4})"');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'rex');
  assert.strictEqual(stage.sourceField, 'message');
  assert.strictEqual(stage.pattern, '(?<error_code>E[0-9]{4})');
});

test('rex rejects missing field or pattern', () => {
  assert.throws(() => parsePplPipeline('search * | rex "(?<x>abc)"'), /rex requires field=/);
});

test('rename parses old as new', () => {
  const result = parsePplPipeline('search * | rename duration_ms as latency');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'rename');
  assert.strictEqual(stage.oldField, 'duration_ms');
  assert.strictEqual(stage.newField, 'latency');
});

test('rename rejects missing as keyword', () => {
  assert.throws(() => parsePplPipeline('search * | rename duration_ms latency'), /rename requires: <old_field> as <new_field>/);
});

test('table parses as alias for fields', () => {
  const result = parsePplPipeline('search * | table ts, service, message');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'table');
  assert.deepStrictEqual(stage.fields, ['ts', 'service', 'message']);
});

test('transaction parses field with maxspan and maxevents', () => {
  const result = parsePplPipeline('search * | transaction trace_id maxspan=5m maxevents=100');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'transaction');
  assert.strictEqual(stage.field, 'trace_id');
  assert.strictEqual(stage.maxSpanMs, 300000);
  assert.strictEqual(stage.maxEvents, 100);
});

test('transaction parses field without options', () => {
  const result = parsePplPipeline('search * | transaction request_id');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'transaction');
  assert.strictEqual(stage.field, 'request_id');
  assert.strictEqual(stage.maxSpanMs, 600000);
  assert.strictEqual(stage.maxEvents, 1000);
});

test('parsePplPipeline rejects unsupported commands', () => {
  assert.throws(
    () => parsePplPipeline('search timeout | cluster trace_id'),
    /Unsupported PPL command: cluster/
  );
});

test('parsePplPipeline rejects OR in where clause for now', () => {
  assert.throws(
    () => parsePplPipeline('search timeout | where status>=500 OR level="error"'),
    /supports only AND conditions/
  );
});
