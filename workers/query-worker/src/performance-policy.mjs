import { hashQueryText as sharedHashQueryText } from '../../shared/materialization-core.mjs';

const EXECUTION_MODES = new Set(['live', 'cached', 'materialized']);
const PERFORMANCE_PROFILES = new Set(['economy', 'balanced', 'fast']);

export function normalizeExecutionMode(value, fallback = 'live') {
  const normalizedFallback = EXECUTION_MODES.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : 'live';
  const normalized = String(value || '').trim().toLowerCase();
  return EXECUTION_MODES.has(normalized) ? normalized : normalizedFallback;
}

export function normalizePerformanceProfile(value, fallback = 'economy') {
  const normalizedFallback = PERFORMANCE_PROFILES.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : 'economy';
  const normalized = String(value || '').trim().toLowerCase();
  return PERFORMANCE_PROFILES.has(normalized) ? normalized : normalizedFallback;
}

export function normalizeCacheTtlSeconds(value, fallback = 120, max = 3600) {
  const normalizedFallback = clampPositiveInt(fallback, 120, max);
  return clampPositiveInt(value, normalizedFallback, max);
}

export function normalizeMaterializeIntervalSeconds(value, fallback = 300, max = 86400) {
  return clampPositiveInt(value, clampPositiveInt(fallback, 300, max), max);
}

export function normalizeMaxStalenessSeconds(value, fallback = 600, max = 86400) {
  return clampPositiveInt(value, clampPositiveInt(fallback, 600, max), max);
}

export function normalizeBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function cacheShardNameForKey(key, shardCount = 16) {
  const shards = clampPositiveInt(shardCount, 16, 256);
  const hash = fnv1a32(String(key || ''));
  return `shard-${hash % shards}`;
}

export function hashQueryText(queryText) {
  return sharedHashQueryText(queryText);
}

function clampPositiveInt(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.trunc(numeric), max);
}

function fnv1a32(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
