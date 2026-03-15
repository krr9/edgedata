import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rbacSource = readFileSync(new URL('../src/rbac.ts', import.meta.url), 'utf8');

test('rbac role seed insert keeps placeholder count aligned with bound values', () => {
  assert.match(
    rbacSource,
    /VALUES \(\?, \?, 1, 1, \?, \?, \?, \?\)/
  );
  assert.doesNotMatch(
    rbacSource,
    /VALUES \(\?, \?, \?, 1, \?, \?, \?, \?\)/
  );
});
