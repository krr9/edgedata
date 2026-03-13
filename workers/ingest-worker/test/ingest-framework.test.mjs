import test from 'node:test';
import assert from 'node:assert/strict';

import { listIngestParsers, parseIngestPayload, normalizeLogpushRecord } from '../src/ingest-framework.mjs';

test('listIngestParsers returns pluggable parser registry', () => {
  const parsers = listIngestParsers();
  const ids = parsers.map((parser) => parser.id);
  assert.deepEqual(ids, ['otlp_http_json_logs', 'otlp_http_json_traces', 'cloudflare_logpush', 'edgedata_json', 'ndjson_lines']);
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

test('parseIngestPayload handles OpenTelemetry OTLP HTTP JSON traces', () => {
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'checkout-api' } },
            { key: 'deployment.environment', value: { stringValue: 'prod' } },
            { key: 'host.name', value: { stringValue: 'checkout-01' } },
            { key: 'edgedata.index', value: { stringValue: 'otel-traces' } }
          ]
        },
        scopeSpans: [
          {
            scope: { name: 'otel.tracer', version: '1.2.3' },
            spans: [
              {
                traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                spanId: '00f067aa0ba902b7',
                parentSpanId: '1111111111111111',
                name: 'POST /checkout',
                kind: 3,
                startTimeUnixNano: '1735689600000000000',
                endTimeUnixNano: '1735689600350000000',
                status: { code: 2, message: 'upstream timeout' },
                attributes: [
                  { key: 'http.request.method', value: { stringValue: 'POST' } },
                  { key: 'http.route', value: { stringValue: '/checkout' } },
                  { key: 'http.response.status_code', value: { intValue: '504' } },
                  { key: 'enduser.id', value: { stringValue: 'user-99' } },
                  { key: 'client.address', value: { stringValue: '203.0.113.8' } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const result = parseIngestPayload({
    path: '/v1/traces',
    contentType: 'application/json',
    headers: {},
    rawBody: JSON.stringify(payload),
    parsedBody: payload
  });

  assert.equal(result.parser, 'otlp_http_json_traces');
  assert.equal(result.events.length, 1);
  assert.equal(result.defaults?.service, 'checkout-api');
  assert.equal(result.defaults?.env, 'prod');
  assert.equal(result.defaults?.host, 'checkout-01');
  assert.equal(result.defaults?.index, 'otel-traces');
  assert.equal(result.events[0].message, 'POST /checkout');
  assert.equal(result.events[0].service, 'checkout-api');
  assert.equal(result.events[0].trace_id, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(result.events[0].span_id, '00f067aa0ba902b7');
  assert.equal(result.events[0].parent_span_id, '1111111111111111');
  assert.equal(result.events[0].request_id, '00f067aa0ba902b7');
  assert.equal(result.events[0].status, 504);
  assert.equal(result.events[0].duration_ms, 350);
  assert.equal(result.events[0].user_id, 'user-99');
  assert.equal(result.events[0].src_ip, '203.0.113.8');
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

// ---------------------------------------------------------------------------
// Cloudflare Logpush: HTTP Requests
// ---------------------------------------------------------------------------

test('parseIngestPayload detects Cloudflare Logpush HTTP Request events', () => {
  const records = [
    {
      ClientIP: '203.0.113.5',
      ClientRequestHost: 'api.example.com',
      ClientRequestMethod: 'POST',
      ClientRequestURI: '/v1/checkout',
      ClientRequestUserAgent: 'Mozilla/5.0',
      EdgeStartTimestamp: '2026-03-12T14:30:00Z',
      EdgeEndTimestamp: '2026-03-12T14:30:00.050Z',
      EdgeResponseStatus: 502,
      OriginResponseTime: 45000000,
      RayID: 'abc123def456',
      CacheCacheStatus: 'dynamic',
      SecurityLevel: 'med'
    },
    {
      ClientIP: '198.51.100.10',
      ClientRequestHost: 'api.example.com',
      ClientRequestMethod: 'GET',
      ClientRequestURI: '/healthz',
      EdgeStartTimestamp: '2026-03-12T14:30:01Z',
      EdgeResponseStatus: 200,
      OriginResponseTime: 2000000,
      RayID: 'xyz789abc012'
    }
  ];

  const rawBody = records.map((r) => JSON.stringify(r)).join('\n');
  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'application/x-ndjson',
    headers: {},
    rawBody
  });

  assert.equal(result.parser, 'cloudflare_logpush');
  assert.equal(result.events.length, 2);

  const first = result.events[0];
  assert.equal(first.index, 'cf-http-requests');
  assert.equal(first.service, 'api.example.com');
  assert.equal(first.host, 'api.example.com');
  assert.equal(first.level, 'error');
  assert.equal(first.status, 502);
  assert.equal(first.request_id, 'abc123def456');
  assert.equal(first.src_ip, '203.0.113.5');
  assert.ok(first.message.includes('POST'));
  assert.ok(first.message.includes('/v1/checkout'));
  assert.ok(first.message.includes('502'));
  assert.equal(first.duration_ms, 45);
  assert.ok(first.ts.startsWith('2026-03-12T14:30:00'));
  assert.ok(first.attrs.ClientRequestUserAgent);
  assert.ok(first.attrs.CacheCacheStatus);

  const second = result.events[1];
  assert.equal(second.level, 'info');
  assert.equal(second.status, 200);
  assert.equal(second.duration_ms, 2);
});

test('normalizeLogpushRecord handles HTTP Request with nanosecond timestamp', () => {
  const record = {
    ClientIP: '10.0.0.1',
    ClientRequestHost: 'cdn.example.com',
    ClientRequestMethod: 'GET',
    ClientRequestURI: '/assets/logo.png',
    EdgeStartTimestamp: '1741789800000000000',
    EdgeResponseStatus: 200,
    OriginResponseTime: 500000,
    RayID: 'nanos-test-ray'
  };

  const events = normalizeLogpushRecord(record);
  assert.ok(events);
  assert.equal(events.length, 1);
  assert.equal(events[0].index, 'cf-http-requests');
  assert.ok(events[0].ts);
  assert.equal(events[0].duration_ms, 0.5);
});

// ---------------------------------------------------------------------------
// Cloudflare Logpush: Firewall Events
// ---------------------------------------------------------------------------

test('parseIngestPayload detects Cloudflare Logpush Firewall events', () => {
  const records = [
    {
      Action: 'block',
      ClientIP: '192.0.2.99',
      ClientRequestHost: 'app.example.com',
      ClientRequestMethod: 'POST',
      ClientRequestURI: '/admin/login',
      Datetime: '2026-03-12T15:00:00Z',
      RayID: 'fw-ray-001',
      RuleId: 'waf-rule-xss-01',
      Source: 'waf',
      ClientCountry: 'CN',
      ClientASN: 12345
    },
    {
      Action: 'challenge',
      ClientIP: '198.51.100.42',
      ClientRequestHost: 'app.example.com',
      ClientRequestMethod: 'GET',
      ClientRequestURI: '/api/data',
      Datetime: '2026-03-12T15:00:01Z',
      RayID: 'fw-ray-002',
      RuleId: 'rate-limit-01',
      Source: 'rateLimit'
    }
  ];

  const rawBody = records.map((r) => JSON.stringify(r)).join('\n');
  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'application/x-ndjson',
    headers: {},
    rawBody
  });

  assert.equal(result.parser, 'cloudflare_logpush');
  assert.equal(result.events.length, 2);

  const blocked = result.events[0];
  assert.equal(blocked.index, 'cf-firewall-events');
  assert.equal(blocked.level, 'error');
  assert.equal(blocked.request_id, 'fw-ray-001');
  assert.equal(blocked.src_ip, '192.0.2.99');
  assert.ok(blocked.message.includes('block'));
  assert.ok(blocked.message.includes('/admin/login'));
  assert.ok(blocked.message.includes('waf-rule-xss-01'));
  assert.ok(blocked.attrs.ClientCountry);

  const challenged = result.events[1];
  assert.equal(challenged.level, 'warn');
  assert.ok(challenged.message.includes('challenge'));
});

// ---------------------------------------------------------------------------
// Cloudflare Logpush: Workers Trace Events
// ---------------------------------------------------------------------------

test('parseIngestPayload detects Workers Trace Events and expands Logs/Exceptions', () => {
  const record = {
    ScriptName: 'api-gateway',
    Outcome: 'exception',
    EventTimestampMs: 1741789800000,
    EventType: 'fetch',
    DispatchNamespace: 'prod-ns',
    Event: {
      RayID: 'wt-ray-001',
      Request: {
        Method: 'POST',
        URL: 'https://api.example.com/submit'
      },
      Response: {
        Status: 500
      }
    },
    Logs: [
      { TimestampMs: 1741789800010, Level: 'log', Message: ['processing request', 'user-42'] },
      { TimestampMs: 1741789800020, Level: 'error', Message: ['db connection failed'] }
    ],
    Exceptions: [
      { TimestampMs: 1741789800030, Name: 'TypeError', Message: 'Cannot read property x of undefined' }
    ]
  };

  const rawBody = JSON.stringify(record);
  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'application/x-ndjson',
    headers: {},
    rawBody
  });

  assert.equal(result.parser, 'cloudflare_logpush');
  assert.equal(result.events.length, 4);

  const root = result.events[0];
  assert.equal(root.index, 'cf-workers-trace');
  assert.equal(root.service, 'api-gateway');
  assert.equal(root.host, 'prod-ns');
  assert.equal(root.level, 'error');
  assert.equal(root.status, 500);
  assert.equal(root.request_id, 'wt-ray-001');
  assert.ok(root.message.includes('exception'));
  assert.ok(root.message.includes('api-gateway'));

  const logEntry = result.events[1];
  assert.equal(logEntry.service, 'api-gateway');
  assert.equal(logEntry.level, 'info');
  assert.ok(logEntry.message.includes('processing request'));

  const errorLog = result.events[2];
  assert.equal(errorLog.level, 'error');
  assert.ok(errorLog.message.includes('db connection failed'));

  const exception = result.events[3];
  assert.equal(exception.level, 'error');
  assert.ok(exception.message.includes('TypeError'));
  assert.ok(exception.message.includes('Cannot read property x of undefined'));
});

test('normalizeLogpushRecord returns null for non-Logpush records', () => {
  assert.equal(normalizeLogpushRecord({ message: 'hello', service: 'test' }), null);
  assert.equal(normalizeLogpushRecord({}), null);
  assert.equal(normalizeLogpushRecord(null), null);
});

test('Logpush parser does not interfere with EdgeData JSON payloads', () => {
  const result = parseIngestPayload({
    path: '/ingest',
    contentType: 'application/json',
    headers: {},
    rawBody: '[{"message":"hello","service":"test"}]',
    parsedBody: [{ message: 'hello', service: 'test' }]
  });

  assert.equal(result.parser, 'edgedata_json');
});

test('Logpush parser does not interfere with OTLP payloads', () => {
  const payload = { resourceLogs: [{ resource: {}, scopeLogs: [] }] };
  const result = parseIngestPayload({
    path: '/v1/logs',
    contentType: 'application/json',
    headers: {},
    rawBody: JSON.stringify(payload),
    parsedBody: payload
  });

  assert.equal(result.parser, 'otlp_http_json_logs');
});
