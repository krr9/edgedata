import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSyntheticEvents, parseBatchSize, parseBoolean, parseProfile } from '../src/synthetic-core.mjs';

test('parseBoolean supports common truthy values', () => {
  assert.equal(parseBoolean('true', false), true);
  assert.equal(parseBoolean('1', false), true);
  assert.equal(parseBoolean('yes', false), true);
  assert.equal(parseBoolean('on', false), true);
  assert.equal(parseBoolean('false', true), false);
});

test('parseBatchSize clamps and falls back safely', () => {
  assert.equal(parseBatchSize('10', 24, 120), 10);
  assert.equal(parseBatchSize('0', 24, 120), 24);
  assert.equal(parseBatchSize('999', 24, 120), 120);
  assert.equal(parseBatchSize('bad', 24, 120), 24);
});

test('parseProfile accepts basic and realistic values', () => {
  assert.equal(parseProfile('basic', 'realistic'), 'basic');
  assert.equal(parseProfile('REALISTIC', 'basic'), 'realistic');
  assert.equal(parseProfile('unknown', 'basic'), 'basic');
});

test('buildSyntheticEvents builds bounded normalized payloads', () => {
  const events = buildSyntheticEvents({
    now_ms: Date.UTC(2026, 1, 25, 22, 0, 0),
    batch_size: 12,
    index: 'security',
    service: 'svc-a',
    env: 'demo',
    host_prefix: 'host-x',
    region: 'us'
  });

  assert.equal(events.length, 12);
  for (const event of events) {
    assert.equal(event.index, 'security');
    assert.equal(event.service, 'svc-a');
    assert.equal(event.env, 'demo');
    assert.equal(event.host.startsWith('host-x-'), true);
    assert.equal(typeof event.message, 'string');
    assert.equal(typeof event.duration_ms, 'number');
    assert.equal(typeof event.status, 'number');
    assert.equal(event.attrs.synthetic, true);
    assert.equal(event.attrs.source, 'synthetic-worker');
    assert.equal(typeof event.ts, 'string');
  }
});

test('realistic profile increases event diversity', () => {
  const events = buildSyntheticEvents({
    now_ms: Date.UTC(2026, 1, 25, 22, 0, 0),
    batch_size: 30,
    profile: 'realistic',
    index: 'default',
    service: 'svc-a',
    env: 'demo',
    host_prefix: 'host-x',
    region: 'us'
  });

  const services = new Set(events.map((event) => event.service));
  const envs = new Set(events.map((event) => event.env));
  const levels = new Set(events.map((event) => event.level));
  const routes = new Set(events.map((event) => event.attrs.route));
  const statuses = new Set(events.map((event) => event.status));
  const components = new Set(events.map((event) => event.attrs.component));

  assert.equal(events.length, 30);
  assert.equal(services.size >= 3, true);
  assert.equal(envs.size >= 2, true);
  assert.equal(levels.size >= 3, true);
  assert.equal(routes.size >= 8, true);
  assert.equal(statuses.size >= 6, true);
  assert.equal(components.size >= 4, true);
});
