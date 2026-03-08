-- 008: Seed OpenTelemetry demo saved/scheduled searches for showcase workflows

INSERT OR IGNORE INTO saved_searches (id, name, query, created_by, created_at, updated_at)
VALUES
  (
    'seed-otel-errors-by-service',
    'OTel Demo: Error Volume by Service',
    'search * | where index="otel-demo" and level="error" | stats count() by service | sort -count | head 20',
    NULL,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-otel-high-latency',
    'OTel Demo: Slowest Routes',
    'search * | where index="otel-demo" and duration_ms>=800 | fields ts, service, status, duration_ms, trace_id, message | sort -duration_ms | head 50',
    NULL,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-otel-checkout-failures',
    'OTel Demo: Checkout Failures',
    'search * | where index="otel-demo" and service="checkoutservice" and status>=500 | fields ts, service, status, trace_id, span_id, message | sort -ts | head 100',
    NULL,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  );

INSERT OR IGNORE INTO scheduled_searches (
  id,
  name,
  ppl,
  time_window_minutes,
  schedule_cron,
  enabled,
  actions_json,
  max_results,
  created_by,
  created_at,
  updated_at
)
VALUES
  (
    'seed-sched-otel-error-rollup',
    'OTel Demo: 15m Error Rollup',
    'search * | where index="otel-demo" and level="error" | stats count() by service | sort -count | head 25',
    30,
    '*/30 * * * *',
    1,
    '[{"type":"summary","retain_days":21}]',
    250,
    NULL,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-sched-otel-latency-watch',
    'OTel Demo: 30m Latency Watch',
    'search * | where index="otel-demo" and duration_ms>=900 | fields ts, service, duration_ms, status, trace_id, message | sort -duration_ms | head 100',
    60,
    '0 * * * *',
    1,
    '[{"type":"summary","retain_days":21}]',
    300,
    NULL,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  );

INSERT OR IGNORE INTO dashboards (
  id,
  name,
  description,
  layout_json,
  is_default,
  created_by,
  created_at,
  updated_at
)
VALUES
  (
    'seed-otel-demo-overview',
    'OTel Demo Overview',
    'Showcase dashboard for OpenTelemetry-style synthetic workload.',
    '[{"i":"seed-panel-otel-errors","x":0,"y":0,"w":6,"h":8},{"i":"seed-panel-otel-latency","x":6,"y":0,"w":6,"h":8},{"i":"seed-panel-otel-trace-sampler","x":0,"y":8,"w":12,"h":10}]',
    0,
    NULL,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  );

INSERT OR IGNORE INTO dashboard_panels (
  id,
  dashboard_id,
  title,
  ppl,
  viz_type,
  time_window_minutes,
  refresh_seconds,
  options_json,
  position,
  created_at,
  updated_at
)
VALUES
  (
    'seed-panel-otel-errors',
    'seed-otel-demo-overview',
    'Errors by Service (Last 30m)',
    'search * | where index="otel-demo" and level="error" | stats count() by service | sort -count | head 15',
    'table',
    30,
    60,
    '{}',
    0,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-latency',
    'seed-otel-demo-overview',
    'Top Latency Outliers (Last 30m)',
    'search * | where index="otel-demo" and duration_ms>=900 | fields ts, service, duration_ms, status, trace_id, span_id | sort -duration_ms | head 25',
    'table',
    30,
    60,
    '{}',
    1,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-trace-sampler',
    'seed-otel-demo-overview',
    'Recent Failing Trace Samples',
    'search * | where index="otel-demo" and status>=500 | fields ts, service, status, trace_id, span_id, message | sort -ts | head 50',
    'table',
    30,
    60,
    '{}',
    2,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  );
