-- 006: Operational Workflows (scheduled searches, dashboards, lookup tables)

CREATE TABLE IF NOT EXISTS scheduled_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ppl TEXT NOT NULL,
  time_window_minutes INTEGER NOT NULL DEFAULT 60,
  schedule_cron TEXT NOT NULL DEFAULT '0 * * * *',
  enabled INTEGER NOT NULL DEFAULT 1,
  actions_json TEXT NOT NULL DEFAULT '[]',
  max_results INTEGER NOT NULL DEFAULT 500,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_search_results (
  id TEXT PRIMARY KEY,
  scheduled_search_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  time_from TEXT NOT NULL,
  time_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  result_count INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  stats_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sched_results_search_run
  ON scheduled_search_results(scheduled_search_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_searches_enabled
  ON scheduled_searches(enabled);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  layout_json TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS dashboard_panels (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ppl TEXT NOT NULL,
  viz_type TEXT NOT NULL DEFAULT 'table',
  time_window_minutes INTEGER NOT NULL DEFAULT 60,
  refresh_seconds INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_panels_dashboard
  ON dashboard_panels(dashboard_id, position);
CREATE INDEX IF NOT EXISTS idx_dashboards_default
  ON dashboards(is_default);

CREATE TABLE IF NOT EXISTS lookup_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  key_field TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS lookup_rows (
  lookup_id TEXT NOT NULL,
  key_value TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (lookup_id, key_value)
);

CREATE INDEX IF NOT EXISTS idx_lookup_tables_name
  ON lookup_tables(name);
