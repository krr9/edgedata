import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSyntheticEvents,
  computeSyntheticBatchSize,
  parseBatchSize,
  parseBoolean,
  parseProfile
} from '../src/synthetic-core.mjs';

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

test('parseProfile accepts basic, realistic, mixed and otel aliases', () => {
  assert.equal(parseProfile('basic', 'realistic'), 'basic');
  assert.equal(parseProfile('REALISTIC', 'basic'), 'realistic');
  assert.equal(parseProfile('mixed', 'basic'), 'mixed');
  assert.equal(parseProfile('otel', 'basic'), 'otel-demo');
  assert.equal(parseProfile('OTEL-DEMO', 'basic'), 'otel-demo');
  assert.equal(parseProfile('unknown', 'basic'), 'basic');
});

test('computeSyntheticBatchSize yields bounded but varying load', () => {
  const early = computeSyntheticBatchSize({
    now_ms: Date.UTC(2026, 2, 7, 10, 0, 0),
    batch_size: 40,
    batch_min: 20,
    batch_max: 90,
    profile: 'otel-demo',
    index: 'otel-demo',
    service: 'frontend'
  });
  const later = computeSyntheticBatchSize({
    now_ms: Date.UTC(2026, 2, 7, 12, 30, 0),
    batch_size: 40,
    batch_min: 20,
    batch_max: 90,
    profile: 'otel-demo',
    index: 'otel-demo',
    service: 'frontend'
  });

  assert.equal(early >= 20 && early <= 90, true);
  assert.equal(later >= 20 && later <= 90, true);
  assert.notEqual(early, later);
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

test('otel-demo profile emits OpenTelemetry-like log metadata', () => {
  const events = buildSyntheticEvents({
    now_ms: Date.UTC(2026, 2, 7, 22, 0, 0),
    batch_size: 32,
    batch_min: 32,
    batch_max: 32,
    profile: 'otel-demo',
    index: 'otel-demo',
    service: 'frontend',
    env: 'demo',
    host_prefix: 'otel-node',
    region: 'us'
  });

  const services = new Set(events.map((event) => event.service));
  const methods = new Set(events.map((event) => event.attrs['otel.http.method']));
  const spanKinds = new Set(events.map((event) => event.attrs['otel.span.kind']));

  assert.equal(events.length, 32);
  assert.equal(services.size >= 5, true);
  assert.equal(methods.has('GET'), true);
  assert.equal(spanKinds.size >= 2, true);

  for (const event of events) {
    assert.equal(event.index, 'otel-demo');
    assert.equal(event.attrs.synthetic_profile, 'otel-demo');
    assert.equal(event.attrs.dataset, 'opentelemetry-demo');
    assert.equal(event.attrs['otel.service.name'], event.service);
    assert.equal(typeof event.attrs['otel.http.route'], 'string');
    assert.equal(typeof event.attrs['otel.http.status_code'], 'number');
    assert.equal(typeof event.span_id, 'string');
    assert.equal(event.trace_id.length, 32);
    assert.equal(event.span_id.length, 16);
  }
});

test('buildSyntheticEvents uses non-uniform timestamp distribution', () => {
  const now = Date.UTC(2026, 2, 7, 22, 0, 0);
  const events = buildSyntheticEvents({
    now_ms: now,
    batch_size: 60,
    batch_min: 60,
    batch_max: 60,
    profile: 'otel-demo',
    index: 'otel-demo',
    service: 'frontend',
    env: 'demo',
    host_prefix: 'otel-node',
    region: 'us'
  });

  const countsByMinute = new Map();
  for (const event of events) {
    const minute = event.ts.slice(0, 16);
    countsByMinute.set(minute, (countsByMinute.get(minute) || 0) + 1);
  }

  const values = Array.from(countsByMinute.values());
  const uniqueCounts = new Set(values);
  assert.equal(countsByMinute.size >= 3, true);
  assert.equal(uniqueCounts.size >= 2, true);
});

test('mixed profile rotates runtime profile families over time', () => {
  const observed = new Set();
  const base = Date.UTC(2026, 2, 8, 0, 0, 0);
  for (let i = 0; i < 24; i++) {
    const events = buildSyntheticEvents({
      now_ms: base + (i * 5 * 60 * 1000),
      batch_size: 6,
      batch_min: 6,
      batch_max: 6,
      profile: 'mixed',
      index: 'otel-demo',
      service: 'frontend',
      env: 'demo',
      host_prefix: 'otel-node',
      region: 'us'
    });
    observed.add(events[0].attrs.synthetic_profile);
    assert.equal(events[0].attrs.synthetic_profile_requested, 'mixed');
  }

  assert.equal(observed.has('otel-demo'), true);
  assert.equal(observed.has('realistic'), true);
  assert.equal(observed.has('basic'), true);
});
