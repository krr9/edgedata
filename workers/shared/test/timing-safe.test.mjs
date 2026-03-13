import test from 'node:test';
import assert from 'node:assert/strict';

import { timingSafeEqual, timingSafeTokenCompare } from '../timing-safe.mjs';

test('timingSafeEqual returns true for identical strings', () => {
  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
});

test('timingSafeEqual returns false for different strings of same length', () => {
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
});

test('timingSafeEqual returns false for different lengths', () => {
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('timingSafeEqual returns false for empty vs non-empty', () => {
  assert.equal(timingSafeEqual('', 'a'), false);
});

test('timingSafeEqual returns true for empty strings', () => {
  assert.equal(timingSafeEqual('', ''), true);
});

test('timingSafeEqual returns false for non-string inputs', () => {
  assert.equal(timingSafeEqual(null, 'abc'), false);
  assert.equal(timingSafeEqual('abc', undefined), false);
  assert.equal(timingSafeEqual(123, 'abc'), false);
});

test('timingSafeTokenCompare returns true for matching tokens', () => {
  assert.equal(timingSafeTokenCompare('my-secret-token', 'my-secret-token'), true);
});

test('timingSafeTokenCompare returns false for mismatched tokens', () => {
  assert.equal(timingSafeTokenCompare('my-secret-token', 'wrong-token'), false);
});

test('timingSafeTokenCompare returns false when provided is empty/null', () => {
  assert.equal(timingSafeTokenCompare('', 'expected'), false);
  assert.equal(timingSafeTokenCompare(null, 'expected'), false);
  assert.equal(timingSafeTokenCompare(undefined, 'expected'), false);
});

test('timingSafeTokenCompare returns false when expected is empty/null', () => {
  assert.equal(timingSafeTokenCompare('provided', ''), false);
  assert.equal(timingSafeTokenCompare('provided', null), false);
  assert.equal(timingSafeTokenCompare('provided', undefined), false);
});

test('timingSafeTokenCompare coerces numbers to strings', () => {
  assert.equal(timingSafeTokenCompare(12345, '12345'), true);
});
