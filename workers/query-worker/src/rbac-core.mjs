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
