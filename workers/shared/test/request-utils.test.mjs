import test from 'node:test';
import assert from 'node:assert/strict';

import { clientIp } from '../request-utils.mjs';

test('clientIp returns CF-Connecting-IP when present', () => {
  const req = { headers: { get: (name) => name === 'CF-Connecting-IP' ? '1.2.3.4' : null } };
  assert.equal(clientIp(req), '1.2.3.4');
});

test('clientIp falls back to x-forwarded-for', () => {
  const req = { headers: { get: (name) => name === 'x-forwarded-for' ? '5.6.7.8' : null } };
  assert.equal(clientIp(req), '5.6.7.8');
});

test('clientIp uses the first forwarded hop and trims whitespace', () => {
  const req = { headers: { get: (name) => name === 'x-forwarded-for' ? ' 5.6.7.8, 10.0.0.1 ' : null } };
  assert.equal(clientIp(req), '5.6.7.8');
});

test('clientIp strips header control characters before building rate-limit keys', () => {
  const req = { headers: { get: (name) => name === 'x-forwarded-for' ? '\n\t5.6.7.8\r, 10.0.0.1' : null } };
  assert.equal(clientIp(req), '5.6.7.8');
});

test('clientIp unwraps bracketed IPv6 addresses', () => {
  const req = { headers: { get: (name) => name === 'x-forwarded-for' ? ' [2001:db8::1] , proxy' : null } };
  assert.equal(clientIp(req), '2001:db8::1');
});

test('clientIp ignores blank CF-Connecting-IP values and falls back safely', () => {
  const req = {
    headers: {
      get: (name) => {
        if (name === 'CF-Connecting-IP') return '   ';
        if (name === 'x-forwarded-for') return '9.8.7.6, 10.0.0.1';
        return null;
      }
    }
  };
  assert.equal(clientIp(req), '9.8.7.6');
});

test('clientIp returns unknown-ip when no headers', () => {
  const req = { headers: { get: () => null } };
  assert.equal(clientIp(req), 'unknown-ip');
});
