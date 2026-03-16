-- 017: Add name column to investigation sessions for workspace management
ALTER TABLE investigation_sessions ADD COLUMN name TEXT;
