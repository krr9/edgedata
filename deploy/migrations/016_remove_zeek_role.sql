-- Replace legacy zeek_viewer role references with viewer and remove the old role.
INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
SELECT user_id, 'viewer', COALESCE(assigned_by, 'migration-016'), assigned_at
FROM user_roles
WHERE role_id = 'zeek_viewer';

DELETE FROM user_roles
WHERE role_id = 'zeek_viewer';

UPDATE users
SET role = 'viewer'
WHERE role = 'zeek_viewer';

INSERT INTO access_group_role_mappings (id, access_group, role_id, created_at, updated_at)
SELECT lower(hex(randomblob(16))), access_group, 'viewer', created_at, datetime('now')
FROM access_group_role_mappings old
WHERE old.role_id = 'zeek_viewer'
  AND NOT EXISTS (
    SELECT 1
    FROM access_group_role_mappings newer
    WHERE newer.access_group = old.access_group
      AND newer.role_id = 'viewer'
  );

DELETE FROM access_group_role_mappings
WHERE role_id = 'zeek_viewer';

UPDATE invitations
SET role_ids_json = CASE
  WHEN role_ids_json = '["zeek_viewer"]' THEN '["viewer"]'
  ELSE replace(role_ids_json, '"zeek_viewer"', '"viewer"')
END
WHERE role_ids_json LIKE '%"zeek_viewer"%';

DELETE FROM roles
WHERE id = 'zeek_viewer';
