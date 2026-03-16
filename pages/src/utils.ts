import React from 'react';
import type { InvestigationPivots } from './investigation/types';
import {
  ALERT_TEMPLATE_PRESETS,
  ASK_AI_INTENT_WORDS,
  ASK_AI_STOPWORDS,
  LOCAL_FALLBACK_SNIPPETS,
  NAV_ICONS,
  PPL_COMMAND_PREFIX,
  TAB_QUERY_PARAM,
  THEME_STORAGE_KEY,
  VIEW_MODES
} from './constants';
import type {
  AlertDefinition,
  AlertNotifyConfig,
  AlertParamsConfig,
  AlertQueryTemplate,
  AlertTemplatePreset,
  AskAiPlan,
  FacetItem,
  GuardrailExplanation,
  LogEvent,
  NavIconKey,
  QuerySuggestionItem,
  SearchFilterState,
  SearchMode,
  ThemePreference,
  ViewMode
} from './types';

export function parseViewMode(raw: string | null): ViewMode | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(/^#/, '');
  if (!normalized) return null;
  if (VIEW_MODES.has(normalized as ViewMode)) return normalized as ViewMode;

  const hashParams = new URLSearchParams(normalized.startsWith('?') ? normalized.slice(1) : normalized);
  const nested = hashParams.get(TAB_QUERY_PARAM);
  if (!nested) return null;
  return VIEW_MODES.has(nested as ViewMode) ? (nested as ViewMode) : null;
}

export function readViewFromLocation(loc: Pick<Location, 'search' | 'hash'>): ViewMode | null {
  const params = new URLSearchParams(loc.search);
  return parseViewMode(params.get(TAB_QUERY_PARAM)) || parseViewMode(loc.hash);
}

export function writeViewToLocation(view: ViewMode, options?: { replace?: boolean }): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get(TAB_QUERY_PARAM) === view) return;

  url.searchParams.set(TAB_QUERY_PARAM, view);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (options?.replace) {
    window.history.replaceState({}, '', nextUrl);
  } else {
    window.history.pushState({}, '', nextUrl);
  }
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function formatDateTimeLocalValue(date: Date): string {
  const pad2 = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function toUtcIsoFromLocalDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid local datetime: ${value}`);
  }
  return parsed.toISOString();
}

export function toUtcIso(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Datetime value is required');
  }
  // Accept full ISO input from workspace/session handoff without truncating precision.
  if (/z$/i.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error(`Invalid datetime: ${value}`);
    }
    return parsed.toISOString();
  }
  return toUtcIsoFromLocalDateTime(trimmed);
}

export function renderNavIcon(icon: NavIconKey): React.ReactElement {
  const Icon = NAV_ICONS[icon];
  return React.createElement(Icon, { strokeWidth: 2.15 });
}

export function quotePplLiteral(value: string): string {
  if (!/[\s"'=<>]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildScopedConditions(filterState: SearchFilterState, pivots: InvestigationPivots): string[] {
  const conditions: string[] = [];
  if (filterState.indexName.trim()) conditions.push(`index=${quotePplLiteral(filterState.indexName.trim().toLowerCase())}`);
  if (filterState.service.trim()) conditions.push(`service=${quotePplLiteral(filterState.service.trim())}`);
  if (filterState.environment.trim()) conditions.push(`env=${quotePplLiteral(filterState.environment.trim())}`);
  if (filterState.host.trim()) conditions.push(`host=${quotePplLiteral(filterState.host.trim())}`);
  if (filterState.level.trim()) conditions.push(`level=${quotePplLiteral(filterState.level.trim().toLowerCase())}`);
  if (filterState.statusCode.trim()) {
    const numeric = Number(filterState.statusCode.trim());
    if (!Number.isNaN(numeric)) conditions.push(`status=${Math.trunc(numeric)}`);
  }
  if (pivots.trace_id) conditions.push(`trace_id=${quotePplLiteral(pivots.trace_id)}`);
  if (pivots.request_id) conditions.push(`request_id=${quotePplLiteral(pivots.request_id)}`);
  if (pivots.user_id) conditions.push(`user_id=${quotePplLiteral(pivots.user_id)}`);
  if (pivots.msg_hash) conditions.push(`msg_hash=${quotePplLiteral(pivots.msg_hash)}`);
  return conditions;
}

export function tokenizeAskPrompt(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .normalize('NFKD')
    .replace(/["',!?()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !ASK_AI_STOPWORDS.has(token))
    .filter((token) => token.length >= 2)
    .filter((token) => !ASK_AI_INTENT_WORDS.has(token))
    .filter((token) => !/^(last|next|past)\d+$/.test(token))
    .filter((token) => !/^\d+(ms|s|m|h|d)?$/.test(token));
}

export function buildAskAiPlan(options: {
  prompt: string;
  filters: SearchFilterState;
  pivots: InvestigationPivots;
  topTerms: string[];
}): AskAiPlan {
  const prompt = String(options.prompt || '').trim();
  const scopedConditions = buildScopedConditions(options.filters, options.pivots);
  const reasoning: string[] = ['Runs in the current Log Explorer so results, facets, and pivots stay in one place.'];

  if (scopedConditions.length > 0) {
    reasoning.push('Keeps the current explorer filters and investigation pivots in scope.');
  } else {
    reasoning.push('Uses the current time range and keeps index/service scope broad unless the prompt narrows it.');
  }

  if (!prompt) {
    const generatedPpl = scopedConditions.length > 0
      ? `search * | where ${scopedConditions.join(' and ')} | sort -ts | head 200`
      : 'search * | sort -ts | head 200';
    reasoning.push('No AI prompt entered yet, so this stays as a broad recent-events search.');
    return {
      intentLabel: 'Broad exploration',
      confidence: 'low',
      generatedPpl,
      reasoning,
      passthrough: false
    };
  }

  if (prompt.includes('|') || PPL_COMMAND_PREFIX.test(prompt)) {
    reasoning.push('Input already looks like PPL, so Ask AI will pass it through unchanged.');
    return {
      intentLabel: 'Direct PPL passthrough',
      confidence: 'high',
      generatedPpl: prompt,
      reasoning,
      passthrough: true
    };
  }

  const lower = prompt.toLowerCase();
  const inferredConditions: string[] = [];
  let confidence: AskAiPlan['confidence'] = 'medium';
  let intentLabel = 'Guided exploration';

  const quotedPhrase = prompt.match(/"([^"]+)"/)?.[1]?.trim();
  const routeToken = prompt.match(/\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*/)?.[0]?.trim();
  const traceId = /\btrace(?:[_\s-]?id)?\b/i.test(prompt)
    ? prompt.match(/\b([0-9a-f]{16,32})\b/i)?.[1]
    : undefined;
  const requestId = /\brequest(?:[_\s-]?id)?\b/i.test(prompt)
    ? prompt.match(/\brequest(?:[_\s-]?id)?[:=\s]+([A-Za-z0-9._:-]{6,})\b/i)?.[1]
    : undefined;
  const explicitStatus = lower.match(/\bstatus(?: code)?\s*(?:=|is|of)?\s*(\d{3})\b/)?.[1];
  const statusClass = lower.match(/\b([45])xx\b/)?.[1];
  const durationMs = lower.match(/\b(?:over|above|greater than|slower than|longer than)\s*(\d+)\s*ms\b/)?.[1];
  const durationSeconds = lower.match(/\b(?:over|above|greater than|slower than|longer than)\s*(\d+)\s*(?:s|sec|secs|seconds)\b/)?.[1];

  if (traceId) {
    intentLabel = 'Trace investigation';
    confidence = 'high';
    inferredConditions.push(`trace_id=${quotePplLiteral(traceId)}`);
    reasoning.push(`Detected trace lookup for ${traceId}.`);
  } else if (requestId) {
    intentLabel = 'Request investigation';
    confidence = 'high';
    inferredConditions.push(`request_id=${quotePplLiteral(requestId)}`);
    reasoning.push(`Detected request lookup for ${requestId}.`);
  } else if (/\b(latency|slow|slower|duration|p95|performance)\b/i.test(prompt)) {
    intentLabel = 'Latency investigation';
    const threshold = durationMs
      ? Number(durationMs)
      : durationSeconds
        ? Number(durationSeconds) * 1000
        : 1000;
    inferredConditions.push(`duration_ms>=${Math.trunc(threshold)}`);
    reasoning.push(`Interpreted this as a latency investigation and added duration_ms>=${Math.trunc(threshold)}.`);
  } else if (/\b(error|errors|fail|failed|failure|exception|5xx)\b/i.test(prompt)) {
    intentLabel = 'Error investigation';
    if (statusClass) {
      inferredConditions.push(`status>=${Number(statusClass) * 100}`);
      reasoning.push(`Detected ${statusClass}xx status focus and constrained status accordingly.`);
    } else if (explicitStatus) {
      inferredConditions.push(`status=${Math.trunc(Number(explicitStatus))}`);
      reasoning.push(`Detected explicit status ${explicitStatus}.`);
      confidence = 'high';
    } else {
      inferredConditions.push('level="error"');
      reasoning.push('Interpreted this as an error-focused query and constrained level="error".');
    }
  } else if (/\b(warn|warning|warnings)\b/i.test(prompt)) {
    intentLabel = 'Warning investigation';
    inferredConditions.push('level="warn"');
    reasoning.push('Interpreted this as a warning-focused query and constrained level="warn".');
  }

  if (explicitStatus && !inferredConditions.some((condition) => condition.startsWith('status='))) {
    inferredConditions.push(`status=${Math.trunc(Number(explicitStatus))}`);
    reasoning.push(`Added explicit status=${explicitStatus} from the prompt.`);
    confidence = 'high';
  }

  const rawTokens = tokenizeAskPrompt(prompt);
  const routeAwareTokens = routeToken
    ? [routeToken, ...rawTokens.filter((token) => token !== routeToken.toLowerCase())]
    : rawTokens;
  const searchTokens = routeAwareTokens
    .filter((token) => !traceId || token !== traceId.toLowerCase())
    .filter((token) => !requestId || token !== requestId.toLowerCase())
    .slice(0, 6);

  let searchExpr = '*';
  if (quotedPhrase) {
    searchExpr = quotePplLiteral(quotedPhrase);
    reasoning.push('Treats the quoted text as an exact phrase search.');
    if (confidence === 'low') confidence = 'medium';
  } else if (searchTokens.length > 0) {
    searchExpr = searchTokens
      .map((token) => (/^[a-z0-9:_/-]+$/i.test(token) ? token : quotePplLiteral(token)))
      .join(' ');
    reasoning.push(`Uses prompt keywords as search terms: ${searchTokens.join(', ')}.`);
  } else if (options.topTerms.length > 0) {
    searchExpr = options.topTerms.slice(0, 2).map((term) => quotePplLiteral(term)).join(' ');
    reasoning.push('No strong keywords were detected, so this falls back to recent top terms from the current dataset.');
    confidence = 'low';
  }

  const whereConditions = [...scopedConditions, ...inferredConditions];
  let generatedPpl = `search ${searchExpr}`;
  if (whereConditions.length > 0) {
    generatedPpl += ` | where ${whereConditions.join(' and ')}`;
  }
  generatedPpl += ' | sort -ts | head 200';

  return {
    intentLabel,
    confidence,
    generatedPpl,
    reasoning,
    passthrough: false
  };
}

export function buildTraceContextPplFromEvent(event: Pick<LogEvent, 'trace_id' | 'index' | 'service' | 'env'>): string {
  const traceId = String(event.trace_id || '').trim();
  if (!traceId) return 'search *';

  const conditions: string[] = [`trace_id=${quotePplLiteral(traceId)}`];
  const indexValue = String(event.index || '').trim().toLowerCase();
  const serviceValue = String(event.service || '').trim();
  const envValue = String(event.env || '').trim();
  if (indexValue) conditions.push(`index=${quotePplLiteral(indexValue)}`);
  if (serviceValue) conditions.push(`service=${quotePplLiteral(serviceValue)}`);
  if (envValue) conditions.push(`env=${quotePplLiteral(envValue)}`);

  return `search * | where ${conditions.join(' and ')} | transaction trace_id maxspan=5m maxevents=200 | sort -ts | head 200`;
}

export function buildInlineSuggestionQuery(currentQuery: string, replacement: string): string {
  const segmentStart = currentQuery.lastIndexOf('|') + 1;
  const prefix = currentQuery.slice(0, segmentStart);
  if (!prefix) return replacement;
  if (prefix.endsWith('|')) return `${prefix} ${replacement}`;
  return `${prefix}${replacement}`;
}

export function buildLocalFallbackSuggestions(query: string): QuerySuggestionItem[] {
  const segment = query.slice(query.lastIndexOf('|') + 1).trim().toLowerCase();
  return LOCAL_FALLBACK_SNIPPETS
    .filter((item) => !segment || item.label.startsWith(segment))
    .map((item, index) => ({
      label: item.label,
      kind: item.kind,
      detail: item.detail,
      next_query: buildInlineSuggestionQuery(query, item.insert),
      score: 30 - index
    }))
    .slice(0, 6);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function extractHighlightTerms(query: string): string[] {
  if (!query.trim()) return [];

  const phraseMatches = Array.from(query.matchAll(/"([^"]+)"/g)).map((match) => match[1]);
  const raw = query
    .replace(/"[^"]+"/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/[=<>]/.test(token))
    .filter((token) => token.length >= 2);

  const phraseTerms = phraseMatches.flatMap((phrase) => phrase.split(/\s+/).filter((t) => t.length >= 2));
  const set = new Set([...raw, ...phraseTerms].map((term) => term.toLowerCase()));
  return Array.from(set).slice(0, 18);
}

export function highlightText(text: string, terms: string[]): React.ReactElement {
  if (!terms.length) return React.createElement(React.Fragment, null, text);

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'ig');
  const parts = text.split(pattern);
  const lowerTerms = new Set(terms.map((term) => term.toLowerCase()));

  return React.createElement(
    React.Fragment,
    null,
    parts.map((part, index) => {
      const matched = lowerTerms.has(part.toLowerCase());
      return matched
        ? React.createElement('mark', { key: `${part}-${index}` }, part)
        : React.createElement('span', { key: `${part}-${index}` }, part);
    })
  );
}

export function jsonSyntaxHtml(raw: string): string {
  const escaped = escapeHtml(raw);
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      if (match.endsWith(':')) return `<span class="json-key">${match}</span>`;
      if (match.startsWith('"')) return `<span class="json-string">${match}</span>`;
      if (match === 'true' || match === 'false') return `<span class="json-bool">${match}</span>`;
      if (match === 'null') return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    }
  );
}

export function prettyJsonOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}

export function attrsPreviewPairs(attrsJson: string | undefined, limit = 3): Array<{ key: string; value: string }> {
  if (!attrsJson) return [];
  try {
    const parsed = JSON.parse(attrsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed)
      .slice(0, limit)
      .map(([key, value]) => ({ key, value: String(value) }));
  } catch {
    return [];
  }
}

export function toFacet(items: Array<string | number | undefined>, limit = 10): FacetItem[] {
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

export function modeLabel(mode: SearchMode | null): string {
  if (!mode) return 'Auto';
  if (mode === 'structured') return 'Structured';
  if (mode === 'token') return 'Token';
  return 'Phrase';
}

export function toGuardrailExplanation(value: unknown): GuardrailExplanation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const code = String(candidate.code || '').trim();
  const title = String(candidate.title || '').trim();
  const reason = String(candidate.reason || '').trim();
  const suggestion = String(candidate.suggestion || '').trim();
  if (!code || !title || !reason || !suggestion) return null;
  return { code, title, reason, suggestion };
}

export function parseErrorPayload(
  rawText: string,
  fallbackMessage: string
): { message: string; guardrail: GuardrailExplanation | null } {
  const text = String(rawText || '').trim();
  if (!text) return { message: fallbackMessage, guardrail: null };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = String(parsed.error || fallbackMessage).trim() || fallbackMessage;
    return {
      message,
      guardrail: toGuardrailExplanation(parsed.guardrail)
    };
  } catch {
    return { message: text, guardrail: null };
  }
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function formatTimelineTick(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function compareEventsDesc(left: LogEvent, right: LogEvent): number {
  const tsCompare = right.ts.localeCompare(left.ts);
  if (tsCompare !== 0) return tsCompare;
  return right.event_id.localeCompare(left.event_id);
}

export function sortEventsNewestFirst(events: LogEvent[]): LogEvent[] {
  return [...events].sort(compareEventsDesc);
}

export function readLevelCount(levels: FacetItem[], target: string): number {
  return levels.find((item) => item.value === target)?.count || 0;
}

export function maxFacetCount(items: FacetItem[]): number {
  return Math.max(1, ...items.map((item) => item.count));
}

export function parseStringArray(raw: string | undefined, fallback: string[] = []): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return fallback;
  }
}

export function resolveAlertTemplatePreset(id: string): AlertTemplatePreset {
  return ALERT_TEMPLATE_PRESETS.find((preset) => preset.id === id) || ALERT_TEMPLATE_PRESETS[0];
}

export function buildAlertDeepQuery(
  template: AlertQueryTemplate,
  params: { index?: string; service?: string; env?: string; token?: string },
  thresholdValue: number
): string {
  const whereFilters: string[] = [];
  const indexValue = String(params.index || '').trim().toLowerCase();
  const serviceValue = String(params.service || '').trim();
  const envValue = String(params.env || '').trim();

  if (indexValue) whereFilters.push(`index=${quotePplLiteral(indexValue)}`);
  if (serviceValue) whereFilters.push(`service=${quotePplLiteral(serviceValue)}`);
  if (envValue) whereFilters.push(`env=${quotePplLiteral(envValue)}`);

  if (template === 'error_rate_over_threshold') {
    const filters = [...whereFilters, 'level="error"'];
    return `search * | where ${filters.join(' and ')}`;
  }

  if (template === 'latency_p95_over_threshold') {
    const cutoff = Number.isFinite(thresholdValue) ? Math.max(1, Math.floor(thresholdValue)) : 1;
    const filters = [...whereFilters, `duration_ms>=${cutoff}`];
    return `search * | where ${filters.join(' and ')}`;
  }

  const tokenValue = String(params.token || '').trim();
  const searchTerm = tokenValue ? quotePplLiteral(tokenValue) : '*';
  if (whereFilters.length === 0) return `search ${searchTerm}`;
  return `search ${searchTerm} | where ${whereFilters.join(' and ')}`;
}

export function buildDefaultAlertDeepLink(query: string): string {
  if (typeof window === 'undefined') return '';
  const base = window.location.origin.replace(/\/+$/, '');
  if (!base || !query.trim()) return '';
  return `${base}/?view=search&query=${encodeURIComponent(query)}`;
}

export function parseAlertNotifyConfig(raw: string): AlertNotifyConfig {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return {
      slack: parsed.slack === true,
      webhook: parsed.webhook === true,
      severity: String(parsed.severity || '').trim() || undefined,
      deep_link: String(parsed.deep_link || '').trim() || undefined,
      runbook_url: String(parsed.runbook_url || '').trim() || undefined,
      owner_team: String(parsed.owner_team || '').trim() || undefined
    };
  } catch {
    return {};
  }
}

export function parseAlertParamsConfig(raw: string): AlertParamsConfig {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const windowMinutesRaw = Number(parsed.window_minutes);
    return {
      index: String(parsed.index || '').trim() || undefined,
      service: String(parsed.service || '').trim() || undefined,
      env: String(parsed.env || '').trim() || undefined,
      window_minutes: Number.isFinite(windowMinutesRaw) && windowMinutesRaw > 0
        ? Math.trunc(windowMinutesRaw)
        : undefined,
      token: String(parsed.token || '').trim() || undefined,
      _starter_id: String(parsed._starter_id || '').trim() || undefined,
      _starter_version: String(parsed._starter_version || '').trim() || undefined
    };
  } catch {
    return {};
  }
}

export interface InvestigationContext {
  source?: string;
  sourceLabel?: string;
  index?: string;
  service?: string;
  env?: string;
  trace_id?: string;
  request_id?: string;
  user_id?: string;
  msg_hash?: string;
  time_from?: string;
  time_to?: string;
}

export function buildInvestigationHref(ctx: InvestigationContext): string {
  const query = new URLSearchParams();
  query.set('view', 'workspace');
  for (const [k, v] of Object.entries(ctx)) {
    if (v) query.set(k, v);
  }
  return `?${query.toString()}`;
}

export function parseInvestigationUrlParams(loc: Pick<Location, 'search'>): InvestigationContext | null {
  const params = new URLSearchParams(loc.search);
  if (params.get('view') !== 'workspace') return null;
  const ctx: InvestigationContext = {};
  let hasContext = false;
  for (const key of ['source', 'sourceLabel', 'index', 'service', 'env', 'trace_id', 'request_id', 'user_id', 'msg_hash', 'time_from', 'time_to'] as const) {
    const v = params.get(key)?.trim();
    if (v) { ctx[key] = v; hasContext = true; }
  }
  return hasContext ? ctx : null;
}

export function buildAlertWorkspaceHref(alert: AlertDefinition): string | null {
  const params = parseAlertParamsConfig(alert.params_json);
  const service = String(params.service || '').trim();
  if (!service) return null;
  return buildInvestigationHref({
    source: 'alert',
    sourceLabel: alert.name,
    service,
    index: params.index,
    env: params.env
  });
}

export function formatTimeCompact(ts: string): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}
