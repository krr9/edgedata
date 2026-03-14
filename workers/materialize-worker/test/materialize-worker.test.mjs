import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMaterializationBucket,
  buildScopeKey,
  hashQueryText
} from '../../shared/materialization-core.mjs';
import { authorizeManualRun } from '../src/index.ts';

test('buildMaterializationBucket canonicalizes to cadence windows', () => {
  const bucket = buildMaterializationBucket(
    {
      from: '2026-03-11T20:02:31.000Z',
      to: '2026-03-11T21:02:31.000Z'
    },
    300
  );

  assert.equal(bucket.time_bucket_end, '2026-03-11T21:00:00.000Z');
  assert.equal(bucket.time_bucket_start, '2026-03-11T20:00:00.000Z');
  assert.equal(bucket.expires_at, '2026-03-11T21:05:00.000Z');
});

test('buildScopeKey and hashQueryText are stable', () => {
  const scope = buildScopeKey({ indexes: ['*'], services: ['auth', 'api'], envs: ['prod'], hosts: ['*'] });
  assert.equal(scope, 'i:*|s:api,auth|e:prod|h:*');
  assert.equal(hashQueryText(' search   level=error '), hashQueryText('search level=error'));
});

test('authorizeManualRun rejects missing or malformed bearer auth', async () => {
  const env = { MATERIALIZE_RUN_SECRET: 'top-secret' };
  assert.equal(await authorizeManualRun(new Request('https://example.com/run'), env), false);
  assert.equal(
    await authorizeManualRun(new Request('https://example.com/run', { headers: { authorization: 'Basic abc' } }), env),
    false
  );
  assert.equal(
    await authorizeManualRun(new Request('https://example.com/run', { headers: { authorization: 'Bearer ' } }), env),
    false
  );
});

test('authorizeManualRun uses timing-safe token compare semantics', async () => {
  const env = { MATERIALIZE_RUN_SECRET: 'top-secret' };
  assert.equal(
    await authorizeManualRun(
      new Request('https://example.com/run', { headers: { authorization: 'Bearer top-secret' } }),
      env
    ),
    true
  );
  assert.equal(
    await authorizeManualRun(
      new Request('https://example.com/run', { headers: { authorization: 'Bearer top-secret ' } }),
      env
    ),
    true
  );
  assert.equal(
    await authorizeManualRun(
      new Request('https://example.com/run', { headers: { authorization: 'Bearer top-secret-nope' } }),
      env
    ),
    false
  );
});
