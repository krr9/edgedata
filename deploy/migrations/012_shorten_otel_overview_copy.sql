-- 012: Shorten verbose markdown copy in OTel overview panel

UPDATE dashboard_panels
SET
  display_options_json = '{"markdown":"## OpenTelemetry Demo Pulse\n\nSynthetic OTel-style traffic with realistic traces, spans, service fanout, and bursty errors."}',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'seed-panel-otel-story';
