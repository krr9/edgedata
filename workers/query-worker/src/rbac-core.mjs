import { ensureRoleId } from './auth-core.mjs';

export function mergePermissionsWithDefaults(currentPermissions = [], defaultPermissions = []) {
  const merged = [];
  const seen = new Set();

  for (const permission of [...currentPermissions, ...defaultPermissions]) {
    const normalized = String(permission || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

export function hasPermission(auth, permission) {
  return auth.permissions.has('*') || auth.permissions.has(permission);
}

export function assertPermission(auth, permission) {
  if (!hasPermission(auth, permission)) {
    throw new Error('Forbidden');
  }
}

export const PRIVILEGED_ROLES = new Set(['superadmin', 'admin']);

export function assertCanAssignRoles(auth, roleIds) {
  const requestsPrivileged = roleIds.some((id) => PRIVILEGED_ROLES.has(ensureRoleId(id)));
  if (!requestsPrivileged) return;
  if (auth.role !== 'superadmin') {
    throw new Error('Forbidden: only superadmin can assign admin or superadmin roles');
  }
}
