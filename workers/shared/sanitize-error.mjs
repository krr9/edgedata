const SAFE_ERROR_PATTERNS = [
  /^Forbidden/i,
  /^Access denied/i,
  /^Unauthorized/i,
  /^Rate limit exceeded/i,
  /^Invalid/i,
  /^Not found/i,
  /search (requires|limited to)/i,
  /outside role scope/i,
  /^ppl /i,
  /^email is required/i,
  /^password must be/i,
  /^token is required/i,
  /^name/i,
  /^id/i,
  /^query/i,
  /^Too many/i,
  /^Maximum/i,
  /^Unsupported/i,
  /^Missing/i,
  /^Unclosed/i,
  /^Cannot/i,
];

export function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  for (const pattern of SAFE_ERROR_PATTERNS) {
    if (pattern.test(message)) return message;
  }
  return 'Internal server error';
}
