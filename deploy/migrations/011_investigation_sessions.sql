-- 011: Investigation sessions for investigation acceleration pack

CREATE TABLE IF NOT EXISTS investigation_sessions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  source_type TEXT,
  scope_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_investigation_sessions_owner_created
  ON investigation_sessions(owner_user_id, created_at DESC);
