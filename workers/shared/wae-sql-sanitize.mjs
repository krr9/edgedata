export function sanitizeWaeSqlValue(value) {
  return value.replace(/[^a-zA-Z0-9_.\-:@/ ]/g, '');
}
