-- 010: Add runtime flags table for synthetic ingest control

CREATE TABLE IF NOT EXISTS runtime_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO runtime_flags (key, value, updated_at)
VALUES ('synthetic_ingest_enabled', 'true', '2026-03-07T00:00:00.000Z');
