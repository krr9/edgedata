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

test('parsePplPipeline rejects unsupported commands', () => {
  assert.throws(
    () => parsePplPipeline('search timeout | eval foo=bar'),
    /Unsupported PPL command: eval/
  );
});

test('parsePplPipeline rejects OR in where clause for now', () => {
  assert.throws(
    () => parsePplPipeline('search timeout | where status>=500 OR level="error"'),
    /supports only AND conditions/
  );
});
