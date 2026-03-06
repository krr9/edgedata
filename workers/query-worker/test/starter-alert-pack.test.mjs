import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStarterAlertPackDefinitions,
  extractStarterIdFromParamsJson
} from '../src/starter-alert-pack.mjs';

test('buildStarterAlertPackDefinitions returns versioned starter templates', () => {
  const defs = buildStarterAlertPackDefinitions({
    index: 'security',
    service: 'payments',
    env: 'prod',
    deep_link_base: 'https://ops.example.com',
    runbook_base_url: 'https://runbooks.example.com',
    owner_team: 'platform'
  });

  assert.equal(defs.length >= 3, true);
  for (const def of defs) {
    const params = JSON.parse(def.params_json);
    const notify = JSON.parse(def.notify_json);

    assert.equal(typeof params._starter_id, 'string');
    assert.equal(typeof params._starter_version, 'string');
    assert.equal(params.service, 'payments');
    assert.equal(params.env, 'prod');
    assert.equal(params.index, 'security');
    assert.equal(notify.owner_team, 'platform');
    assert.equal(notify.deep_link.startsWith('https://ops.example.com/'), true);
    assert.equal(notify.runbook_url.startsWith('https://runbooks.example.com/'), true);
  }
});

test('extractStarterIdFromParamsJson handles invalid input safely', () => {
  assert.equal(extractStarterIdFromParamsJson('not-json'), null);
  assert.equal(extractStarterIdFromParamsJson('{}'), null);
  assert.equal(
    extractStarterIdFromParamsJson('{"_starter_id":"latency-p95-regression"}'),
    'latency-p95-regression'
  );
});
