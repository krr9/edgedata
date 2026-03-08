import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_KEY,
  readSyntheticIngestEnabled,
  writeSyntheticIngestEnabled
} from '../src/runtime-control.mjs';

function createFakeDb(initialValue = null) {
  const state = { value: initialValue, writes: [] };
  return {
    state,
    prepare(sql) {
      const runQuery = async () => ({ success: true });
      return {
        async run() {
          return runQuery();
        },
        bind(...args) {
          return {
            async first() {
              if (/SELECT value FROM runtime_flags/i.test(sql)) {
                if (state.value === null || state.value === undefined) return null;
                return { value: state.value };
              }
              return null;
            },
            async run() {
              if (/INSERT INTO runtime_flags/i.test(sql)) {
                state.value = String(args[1]);
                state.writes.push({
                  key: String(args[0]),
                  value: String(args[1]),
                  updated_at: String(args[2])
                });
              }
              return { success: true };
            }
          };
        }
      };
    }
  };
}

test('readSyntheticIngestEnabled falls back to configured toggle without DB', async () => {
  assert.equal(await readSyntheticIngestEnabled(undefined, true), true);
  assert.equal(await readSyntheticIngestEnabled(undefined, false), false);
});

test('readSyntheticIngestEnabled uses persisted runtime flag when present', async () => {
  const dbOn = createFakeDb('true');
  const dbOff = createFakeDb('false');

  assert.equal(await readSyntheticIngestEnabled(dbOn, false), true);
  assert.equal(await readSyntheticIngestEnabled(dbOff, true), false);
});

test('writeSyntheticIngestEnabled persists string boolean to runtime_flags', async () => {
  const db = createFakeDb(null);
  const now = '2026-03-07T10:00:00.000Z';
  await writeSyntheticIngestEnabled(db, true, now);
  await writeSyntheticIngestEnabled(db, false, now);

  assert.equal(db.state.writes.length, 2);
  assert.deepEqual(db.state.writes[0], {
    key: CONTROL_KEY,
    value: 'true',
    updated_at: now
  });
  assert.deepEqual(db.state.writes[1], {
    key: CONTROL_KEY,
    value: 'false',
    updated_at: now
  });
});
