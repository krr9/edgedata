import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queryWranglerToml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

test('production query worker binds synthetic admin controls to synthetic-worker-prod', () => {
  assert.match(
    queryWranglerToml,
    /\[\[env\.production\.services\]\][\s\S]*?binding = "SYNTHETIC_SERVICE"[\s\S]*?service = "synthetic-worker-prod"/
  );
});
