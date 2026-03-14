import test from 'node:test';
import assert from 'node:assert/strict';

import { hasPermission, assertPermission, assertCanAssignRoles, PRIVILEGED_ROLES } from '../src/rbac-core.mjs';
import {
  parseScope,
  parseScopeInput,
  parsePermissionsInput,
  normalizeScope,
  matchesScopedValue,
  globToRegExp,
  mergeScope,
  highestRole,
  ensureRoleId
} from '../src/auth-core.mjs';

function authWithPermissions(permissions, role = 'viewer') {
  return {
    principal: 'test',
    email: 'test@example.com',
    role,
    roleIds: [role],
    permissions: new Set(permissions),
    scope: { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] },
    authMode: 'local_password',
    groups: []
  };
}

test('hasPermission grants when permission is in set', () => {
  const auth = authWithPermissions(['search.read', 'dashboard.read']);
  assert.equal(hasPermission(auth, 'search.read'), true);
  assert.equal(hasPermission(auth, 'dashboard.read'), true);
});

test('hasPermission denies when permission is not in set', () => {
  const auth = authWithPermissions(['search.read']);
  assert.equal(hasPermission(auth, 'users.write'), false);
});

test('hasPermission grants all when wildcard present', () => {
  const auth = authWithPermissions(['*']);
  assert.equal(hasPermission(auth, 'users.write'), true);
  assert.equal(hasPermission(auth, 'admin.anything'), true);
});

test('assertPermission throws Forbidden when permission missing', () => {
  const auth = authWithPermissions(['search.read']);
  assert.throws(() => assertPermission(auth, 'users.write'), /Forbidden/);
});

test('assertPermission does not throw when permission present', () => {
  const auth = authWithPermissions(['users.write']);
  assert.doesNotThrow(() => assertPermission(auth, 'users.write'));
});

test('PRIVILEGED_ROLES contains superadmin and admin', () => {
  assert.equal(PRIVILEGED_ROLES.has('superadmin'), true);
  assert.equal(PRIVILEGED_ROLES.has('admin'), true);
  assert.equal(PRIVILEGED_ROLES.has('analyst'), false);
  assert.equal(PRIVILEGED_ROLES.has('viewer'), false);
});

test('assertCanAssignRoles allows viewer to assign non-privileged roles', () => {
  const auth = authWithPermissions(['users.write'], 'viewer');
  auth.role = 'viewer';
  assert.doesNotThrow(() => assertCanAssignRoles(auth, ['viewer']));
  assert.doesNotThrow(() => assertCanAssignRoles(auth, ['analyst']));
});

test('assertCanAssignRoles allows viewer to assign viewer+analyst (no privileged)', () => {
  const auth = authWithPermissions(['users.write'], 'viewer');
  auth.role = 'viewer';
  assert.doesNotThrow(() => assertCanAssignRoles(auth, ['viewer', 'analyst']));
});

test('assertCanAssignRoles throws when viewer tries to assign admin', () => {
  const auth = authWithPermissions(['users.write'], 'viewer');
  auth.role = 'viewer';
  assert.throws(() => assertCanAssignRoles(auth, ['admin']), /Forbidden/);
});

test('assertCanAssignRoles throws when analyst tries to assign admin', () => {
  const auth = authWithPermissions(['users.write'], 'analyst');
  auth.role = 'analyst';
  assert.throws(() => assertCanAssignRoles(auth, ['admin']), /Forbidden/);
});

test('assertCanAssignRoles throws when analyst tries to assign superadmin', () => {
  const auth = authWithPermissions(['users.write'], 'analyst');
  auth.role = 'analyst';
  assert.throws(() => assertCanAssignRoles(auth, ['superadmin']), /Forbidden/);
});

test('assertCanAssignRoles allows superadmin to assign admin', () => {
  const auth = authWithPermissions(['*'], 'superadmin');
  auth.role = 'superadmin';
  assert.doesNotThrow(() => assertCanAssignRoles(auth, ['admin']));
});

test('assertCanAssignRoles allows superadmin to assign superadmin', () => {
  const auth = authWithPermissions(['*'], 'superadmin');
  auth.role = 'superadmin';
  assert.doesNotThrow(() => assertCanAssignRoles(auth, ['superadmin']));
});

test('parseScope returns default scope for empty input', () => {
  const scope = parseScope(undefined);
  assert.deepEqual(scope.indexes, ['*']);
  assert.deepEqual(scope.services, ['*']);
  assert.deepEqual(scope.envs, ['*']);
  assert.deepEqual(scope.hosts, ['*']);
});

test('parseScope parses valid JSON scope', () => {
  const scope = parseScope(JSON.stringify({
    indexes: ['logs'],
    services: ['api', 'web'],
    envs: ['prod'],
    hosts: ['*']
  }));
  assert.deepEqual(scope.indexes, ['logs']);
  assert.deepEqual(scope.services, ['api', 'web']);
  assert.deepEqual(scope.envs, ['prod']);
  assert.deepEqual(scope.hosts, ['*']);
});

test('parseScope falls back to default for invalid JSON', () => {
  const scope = parseScope('not json');
  assert.deepEqual(scope.indexes, ['*']);
});

test('parseScope trims whitespace, removes duplicates, and drops empty entries', () => {
  const scope = parseScope(JSON.stringify({
    indexes: [' logs ', 'logs', '', '   '],
    services: [' api ', 'api', '\n'],
    envs: [' prod ', 'prod'],
    hosts: [' host-1 ', 'host-1']
  }));
  assert.deepEqual(scope.indexes, ['logs']);
  assert.deepEqual(scope.services, ['api']);
  assert.deepEqual(scope.envs, ['prod']);
  assert.deepEqual(scope.hosts, ['host-1']);
});

test('parseScopeInput accepts object input', () => {
  const scope = parseScopeInput({ indexes: ['logs'], services: ['api'] });
  assert.deepEqual(scope.indexes, ['logs']);
  assert.deepEqual(scope.services, ['api']);
});

test('parseScopeInput tolerates malformed arrays and falls back safely', () => {
  const scope = parseScopeInput({ indexes: null, services: [' api ', '', 'api'], envs: 'prod', hosts: [null, ' host '] });
  assert.deepEqual(scope.indexes, ['*']);
  assert.deepEqual(scope.services, ['api']);
  assert.deepEqual(scope.envs, ['*']);
  assert.deepEqual(scope.hosts, ['host']);
});

test('normalizeScope preserves non-empty arrays', () => {
  const scope = normalizeScope({
    indexes: ['logs'],
    services: [],
    envs: ['prod'],
    hosts: []
  });
  assert.deepEqual(scope.indexes, ['logs']);
  assert.deepEqual(scope.services, ['*']);
  assert.deepEqual(scope.envs, ['prod']);
  assert.deepEqual(scope.hosts, ['*']);
});

test('matchesScopedValue returns true for wildcard patterns', () => {
  assert.equal(matchesScopedValue('api', ['*']), true);
  assert.equal(matchesScopedValue('api', []), true);
});

test('matchesScopedValue matches exact values case-insensitively', () => {
  assert.equal(matchesScopedValue('api', ['api']), true);
  assert.equal(matchesScopedValue('API', ['api']), true);
});

test('matchesScopedValue matches glob patterns', () => {
  assert.equal(matchesScopedValue('api-prod', ['api*']), true);
  assert.equal(matchesScopedValue('svc-v2', ['svc-*']), true);
});

test('matchesScopedValue returns false when no match', () => {
  assert.equal(matchesScopedValue('other', ['api', 'web']), false);
});

test('globToRegExp escapes special chars and converts * to .*', () => {
  const re = globToRegExp('api*');
  assert.equal(re.test('api'), true);
  assert.equal(re.test('api-prod'), true);
  assert.equal(re.test('other'), false);
});

test('globToRegExp treats regex metacharacters literally', () => {
  const re = globToRegExp('prod.+(admin)');
  assert.equal(re.test('prod.+(admin)'), true);
  assert.equal(re.test('production-admin'), false);
});

test('mergeScope merges multiple scopes', () => {
  const merged = mergeScope([
    { indexes: ['logs'], services: ['api'], envs: ['*'], hosts: ['*'] },
    { indexes: ['logs'], services: ['web'], envs: ['*'], hosts: ['*'] }
  ]);
  assert.deepEqual(merged.services, ['api', 'web']);
});

test('mergeScope returns wildcard when any scope has wildcard', () => {
  const merged = mergeScope([
    { indexes: ['*'], services: ['api'], envs: ['*'], hosts: ['*'] },
    { indexes: ['logs'], services: ['web'], envs: ['*'], hosts: ['*'] }
  ]);
  assert.deepEqual(merged.indexes, ['*']);
});

test('highestRole returns highest role in hierarchy', () => {
  assert.equal(highestRole(['viewer']), 'viewer');
  assert.equal(highestRole(['analyst', 'viewer']), 'analyst');
  assert.equal(highestRole(['admin', 'analyst']), 'admin');
  assert.equal(highestRole(['superadmin', 'admin']), 'superadmin');
});

test('ensureRoleId normalizes role string', () => {
  assert.equal(ensureRoleId('Admin'), 'admin');
  assert.equal(ensureRoleId('  SUPERADMIN  '), 'superadmin');
  assert.equal(ensureRoleId(null), '');
});

test('parsePermissionsInput accepts string and array', () => {
  assert.deepEqual(parsePermissionsInput('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parsePermissionsInput(['a', 'b']), ['a', 'b']);
  assert.deepEqual(parsePermissionsInput(undefined, ['default']), ['default']);
});

test('parsePermissionsInput trims duplicates and ignores empty values', () => {
  assert.deepEqual(parsePermissionsInput('[" search.read ","search.read","","   "]'), ['search.read']);
  assert.deepEqual(parsePermissionsInput([' alert.read ', null, 'alert.read']), ['alert.read']);
});

test('matchesScopedValue ignores empty patterns and does not treat regex metacharacters as special', () => {
  assert.equal(matchesScopedValue('prod.+(admin)', ['', '  ', 'prod.+(admin)']), true);
  assert.equal(matchesScopedValue('prodX(admin)', ['prod.+(admin)']), false);
});
