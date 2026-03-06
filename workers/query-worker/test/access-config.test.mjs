import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAccessJwtRequired,
  parseCsvSet,
  validateAlertAccessJwtConfig,
  validateQueryAccessJwtConfig
} from '../../shared/access-config.mjs';

test('isAccessJwtRequired recognizes common truthy values', () => {
  assert.equal(isAccessJwtRequired('true'), true);
  assert.equal(isAccessJwtRequired('TRUE'), true);
  assert.equal(isAccessJwtRequired('1'), true);
  assert.equal(isAccessJwtRequired('yes'), true);
  assert.equal(isAccessJwtRequired('on'), true);
  assert.equal(isAccessJwtRequired('false'), false);
  assert.equal(isAccessJwtRequired(''), false);
});

test('parseCsvSet normalizes whitespace and case', () => {
  const parsed = parseCsvSet(' Admins, admins , Analysts ,, VIEWERS ');
  assert.deepEqual(Array.from(parsed), ['admins', 'analysts', 'viewers']);
});

test('validateQueryAccessJwtConfig requires audience, issuer, and at least one role mapping', () => {
  const errors = validateQueryAccessJwtConfig({
    REQUIRE_ACCESS_JWT: 'true',
    ACCESS_AUD: '',
    ACCESS_ISSUER: '',
    ACCESS_SUPERADMIN_GROUPS: '',
    ACCESS_ADMIN_GROUPS: '',
    ACCESS_ANALYST_GROUPS: '',
    ACCESS_VIEWER_GROUPS: ''
  });

  assert.equal(errors.length, 3);
  assert.match(errors.join(' | '), /ACCESS_AUD/);
  assert.match(errors.join(' | '), /ACCESS_ISSUER/);
  assert.match(errors.join(' | '), /ACCESS_\*_GROUPS/);
});

test('validateQueryAccessJwtConfig passes when one group mapping is configured', () => {
  const errors = validateQueryAccessJwtConfig({
    REQUIRE_ACCESS_JWT: 'true',
    ACCESS_AUD: 'query-aud',
    ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
    ACCESS_SUPERADMIN_GROUPS: '',
    ACCESS_ADMIN_GROUPS: '',
    ACCESS_ANALYST_GROUPS: 'cf-analysts',
    ACCESS_VIEWER_GROUPS: ''
  });

  assert.deepEqual(errors, []);
});

test('validateAlertAccessJwtConfig requires alert admin groups under JWT mode', () => {
  const errors = validateAlertAccessJwtConfig({
    REQUIRE_ACCESS_JWT: 'true',
    ACCESS_AUD: 'alert-aud',
    ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
    ACCESS_ADMIN_GROUPS: ''
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /ACCESS_ADMIN_GROUPS/);
});

test('validateAlertAccessJwtConfig skips checks when JWT mode disabled', () => {
  const errors = validateAlertAccessJwtConfig({
    REQUIRE_ACCESS_JWT: 'false',
    ACCESS_AUD: '',
    ACCESS_ISSUER: '',
    ACCESS_ADMIN_GROUPS: ''
  });

  assert.deepEqual(errors, []);
});

