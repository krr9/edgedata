/**
 * Pure search engine helpers for unit testing. Used by search-engine.ts.
 */

import { matchesScopedValue } from './auth-core.mjs';

const DEFAULT_EVENT_INDEX = 'default';

export function normalizeIndexValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || DEFAULT_EVENT_INDEX;
}

export function eventIndex(event) {
  return normalizeIndexValue(event.index);
}

export function isBeforeCursor(event, cursor) {
  if (!cursor) return true;
  if (event.ts < cursor.before_ts) return true;
  if (event.ts > cursor.before_ts) return false;
  return event.event_id < cursor.before_event_id;
}

export function eventMatchesFilters(event, filters) {
  if (filters.index && eventIndex(event) !== normalizeIndexValue(filters.index)) return false;
  if (filters.service && event.service !== filters.service) return false;
  if (filters.env && event.env !== filters.env) return false;
  if (filters.host && event.host !== filters.host) return false;
  if (filters.level && event.level !== filters.level) return false;
  if (filters.status !== undefined && event.status !== filters.status) return false;
  if (filters.status_gt !== undefined && (event.status === undefined || event.status <= filters.status_gt)) return false;
  if (filters.status_gte !== undefined && (event.status === undefined || event.status < filters.status_gte)) return false;
  if (filters.status_lt !== undefined && (event.status === undefined || event.status >= filters.status_lt)) return false;
  if (filters.status_lte !== undefined && (event.status === undefined || event.status > filters.status_lte)) return false;
  if (filters.user_id && event.user_id !== filters.user_id) return false;
  if (filters.src_ip && event.src_ip !== filters.src_ip) return false;
  if (filters.trace_id && event.trace_id !== filters.trace_id) return false;
  if (filters.span_id && event.span_id !== filters.span_id) return false;
  if (filters.parent_span_id && event.parent_span_id !== filters.parent_span_id) return false;
  if (filters.request_id && event.request_id !== filters.request_id) return false;
  if (filters.msg_hash && event.msg_hash !== filters.msg_hash) return false;

  if (filters.duration_gt !== undefined && (event.duration_ms === undefined || event.duration_ms <= filters.duration_gt)) return false;
  if (filters.duration_gte !== undefined && (event.duration_ms === undefined || event.duration_ms < filters.duration_gte)) return false;
  if (filters.duration_lt !== undefined && (event.duration_ms === undefined || event.duration_ms >= filters.duration_lt)) return false;
  if (filters.duration_lte !== undefined && (event.duration_ms === undefined || event.duration_ms > filters.duration_lte)) return false;

  return true;
}

export function eventMatchesScope(event, scope) {
  if (!matchesScopedValue(eventIndex(event), scope.indexes)) return false;
  if (!matchesScopedValue(event.service, scope.services)) return false;
  if (!matchesScopedValue(event.env, scope.envs)) return false;
  if (!matchesScopedValue(event.host, scope.hosts)) return false;
  return true;
}

export function assertFiltersWithinScope(filters, scope) {
  if (filters.index && !matchesScopedValue(normalizeIndexValue(filters.index), scope.indexes)) {
    throw new Error('Forbidden: index outside role scope');
  }
  if (filters.service && !matchesScopedValue(filters.service, scope.services)) {
    throw new Error('Forbidden: service outside role scope');
  }
  if (filters.env && !matchesScopedValue(filters.env, scope.envs)) {
    throw new Error('Forbidden: env outside role scope');
  }
  if (filters.host && !matchesScopedValue(filters.host, scope.hosts)) {
    throw new Error('Forbidden: host outside role scope');
  }
}

export function injectScopeFilters(filters, scope) {
  const next = { ...filters };
  const maybeInject = (key, patterns) => {
    if (next[key]) return;
    if (patterns.includes('*')) return;
    const exactOnly = patterns.filter((pattern) => !pattern.includes('*'));
    if (exactOnly.length === 1) {
      next[key] = exactOnly[0];
    }
  };
  maybeInject('index', scope.indexes);
  maybeInject('service', scope.services);
  maybeInject('env', scope.envs);
  maybeInject('host', scope.hosts);
  return next;
}

export function isWithinWindow(eventTs, fromMs, toMs) {
  const value = new Date(eventTs).getTime();
  return Number.isFinite(value) && value >= fromMs && value <= toMs;
}

export function isExactScopedValue(value) {
  if (!value) return false;
  if (value === '*') return false;
  return !value.includes('*');
}

export function encodePartitionValue(value) {
  return encodeURIComponent(value);
}

export function buildPartitionPrefix(kind, date, filters) {
  const base = `${kind}/date=${date}/`;
  const index = isExactScopedValue(filters.index) ? normalizeIndexValue(filters.index) : null;
  if (!index) return base;

  const indexPrefix = `${base}index=${encodePartitionValue(index)}/`;
  if (kind === 'raw') return indexPrefix;

  const service = isExactScopedValue(filters.service) ? filters.service : null;
  if (!service) return indexPrefix;

  const servicePrefix = `${indexPrefix}service=${encodePartitionValue(service)}/`;
  const env = isExactScopedValue(filters.env) ? filters.env : null;
  if (!env) return servicePrefix;
  return `${servicePrefix}env=${encodePartitionValue(env)}/`;
}

export function keyDimensionValue(key, dimension) {
  const match = key.match(new RegExp(`/${dimension}=([^/]+)/`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function keyMatchesFiltersByPath(key, filters) {
  if (filters.index) {
    const keyIndex = normalizeIndexValue(keyDimensionValue(key, 'index') || DEFAULT_EVENT_INDEX);
    if (keyIndex !== normalizeIndexValue(filters.index)) return false;
  }
  if (filters.service) {
    const keyService = keyDimensionValue(key, 'service');
    if (keyService !== filters.service) return false;
  }
  if (filters.env) {
    const keyEnv = keyDimensionValue(key, 'env');
    if (keyEnv !== filters.env) return false;
  }
  return true;
}
