import test from 'node:test';
import assert from 'node:assert/strict';

import { listIngestParsers, parseIngestPayload } from '../src/ingest-framework.mjs';

test('listIngestParsers returns pluggable parser registry', () => {
  const parsers = listIngestParsers();
  const ids = parsers.map((parser) => parser.id);
  assert.deepEqual(ids, ['otlp_http_json_logs', 'edgedata_json', 'ndjson_lines']);
});

test('parseIngestPayload handles EdgeData JSON event arrays', () => {
  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'application/json',
    headers: {},
    rawBody: '[{"message":"hello"}]',
    parsedBody: [{ message: 'hello' }]
  });

  assert.equal(result.parser, 'edgedata_json');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].message, 'hello');
});

test('parseIngestPayload handles OpenTelemetry OTLP HTTP JSON logs', () => {
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'checkout-api' } },
            { key: 'deployment.environment', value: { stringValue: 'prod' } },
            { key: 'host.name', value: { stringValue: 'checkout-01' } }
          ]
        },
        scopeLogs: [
          {
            scope: { name: 'otel.logger', version: '1.0.0' },
            logRecords: [
              {
                timeUnixNano: '1735689600000000000',
                severityText: 'ERROR',
                severityNumber: 17,
                traceId: 'abc123',
                spanId: 'def456',
                body: { stringValue: 'payment failed' },
                attributes: [
                  { key: 'http.status_code', value: { intValue: '502' } },
                  { key: 'enduser.id', value: { stringValue: 'user-42' } },
                  { key: 'client.address', value: { stringValue: '203.0.113.5' } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const result = parseIngestPayload({
    path: '/v1/logs',
    contentType: 'application/json',
    headers: {},
    rawBody: JSON.stringify(payload),
    parsedBody: payload
  });

  assert.equal(result.parser, 'otlp_http_json_logs');
  assert.equal(result.events.length, 1);
  assert.equal(result.defaults?.service, 'checkout-api');
  assert.equal(result.defaults?.env, 'prod');
  assert.equal(result.defaults?.host, 'checkout-01');
  assert.equal(result.events[0].message, 'payment failed');
  assert.equal(result.events[0].status, 502);
  assert.equal(result.events[0].user_id, 'user-42');
  assert.equal(result.events[0].src_ip, '203.0.113.5');
  assert.equal(result.events[0].level, 'error');
});

test('parseIngestPayload handles NDJSON lines', () => {
  const rawBody = [
    '{"message":"line1","service":"demo"}',
    '{"message":"line2","service":"demo"}',
    'not-json-line'
  ].join('\n');

  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'application/x-ndjson',
    headers: {},
    rawBody
  });

  assert.equal(result.parser, 'ndjson_lines');
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].message, 'line1');
  assert.equal(result.events[1].message, 'line2');
});

test('parseIngestPayload returns unknown parser for unsupported payloads', () => {
  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'text/plain',
    headers: {},
    rawBody: 'hello world'
  });

  assert.equal(result.parser, 'unknown');
  assert.equal(result.events.length, 0);
});
