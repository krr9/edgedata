import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowsCredentialedCors,
  originMatchesPattern,
  resolveCorsOriginFromPatterns
} from '../src/cors-utils.mjs';

test('originMatchesPattern supports exact origin matching', () => {
  assert.equal(originMatchesPattern('https://app.example.com', 'https://app.example.com'), true);
  assert.equal(originMatchesPattern('https://app.example.com', 'https://other.example.com'), false);
});

test('originMatchesPattern supports wildcard subdomain patterns', () => {
  assert.equal(
    originMatchesPattern(
      'https://ce91209e.edgedata-1fo.pages.dev',
      'https://*.edgedata-1fo.pages.dev'
    ),
    true
  );
  assert.equal(
    originMatchesPattern(
      'https://edgedata-1fo.pages.dev',
      'https://*.edgedata-1fo.pages.dev'
    ),
    false
  );
  assert.equal(
    originMatchesPattern(
      'http://ce91209e.edgedata-1fo.pages.dev',
      'https://*.edgedata-1fo.pages.dev'
    ),
    false
  );
});

test('resolveCorsOriginFromPatterns returns request origin when allowed', () => {
  const resolved = resolveCorsOriginFromPatterns('https://preview.edgedata-1fo.pages.dev', [
    'https://edgedata-1fo.pages.dev',
    'https://*.edgedata-1fo.pages.dev'
  ]);
  assert.equal(resolved, 'https://preview.edgedata-1fo.pages.dev');
});

test('resolveCorsOriginFromPatterns falls back to first allowlist value', () => {
  const resolved = resolveCorsOriginFromPatterns('https://unknown.example.com', [
    'https://edgedata-1fo.pages.dev',
    'https://*.edgedata-1fo.pages.dev'
  ]);
  assert.equal(resolved, 'https://edgedata-1fo.pages.dev');
});

test('allowsCredentialedCors only permits concrete origins', () => {
  assert.equal(allowsCredentialedCors('https://edgedata-1fo.pages.dev'), true);
  assert.equal(allowsCredentialedCors('*'), false);
  assert.equal(allowsCredentialedCors(''), false);
});
