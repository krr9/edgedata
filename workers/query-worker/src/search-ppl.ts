/**
 * PPL search execution: helpers, pipeline application, search/stream/summary, WAE SQL.
 */

import type {
  AuthContext,
  DataScope,
  Env,
  FacetCount,
  PplCondition,
  PplConditionOperator,
  PplPipeline,
  PplStage,
  SearchContext,
  SearchEvent,
  SearchFilters,
  SearchRequest,
  SearchSummaryResponse,
  WAERow
} from './types.js';
import {
  DEFAULT_EVENT_INDEX,
  MAX_LIMIT,
  MAX_SUMMARY_EVENTS,
  NDJSON_CONTENT_TYPE,
  PPL_MAX_LIMIT,
  PPL_PREFILTER_EQ_FIELDS
} from './types.js';
import {
  buildFieldPresence,
  buildSearchContext,
  buildTimeline,
  buildTopTerms,
  clampLimit,
  countFacet,
  createListingTracker,
  createTimingTracker,
  eventIndex,
  fetchEventsByIds,
  fetchEventsByIdsStream,
  scanEvents,
  scanEventsStream,
  scanTokenCandidates,
  snapshotListingTracker,
  snapshotTimingTracker,
  nextCursor
} from './search-engine.js';
import { getDateRange, parseISODate } from './query-core.mjs';
import { classifyGuardrailError } from './query-core.mjs';
import { parsePplPipeline } from './ppl-core.mjs';
import {
  applyPostPipeline,
  executeLookupPipeline,
  executeRenamePipeline,
  executeRexPipeline,
  executeTransactionPipeline,
  isIncrementalStreamPipeline,
  resolvePipelineLimit,
  rowMatchesWhereStages
} from './search-stream-core.mjs';
import { sqlLiteral, valuesAreSqlExact } from './helpers.js';

// --- PPL helpers ---

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function compareUnknownValues(left: unknown, right: unknown): number {
  const leftNum = asNumber(left);
  const rightNum = asNumber(right);
  if (leftNum !== null && rightNum !== null) {
    if (leftNum === rightNum) return 0;
    return leftNum < rightNum ? -1 : 1;
  }
  const leftText = left === undefined || left === null ? '' : String(left);
  const rightText = right === undefined || right === null ? '' : String(right);
  return leftText.localeCompare(rightText);
}

export function rowMatchesCondition(row: Record<string, unknown>, condition: PplCondition): boolean {
  const left = row[condition.field];
  const right = condition.value;
  const cmp = compareUnknownValues(left, right);

  if (condition.operator === '=') return cmp === 0;
  if (condition.operator === '!=') return cmp !== 0;
  if (condition.operator === '>') return cmp > 0;
  if (condition.operator === '>=') return cmp >= 0;
  if (condition.operator === '<') return cmp < 0;
  if (condition.operator === '<=') return cmp <= 0;
  return false;
}

export function applyPplFields(rows: Array<Record<string, unknown>>, fields: string[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const field of fields) {
      projected[field] = row[field] ?? null;
    }
    return projected;
  });
}

export function applyPplSort(
  rows: Array<Record<string, unknown>>,
  keys: Array<{ field: string; direction: 'asc' | 'desc' }>
): Array<Record<string, unknown>> {
  if (keys.length === 0) return rows;
  const sorted = [...rows];
  sorted.sort((left, right) => {
    for (const key of keys) {
      const cmp = compareUnknownValues(left[key.field], right[key.field]);
      if (cmp === 0) continue;
      return key.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return sorted;
}

export function applyPplStatsCount(
  rows: Array<Record<string, unknown>>,
  stage: Extract<PplStage, { command: 'stats' }>
): Array<Record<string, unknown>> {
  const keyToRow = new Map<string, Record<string, unknown>>();
  const keyToCount = new Map<string, number>();

  for (const row of rows) {
    const groupValues = stage.by.map((field) => row[field] ?? null);
    const key = JSON.stringify(groupValues);
    if (!keyToRow.has(key)) {
      const grouped: Record<string, unknown> = {};
      for (let index = 0; index < stage.by.length; index++) {
        grouped[stage.by[index]] = groupValues[index];
      }
      keyToRow.set(key, grouped);
    }
    keyToCount.set(key, (keyToCount.get(key) || 0) + 1);
  }

  const result: Array<Record<string, unknown>> = [];
  for (const [key, groupedRow] of keyToRow.entries()) {
    result.push({
      ...groupedRow,
      [stage.as]: keyToCount.get(key) || 0
    });
  }

  return result;
}

const TABLE_COMMANDS = new Set(['stats', 'fields', 'table', 'timechart', 'top', 'rare', 'transaction']);

export function isPplTableQuery(stages: PplStage[]): boolean {
  return stages.some((stage) => TABLE_COMMANDS.has(stage.command));
}

export function buildSearchRequestFromPpl(request: { time: { from: string; to: string }; ppl: string; limit?: number; cursor?: { before_ts: string; before_event_id: string } | null }, pipeline: PplPipeline): SearchRequest {
  const filters: Record<string, string | number> = {};
  const searchParts: string[] = [];
  let prefilterLocked = false;

  const addNumericFilter = (field: 'status' | 'duration_ms', operator: PplConditionOperator, value: number) => {
    if (field === 'status') {
      if (operator === '=') filters.status = Math.trunc(value);
      if (operator === '>') filters.status__gt = Math.trunc(value);
      if (operator === '>=') filters.status__gte = Math.trunc(value);
      if (operator === '<') filters.status__lt = Math.trunc(value);
      if (operator === '<=') filters.status__lte = Math.trunc(value);
      return;
    }

    if (operator === '=') {
      filters.duration_ms__gte = value;
      filters.duration_ms__lte = value;
      return;
    }
    if (operator === '>') filters.duration_ms__gt = value;
    if (operator === '>=') filters.duration_ms__gte = value;
    if (operator === '<') filters.duration_ms__lt = value;
    if (operator === '<=') filters.duration_ms__lte = value;
  };

  for (const stage of pipeline.stages) {
    if (stage.command === 'search' && !prefilterLocked) {
      if (stage.expression.trim()) searchParts.push(stage.expression.trim());
      continue;
    }

    if (stage.command === 'where' && !prefilterLocked) {
      for (const condition of stage.conditions) {
        if (condition.operator === '=' && PPL_PREFILTER_EQ_FIELDS.has(condition.field)) {
          filters[condition.field] = String(condition.value);
          continue;
        }
        if (condition.operator !== '!=' && (condition.field === 'status' || condition.field === 'duration_ms')) {
          const numeric = asNumber(condition.value);
          if (numeric === null) continue;
          addNumericFilter(condition.field, condition.operator, numeric);
        }
      }
      continue;
    }

    prefilterLocked = true;
  }

  return {
    time: request.time,
    filters,
    q: searchParts.join(' ').trim(),
    limit: request.limit,
    cursor: request.cursor || null
  };
}

export async function loadLookupCache(
  pipeline: PplPipeline,
  env: Env
): Promise<Map<string, Map<string, Record<string, unknown>>>> {
  const cache = new Map<string, Map<string, Record<string, unknown>>>();
  const lookupStages = pipeline.stages.filter(s => s.command === 'lookup') as Array<{ command: 'lookup'; table: string; field: string; outputFields: string[] | null }>;
  for (const stage of lookupStages) {
    if (cache.has(stage.table)) continue;
    try {
      const table = await env.DB.prepare('SELECT id FROM lookup_tables WHERE name = ?').bind(stage.table).first<{ id: string }>();
      if (!table) continue;
      const rows = await env.DB.prepare('SELECT key_value, data_json FROM lookup_rows WHERE lookup_id = ? LIMIT 10000')
        .bind(table.id).all<{ key_value: string; data_json: string }>();
      const map = new Map<string, Record<string, unknown>>();
      for (const row of rows.results || []) {
        try { map.set(row.key_value, JSON.parse(row.data_json)); } catch { /* skip bad rows */ }
      }
      cache.set(stage.table, map);
    } catch {
      // lookup table not found — skip
    }
  }
  return cache;
}

export function applyPplPipelineStages(
  events: SearchEvent[],
  pipeline: PplPipeline,
  lookupCache?: Map<string, Map<string, Record<string, unknown>>>
): { resultType: 'events' | 'table'; rows: Array<SearchEvent | Record<string, unknown>> } {
  let rows: Array<Record<string, unknown>> = events.map((event) => ({ ...event }));
  let resultType: 'events' | 'table' = 'events';

  for (const stage of pipeline.stages) {
    if (stage.command === 'search') continue;
    if (stage.command === 'where') {
      rows = rows.filter((row) => stage.conditions.every((condition) => rowMatchesCondition(row, condition)));
      continue;
    }
    if (stage.command === 'sort') {
      rows = applyPplSort(rows, stage.keys);
      continue;
    }
    if (stage.command === 'head') {
      rows = rows.slice(0, stage.count);
      continue;
    }
    if (stage.command === 'fields') {
      rows = applyPplFields(rows, stage.fields);
      resultType = 'table';
      continue;
    }
    if (stage.command === 'stats') {
      rows = applyPostPipeline(rows, [stage]) as Array<Record<string, unknown>>;
      resultType = 'table';
      continue;
    }
    if (stage.command === 'timechart' || stage.command === 'top' || stage.command === 'rare') {
      rows = applyPostPipeline(rows, [stage]) as Array<Record<string, unknown>>;
      resultType = 'table';
      continue;
    }
    if (stage.command === 'dedup') {
      rows = applyPostPipeline(rows, [stage]) as Array<Record<string, unknown>>;
      continue;
    }
    if (stage.command === 'eval') {
      rows = applyPostPipeline(rows, [stage]) as Array<Record<string, unknown>>;
      continue;
    }
    if (stage.command === 'lookup') {
      const lm = lookupCache?.get(stage.table);
      if (lm) {
        rows = executeLookupPipeline(rows, stage, lm) as Array<Record<string, unknown>>;
      }
      continue;
    }
    if (stage.command === 'rex') {
      rows = executeRexPipeline(rows, stage) as Array<Record<string, unknown>>;
      continue;
    }
    if (stage.command === 'rename') {
      rows = executeRenamePipeline(rows, stage) as Array<Record<string, unknown>>;
      continue;
    }
    if (stage.command === 'table') {
      rows = applyPostPipeline(rows, [stage]) as Array<Record<string, unknown>>;
      resultType = 'table';
      continue;
    }
    if (stage.command === 'transaction') {
      rows = executeTransactionPipeline(rows, stage) as Array<Record<string, unknown>>;
      resultType = 'table';
      continue;
    }
  }

  if (resultType === 'events') {
    return {
      resultType,
      rows: rows
        .filter((row) => typeof row.event_id === 'string' && typeof row.ts === 'string')
        .map((row) => row as SearchEvent)
    };
  }

  return { resultType, rows };
}

export async function executeSearchWithContext(
  context: SearchContext,
  env: Env,
  auth: AuthContext,
  cursor: { before_ts: string; before_event_id: string } | null | undefined,
  limit: number,
  timing = createTimingTracker()
): Promise<{ results: SearchEvent[]; scannedObjects: number; candidates: number; listing: import('./types.js').ListingStatsSnapshot }> {
  const { mode, phrase, filters, fromMs, toMs, dates, parsed } = context;

  let results: SearchEvent[] = [];
  let scannedObjects = 0;
  let candidates = 0;
  const listingTracker = createListingTracker();

  if (mode === 'token') {
    const tokenScan = await scanTokenCandidates(env, dates, parsed.tokens, filters, auth.scope, listingTracker, timing);
    scannedObjects += tokenScan.scannedObjects;
    candidates = tokenScan.ids.length;

    if (tokenScan.ids.length > 0) {
      const events = await fetchEventsByIds(
        env,
        dates,
        new Set(tokenScan.ids),
        filters,
        auth.scope,
        fromMs,
        toMs,
        cursor,
        limit,
        listingTracker,
        timing
      );
      scannedObjects += events.scannedObjects;
      results = events.results;
    }
  } else {
    const scanned = await scanEvents(
      env,
      dates,
      filters,
      auth.scope,
      fromMs,
      toMs,
      cursor,
      limit,
      mode === 'phrase' ? phrase : null,
      listingTracker,
      timing
    );
    scannedObjects += scanned.scannedObjects;
    results = scanned.results;
  }

  return { results, scannedObjects, candidates, listing: snapshotListingTracker(listingTracker) };
}

export async function performSearch(
  request: SearchRequest,
  env: Env,
  auth: AuthContext
): Promise<{ results: SearchEvent[]; next_cursor: { before_ts: string; before_event_id: string } | null; stats: import('./types.js').SearchResponse['stats'] }> {
  const startedAt = Date.now();
  const timing = createTimingTracker();
  const context = buildSearchContext(request, auth);
  const limit = clampLimit(request.limit, context.mode === 'phrase' ? 200 : MAX_LIMIT);
  const execution = await executeSearchWithContext(context, env, auth, request.cursor, limit, timing);

  return {
    results: execution.results,
    next_cursor: nextCursor(execution.results),
    stats: {
      mode: context.mode,
      scanned_partitions: context.dates.length,
      scanned_objects: execution.scannedObjects,
      listed_prefixes: execution.listing.listed_prefixes,
      listing_calls: execution.listing.listing_calls,
      listed_objects: execution.listing.listed_objects,
      listing_fallbacks: execution.listing.listing_fallbacks,
      candidates: execution.candidates,
      returned: execution.results.length,
      execution_path: 'single',
      timing_ms: snapshotTimingTracker(timing, Date.now() - startedAt)
    }
  };
}

export async function performSearchSummary(
  request: SearchRequest,
  env: Env,
  auth: AuthContext
): Promise<SearchSummaryResponse> {
  const startedAt = Date.now();
  const timing = createTimingTracker();
  const context = buildSearchContext(request, auth);
  const execution = await executeSearchWithContext(context, env, auth, null, MAX_SUMMARY_EVENTS, timing);
  const sampledEvents = execution.results;

  const facets = {
    indexes: countFacet(sampledEvents.map((event) => eventIndex(event)), 8),
    services: countFacet(sampledEvents.map((event) => event.service), 12),
    levels: countFacet(sampledEvents.map((event) => event.level), 6),
    statuses: countFacet(sampledEvents.map((event) => event.status), 8),
    hosts: countFacet(sampledEvents.map((event) => event.host), 10)
  };

  return {
    mode: context.mode,
    scanned_partitions: context.dates.length,
    sampled_events: sampledEvents.length,
    sampled_candidates: execution.candidates,
    scanned_objects: execution.scannedObjects,
    listed_prefixes: execution.listing.listed_prefixes,
    listing_calls: execution.listing.listing_calls,
    listed_objects: execution.listing.listed_objects,
    listing_fallbacks: execution.listing.listing_fallbacks,
    timing_ms: snapshotTimingTracker(timing, Date.now() - startedAt),
    truncated: sampledEvents.length >= MAX_SUMMARY_EVENTS,
    top_terms: buildTopTerms(sampledEvents, 24),
    field_presence: buildFieldPresence(sampledEvents),
    facets,
    timeline: buildTimeline(sampledEvents, 72)
  };
}

export async function performPplSearch(
  request: { time: { from: string; to: string }; ppl: string; limit?: number; cursor?: { before_ts: string; before_event_id: string } | null },
  env: Env,
  auth: AuthContext
): Promise<import('./types.js').PplSearchResponse> {
  const startedAt = Date.now();
  const timing = createTimingTracker();
  if (!request?.time?.from || !request?.time?.to) {
    throw new Error('Time range required');
  }
  if (!request.ppl || !String(request.ppl).trim()) {
    throw new Error('ppl query is required');
  }

  const pipeline = parsePplPipeline(request.ppl) as PplPipeline;
  const compiled = buildSearchRequestFromPpl(request, pipeline);
  const context = buildSearchContext(compiled, auth);
  const requestedLimit = clampLimit(request.limit, PPL_MAX_LIMIT);
  const executionLimit = context.mode === 'phrase' ? Math.min(200, requestedLimit) : requestedLimit;
  const execution = await executeSearchWithContext(context, env, auth, compiled.cursor, executionLimit, timing);
  const postPipelineStartedAt = Date.now();
  const lookupCache = await loadLookupCache(pipeline, env);
  const transformed = applyPplPipelineStages(execution.results, pipeline, lookupCache);
  timing.postPipelineMs += Date.now() - postPipelineStartedAt;
  const rows = transformed.rows.slice(0, requestedLimit);
  const nextCursorValue = transformed.resultType === 'events'
    ? nextCursor(rows as SearchEvent[])
    : null;

  return {
    result_type: transformed.resultType,
    results: rows,
    next_cursor: nextCursorValue,
    stats: {
      mode: context.mode,
      scanned_partitions: context.dates.length,
      scanned_objects: execution.scannedObjects,
      listed_prefixes: execution.listing.listed_prefixes,
      listing_calls: execution.listing.listing_calls,
      listed_objects: execution.listing.listed_objects,
      listing_fallbacks: execution.listing.listing_fallbacks,
      candidates: execution.candidates,
      returned: rows.length,
      execution_path: 'single',
      timing_ms: snapshotTimingTracker(timing, Date.now() - startedAt),
      language: 'ppl',
      stage_count: pipeline.stages.length
    },
    warning: execution.results.length >= executionLimit && isPplTableQuery(pipeline.stages)
      ? `PPL pipeline evaluated on first ${executionLimit} matched events`
      : undefined
  };
}

export async function writeNdjsonLine(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  payload: Record<string, unknown>
): Promise<void> {
  await writer.write(encoder.encode(`${JSON.stringify(payload)}\n`));
}

export async function streamPplSearch(
  request: { time: { from: string; to: string }; ppl: string; limit?: number; cursor?: { before_ts: string; before_event_id: string } | null },
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (!request?.time?.from || !request?.time?.to) {
    throw new Error('Time range required');
  }
  if (!request.ppl || !String(request.ppl).trim()) {
    throw new Error('ppl query is required');
  }

  const pipeline = parsePplPipeline(request.ppl) as PplPipeline;
  const compiled = buildSearchRequestFromPpl(request, pipeline);
  const context = buildSearchContext(compiled, auth);
  const requestedLimit = clampLimit(request.limit, PPL_MAX_LIMIT);
  const streamLimit = context.mode === 'phrase'
    ? Math.min(200, resolvePipelineLimit(pipeline.stages, requestedLimit, PPL_MAX_LIMIT))
    : resolvePipelineLimit(pipeline.stages, requestedLimit, PPL_MAX_LIMIT);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const incremental = isIncrementalStreamPipeline(pipeline.stages);

  void (async () => {
    try {
      await writeNdjsonLine(writer, encoder, {
        type: 'meta',
        language: 'ppl',
        mode: context.mode,
        stream_mode: incremental ? 'incremental' : 'buffered'
      });

      if (!incremental) {
        const full = await performPplSearch(request, env, auth);
        if (full.result_type === 'events') {
          for (const event of full.results as SearchEvent[]) {
            await writeNdjsonLine(writer, encoder, { type: 'event', event });
          }
        } else {
          for (const row of full.results as Record<string, unknown>[]) {
            await writeNdjsonLine(writer, encoder, { type: 'row', row });
          }
        }
        await writeNdjsonLine(writer, encoder, {
          type: 'final',
          result_type: full.result_type,
          next_cursor: full.next_cursor,
          stats: {
            ...full.stats,
            stream: true,
            latency_ms: Date.now() - startedAt
          },
          warning: full.warning
        });
        return;
      }

      let emitted = 0;
      let candidates = 0;
      let scannedObjects = 0;
      let lastEvent: SearchEvent | null = null;
      const listingTracker = createListingTracker();

      const emitEventIfMatch = async (event: SearchEvent): Promise<boolean> => {
        if (!rowMatchesWhereStages(event as unknown as Record<string, unknown>, pipeline.stages)) {
          return true;
        }
        await writeNdjsonLine(writer, encoder, { type: 'event', event });
        emitted += 1;
        lastEvent = event;
        if (emitted % 25 === 0) {
          const listing = snapshotListingTracker(listingTracker);
          await writeNdjsonLine(writer, encoder, {
            type: 'progress',
            scanned_objects: scannedObjects,
            listed_prefixes: listing.listed_prefixes,
            listing_calls: listing.listing_calls,
            listed_objects: listing.listed_objects,
            listing_fallbacks: listing.listing_fallbacks,
            candidates,
            returned: emitted
          });
        }
        return emitted < streamLimit;
      };

      if (context.mode === 'token') {
        const tokenScan = await scanTokenCandidates(env, context.dates, context.parsed.tokens, context.filters, auth.scope, listingTracker);
        scannedObjects += tokenScan.scannedObjects;
        candidates = tokenScan.ids.length;

        if (tokenScan.ids.length > 0 && emitted < streamLimit) {
          const fetched = await fetchEventsByIdsStream(
            env,
            context.dates,
            new Set(tokenScan.ids),
            context.filters,
            auth.scope,
            context.fromMs,
            context.toMs,
            compiled.cursor,
            emitEventIfMatch,
            listingTracker
          );
          scannedObjects += fetched.scannedObjects;
        }
      } else {
        const scanned = await scanEventsStream(
          env,
          context.dates,
          context.filters,
          auth.scope,
          context.fromMs,
          context.toMs,
          compiled.cursor,
          context.mode === 'phrase' ? context.phrase : null,
          emitEventIfMatch,
          listingTracker
        );
        scannedObjects += scanned.scannedObjects;
      }

      const nextCursorValue = lastEvent
        ? { before_ts: lastEvent.ts, before_event_id: lastEvent.event_id }
        : null;

      const listing = snapshotListingTracker(listingTracker);
      await writeNdjsonLine(writer, encoder, {
        type: 'final',
        result_type: 'events',
        next_cursor: nextCursorValue,
        stats: {
          mode: context.mode,
          scanned_partitions: context.dates.length,
          scanned_objects: scannedObjects,
          listed_prefixes: listing.listed_prefixes,
          listing_calls: listing.listing_calls,
          listed_objects: listing.listed_objects,
          listing_fallbacks: listing.listing_fallbacks,
          candidates,
          returned: emitted,
          language: 'ppl',
          stage_count: pipeline.stages.length,
          stream: true,
          latency_ms: Date.now() - startedAt
        }
      });
    } catch (error) {
      await writeNdjsonLine(writer, encoder, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        guardrail: classifyGuardrailError(error instanceof Error ? error.message : String(error)) || undefined
      }).catch(() => undefined);
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      ...requestCorsHeaders,
      'content-type': NDJSON_CONTENT_TYPE,
      'cache-control': 'no-store'
    }
  });
}

export async function performPplSearchSummary(
  request: { time: { from: string; to: string }; ppl: string; limit?: number; cursor?: { before_ts: string; before_event_id: string } | null },
  env: Env,
  auth: AuthContext
): Promise<SearchSummaryResponse> {
  if (!request?.time?.from || !request?.time?.to) {
    throw new Error('Time range required');
  }
  if (!request.ppl || !String(request.ppl).trim()) {
    throw new Error('ppl query is required');
  }

  const pipeline = parsePplPipeline(request.ppl) as PplPipeline;
  const compiled = buildSearchRequestFromPpl({ ...request, limit: MAX_SUMMARY_EVENTS, cursor: null }, pipeline);
  const context = buildSearchContext(compiled, auth);
  const execution = await executeSearchWithContext(context, env, auth, null, MAX_SUMMARY_EVENTS);
  const summaryLookupCache = await loadLookupCache(pipeline, env);
  const transformed = applyPplPipelineStages(execution.results, pipeline, summaryLookupCache);
  const sampledEvents = transformed.resultType === 'events' ? transformed.rows as SearchEvent[] : [];

  const facets = {
    indexes: countFacet(sampledEvents.map((event) => eventIndex(event)), 8),
    services: countFacet(sampledEvents.map((event) => event.service), 12),
    levels: countFacet(sampledEvents.map((event) => event.level), 6),
    statuses: countFacet(sampledEvents.map((event) => event.status), 8),
    hosts: countFacet(sampledEvents.map((event) => event.host), 10)
  };

  return {
    mode: context.mode,
    sampled_events: sampledEvents.length,
    sampled_candidates: execution.candidates,
    scanned_objects: execution.scannedObjects,
    truncated: execution.results.length >= MAX_SUMMARY_EVENTS,
    top_terms: buildTopTerms(sampledEvents, 24),
    field_presence: buildFieldPresence(sampledEvents),
    facets,
    timeline: buildTimeline(sampledEvents, 72)
  };
}

// --- WAE SQL ---

export async function executeWAESQL(sql: string, env: Env): Promise<WAERow[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return [];
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql })
    }
  );

  if (!response.ok) {
    throw new Error(`WAE SQL request failed: ${response.status}`);
  }

  const payload = await response.json() as { data?: WAERow[] };
  return payload.data || [];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export async function collectRecentEvents(
  env: Env,
  scope: DataScope,
  windowMinutes: number,
  maxEvents = 20000
): Promise<SearchEvent[]> {
  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.now() - (windowMinutes * 60 * 1000)).toISOString();
  const dates = getDateRange(fromIso, toIso).reverse();
  const fromMs = parseISODate(fromIso).getTime();
  const toMs = parseISODate(toIso).getTime();

  const { results } = await scanEvents(env, dates, {}, scope, fromMs, toMs, null, maxEvents, null);
  return results;
}

export async function computeDashboardFallback(query: string, windowMinutes: number, env: Env, scope: DataScope): Promise<WAERow[]> {
  const events = await collectRecentEvents(env, scope, windowMinutes);

  if (query === 'throughput') {
    const counts = new Map<string, number>();
    for (const event of events) {
      const key = event.service || 'unknown';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => Number(b.count) - Number(a.count))
      .slice(0, 20);
  }

  if (query === 'top_hosts') {
    const counts = new Map<string, number>();
    for (const event of events) {
      const key = event.host || 'unknown';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => Number(b.count) - Number(a.count))
      .slice(0, 20);
  }

  if (query === 'top_errors') {
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.level !== 'error') continue;
      const key = `${event.service || 'unknown'}::${event.msg_hash || 'no_hash'}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => {
        const [service, msg_hash] = key.split('::');
        return { service, msg_hash, count };
      })
      .sort((a, b) => Number(b.count) - Number(a.count))
      .slice(0, 20);
  }

  if (query === 'error_rate_by_service') {
    const totals = new Map<string, { total: number; errors: number }>();
    for (const event of events) {
      const key = event.service || 'unknown';
      const row = totals.get(key) || { total: 0, errors: 0 };
      row.total += 1;
      if (event.level === 'error') row.errors += 1;
      totals.set(key, row);
    }
    return Array.from(totals.entries())
      .map(([service, row]) => ({
        service,
        errors: row.errors,
        total: row.total,
        error_rate: row.total > 0 ? (100 * row.errors) / row.total : 0
      }))
      .sort((a, b) => Number(b.error_rate) - Number(a.error_rate))
      .slice(0, 20);
  }

  if (query === 'latency_p95_by_service') {
    const durations = new Map<string, number[]>();
    for (const event of events) {
      if (event.duration_ms === undefined || event.duration_ms <= 0) continue;
      const key = event.service || 'unknown';
      const arr = durations.get(key) || [];
      arr.push(event.duration_ms);
      durations.set(key, arr);
    }
    return Array.from(durations.entries())
      .map(([service, samples]) => ({
        service,
        p95_latency: percentile(samples, 95)
      }))
      .sort((a, b) => Number(b.p95_latency) - Number(a.p95_latency))
      .slice(0, 20);
  }

  return [];
}

export function buildWaeScopeWhere(scope: DataScope): { whereSql: string; requiresFallback: boolean } {
  const dimensions: Array<{ values: string[]; column: string }> = [
    { values: scope.indexes, column: 'index1' },
    { values: scope.services, column: 'blob1' },
    { values: scope.envs, column: 'blob2' },
    { values: scope.hosts, column: 'blob3' }
  ];

  let whereSql = '';
  let requiresFallback = false;
  for (const dimension of dimensions) {
    const values = dimension.values;
    if (values.includes('*')) continue;
    if (!valuesAreSqlExact(values)) {
      requiresFallback = true;
      continue;
    }
    const inList = values.map(sqlLiteral).join(', ');
    whereSql += `\n        AND ${dimension.column} IN (${inList})`;
  }

  return { whereSql, requiresFallback };
}
