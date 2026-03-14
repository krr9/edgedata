export function sanitizeWaeSqlValue(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_.\-:@/ ]/g, '');
}
