-- Add lookup index for access group role mappings by role ID.
CREATE INDEX IF NOT EXISTS idx_group_role_map_role_id ON access_group_role_mappings(role_id);
