export function asRateLimitPerMinute(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

export async function enforceRateLimit(db, scope, key, perMinute) {
  if (perMinute <= 0) return;

  const now = Date.now();
  const windowStartMs = Math.floor(now / 60000) * 60000;
  const nowIso = new Date(now).toISOString();

  await db.prepare(
    `INSERT INTO rate_limits (scope, limit_key, window_start_ms, count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, limit_key, window_start_ms) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at`
  ).bind(scope, key, windowStartMs, nowIso).run();

  const row = await db.prepare(
    `SELECT count
     FROM rate_limits
     WHERE scope = ? AND limit_key = ? AND window_start_ms = ?`
  ).bind(scope, key, windowStartMs).first();

  if (Number(row?.count || 0) > perMinute) {
    throw new Error('Rate limit exceeded');
  }
}
