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

test('originMatchesPattern rejects deceptive suffixes and credential-bearing origins', () => {
  assert.equal(
    originMatchesPattern(
      'https://preview.edgedata-1fo.pages.dev.attacker.example',
      'https://*.edgedata-1fo.pages.dev'
    ),
    false
  );
  assert.equal(
    originMatchesPattern(
      'https://edgedata-1fo.pages.dev@attacker.example',
      'https://*.edgedata-1fo.pages.dev'
    ),
    false
  );
});

test('originMatchesPattern enforces explicit wildcard ports', () => {
  assert.equal(
    originMatchesPattern(
      'https://preview.edgedata-1fo.pages.dev:8443',
      'https://*.edgedata-1fo.pages.dev:8443'
    ),
    true
  );
  assert.equal(
    originMatchesPattern(
      'https://preview.edgedata-1fo.pages.dev',
      'https://*.edgedata-1fo.pages.dev:8443'
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

test('resolveCorsOriginFromPatterns returns wildcard when allowlist is empty or invalid', () => {
  assert.equal(resolveCorsOriginFromPatterns('https://app.example.com', []), '*');
  assert.equal(resolveCorsOriginFromPatterns('https://app.example.com', ['   ']), '*');
});
