import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccessStartReturnTo } from '../src/access-sso-utils.mjs';

test('resolveAccessStartReturnTo prefers explicit allowed return_to value', () => {
  const actual = resolveAccessStartReturnTo({
    requestUrl: 'https://query-worker.example.workers.dev/auth/access/start',
    requestedReturnTo: 'https://app.example.com/auth',
    allowedOrigins: ['https://app.example.com', 'https://*.preview.example.com'],
    originHeader: 'https://app.example.com',
    refererHeader: 'https://app.example.com/login'
  });

  assert.equal(actual, 'https://app.example.com/auth');
});

test('resolveAccessStartReturnTo accepts preview origins that match wildcard CORS patterns', () => {
  const actual = resolveAccessStartReturnTo({
    requestUrl: 'https://query-worker.example.workers.dev/auth/access/start',
    requestedReturnTo: 'https://tenant.preview.example.com/investigations',
    allowedOrigins: ['https://app.example.com', 'https://*.preview.example.com'],
    originHeader: 'https://app.example.com',
    refererHeader: 'https://app.example.com/login'
  });

  assert.equal(actual, 'https://tenant.preview.example.com/investigations');
});

test('resolveAccessStartReturnTo falls back to origin header when return_to is not allowed', () => {
  const actual = resolveAccessStartReturnTo({
    requestUrl: 'https://query-worker.example.workers.dev/auth/access/start',
    requestedReturnTo: 'https://evil.example.net/phish',
    allowedOrigins: ['https://app.example.com'],
    originHeader: 'https://app.example.com',
    refererHeader: 'https://app.example.com/login'
  });

  assert.equal(actual, 'https://app.example.com/');
});

test('resolveAccessStartReturnTo falls back to worker origin when nothing else is allowed', () => {
  const actual = resolveAccessStartReturnTo({
    requestUrl: 'https://query-worker.example.workers.dev/auth/access/start?return_to=javascript:alert(1)',
    requestedReturnTo: 'javascript:alert(1)',
    allowedOrigins: ['https://app.example.com'],
    originHeader: 'https://evil.example.net',
    refererHeader: 'https://evil.example.net/login'
  });

  assert.equal(actual, 'https://query-worker.example.workers.dev');
});
