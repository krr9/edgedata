import { parseBoolean } from './synthetic-core.mjs';

export const CONTROL_KEY = 'synthetic_ingest_enabled';

async function ensureRuntimeFlagsTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS runtime_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
}

export async function readSyntheticIngestEnabled(db, configuredEnabled) {
  if (!db) return configuredEnabled;
  try {
    await ensureRuntimeFlagsTable(db);
    const row = await db.prepare(
      'SELECT value FROM runtime_flags WHERE key = ?'
    ).bind(CONTROL_KEY).first();
    if (!row || row.value === undefined || row.value === null) {
      return configuredEnabled;
    }
    return parseBoolean(String(row.value), configuredEnabled);
  } catch {
    return configuredEnabled;
  }
}

export async function writeSyntheticIngestEnabled(db, enabled, updatedAt = new Date().toISOString()) {
  if (!db) {
    throw new Error('Missing DB binding');
  }
  await ensureRuntimeFlagsTable(db);
  await db.prepare(
    `INSERT INTO runtime_flags (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).bind(CONTROL_KEY, enabled ? 'true' : 'false', updatedAt).run();
  return { key: CONTROL_KEY, enabled, updated_at: updatedAt };
}
