-- 007: Dashboard widget model evolution (schema-backed widgets + layout)

ALTER TABLE dashboard_panels ADD COLUMN widget_type TEXT NOT NULL DEFAULT 'table';
ALTER TABLE dashboard_panels ADD COLUMN query_text TEXT NOT NULL DEFAULT '';
ALTER TABLE dashboard_panels ADD COLUMN query_mode TEXT NOT NULL DEFAULT 'ppl';
ALTER TABLE dashboard_panels ADD COLUMN viz_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dashboard_panels ADD COLUMN layout_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dashboard_panels ADD COLUMN bindings_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dashboard_panels ADD COLUMN display_options_json TEXT NOT NULL DEFAULT '{}';

-- Backfill query text from legacy ppl column.
UPDATE dashboard_panels
SET query_text = COALESCE(NULLIF(TRIM(query_text), ''), NULLIF(TRIM(ppl), ''), '')
WHERE query_text = '';

-- Backfill widget type from legacy viz_type semantics.
UPDATE dashboard_panels
SET widget_type = CASE LOWER(COALESCE(viz_type, 'table'))
  WHEN 'counter' THEN 'kpi'
  WHEN 'stat' THEN 'kpi'
  WHEN 'timechart' THEN 'timeseries'
  WHEN 'pie' THEN 'pie'
  WHEN 'bar' THEN 'bar'
  ELSE 'table'
END
WHERE widget_type = 'table';

-- Backfill a reasonable default grid layout from legacy panel order.
UPDATE dashboard_panels
SET layout_json = json_object(
  'x', ((COALESCE(position, 0) % 2) * 6),
  'y', (CAST(COALESCE(position, 0) / 2 AS INTEGER) * 8),
  'w', CASE
    WHEN LOWER(COALESCE(viz_type, 'table')) IN ('counter', 'stat') THEN 3
    ELSE 6
  END,
  'h', CASE
    WHEN LOWER(COALESCE(viz_type, 'table')) IN ('counter', 'stat') THEN 4
    ELSE 8
  END,
  'minW', 3,
  'minH', 4
)
WHERE layout_json = '{}';
