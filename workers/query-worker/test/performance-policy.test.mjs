import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheShardNameForKey,
  hashQueryText,
  normalizeBooleanFlag,
  normalizeCacheTtlSeconds,
  normalizeExecutionMode,
  normalizeMaterializeIntervalSeconds,
  normalizeMaxStalenessSeconds,
  normalizePerformanceProfile
} from '../src/performance-policy.mjs';

test('normalizeExecutionMode and normalizePerformanceProfile guard invalid values', () => {
  assert.equal(normalizeExecutionMode('cached'), 'cached');
  assert.equal(normalizeExecutionMode('MATERIALIZED'), 'materialized');
  assert.equal(normalizeExecutionMode('unknown', 'cached'), 'cached');

  assert.equal(normalizePerformanceProfile('fast'), 'fast');
  assert.equal(normalizePerformanceProfile('BALANCED'), 'balanced');
  assert.equal(normalizePerformanceProfile('oops'), 'economy');
});

test('cache/materialization numeric normalizers clamp to bounded positive integers', () => {
  assert.equal(normalizeCacheTtlSeconds(30), 30);
  assert.equal(normalizeCacheTtlSeconds(-1), 120);
  assert.equal(normalizeCacheTtlSeconds(999999), 3600);

  assert.equal(normalizeMaterializeIntervalSeconds(60), 60);
  assert.equal(normalizeMaterializeIntervalSeconds('bad'), 300);

  assert.equal(normalizeMaxStalenessSeconds(90), 90);
  assert.equal(normalizeMaxStalenessSeconds(999999), 86400);
});

test('normalizeBooleanFlag accepts common truthy and falsy shapes', () => {
  assert.equal(normalizeBooleanFlag(true), true);
  assert.equal(normalizeBooleanFlag(1), true);
  assert.equal(normalizeBooleanFlag('yes'), true);
  assert.equal(normalizeBooleanFlag('0', true), false);
  assert.equal(normalizeBooleanFlag(undefined, true), true);
});

test('cacheShardNameForKey is deterministic and spreads keys across shards', () => {
  const a = cacheShardNameForKey('tenant-a|widget-1', 8);
  const b = cacheShardNameForKey('tenant-a|widget-1', 8);
  const c = cacheShardNameForKey('tenant-a|widget-2', 8);
  assert.equal(a, b);
  assert.match(a, /^shard-[0-7]$/);
  assert.notEqual(a, c);
});

test('hashQueryText normalizes whitespace before hashing', () => {
  assert.equal(hashQueryText('search * | stats count()'), hashQueryText(' search   *   | stats count() '));
  assert.notEqual(hashQueryText('search level=error'), hashQueryText('search level=info'));
});
