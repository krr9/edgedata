import test from 'node:test';
import assert from 'node:assert/strict';

import { asRateLimitPerMinute, enforceRateLimit } from '../rate-limit.mjs';

test('asRateLimitPerMinute parses valid number', () => {
  assert.equal(asRateLimitPerMinute('100', 50), 100);
});

test('asRateLimitPerMinute returns fallback for invalid input', () => {
  assert.equal(asRateLimitPerMinute(undefined, 50), 50);
  assert.equal(asRateLimitPerMinute('abc', 50), 50);
  assert.equal(asRateLimitPerMinute('-1', 50), 50);
});

test('asRateLimitPerMinute truncates floats', () => {
  assert.equal(asRateLimitPerMinute('99.7', 50), 99);
});

test('enforceRateLimit does nothing for zero limit', async () => {
  await enforceRateLimit(null, 'test', 'key', 0);
});

test('enforceRateLimit throws when limit exceeded', async () => {
  const mockDb = {
    prepare: () => ({
      bind: () => ({
        run: async () => {},
        first: async () => ({ count: 11 })
      })
    })
  };
  await assert.rejects(
    () => enforceRateLimit(mockDb, 'test', 'key', 10),
    /Rate limit exceeded/
  );
});

test('enforceRateLimit succeeds when within limit', async () => {
  const mockDb = {
    prepare: () => ({
      bind: () => ({
        run: async () => {},
        first: async () => ({ count: 5 })
      })
    })
  };
  await enforceRateLimit(mockDb, 'test', 'key', 10);
});
