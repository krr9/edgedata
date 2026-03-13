import test from 'node:test';
import assert from 'node:assert/strict';

import { mergePermissionsWithDefaults } from '../src/rbac-core.mjs';

test('mergePermissionsWithDefaults appends missing defaults without dropping custom permissions', () => {
  const merged = mergePermissionsWithDefaults(
    ['search.read', 'dashboard.read', 'custom.permission'],
    ['search.read', 'dashboard.read', 'scheduled_search.read']
  );

  assert.deepEqual(merged, [
    'search.read',
    'dashboard.read',
    'custom.permission',
    'scheduled_search.read'
  ]);
});

test('mergePermissionsWithDefaults de-duplicates empty and repeated permission keys', () => {
  const merged = mergePermissionsWithDefaults(
    ['search.read', '', 'scheduled_search.read', 'scheduled_search.read'],
    ['search.read', 'lookup.read']
  );

  assert.deepEqual(merged, ['search.read', 'scheduled_search.read', 'lookup.read']);
});
