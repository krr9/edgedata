/**
 * Helper/utility functions extracted from query-worker index.
 */

import type {
  DashboardPanelRow,
  DashboardRow,
  DashboardWidgetType,
  ExecutionMode,
  ExecutionPolicy,
  PerformanceProfile,
  ScheduledSearchResultRow,
  ScheduledSearchRow,
  SearchEvent
} from './types.js';
import {
  DEFAULT_EVENT_INDEX,
  DEFAULT_LIMIT,
  MAX_LIMIT
} from './types.js';
import {
  normalizeBooleanFlag,
  normalizeCacheTtlSeconds,
  normalizeExecutionMode,
  normalizeMaterializeIntervalSeconds,
  normalizeMaxStalenessSeconds,
  normalizePerformanceProfile
} from './performance-policy.mjs';

const DASHBOARD_WIDGET_TYPES: DashboardWidgetType[] = ['timeseries', 'bar', 'pie', 'table', 'kpi', 'topn', 'markdown'];
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  execution_mode: 'live',
  cache_ttl_seconds: 120,
  materialize_enabled: false,
  materialize_interval_seconds: 300,
  max_staleness_seconds: 600,
  priority: 0
};

// --- Response helpers ---

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders
    }
  });
}

export function textResponse(text: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: extraHeaders
  });
}

export function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...extraHeaders
    }
  });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// --- Limit / sort / parse helpers ---

export function clampLimit(limit: number | undefined, maxLimit = MAX_LIMIT): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), maxLimit));
}

export function compareEventsDesc(a: SearchEvent, b: SearchEvent): number {
  if (a.ts !== b.ts) return b.ts.localeCompare(a.ts);
  return b.event_id.localeCompare(a.event_id);
}

export function asPositiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function valuesAreSqlExact(values: string[]): boolean {
  return values.every((value) => value === '*' || !value.includes('*'));
}

// --- JSON / dashboard normalization helpers ---

export function normalizeJsonInput(input: unknown, fallback: string): string {
  if (typeof input === 'string') {
    try {
      JSON.parse(input);
      return input;
    } catch {
      return fallback;
    }
  }
  if (input && typeof input === 'object') {
    return JSON.stringify(input);
  }
  return fallback;
}

export function mapLegacyVizToWidgetType(vizType: string | null | undefined): DashboardWidgetType {
  const value = String(vizType || 'table').toLowerCase();
  if (value === 'counter' || value === 'stat') return 'kpi';
  if (value === 'timechart') return 'timeseries';
  if (value === 'top') return 'topn';
  if ((DASHBOARD_WIDGET_TYPES as string[]).includes(value)) return value as DashboardWidgetType;
  return 'table';
}

export function mapWidgetTypeToLegacyViz(widgetType: DashboardWidgetType): string {
  if (widgetType === 'timeseries') return 'timechart';
  if (widgetType === 'kpi') return 'stat';
  if (widgetType === 'topn') return 'bar';
  return widgetType;
}

export function normalizeWidgetType(value: unknown): DashboardWidgetType {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'table';
  if (raw === 'counter' || raw === 'stat') return 'kpi';
  if (raw === 'timechart') return 'timeseries';
  if ((DASHBOARD_WIDGET_TYPES as string[]).includes(raw)) return raw as DashboardWidgetType;
  return 'table';
}

export function defaultLayoutForPanel(position: number, widgetType: DashboardWidgetType): string {
  const safePosition = Math.max(0, Math.trunc(position || 0));
  const width = widgetType === 'kpi' ? 3 : 6;
  const height = widgetType === 'kpi' ? 4 : 8;
  return JSON.stringify({
    x: (safePosition % 2) * 6,
    y: Math.trunc(safePosition / 2) * 8,
    w: width,
    h: height,
    minW: Math.min(width, 3),
    minH: Math.min(height, 4)
  });
}

export function parseJsonObject(input: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!input) return { ...fallback };
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return { ...fallback };
    } catch {
      return { ...fallback };
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { ...fallback };
}

export function parseJsonRecordArray(input: unknown): Record<string, unknown>[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[];
  }
  if (typeof input !== 'string') return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export function normalizeDashboardPanelRow(row: DashboardPanelRow): Record<string, unknown> {
  const widgetType = row.widget_type
    ? mapLegacyVizToWidgetType(row.widget_type)
    : mapLegacyVizToWidgetType(row.viz_type);
  const queryText = String(row.query_text || row.ppl || '').trim();
  const normalizedLayoutJson = normalizeJsonInput(
    row.layout_json,
    defaultLayoutForPanel(row.position, widgetType)
  );
  return {
    ...row,
    widget_type: widgetType,
    query_text: queryText,
    query_mode: String(row.query_mode || 'ppl'),
    execution_mode: normalizeExecutionMode(row.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode),
    cache_ttl_seconds: normalizeCacheTtlSeconds(row.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds),
    materialize_enabled: normalizeBooleanFlag(row.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled),
    materialize_interval_seconds: normalizeMaterializeIntervalSeconds(row.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds),
    max_staleness_seconds: normalizeMaxStalenessSeconds(row.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds),
    priority: Number.isFinite(Number(row.priority)) ? Math.max(0, Math.trunc(Number(row.priority))) : 0,
    viz_config_json: normalizeJsonInput(row.viz_config_json || row.options_json, '{}'),
    layout_json: normalizedLayoutJson,
    bindings_json: normalizeJsonInput(row.bindings_json, '{}'),
    display_options_json: normalizeJsonInput(row.display_options_json, '{}'),
    viz_type: row.viz_type || mapWidgetTypeToLegacyViz(widgetType),
    ppl: row.ppl || queryText,
    layout: parseJsonObject(normalizedLayoutJson, {}),
    bindings: parseJsonObject(row.bindings_json, {}),
    viz_config: parseJsonObject(row.viz_config_json || row.options_json, {}),
    display_options: parseJsonObject(row.display_options_json, {})
  };
}

export function normalizeDashboardRow(row: DashboardRow): Record<string, unknown> {
  return {
    ...row,
    performance_profile: normalizePerformanceProfile(row.performance_profile, 'economy') as PerformanceProfile,
    default_execution_mode: normalizeExecutionMode(row.default_execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode) as ExecutionMode
  };
}

export function normalizeScheduledSearchRow(row: ScheduledSearchRow): Record<string, unknown> {
  return {
    ...row,
    execution_mode: normalizeExecutionMode(row.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode),
    cache_ttl_seconds: normalizeCacheTtlSeconds(row.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds),
    materialize_enabled: normalizeBooleanFlag(row.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled),
    materialize_interval_seconds: normalizeMaterializeIntervalSeconds(row.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds),
    max_staleness_seconds: normalizeMaxStalenessSeconds(row.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds)
  };
}

export function normalizeScheduledSearchResultRow(
  row: ScheduledSearchResultRow,
  options: { includePreview?: boolean } = {}
): Record<string, unknown> {
  const preview = parseJsonRecordArray(row.preview_json || row.results_json);
  return {
    id: row.id,
    scheduled_search_id: row.scheduled_search_id,
    run_at: row.run_at,
    time_from: row.time_from,
    time_to: row.time_to,
    status: row.status,
    result_count: row.result_count,
    trigger_type: row.trigger_type || 'schedule',
    requested_by: row.requested_by || null,
    summary: parseJsonObject(row.summary_json, {}),
    comparison: parseJsonObject(row.comparison_json, {}),
    stats: parseJsonObject(row.stats_json, {}),
    error_message: row.error_message || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    baseline_run_id: row.baseline_run_id || null,
    materialized_result_id: row.materialized_result_id || null,
    has_full_results: Boolean(row.materialized_result_id),
    preview: options.includePreview ? preview : undefined
  };
}
