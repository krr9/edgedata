-- Add rate limit table for fixed-window abuse protection.

CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, limit_key, window_start_ms)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at ON rate_limits(updated_at);
