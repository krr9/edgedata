-- First-class RBAC, Access group mappings, invitations, and audit log.

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

CREATE INDEX IF NOT EXISTS idx_roles_enabled ON roles(enabled);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_group_role_map_group ON access_group_role_mappings(access_group);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC);
