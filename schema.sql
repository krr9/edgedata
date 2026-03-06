-- EdgeData D1 Schema

-- Saved searches for user queries
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Alert definitions
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  type TEXT NOT NULL,
  query_template TEXT NOT NULL,
  params_json TEXT DEFAULT '{}',
  schedule_seconds INTEGER DEFAULT 60,
  threshold_json TEXT NOT NULL,
  notify_json TEXT DEFAULT '{}',
  cooldown_seconds INTEGER DEFAULT 300,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Alert state for tracking firing/resolved
CREATE TABLE IF NOT EXISTS alert_state (
  alert_id TEXT PRIMARY KEY,
  last_evaluated_at TEXT NOT NULL,
  last_fired_at TEXT,
  is_firing INTEGER DEFAULT 0,
  last_value_json TEXT DEFAULT '{}',
  fingerprint TEXT
);

-- User preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  preferences_json TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- Local users for traditional email/password auth
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_login_at TEXT
);

-- Fixed-window request counters for basic abuse prevention
CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, limit_key, window_start_ms)
);

-- RBAC role catalog and assignments
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  system_role INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  permissions_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS access_group_role_mappings (
  id TEXT PRIMARY KEY,
  access_group TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Invite lifecycle (SSO or local)
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role_ids_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT
);

-- Audit trail for security-sensitive actions
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_principal TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_state_firing ON alert_state(is_firing);
CREATE INDEX IF NOT EXISTS idx_saved_searches_created ON saved_searches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_searches_created_by ON saved_searches(created_by);
CREATE INDEX IF NOT EXISTS idx_alerts_created_by ON alerts(created_by);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at ON rate_limits(updated_at);
CREATE INDEX IF NOT EXISTS idx_roles_enabled ON roles(enabled);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_group_role_map_group ON access_group_role_mappings(access_group);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC);

-- Scheduled searches
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

-- Dashboards
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

-- Lookup tables
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
