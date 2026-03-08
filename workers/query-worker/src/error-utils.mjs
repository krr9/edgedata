/**
 * Error-to-HTTP-status mapping for query-worker handlers.
 * Exported for unit testing the 403 permission-failure path.
 */

/**
 * Maps an error to an HTTP status code.
 * @param {unknown} error
 * @param {number} [fallback=500]
 * @returns {number}
 */
export function statusFromError(error, fallback = 500) {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('misconfigured')) return 500;
    if (message.includes('rate limit')) return 429;
    if (message.includes('forbidden') || message.includes('access denied') || message.includes('not invited')) return 403;
    if (
      message.includes('unauthorized') ||
      message.includes('missing access jwt') ||
      message.includes('invalid access jwt') ||
      message.includes('expired')
    ) return 401;
    if (message.includes('invalid') || message.includes('required') || message.includes('limited')) return 400;
  }
  return fallback;
}
