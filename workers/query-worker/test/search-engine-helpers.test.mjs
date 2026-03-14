import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIndexValue,
  eventIndex,
  isBeforeCursor,
  eventMatchesFilters,
  eventMatchesScope,
  assertFiltersWithinScope,
  injectScopeFilters,
  isWithinWindow,
  encodePartitionValue,
  buildPartitionPrefix,
  keyDimensionValue,
  keyMatchesFiltersByPath,
  isExactScopedValue
} from '../src/search-engine-core.mjs';

test('normalizeIndexValue returns default for empty', () => {
  assert.equal(normalizeIndexValue(undefined), 'default');
  assert.equal(normalizeIndexValue(''), 'default');
});

test('normalizeIndexValue trims and lowercases', () => {
  assert.equal(normalizeIndexValue('  SECURITY  '), 'security');
});

test('eventIndex uses normalizeIndexValue', () => {
  assert.equal(eventIndex({ index: 'logs' }), 'logs');
  assert.equal(eventIndex({ index: undefined }), 'default');
});

test('isBeforeCursor returns true when no cursor', () => {
  assert.equal(isBeforeCursor({ ts: '2026-03-12T10:00:00Z', event_id: 'a' }, null), true);
});

test('isBeforeCursor compares by ts then event_id', () => {
  const cursor = { before_ts: '2026-03-12T10:00:00Z', before_event_id: 'b' };
  assert.equal(isBeforeCursor({ ts: '2026-03-12T09:00:00Z', event_id: 'a' }, cursor), true);
  assert.equal(isBeforeCursor({ ts: '2026-03-12T11:00:00Z', event_id: 'a' }, cursor), false);
  assert.equal(isBeforeCursor({ ts: '2026-03-12T10:00:00Z', event_id: 'a' }, cursor), true);
  assert.equal(isBeforeCursor({ ts: '2026-03-12T10:00:00Z', event_id: 'c' }, cursor), false);
});

test('eventMatchesFilters matches index, service, env, host', () => {
  const event = {
    event_id: '1',
    ts: '2026-03-12T10:00:00Z',
    index: 'logs',
    service: 'api',
    env: 'prod',
    host: 'h1',
    level: 'info',
    message: 'm'
  };
  assert.equal(eventMatchesFilters(event, { index: 'logs', service: 'api', env: 'prod', host: 'h1' }), true);
  assert.equal(eventMatchesFilters(event, { service: 'other' }), false);
});

test('eventMatchesScope uses wildcard and exact patterns', () => {
  const event = { index: 'logs', service: 'api', env: 'prod', host: 'h1' };
  assert.equal(eventMatchesScope(event, { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] }), true);
  assert.equal(eventMatchesScope(event, { indexes: ['logs'], services: ['api'], envs: ['prod'], hosts: ['h1'] }), true);
  assert.equal(eventMatchesScope(event, { indexes: ['other'], services: ['*'], envs: ['*'], hosts: ['*'] }), false);
});

test('assertFiltersWithinScope throws when index outside scope', () => {
  assert.throws(
    () => assertFiltersWithinScope({ index: 'forbidden' }, { indexes: ['logs'], services: ['*'], envs: ['*'], hosts: ['*'] }),
    /Forbidden: index outside role scope/
  );
});

test('assertFiltersWithinScope does not throw when in scope', () => {
  assert.doesNotThrow(() =>
    assertFiltersWithinScope({ index: 'logs' }, { indexes: ['logs'], services: ['*'], envs: ['*'], hosts: ['*'] })
  );
});

test('injectScopeFilters injects single exact value when scope has one', () => {
  const filters = {};
  const scope = { indexes: ['*'], services: ['api'], envs: ['*'], hosts: ['*'] };
  const result = injectScopeFilters(filters, scope);
  assert.equal(result.service, 'api');
});

test('injectScopeFilters does not override existing filter', () => {
  const filters = { service: 'web' };
  const scope = { indexes: ['*'], services: ['api'], envs: ['*'], hosts: ['*'] };
  const result = injectScopeFilters(filters, scope);
  assert.equal(result.service, 'web');
});

test('isWithinWindow returns true for timestamp in range', () => {
  const fromMs = new Date('2026-03-12T10:00:00Z').getTime();
  const toMs = new Date('2026-03-12T11:00:00Z').getTime();
  assert.equal(isWithinWindow('2026-03-12T10:30:00Z', fromMs, toMs), true);
  assert.equal(isWithinWindow('2026-03-12T09:00:00Z', fromMs, toMs), false);
});

test('encodePartitionValue encodes special chars', () => {
  assert.equal(encodePartitionValue('my-index'), 'my-index');
  assert.equal(encodePartitionValue('a/b'), 'a%2Fb');
});

test('buildPartitionPrefix builds events path with index, service, env', () => {
  const prefix = buildPartitionPrefix('events', '2026-03-12', {
    index: 'logs',
    service: 'api',
    env: 'prod'
  });
  assert.equal(prefix, 'events/date=2026-03-12/index=logs/service=api/env=prod/');
});

test('buildPartitionPrefix returns base when no index filter', () => {
  const prefix = buildPartitionPrefix('events', '2026-03-12', {});
  assert.equal(prefix, 'events/date=2026-03-12/');
});

test('buildPartitionPrefix raw kind stops at index', () => {
  const prefix = buildPartitionPrefix('raw', '2026-03-12', { index: 'logs', service: 'api' });
  assert.equal(prefix, 'raw/date=2026-03-12/index=logs/');
});

test('keyDimensionValue extracts dimension from key path', () => {
  const key = 'events/date=2026-03-12/index=logs/service=api/env=prod/part-1.jsonl';
  assert.equal(keyDimensionValue(key, 'index'), 'logs');
  assert.equal(keyDimensionValue(key, 'service'), 'api');
  assert.equal(keyDimensionValue(key, 'env'), 'prod');
});

test('keyMatchesFiltersByPath matches key path to filters', () => {
  const key = 'events/date=2026-03-12/index=logs/service=api/env=prod/part-1.jsonl';
  assert.equal(keyMatchesFiltersByPath(key, { index: 'logs', service: 'api', env: 'prod' }), true);
  assert.equal(keyMatchesFiltersByPath(key, { service: 'other' }), false);
});

test('isExactScopedValue returns false for empty, wildcard, or glob', () => {
  assert.equal(isExactScopedValue(undefined), false);
  assert.equal(isExactScopedValue('*'), false);
  assert.equal(isExactScopedValue('api*'), false);
});

test('isExactScopedValue returns true for exact value', () => {
  assert.equal(isExactScopedValue('api'), true);
  assert.equal(isExactScopedValue('logs'), true);
});
