-- 009: Upgrade OTel showcase dashboard into richer command-center layout

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
VALUES (
  'seed-otel-demo-overview',
  'OTel Demo Command Center',
  'High-signal OpenTelemetry demo board with KPIs, service hotspots, and incident feed.',
  '[]',
  0,
  NULL,
  '2026-03-07T00:00:00.000Z',
  '2026-03-07T00:00:00.000Z'
);

UPDATE dashboards
SET
  name = 'OTel Demo Command Center',
  description = 'High-signal OpenTelemetry demo board with KPIs, service hotspots, and incident feed.',
  layout_json = '[{"i":"seed-panel-otel-story","x":0,"y":0,"w":12,"h":4},{"i":"seed-panel-otel-kpi-total","x":0,"y":4,"w":3,"h":5},{"i":"seed-panel-otel-kpi-errors","x":3,"y":4,"w":3,"h":5},{"i":"seed-panel-otel-kpi-slow","x":6,"y":4,"w":3,"h":5},{"i":"seed-panel-otel-kpi-checkout","x":9,"y":4,"w":3,"h":5},{"i":"seed-panel-otel-service-volume","x":0,"y":9,"w":6,"h":8},{"i":"seed-panel-otel-level-mix","x":6,"y":9,"w":6,"h":8},{"i":"seed-panel-otel-incident-feed","x":0,"y":17,"w":8,"h":10},{"i":"seed-panel-otel-host-hotspots","x":8,"y":17,"w":4,"h":10}]',
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-otel-demo-overview';

-- Remove older seed panels replaced by this command-center layout.
DELETE FROM dashboard_panels
WHERE id IN (
  'seed-panel-otel-errors',
  'seed-panel-otel-latency',
  'seed-panel-otel-trace-sampler'
);

INSERT OR IGNORE INTO dashboard_panels (
  id, dashboard_id, title, ppl, viz_type, widget_type, query_text, query_mode,
  viz_config_json, layout_json, bindings_json, display_options_json,
  time_window_minutes, refresh_seconds, options_json, position, created_at, updated_at
)
VALUES
  (
    'seed-panel-otel-story',
    'seed-otel-demo-overview',
    'Overview',
    '',
    'table',
    'markdown',
    '',
    'ppl',
    '{}',
    '{"x":0,"y":0,"w":12,"h":4,"minW":6,"minH":3}',
    '{}',
    '{"markdown":"## OpenTelemetry Demo Pulse\n\nSynthetic OTel-style traffic with realistic traces, spans, service fanout, and bursty errors."}',
    60,
    0,
    '{}',
    0,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-kpi-total',
    'seed-otel-demo-overview',
    'Events (window)',
    'search * | where index="otel-demo" | stats count() by index | head 1',
    'counter',
    'kpi',
    'search * | where index="otel-demo" | stats count() by index | head 1',
    'ppl',
    '{}',
    '{"x":0,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
    '{}',
    '{}',
    60,
    120,
    '{}',
    1,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-kpi-errors',
    'seed-otel-demo-overview',
    'Errors (window)',
    'search * | where index="otel-demo" and level="error" | stats count() by level | head 1',
    'counter',
    'kpi',
    'search * | where index="otel-demo" and level="error" | stats count() by level | head 1',
    'ppl',
    '{}',
    '{"x":3,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
    '{}',
    '{}',
    60,
    120,
    '{}',
    2,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-kpi-slow',
    'seed-otel-demo-overview',
    'Slow Requests (>=900ms)',
    'search * | where index="otel-demo" and duration_ms>=900 | stats count() by index | head 1',
    'counter',
    'kpi',
    'search * | where index="otel-demo" and duration_ms>=900 | stats count() by index | head 1',
    'ppl',
    '{}',
    '{"x":6,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
    '{}',
    '{}',
    60,
    120,
    '{}',
    3,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-kpi-checkout',
    'seed-otel-demo-overview',
    'Checkout 5xx',
    'search * | where index="otel-demo" and service="checkoutservice" and status>=500 | stats count() by service | head 1',
    'counter',
    'kpi',
    'search * | where index="otel-demo" and service="checkoutservice" and status>=500 | stats count() by service | head 1',
    'ppl',
    '{}',
    '{"x":9,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
    '{}',
    '{}',
    60,
    120,
    '{}',
    4,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-service-volume',
    'seed-otel-demo-overview',
    'Top Services by Volume',
    'search * | where index="otel-demo" | stats count() by service | sort -count | head 12',
    'bar',
    'bar',
    'search * | where index="otel-demo" | stats count() by service | sort -count | head 12',
    'ppl',
    '{}',
    '{"x":0,"y":9,"w":6,"h":8,"minW":3,"minH":4}',
    '{}',
    '{}',
    60,
    180,
    '{}',
    5,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-level-mix',
    'seed-otel-demo-overview',
    'Log Level Mix',
    'search * | where index="otel-demo" | stats count() by level | sort -count | head 6',
    'pie',
    'pie',
    'search * | where index="otel-demo" | stats count() by level | sort -count | head 6',
    'ppl',
    '{}',
    '{"x":6,"y":9,"w":6,"h":8,"minW":3,"minH":4}',
    '{}',
    '{}',
    60,
    180,
    '{}',
    6,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-incident-feed',
    'seed-otel-demo-overview',
    'Recent 5xx / Slow Incidents',
    'search * | where index="otel-demo" and status>=500 | fields ts, service, status, duration_ms, trace_id, span_id, message | sort -ts | head 80',
    'table',
    'table',
    'search * | where index="otel-demo" and status>=500 | fields ts, service, status, duration_ms, trace_id, span_id, message | sort -ts | head 80',
    'ppl',
    '{}',
    '{"x":0,"y":17,"w":8,"h":10,"minW":4,"minH":5}',
    '{}',
    '{}',
    60,
    120,
    '{}',
    7,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  ),
  (
    'seed-panel-otel-host-hotspots',
    'seed-otel-demo-overview',
    'Host Hotspots',
    'search * | where index="otel-demo" | stats count() by host | sort -count | head 12',
    'top',
    'topn',
    'search * | where index="otel-demo" | stats count() by host | sort -count | head 12',
    'ppl',
    '{}',
    '{"x":8,"y":17,"w":4,"h":10,"minW":3,"minH":5}',
    '{}',
    '{}',
    60,
    180,
    '{}',
    8,
    '2026-03-07T00:00:00.000Z',
    '2026-03-07T00:00:00.000Z'
  );

-- Ensure existing seeded widgets are updated to latest query/layout/widget types.
UPDATE dashboard_panels
SET
  title = 'Overview',
  viz_type = 'table',
  widget_type = 'markdown',
  query_text = '',
  query_mode = 'ppl',
  ppl = '',
  layout_json = '{"x":0,"y":0,"w":12,"h":4,"minW":6,"minH":3}',
  display_options_json = '{"markdown":"## OpenTelemetry Demo Pulse\n\nSynthetic OTel-style traffic with realistic traces, spans, service fanout, and bursty errors."}',
  time_window_minutes = 60,
  refresh_seconds = 0,
  position = 0,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-story';

UPDATE dashboard_panels
SET
  title = 'Events (window)',
  viz_type = 'counter',
  widget_type = 'kpi',
  query_text = 'search * | where index="otel-demo" | stats count() by index | head 1',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" | stats count() by index | head 1',
  layout_json = '{"x":0,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 120,
  position = 1,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-kpi-total';

UPDATE dashboard_panels
SET
  title = 'Errors (window)',
  viz_type = 'counter',
  widget_type = 'kpi',
  query_text = 'search * | where index="otel-demo" and level="error" | stats count() by level | head 1',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" and level="error" | stats count() by level | head 1',
  layout_json = '{"x":3,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 120,
  position = 2,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-kpi-errors';

UPDATE dashboard_panels
SET
  title = 'Slow Requests (>=900ms)',
  viz_type = 'counter',
  widget_type = 'kpi',
  query_text = 'search * | where index="otel-demo" and duration_ms>=900 | stats count() by index | head 1',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" and duration_ms>=900 | stats count() by index | head 1',
  layout_json = '{"x":6,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 120,
  position = 3,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-kpi-slow';

UPDATE dashboard_panels
SET
  title = 'Checkout 5xx',
  viz_type = 'counter',
  widget_type = 'kpi',
  query_text = 'search * | where index="otel-demo" and service="checkoutservice" and status>=500 | stats count() by service | head 1',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" and service="checkoutservice" and status>=500 | stats count() by service | head 1',
  layout_json = '{"x":9,"y":4,"w":3,"h":5,"minW":2,"minH":3}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 120,
  position = 4,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-kpi-checkout';

UPDATE dashboard_panels
SET
  title = 'Top Services by Volume',
  viz_type = 'bar',
  widget_type = 'bar',
  query_text = 'search * | where index="otel-demo" | stats count() by service | sort -count | head 12',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" | stats count() by service | sort -count | head 12',
  layout_json = '{"x":0,"y":9,"w":6,"h":8,"minW":3,"minH":4}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 180,
  position = 5,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-service-volume';

UPDATE dashboard_panels
SET
  title = 'Log Level Mix',
  viz_type = 'pie',
  widget_type = 'pie',
  query_text = 'search * | where index="otel-demo" | stats count() by level | sort -count | head 6',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" | stats count() by level | sort -count | head 6',
  layout_json = '{"x":6,"y":9,"w":6,"h":8,"minW":3,"minH":4}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 180,
  position = 6,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-level-mix';

UPDATE dashboard_panels
SET
  title = 'Recent 5xx / Slow Incidents',
  viz_type = 'table',
  widget_type = 'table',
  query_text = 'search * | where index="otel-demo" and status>=500 | fields ts, service, status, duration_ms, trace_id, span_id, message | sort -ts | head 80',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" and status>=500 | fields ts, service, status, duration_ms, trace_id, span_id, message | sort -ts | head 80',
  layout_json = '{"x":0,"y":17,"w":8,"h":10,"minW":4,"minH":5}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 120,
  position = 7,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-incident-feed';

UPDATE dashboard_panels
SET
  title = 'Host Hotspots',
  viz_type = 'top',
  widget_type = 'topn',
  query_text = 'search * | where index="otel-demo" | stats count() by host | sort -count | head 12',
  query_mode = 'ppl',
  ppl = 'search * | where index="otel-demo" | stats count() by host | sort -count | head 12',
  layout_json = '{"x":8,"y":17,"w":4,"h":10,"minW":3,"minH":5}',
  display_options_json = '{}',
  time_window_minutes = 60,
  refresh_seconds = 180,
  position = 8,
  updated_at = '2026-03-07T00:00:00.000Z'
WHERE id = 'seed-panel-otel-host-hotspots';
