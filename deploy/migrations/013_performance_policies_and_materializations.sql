-- 013: Performance policies, materialization metadata, and reusable result storage

ALTER TABLE dashboards ADD COLUMN performance_profile TEXT NOT NULL DEFAULT 'economy';
ALTER TABLE dashboards ADD COLUMN default_execution_mode TEXT NOT NULL DEFAULT 'live';

ALTER TABLE dashboard_panels ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'live';
ALTER TABLE dashboard_panels ADD COLUMN cache_ttl_seconds INTEGER NOT NULL DEFAULT 120;
ALTER TABLE dashboard_panels ADD COLUMN materialize_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dashboard_panels ADD COLUMN materialize_interval_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE dashboard_panels ADD COLUMN max_staleness_seconds INTEGER NOT NULL DEFAULT 600;
ALTER TABLE dashboard_panels ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dashboard_panels ADD COLUMN last_materialized_at TEXT;
ALTER TABLE dashboard_panels ADD COLUMN last_materialization_status TEXT;
ALTER TABLE dashboard_panels ADD COLUMN last_materialization_error TEXT;

ALTER TABLE scheduled_searches ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'live';
ALTER TABLE scheduled_searches ADD COLUMN cache_ttl_seconds INTEGER NOT NULL DEFAULT 120;
ALTER TABLE scheduled_searches ADD COLUMN materialize_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_searches ADD COLUMN materialize_interval_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE scheduled_searches ADD COLUMN max_staleness_seconds INTEGER NOT NULL DEFAULT 600;
ALTER TABLE scheduled_searches ADD COLUMN last_materialized_at TEXT;
ALTER TABLE scheduled_searches ADD COLUMN last_materialization_status TEXT;
ALTER TABLE scheduled_searches ADD COLUMN last_materialization_error TEXT;

CREATE TABLE IF NOT EXISTS materialized_results (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  time_bucket_start TEXT NOT NULL,
  time_bucket_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  result_count INTEGER NOT NULL DEFAULT 0,
  payload_r2_key TEXT,
  payload_inline_json TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  computed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_materialized_lookup
  ON materialized_results(entity_type, entity_id, scope_key, query_hash, time_bucket_end DESC);

CREATE TABLE IF NOT EXISTS materialization_runs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result_count INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_materialization_runs_entity
  ON materialization_runs(entity_type, entity_id, started_at DESC);
