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

test('clientIp returns unknown-ip when no headers', () => {
  const req = { headers: { get: () => null } };
  assert.equal(clientIp(req), 'unknown-ip');
});
