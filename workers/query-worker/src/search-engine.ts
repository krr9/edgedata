/**
 * Search engine: R2 listing, event scanning, filtering, facets, and search context.
 */

import type {
  AuthContext,
  DataScope,
  Env,
  FacetCount,
  ListingStatsSnapshot,
  ListingTracker,
  ParsedQuery,
  SearchContext,
  SearchEvent,
  SearchFilters,
  SearchMode,
  SearchRequest,
  SearchSummaryResponse,
  TimingStatsSnapshot,
  TimingTracker
} from './types.js';
import {
  MAX_CANDIDATES,
  PPL_PREFILTER_EQ_FIELDS,
  R2_READ_CONCURRENCY
} from './types.js';
import {
  enforceTimeGuardrails,
  getDateRange,
  inferSearchMode,
  mergeFilters,
  parseISODate,
  parseQueryInput,
  tokenize
} from './query-core.mjs';
import { clampLimit, compareEventsDesc } from './helpers.js';
import {
  normalizeIndexValue,
  eventIndex,
  isBeforeCursor,
  eventMatchesFilters,
  eventMatchesScope,
  assertFiltersWithinScope,
  injectScopeFilters,
  isWithinWindow,
  isExactScopedValue,
  encodePartitionValue,
  buildPartitionPrefix,
  keyDimensionValue,
  keyMatchesFiltersByPath
} from './search-engine-core.mjs';

export { normalizeIndexValue, eventIndex, isBeforeCursor, eventMatchesFilters, eventMatchesScope, assertFiltersWithinScope, injectScopeFilters, isWithinWindow, isExactScopedValue, encodePartitionValue, buildPartitionPrefix, keyDimensionValue, keyMatchesFiltersByPath };

// --- Timing and listing trackers ---

export function createTimingTracker(): TimingTracker {
  return {
    listingMs: 0,
    objectReadMs: 0,
    parseFilterMs: 0,
    postPipelineMs: 0
  };
}

export function snapshotTimingTracker(tracker: TimingTracker, totalMs: number): TimingStatsSnapshot {
  return {
    listing: Math.round(tracker.listingMs),
    object_read: Math.round(tracker.objectReadMs),
    parse_filter: Math.round(tracker.parseFilterMs),
    post_pipeline: Math.round(tracker.postPipelineMs),
    total: Math.round(totalMs)
  };
}

export { clampLimit, compareEventsDesc };

export async function listAllObjects(bucket: R2Bucket, prefix: string, maxKeys = 10000): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      keys.push(object.key);
      if (keys.length >= maxKeys) break;
    }
    if (keys.length >= maxKeys) break;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return keys;
}

export function createListingTracker(): ListingTracker {
  return {
    prefixes: new Set<string>(),
    listing_calls: 0,
    listed_objects: 0,
    listing_fallbacks: 0
  };
}

export function snapshotListingTracker(tracker: ListingTracker): ListingStatsSnapshot {
  return {
    listed_prefixes: tracker.prefixes.size,
    listing_calls: tracker.listing_calls,
    listed_objects: tracker.listed_objects,
    listing_fallbacks: tracker.listing_fallbacks
  };
}

export function recordListing(tracker: ListingTracker | undefined, prefix: string, listedObjects: number): void {
  if (!tracker) return;
  tracker.prefixes.add(prefix);
  tracker.listing_calls += 1;
  tracker.listed_objects += listedObjects;
}

export async function listObjectsWithPrefixFallback(
  bucket: R2Bucket,
  preferredPrefix: string,
  fallbackPrefix: string,
  tracker?: ListingTracker,
  timing?: TimingTracker
): Promise<string[]> {
  const preferredStartedAt = Date.now();
  const preferred = await listAllObjects(bucket, preferredPrefix);
  if (timing) timing.listingMs += Date.now() - preferredStartedAt;
  recordListing(tracker, preferredPrefix, preferred.length);
  if (preferred.length > 0 || preferredPrefix === fallbackPrefix) return preferred;
  if (tracker) tracker.listing_fallbacks += 1;
  const fallbackStartedAt = Date.now();
  const fallback = await listAllObjects(bucket, fallbackPrefix);
  if (timing) timing.listingMs += Date.now() - fallbackStartedAt;
  recordListing(tracker, fallbackPrefix, fallback.length);
  return fallback;
}

export async function listEventKeysForDate(
  bucket: R2Bucket,
  date: string,
  filters: SearchFilters,
  tracker?: ListingTracker,
  timing?: TimingTracker
): Promise<string[]> {
  const eventPrefix = buildPartitionPrefix('events', date, filters);
  const eventKeys = await listObjectsWithPrefixFallback(bucket, eventPrefix, `events/date=${date}/`, tracker, timing);
  const filteredEvents = eventKeys.filter((key) => keyMatchesFiltersByPath(key, filters));

  if (filteredEvents.length > 0) {
    return filteredEvents;
  }

  // Backward compatibility for data ingested before `events/` path existed.
  const rawPrefix = buildPartitionPrefix('raw', date, filters);
  const rawKeys = await listObjectsWithPrefixFallback(bucket, rawPrefix, `raw/date=${date}/`, tracker, timing);
  return rawKeys.filter((key) => keyMatchesFiltersByPath(key, filters));
}

export async function listTokenKeysForDate(
  bucket: R2Bucket,
  date: string,
  filters: SearchFilters,
  tracker?: ListingTracker,
  timing?: TimingTracker
): Promise<string[]> {
  const tokenPrefix = buildPartitionPrefix('tokens', date, filters);
  const tokenKeys = await listObjectsWithPrefixFallback(bucket, tokenPrefix, `tokens/date=${date}/`, tracker, timing);
  return tokenKeys.filter((key) => keyMatchesFiltersByPath(key, filters));
}

export async function readObjectText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return object.text();
}

export async function readObjectChunk(
  bucket: R2Bucket,
  keys: string[],
  timing?: TimingTracker
): Promise<Array<{ key: string; text: string | null }>> {
  const startedAt = Date.now();
  const results = await Promise.all(keys.map(async (key) => ({ key, text: await readObjectText(bucket, key) })));
  if (timing) timing.objectReadMs += Date.now() - startedAt;
  return results;
}

export async function fetchEventsByIds(
  env: Env,
  dates: string[],
  eventIds: Set<string>,
  filters: SearchFilters,
  scope: DataScope,
  fromMs: number,
  toMs: number,
  cursor: { before_ts: string; before_event_id: string } | null | undefined,
  limit: number,
  tracker?: ListingTracker,
  timing?: TimingTracker
): Promise<{ results: SearchEvent[]; scannedObjects: number }> {
  const results: SearchEvent[] = [];
  let scannedObjects = 0;

  for (const date of dates) {
    const keys = await listEventKeysForDate(env.RAW_BUCKET, date, filters, tracker, timing);
    for (let i = 0; i < keys.length; i += R2_READ_CONCURRENCY) {
      if (results.length >= limit || eventIds.size === 0) break;
      const chunk = keys.slice(i, i + R2_READ_CONCURRENCY);
      const objects = await readObjectChunk(env.RAW_BUCKET, chunk, timing);
      for (const { text } of objects) {
        if (results.length >= limit || eventIds.size === 0) break;
        if (!text) continue;

        scannedObjects++;
        const parseStartedAt = Date.now();
        const lines = text.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: SearchEvent;
          try {
            event = JSON.parse(line) as SearchEvent;
          } catch {
            continue;
          }
          event.index = eventIndex(event);

          if (!eventIds.has(event.event_id)) continue;
          if (!isWithinWindow(event.ts, fromMs, toMs)) continue;
          if (!isBeforeCursor(event, cursor)) continue;
          if (!eventMatchesFilters(event, filters)) continue;
          if (!eventMatchesScope(event, scope)) continue;

          results.push(event);
          eventIds.delete(event.event_id);
          if (results.length >= limit) break;
        }
        if (timing) timing.parseFilterMs += Date.now() - parseStartedAt;
      }
    }

    if (results.length >= limit || eventIds.size === 0) break;
  }

  return { results: results.sort(compareEventsDesc).slice(0, limit), scannedObjects };
}

export async function scanEvents(
  env: Env,
  dates: string[],
  filters: SearchFilters,
  scope: DataScope,
  fromMs: number,
  toMs: number,
  cursor: { before_ts: string; before_event_id: string } | null | undefined,
  limit: number,
  phrase: string | null,
  tracker?: ListingTracker,
  timing?: TimingTracker
): Promise<{ results: SearchEvent[]; scannedObjects: number }> {
  const matches: SearchEvent[] = [];
  let scannedObjects = 0;

  for (const date of dates) {
    const keys = await listEventKeysForDate(env.RAW_BUCKET, date, filters, tracker, timing);
    for (let i = 0; i < keys.length; i += R2_READ_CONCURRENCY) {
      const chunk = keys.slice(i, i + R2_READ_CONCURRENCY);
      const objects = await readObjectChunk(env.RAW_BUCKET, chunk, timing);
      for (const { text } of objects) {
        if (!text) continue;

        scannedObjects++;
        const parseStartedAt = Date.now();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;

          let event: SearchEvent;
          try {
            event = JSON.parse(line) as SearchEvent;
          } catch {
            continue;
          }
          event.index = eventIndex(event);

          if (!isWithinWindow(event.ts, fromMs, toMs)) continue;
          if (!isBeforeCursor(event, cursor)) continue;
          if (!eventMatchesFilters(event, filters)) continue;
          if (!eventMatchesScope(event, scope)) continue;

          if (phrase) {
            const haystack = (event.message_lc || event.message.toLowerCase());
            if (!haystack.includes(phrase)) continue;
          }

          matches.push(event);
          if (matches.length >= limit) break;
        }
        if (timing) timing.parseFilterMs += Date.now() - parseStartedAt;
        if (matches.length >= limit) break;
      }
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }

  matches.sort(compareEventsDesc);
  return { results: matches.slice(0, limit), scannedObjects };
}

export async function scanTokenCandidates(
  env: Env,
  dates: string[],
  queryTokens: string[],
  filters: SearchFilters,
  scope: DataScope,
  tracker?: ListingTracker,
  timing?: TimingTracker
): Promise<{ ids: string[]; scannedObjects: number }> {
  const tokenSet = new Set(queryTokens);
  const scoreById = new Map<string, number>();
  let scannedObjects = 0;

  for (const date of dates) {
    const keys = await listTokenKeysForDate(env.RAW_BUCKET, date, filters, tracker, timing);
    for (let i = 0; i < keys.length; i += R2_READ_CONCURRENCY) {
      const chunk = keys.slice(i, i + R2_READ_CONCURRENCY);
      const objects = await readObjectChunk(env.RAW_BUCKET, chunk, timing);
      for (const { text } of objects) {
        if (!text) continue;

        scannedObjects++;
        const parseStartedAt = Date.now();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;

          let record: { token?: string; event_id?: string; index?: string; service?: string; env?: string };
          try {
            record = JSON.parse(line) as { token?: string; event_id?: string; index?: string; service?: string; env?: string };
          } catch {
            continue;
          }

          if (!record.event_id || !record.token) continue;
          if (!tokenSet.has(record.token)) continue;
          const recordIndex = normalizeIndexValue(record.index);
          if (filters.index && recordIndex !== normalizeIndexValue(filters.index)) continue;
          if (!matchesScopedValue(recordIndex, scope.indexes)) continue;
          if (filters.service && record.service !== filters.service) continue;
          if (filters.env && record.env !== filters.env) continue;
          if (!matchesScopedValue(record.service, scope.services)) continue;
          if (!matchesScopedValue(record.env, scope.envs)) continue;

          scoreById.set(record.event_id, (scoreById.get(record.event_id) || 0) + 1);
          if (scoreById.size >= MAX_CANDIDATES) break;
        }
        if (timing) timing.parseFilterMs += Date.now() - parseStartedAt;
        if (scoreById.size >= MAX_CANDIDATES) break;
      }
      if (scoreById.size >= MAX_CANDIDATES) break;
    }
    if (scoreById.size >= MAX_CANDIDATES) break;
  }

  const ids = Array.from(scoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([id]) => id);

  return { ids, scannedObjects };
}

export async function fetchEventsByIdsStream(
  env: Env,
  dates: string[],
  eventIds: Set<string>,
  filters: SearchFilters,
  scope: DataScope,
  fromMs: number,
  toMs: number,
  cursor: { before_ts: string; before_event_id: string } | null | undefined,
  onEvent: (event: SearchEvent) => Promise<boolean> | boolean,
  tracker?: ListingTracker
): Promise<{ scannedObjects: number }> {
  let scannedObjects = 0;

  for (const date of dates) {
    const keys = await listEventKeysForDate(env.RAW_BUCKET, date, filters, tracker);
    for (let i = 0; i < keys.length; i += R2_READ_CONCURRENCY) {
      if (eventIds.size === 0) break;

      const batch = keys.slice(i, i + R2_READ_CONCURRENCY);
      const texts = await Promise.all(batch.map((key) => readObjectText(env.RAW_BUCKET, key)));

      for (const text of texts) {
        if (!text) continue;

        scannedObjects++;
        const lines = text.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: SearchEvent;
          try {
            event = JSON.parse(line) as SearchEvent;
          } catch {
            continue;
          }
          event.index = eventIndex(event);

          if (!eventIds.has(event.event_id)) continue;
          if (!isWithinWindow(event.ts, fromMs, toMs)) continue;
          if (!isBeforeCursor(event, cursor)) continue;
          if (!eventMatchesFilters(event, filters)) continue;
          if (!eventMatchesScope(event, scope)) continue;

          const keepGoing = await onEvent(event);
          eventIds.delete(event.event_id);
          if (!keepGoing) return { scannedObjects };
        }
      }

      if (eventIds.size === 0) break;
    }

    if (eventIds.size === 0) break;
  }

  return { scannedObjects };
}

export async function scanEventsStream(
  env: Env,
  dates: string[],
  filters: SearchFilters,
  scope: DataScope,
  fromMs: number,
  toMs: number,
  cursor: { before_ts: string; before_event_id: string } | null | undefined,
  phrase: string | null,
  onEvent: (event: SearchEvent) => Promise<boolean> | boolean,
  tracker?: ListingTracker
): Promise<{ scannedObjects: number }> {
  let scannedObjects = 0;

  for (const date of dates) {
    const keys = await listEventKeysForDate(env.RAW_BUCKET, date, filters, tracker);

    for (let i = 0; i < keys.length; i += R2_READ_CONCURRENCY) {
      const batch = keys.slice(i, i + R2_READ_CONCURRENCY);
      const texts = await Promise.all(batch.map((key) => readObjectText(env.RAW_BUCKET, key)));

      for (const text of texts) {
        if (!text) continue;

        scannedObjects++;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;

          let event: SearchEvent;
          try {
            event = JSON.parse(line) as SearchEvent;
          } catch {
            continue;
          }
          event.index = eventIndex(event);

          if (!isWithinWindow(event.ts, fromMs, toMs)) continue;
          if (!isBeforeCursor(event, cursor)) continue;
          if (!eventMatchesFilters(event, filters)) continue;
          if (!eventMatchesScope(event, scope)) continue;

          if (phrase) {
            const haystack = (event.message_lc || event.message.toLowerCase());
            if (!haystack.includes(phrase)) continue;
          }

          const keepGoing = await onEvent(event);
          if (!keepGoing) return { scannedObjects };
        }
      }
    }
  }

  return { scannedObjects };
}

export function nextCursor(results: SearchEvent[]): { before_ts: string; before_event_id: string } | null {
  if (results.length === 0) return null;
  const last = results[results.length - 1];
  return {
    before_ts: last.ts,
    before_event_id: last.event_id
  };
}

export function countFacet(items: Array<string | number | undefined>, limit = 10): FacetCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item === undefined || item === null || item === '') continue;
    const key = String(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function buildTimeline(events: SearchEvent[], limit = 60): Array<{ minute: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const minute = event.ts.slice(0, 16) + ':00Z';
    counts.set(minute, (counts.get(minute) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([minute, count]) => ({ minute, count }));
}

export function buildTopTerms(events: SearchEvent[], limit = 20): FacetCount[] {
  const counts = new Map<string, number>();

  for (const event of events) {
    const source = event.message_lc || event.message.toLowerCase();
    for (const token of tokenize(source)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function buildFieldPresence(events: SearchEvent[]): SearchSummaryResponse['field_presence'] {
  const result = {
    trace_id: 0,
    span_id: 0,
    parent_span_id: 0,
    request_id: 0,
    user_id: 0,
    src_ip: 0,
    status: 0,
    duration_ms: 0,
    attrs_json: 0
  };

  for (const event of events) {
    if (event.trace_id) result.trace_id += 1;
    if (event.span_id) result.span_id += 1;
    if (event.parent_span_id) result.parent_span_id += 1;
    if (event.request_id) result.request_id += 1;
    if (event.user_id) result.user_id += 1;
    if (event.src_ip) result.src_ip += 1;
    if (event.status !== undefined) result.status += 1;
    if (event.duration_ms !== undefined) result.duration_ms += 1;
    if (event.attrs_json) result.attrs_json += 1;
  }

  return result;
}

export function buildSearchContext(request: SearchRequest, auth: AuthContext): SearchContext {
  if (!request.time?.from || !request.time?.to) {
    throw new Error('Time range required');
  }

  const parsed = parseQueryInput(request.q || '') as ParsedQuery;
  const mode = inferSearchMode(parsed, request.phrase) as SearchMode;
  const phrase = (request.phrase || parsed.phrase || null)?.toLowerCase() || null;
  const rawFilters = mergeFilters(request.filters || {}, parsed.extractedFilters) as SearchFilters;
  assertFiltersWithinScope(rawFilters, auth.scope);
  const filters = injectScopeFilters(rawFilters, auth.scope);

  if (mode === 'phrase' && !filters.service) {
    throw new Error('Phrase search requires service filter');
  }

  enforceTimeGuardrails(request.time.from, request.time.to, mode);

  const fromMs = parseISODate(request.time.from).getTime();
  const toMs = parseISODate(request.time.to).getTime();
  const dates = getDateRange(request.time.from, request.time.to).reverse();

  return { mode, phrase, filters, fromMs, toMs, dates, parsed };
}
