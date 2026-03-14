-- Add ownership columns for authorization controls.
-- Run this once against existing remote D1 databases.
-- NOTE: Not idempotent. Do not re-run on databases where these columns already exist.

ALTER TABLE saved_searches ADD COLUMN created_by TEXT;
ALTER TABLE alerts ADD COLUMN created_by TEXT;

CREATE INDEX IF NOT EXISTS idx_saved_searches_created_by ON saved_searches(created_by);
CREATE INDEX IF NOT EXISTS idx_alerts_created_by ON alerts(created_by);
