import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  Bookmark,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  SunMoon,
  UserRound,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from './AuthContext';
import { AuthScreen } from './AuthScreen';
import { IncidentWorkspacePage, type WorkspaceStarterSelection } from './investigation/IncidentWorkspacePage';
import { PivotChips } from './investigation/PivotChips';
import { RelatedEventsPanel } from './investigation/RelatedEventsPanel';
import {
  type InvestigationPivots,
  type PivotKey,
  type RelatedEvent,
  hasPivots,
  parseInvestigationParams,
  pivotsFromRelatedEvent
} from './investigation/types';

const DashboardPage = lazy(async () => {
  const mod = await import('./dashboard/DashboardPage');
  return { default: mod.DashboardPage };
});

type ViewMode = 'search' | 'dashboard' | 'saved' | 'scheduled' | 'alerts' | 'admin' | 'livetail' | 'workspace';
type SearchMode = 'structured' | 'token' | 'phrase';
type ThemeMode = 'light' | 'dark';
type ThemePreference = 'system' | ThemeMode;
type NavIconKey = ViewMode | 'signout' | 'user';
type AlertThresholdOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
type AlertQueryTemplate = 'error_rate_over_threshold' | 'latency_p95_over_threshold' | 'token_spike';
type AlertType = 'wae_sql' | 'r2sql_token_spike';

interface AlertTemplatePreset {
  id: AlertQueryTemplate;
  label: string;
  description: string;
  type: AlertType;
  defaultWindowMinutes: number;
  defaultThresholdOperator: AlertThresholdOperator;
  defaultThresholdValue: number;
  defaultScheduleSeconds: number;
  defaultCooldownSeconds: number;
  defaultSeverity: 'critical' | 'warn' | 'info';
  defaultToken?: string;
}

const TAB_QUERY_PARAM = 'tab';
const THEME_STORAGE_KEY = 'edgedata.theme';
const VIEW_MODES = new Set<ViewMode>(['search', 'dashboard', 'saved', 'scheduled', 'alerts', 'admin', 'livetail', 'workspace']);
const TIME_RANGE_PRESETS: Array<{ label: string; fromOffsetMinutes: number; toOffsetMinutes: number }> = [
  { label: 'Last 15m', fromOffsetMinutes: 15, toOffsetMinutes: 0 },
  { label: 'Last 1h', fromOffsetMinutes: 60, toOffsetMinutes: 0 },
  { label: 'Last 6h', fromOffsetMinutes: 6 * 60, toOffsetMinutes: 0 },
  { label: 'Last 24h', fromOffsetMinutes: 24 * 60, toOffsetMinutes: 0 },
  { label: 'Previous 24h', fromOffsetMinutes: 48 * 60, toOffsetMinutes: 24 * 60 },
  { label: 'Last 7d', fromOffsetMinutes: 7 * 24 * 60, toOffsetMinutes: 0 },
  { label: 'Last 30d', fromOffsetMinutes: 30 * 24 * 60, toOffsetMinutes: 0 }
];

const ALERT_TEMPLATE_PRESETS: AlertTemplatePreset[] = [
  {
    id: 'error_rate_over_threshold',
    label: 'Service Error Rate Spike',
    description: 'Alert when error percentage rises above a threshold.',
    type: 'wae_sql',
    defaultWindowMinutes: 5,
    defaultThresholdOperator: 'gt',
    defaultThresholdValue: 5,
    defaultScheduleSeconds: 60,
    defaultCooldownSeconds: 300,
    defaultSeverity: 'critical'
  },
  {
    id: 'latency_p95_over_threshold',
    label: 'Service Latency p95 Regression',
    description: 'Alert when p95 latency stays above a threshold.',
    type: 'wae_sql',
    defaultWindowMinutes: 10,
    defaultThresholdOperator: 'gt',
    defaultThresholdValue: 1200,
    defaultScheduleSeconds: 60,
    defaultCooldownSeconds: 300,
    defaultSeverity: 'warn'
  },
  {
    id: 'token_spike',
    label: 'Keyword / Token Spike',
    description: 'Alert when a token appears unusually often in the selected window.',
    type: 'r2sql_token_spike',
    defaultWindowMinutes: 5,
    defaultThresholdOperator: 'gt',
    defaultThresholdValue: 20,
    defaultScheduleSeconds: 60,
    defaultCooldownSeconds: 300,
    defaultSeverity: 'critical',
    defaultToken: 'unauthorized'
  }
];

const ALERT_THRESHOLD_OPERATOR_OPTIONS: Array<{ value: AlertThresholdOperator; label: string }> = [
  { value: 'gt', label: 'Greater than (>)' },
  { value: 'gte', label: 'Greater than or equal (>=)' },
  { value: 'lt', label: 'Less than (<)' },
  { value: 'lte', label: 'Less than or equal (<=)' },
  { value: 'eq', label: 'Equal (=)' }
];

function parseViewMode(raw: string | null): ViewMode | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(/^#/, '');
  if (!normalized) return null;
  if (VIEW_MODES.has(normalized as ViewMode)) return normalized as ViewMode;

  const hashParams = new URLSearchParams(normalized.startsWith('?') ? normalized.slice(1) : normalized);
  const nested = hashParams.get(TAB_QUERY_PARAM);
  if (!nested) return null;
  return VIEW_MODES.has(nested as ViewMode) ? (nested as ViewMode) : null;
}

function readViewFromLocation(loc: Pick<Location, 'search' | 'hash'>): ViewMode | null {
  const params = new URLSearchParams(loc.search);
  return parseViewMode(params.get(TAB_QUERY_PARAM)) || parseViewMode(loc.hash);
}

function writeViewToLocation(view: ViewMode, options?: { replace?: boolean }): void {
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

function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function formatDateTimeLocalValue(date: Date): string {
  const pad2 = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function toUtcIsoFromLocalDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid local datetime: ${value}`);
  }
  return parsed.toISOString();
}

function toUtcIso(value: string): string {
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

const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
  search: Search,
  dashboard: LayoutDashboard,
  alerts: Bell,
  saved: Bookmark,
  scheduled: Clock3,
  livetail: Activity,
  workspace: Briefcase,
  admin: Settings,
  signout: LogOut,
  user: UserRound
};

function renderNavIcon(icon: NavIconKey): JSX.Element {
  const Icon = NAV_ICONS[icon];
  return <Icon strokeWidth={2.15} />;
}

function quotePplLiteral(value: string): string {
  if (!/[\s"'=<>]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildTraceContextPplFromEvent(event: Pick<LogEvent, 'trace_id' | 'index' | 'service' | 'env'>): string {
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

interface LogEvent {
  event_id: string;
  ts: string;
  index?: string;
  service: string;
  env: string;
  host: string;
  level: string;
  message: string;
  message_lc?: string;
  trace_id?: string;
  request_id?: string;
  msg_hash?: string;
  status?: number;
  duration_ms?: number;
  span_id?: string;
  parent_span_id?: string;
  user_id?: string;
  src_ip?: string;
  attrs_json?: string;
}

interface SearchStats {
  mode: SearchMode;
  scanned_partitions: number;
  scanned_objects: number;
  candidates: number;
  returned: number;
}

interface GuardrailExplanation {
  code: string;
  title: string;
  reason: string;
  suggestion: string;
}

interface SearchResponse {
  result_type?: 'events' | 'table';
  results: Array<LogEvent | DashboardRow>;
  next_cursor: { before_ts: string; before_event_id: string } | null;
  stats: SearchStats;
  warning?: string;
  error?: string;
  guardrail?: GuardrailExplanation;
}

interface FacetItem {
  value: string;
  count: number;
}

interface SearchSummaryResponse {
  mode: SearchMode;
  sampled_events: number;
  sampled_candidates: number;
  scanned_objects: number;
  truncated: boolean;
  top_terms: FacetItem[];
  field_presence: {
    trace_id: number;
    span_id: number;
    parent_span_id: number;
    request_id: number;
    user_id: number;
    src_ip: number;
    status: number;
    duration_ms: number;
    attrs_json: number;
  };
  facets: {
    indexes: FacetItem[];
    services: FacetItem[];
    levels: FacetItem[];
    statuses: FacetItem[];
    hosts: FacetItem[];
  };
  timeline: Array<{ minute: string; count: number }>;
  error?: string;
  guardrail?: GuardrailExplanation;
}

interface SavedSearch {
  id: string;
  name: string;
  query: string;
  created_at: string;
  updated_at?: string;
}

interface ScheduledSearchItem {
  id: string;
  name: string;
  ppl: string;
  time_window_minutes: number;
  schedule_cron: string;
  enabled: number;
  max_results: number;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface ScheduledSearchResult {
  id: string;
  scheduled_search_id: string;
  run_at: string;
  status: string;
  result_count: number;
  error_message?: string | null;
}

interface AlertDefinition {
  id: string;
  name: string;
  enabled: number;
  type: string;
  query_template: string;
  params_json: string;
  schedule_seconds: number;
  threshold_json: string;
  notify_json: string;
  cooldown_seconds: number;
  created_at: string;
  updated_at?: string;
}

interface AlertNotifyConfig {
  slack?: boolean;
  webhook?: boolean;
  severity?: string;
  deep_link?: string;
  runbook_url?: string;
  owner_team?: string;
}

interface AlertParamsConfig {
  index?: string;
  service?: string;
  env?: string;
  window_minutes?: number;
  token?: string;
  _starter_id?: string;
  _starter_version?: string;
}

interface AdminUserRow {
  id: string;
  email: string;
  enabled: number;
  legacy_role?: string;
  role_ids: string[];
  created_at: string;
  updated_at?: string | null;
  last_login_at?: string | null;
}

interface RoleRow {
  id: string;
  name: string;
  system_role: number;
  enabled: number;
  permissions_json: string;
  scope_json: string;
  created_at: string;
  updated_at?: string | null;
}

interface GroupRoleMappingRow {
  id: string;
  access_group: string;
  role_id: string;
  created_at: string;
  updated_at?: string | null;
}

interface AdminInviteRow {
  id: string;
  email: string;
  auth_mode: 'access_sso' | 'local_password';
  role_ids: string[];
  expires_at: string;
  invited_by: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  created_at: string;
  accepted_at?: string | null;
}

interface OnboardingChecklistItem {
  key: string;
  title: string;
  done: boolean;
  detail: string;
}

interface AuditLogRow {
  id: string;
  actor_principal?: string | null;
  actor_email?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  metadata_json?: string | null;
  created_at: string;
}

interface SyntheticIngestControl {
  ok?: boolean;
  enabled: boolean;
  configured_enabled: boolean;
  persisted_enabled?: boolean | null;
  updated_at?: string | null;
}

interface DashboardRow {
  [key: string]: string | number;
}

interface DashboardData {
  error_rate_by_service: DashboardRow[];
  latency_p95_by_service: DashboardRow[];
  top_errors: DashboardRow[];
  throughput: DashboardRow[];
  top_hosts: DashboardRow[];
}

interface SearchFilterState {
  indexName: string;
  service: string;
  environment: string;
  host: string;
  level: string;
  statusCode: string;
}

interface SearchRequestPayload {
  time: { from: string; to: string };
  ppl: string;
  limit: number;
  cursor: { before_ts: string; before_event_id: string } | null;
}

interface SearchStreamChunk {
  type: 'meta' | 'event' | 'row' | 'progress' | 'final' | 'error';
  event?: LogEvent;
  row?: DashboardRow;
  mode?: SearchMode;
  stream_mode?: 'incremental' | 'buffered';
  result_type?: 'events' | 'table';
  next_cursor?: { before_ts: string; before_event_id: string } | null;
  stats?: SearchStats;
  scanned_objects?: number;
  candidates?: number;
  returned?: number;
  warning?: string;
  error?: string;
  guardrail?: GuardrailExplanation;
}

interface QuerySuggestionItem {
  label: string;
  kind: 'command' | 'template' | 'field' | 'term';
  detail?: string;
  example?: string;
  next_query: string;
  score?: number;
}

interface QuerySuggestionResponse {
  suggestions?: QuerySuggestionItem[];
  meta?: {
    context_stage?: string;
    latency_ms?: number;
  };
}

const API_BASE = ((import.meta as { env?: Record<string, string> }).env?.VITE_QUERY_API_BASE || '').trim();
const API_BASE_MISSING_ERROR = 'Missing VITE_QUERY_API_BASE. Configure your deployed query-worker URL.';
const STREAM_FLUSH_INTERVAL_MS = 250;
const QUERY_SUGGESTION_DEBOUNCE_MS = 120;
const QUERY_SUGGESTION_CACHE_TTL_MS = 30_000;

const LOCAL_FALLBACK_SNIPPETS = [
  { label: 'search', kind: 'command', detail: 'Search logs by free text', insert: 'search ' },
  { label: 'where', kind: 'command', detail: 'Filter fields and values', insert: 'where service=' },
  { label: 'stats', kind: 'template', detail: 'Count by service', insert: 'stats count() by service' },
  { label: 'timechart', kind: 'template', detail: 'Trend by 5-minute buckets', insert: 'timechart span=5m count()' },
  { label: 'sort', kind: 'command', detail: 'Sort newest first', insert: 'sort -ts' },
  { label: 'head', kind: 'command', detail: 'Limit returned rows', insert: 'head 100' }
] as const;

function buildInlineSuggestionQuery(currentQuery: string, replacement: string): string {
  const segmentStart = currentQuery.lastIndexOf('|') + 1;
  const prefix = currentQuery.slice(0, segmentStart);
  if (!prefix) return replacement;
  if (prefix.endsWith('|')) return `${prefix} ${replacement}`;
  return `${prefix}${replacement}`;
}

function buildLocalFallbackSuggestions(query: string): QuerySuggestionItem[] {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractHighlightTerms(query: string): string[] {
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

function highlightText(text: string, terms: string[]): JSX.Element {
  if (!terms.length) return <>{text}</>;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'ig');
  const parts = text.split(pattern);
  const lowerTerms = new Set(terms.map((term) => term.toLowerCase()));

  return (
    <>
      {parts.map((part, index) => {
        const matched = lowerTerms.has(part.toLowerCase());
        return matched ? <mark key={`${part}-${index}`}>{part}</mark> : <span key={`${part}-${index}`}>{part}</span>;
      })}
    </>
  );
}

function jsonSyntaxHtml(raw: string): string {
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

function prettyJsonOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}

function attrsPreviewPairs(attrsJson: string | undefined, limit = 3): Array<{ key: string; value: string }> {
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

function toFacet(items: Array<string | number | undefined>, limit = 10): FacetItem[] {
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

function modeLabel(mode: SearchMode | null): string {
  if (!mode) return 'Auto';
  if (mode === 'structured') return 'Structured';
  if (mode === 'token') return 'Token';
  return 'Phrase';
}

function toGuardrailExplanation(value: unknown): GuardrailExplanation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const code = String(candidate.code || '').trim();
  const title = String(candidate.title || '').trim();
  const reason = String(candidate.reason || '').trim();
  const suggestion = String(candidate.suggestion || '').trim();
  if (!code || !title || !reason || !suggestion) return null;
  return { code, title, reason, suggestion };
}

function parseErrorPayload(
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

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatTimelineTick(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function compareEventsDesc(left: LogEvent, right: LogEvent): number {
  const tsCompare = right.ts.localeCompare(left.ts);
  if (tsCompare !== 0) return tsCompare;
  return right.event_id.localeCompare(left.event_id);
}

function sortEventsNewestFirst(events: LogEvent[]): LogEvent[] {
  return [...events].sort(compareEventsDesc);
}

function readLevelCount(levels: FacetItem[], target: string): number {
  return levels.find((item) => item.value === target)?.count || 0;
}

function maxFacetCount(items: FacetItem[]): number {
  return Math.max(1, ...items.map((item) => item.count));
}

function parseStringArray(raw: string | undefined, fallback: string[] = []): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return fallback;
  }
}

function resolveAlertTemplatePreset(id: string): AlertTemplatePreset {
  return ALERT_TEMPLATE_PRESETS.find((preset) => preset.id === id) || ALERT_TEMPLATE_PRESETS[0];
}

function buildAlertDeepQuery(
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

function buildDefaultAlertDeepLink(query: string): string {
  if (typeof window === 'undefined') return '';
  const base = window.location.origin.replace(/\/+$/, '');
  if (!base || !query.trim()) return '';
  return `${base}/?view=search&query=${encodeURIComponent(query)}`;
}

function parseAlertNotifyConfig(raw: string): AlertNotifyConfig {
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

function parseAlertParamsConfig(raw: string): AlertParamsConfig {
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

function buildAlertWorkspaceHref(alert: AlertDefinition): string | null {
  const params = parseAlertParamsConfig(alert.params_json);
  const service = String(params.service || '').trim();
  if (!service) return null;
  const query = new URLSearchParams();
  query.set('view', 'workspace');
  query.set('source', 'alert');
  query.set('service', service);
  if (params.index) query.set('index', params.index);
  if (params.env) query.set('env', params.env);
  return `?${query.toString()}`;
}

function formatTimeCompact(ts: string): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

const MAX_LIVETAIL_EVENTS = 2000;

interface LiveTailFilters {
  service: string;
  env: string;
  level: string;
  keywords: string;
}

function LiveTailView({
  apiBase,
  apiToken,
  onSelectEvent
}: {
  apiBase: string;
  apiToken: string | null;
  onSelectEvent: (event: LogEvent) => void;
}) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState<LiveTailFilters>({ service: '', env: '', level: '', keywords: '' });
  const [rate, setRate] = useState(0);
  const streamRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateCountRef = useRef(0);
  const userScrolledUpRef = useRef(false);

  const wsUrl = apiToken && apiBase
    ? `${apiBase.replace(/^http/, 'ws')}/tail?token=${encodeURIComponent(apiToken)}`
    : null;

  useEffect(() => {
    if (!wsUrl) return;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data as string);
          if ((data.type === 'events' || data.type === 'catchup') && Array.isArray(data.events)) {
            const incoming = data.events as LogEvent[];
            rateCountRef.current += incoming.length;
            setEvents((prev) => {
              const next = [...incoming, ...prev].slice(0, MAX_LIVETAIL_EVENTS);
              return next;
            });
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimerRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        /* handled in onclose */
      };
    };

    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [wsUrl]);

  useEffect(() => {
    if (!connected || !wsRef.current) return;
    const f: Record<string, unknown> = {};
    if (filters.service) f.service = filters.service;
    if (filters.env) f.env = filters.env;
    if (filters.level) f.level = filters.level;
    if (filters.keywords) f.keywords = filters.keywords.split(/\s+/).filter(Boolean);
    wsRef.current.send(JSON.stringify({ type: 'filter', filters: f }));
  }, [connected, filters]);

  useEffect(() => {
    if (!connected || !wsRef.current) return;
    wsRef.current.send(JSON.stringify(paused ? { type: 'pause' } : { type: 'resume' }));
  }, [connected, paused]);

  useEffect(() => {
    const iv = setInterval(() => {
      setRate(rateCountRef.current);
      rateCountRef.current = 0;
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const handleScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    const atTop = el.scrollTop < 30;
    userScrolledUpRef.current = !atTop;
  }, []);

  useEffect(() => {
    if (!userScrolledUpRef.current && streamRef.current) {
      streamRef.current.scrollTop = 0;
    }
  }, [events]);

  const handleClear = useCallback(() => {
    setEvents([]);
  }, []);

  const updateFilter = useCallback(<K extends keyof LiveTailFilters>(key: K, value: LiveTailFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
  }, []);

  return (
    <div className="livetail-view">
      <div className="livetail-toolbar">
        <div className="livetail-filters">
          <input
            className="livetail-input"
            placeholder="service"
            value={filters.service}
            onChange={(e) => updateFilter('service', e.target.value)}
          />
          <input
            className="livetail-input"
            placeholder="env"
            value={filters.env}
            onChange={(e) => updateFilter('env', e.target.value)}
          />
          <select
            className="livetail-input"
            value={filters.level}
            onChange={(e) => updateFilter('level', e.target.value)}
          >
            <option value="">level</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </select>
          <input
            className="livetail-input livetail-keywords"
            placeholder="keywords"
            value={filters.keywords}
            onChange={(e) => updateFilter('keywords', e.target.value)}
          />
        </div>
        <div className="livetail-controls">
          <span className={`livetail-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'connected' : 'disconnected'}
          </span>
          <span className="livetail-rate">{rate} evt/s</span>
          <button className={`livetail-btn ${paused ? 'paused' : ''}`} onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="livetail-btn" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>
      <div className="livetail-stream" ref={streamRef} onScroll={handleScroll}>
        {events.length === 0 ? (
          <div className="livetail-empty">
            {!apiBase
              ? 'Set VITE_QUERY_API_BASE to enable Live Tail.'
              : connected
                ? 'Waiting for events…'
                : 'Connecting…'}
          </div>
        ) : (
          events.map((ev) => (
            <div
              key={ev.event_id}
              className={`livetail-event level-${(ev.level || 'info').toLowerCase()}`}
              onClick={() => onSelectEvent(ev)}
            >
              <span className="livetail-ts">{formatTimeCompact(ev.ts)}</span>
              <span className={`livetail-level ${(ev.level || 'info').toLowerCase()}`}>{ev.level || 'info'}</span>
              <span className="livetail-svc">{ev.service}</span>
              <span className="livetail-msg">{ev.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DashPanelContent({ vizType, data }: { vizType: string; data: DashboardRow[] }) {
  if (vizType === 'counter' || vizType === 'stat') {
    return <DashCounter data={data} />;
  }
  if (vizType === 'bar') {
    return <DashBarChart data={data} />;
  }
  if (vizType === 'pie') {
    return <DashBarChart data={data} />;
  }
  if (vizType === 'timechart') {
    return <DashSparkBars data={data} />;
  }
  return <DashTable data={data} />;
}

function DashCounter({ data }: { data: DashboardRow[] }) {
  const first = data[0];
  const keys = Object.keys(first);
  const numKey = keys.find(k => typeof first[k] === 'number');
  const value = numKey ? Number(first[numKey]) : 0;
  const label = numKey || keys[0] || '';
  return (
    <div className="dash-counter">
      <div className="dash-counter-value">{value.toLocaleString()}</div>
      <div className="dash-counter-label">{label.replace(/_/g, ' ')}</div>
    </div>
  );
}

function DashBarChart({ data }: { data: DashboardRow[] }) {
  const keys = Object.keys(data[0]);
  const labelKey = keys.find(k => typeof data[0][k] === 'string') || keys[0];
  const valueKey = keys.find(k => typeof data[0][k] === 'number' && k !== labelKey) || keys[1];
  if (!labelKey || !valueKey) return <DashTable data={data} />;

  const rows = data.slice(0, 10);
  const maxVal = Math.max(...rows.map(r => Math.abs(Number(r[valueKey]) || 0)), 1);
  const barHeight = 26;

  return (
    <div className="dash-bars">
      {rows.map((row, i) => {
        const label = String(row[labelKey] ?? '');
        const rawVal = Number(row[valueKey]) || 0;
        const pct = Math.abs(rawVal) / maxVal * 100;
        const displayVal = rawVal % 1 === 0 ? rawVal.toLocaleString() : rawVal.toFixed(2);
        return (
          <div key={i} className="dash-bar-row">
            <span className="dash-bar-label" title={label}>{label}</span>
            <div className="dash-bar-track">
              <div className="dash-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="dash-bar-value">{displayVal}</span>
          </div>
        );
      })}
    </div>
  );
}

function DashSparkBars({ data }: { data: DashboardRow[] }) {
  const keys = Object.keys(data[0]);
  const numKeys = keys.filter(k => typeof data[0][k] === 'number');
  if (numKeys.length === 0) return <DashTable data={data} />;

  const valueKey = numKeys[numKeys.length - 1];
  const values = data.map(r => Number(r[valueKey]) || 0);
  const maxVal = Math.max(...values, 1);
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <div className="dash-spark">
      <div className="dash-spark-total">{total.toLocaleString()} <span className="dash-spark-label">{valueKey.replace(/_/g, ' ')}</span></div>
      <div className="dash-spark-bars">
        {values.map((v, i) => (
          <div key={i} className="dash-spark-col" style={{ height: `${(v / maxVal) * 100}%` }} title={`${v}`} />
        ))}
      </div>
    </div>
  );
}

function DashTable({ data }: { data: DashboardRow[] }) {
  const cols = Object.keys(data[0]);
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead>
          <tr>
            {cols.map(col => <th key={col}>{col.replace(/_/g, ' ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 50).map((row, i) => (
            <tr key={i}>
              {cols.map(col => (
                <td key={col}>
                  {typeof row[col] === 'number'
                    ? (row[col] as number) % 1 === 0
                      ? (row[col] as number).toLocaleString()
                      : (row[col] as number).toFixed(2)
                    : String(row[col] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => readSystemPrefersDark());
  const [navExpanded, setNavExpanded] = useState(false);
  const [sidebarTooltip, setSidebarTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [explorerPanelHeight, setExplorerPanelHeight] = useState<number | null>(null);
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'search';
    return readViewFromLocation(window.location) || 'search';
  });

  const [query, setQuery] = useState('search * | where index="otel-demo" | sort -ts | head 200');
  const [queryFocused, setQueryFocused] = useState(false);
  const [querySuggestions, setQuerySuggestions] = useState<QuerySuggestionItem[]>([]);
  const [querySuggestionsOpen, setQuerySuggestionsOpen] = useState(false);
  const [querySuggestionsLoading, setQuerySuggestionsLoading] = useState(false);
  const [querySuggestionIndex, setQuerySuggestionIndex] = useState(-1);
  const [timeFrom, setTimeFrom] = useState(() => {
    const now = new Date();
    const from = new Date(now.getTime() - (15 * 60 * 1000));
    return formatDateTimeLocalValue(from);
  });
  const [timeTo, setTimeTo] = useState(() => formatDateTimeLocalValue(new Date()));
  const [activeTimePreset, setActiveTimePreset] = useState<string | null>('Last 15m');

  const [indexName, setIndexName] = useState('');
  const [service, setService] = useState('');
  const [environment, setEnvironment] = useState('');
  const [host, setHost] = useState('');
  const [level, setLevel] = useState('');
  const [statusCode, setStatusCode] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showSearchActions, setShowSearchActions] = useState(false);
  const [showSaveSearchInline, setShowSaveSearchInline] = useState(false);

  const applyTimePreset = useCallback((fromOffsetMinutes: number, toOffsetMinutes: number, label: string) => {
    const now = new Date();
    const to = new Date(now.getTime() - (toOffsetMinutes * 60 * 1000));
    const from = new Date(now.getTime() - (fromOffsetMinutes * 60 * 1000));
    setTimeFrom(formatDateTimeLocalValue(from));
    setTimeTo(formatDateTimeLocalValue(to));
    setActiveTimePreset(label);
  }, []);

  const hasActiveAdvancedFilters = useMemo(() => {
    return [
      indexName.trim(),
      service.trim(),
      environment.trim(),
      host.trim(),
      level.trim(),
      statusCode.trim()
    ].some((value) => value.length > 0);
  }, [indexName, service, environment, host, level, statusCode]);

  const activeAdvancedFilterCount = useMemo(() => {
    return [
      indexName.trim(),
      service.trim(),
      environment.trim(),
      host.trim(),
      level.trim(),
      statusCode.trim()
    ].filter((value) => value.length > 0).length;
  }, [indexName, service, environment, host, level, statusCode]);

  useEffect(() => {
    if (hasActiveAdvancedFilters) {
      setShowAdvancedFilters(true);
    }
  }, [hasActiveAdvancedFilters]);

  useEffect(() => {
    if (!showSearchActions) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!searchActionsRef.current?.contains(target)) {
        setShowSearchActions(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSearchActions(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('touchstart', handlePointerDown, { passive: true });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showSearchActions]);

  const [resultType, setResultType] = useState<'events' | 'table'>('events');
  const [results, setResults] = useState<LogEvent[]>([]);
  const [tableRows, setTableRows] = useState<DashboardRow[]>([]);
  const [streamSearch, setStreamSearch] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [cursor, setCursor] = useState<{ before_ts: string; before_event_id: string } | null>(null);
  const [stats, setStats] = useState<SearchStats | null>(null);
  const [summary, setSummary] = useState<SearchSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryUnavailable, setSummaryUnavailable] = useState(false);
  const [fieldCoverageFilter, setFieldCoverageFilter] = useState<{
    field: keyof SearchSummaryResponse['field_presence'];
    mode: 'present' | 'missing';
    previousQuery: string;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardrailDetail, setGuardrailDetail] = useState<GuardrailExplanation | null>(null);
  const [workspaceLaunchInfo, setWorkspaceLaunchInfo] = useState<string | null>(null);
  const { user, token: authToken, loading: authLoading, logout } = useAuth();
  const apiToken = authToken || '';

  const [activeIndex, setActiveIndex] = useState(-1);
  const [selectedEvent, setSelectedEvent] = useState<LogEvent | null>(null);
  const [investigationPivots, setInvestigationPivots] = useState<InvestigationPivots>(() => {
    if (typeof window === 'undefined') return {};
    return parseInvestigationParams(window.location.search);
  });

  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardData, setDashboardData] = useState<DashboardData>({
    error_rate_by_service: [],
    latency_p95_by_service: [],
    top_errors: [],
    throughput: [],
    top_hosts: []
  });
  const [pplDashboards, setPplDashboards] = useState<Array<{ id: string; name: string; description?: string | null; is_default: number }>>([]);
  const [selectedDashboardId, setSelectedDashboardId] = useState<string | null>(null);
  const [dashboardPanels, setDashboardPanels] = useState<Array<{ id: string; title: string; ppl: string; viz_type: string; time_window_minutes: number; position: number }>>([]);
  const [panelResults, setPanelResults] = useState<Record<string, DashboardRow[]>>({});
  const [panelLoading, setPanelLoading] = useState<Record<string, boolean>>({});
  const [dashboardTimeMinutes, setDashboardTimeMinutes] = useState(60);

  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [saveName, setSaveName] = useState('');

  const [scheduledSearches, setScheduledSearches] = useState<ScheduledSearchItem[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [scheduledError, setScheduledError] = useState<string | null>(null);
  const [scheduledResults, setScheduledResults] = useState<Record<string, ScheduledSearchResult[]>>({});
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [scheduleFormName, setScheduleFormName] = useState('');
  const [scheduleFormPpl, setScheduleFormPpl] = useState('');
  const [scheduleFormCron, setScheduleFormCron] = useState('0 * * * *');
  const [scheduleFormWindow, setScheduleFormWindow] = useState(60);

  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsInfo, setAlertsInfo] = useState<string | null>(null);
  const [starterPackApplying, setStarterPackApplying] = useState(false);
  const [alerts, setAlerts] = useState<AlertDefinition[]>([]);
  const [newAlertName, setNewAlertName] = useState('');
  const [newAlertTemplateId, setNewAlertTemplateId] = useState<AlertQueryTemplate>('error_rate_over_threshold');
  const [newAlertThresholdOperator, setNewAlertThresholdOperator] = useState<AlertThresholdOperator>('gt');
  const [newAlertThresholdValue, setNewAlertThresholdValue] = useState('5');
  const [newAlertWindowMinutes, setNewAlertWindowMinutes] = useState('5');
  const [newAlertSchedule, setNewAlertSchedule] = useState('60');
  const [newAlertCooldown, setNewAlertCooldown] = useState('300');
  const [newAlertIndex, setNewAlertIndex] = useState('');
  const [newAlertService, setNewAlertService] = useState('');
  const [newAlertEnv, setNewAlertEnv] = useState('');
  const [newAlertToken, setNewAlertToken] = useState('unauthorized');
  const [newAlertNotifySlack, setNewAlertNotifySlack] = useState(true);
  const [newAlertNotifyWebhook, setNewAlertNotifyWebhook] = useState(false);
  const [newAlertSeverity, setNewAlertSeverity] = useState<'critical' | 'warn' | 'info'>('critical');
  const [newAlertOwnerTeam, setNewAlertOwnerTeam] = useState('');
  const [newAlertRunbookUrl, setNewAlertRunbookUrl] = useState('');
  const [newAlertDeepLink, setNewAlertDeepLink] = useState('');
  const [starterRunbookBase, setStarterRunbookBase] = useState('https://runbooks.example.com/edge');
  const [starterOwnerTeam, setStarterOwnerTeam] = useState('edge-ops');

  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUserRow[]>([]);
  const [adminRoles, setAdminRoles] = useState<RoleRow[]>([]);
  const [adminMappings, setAdminMappings] = useState<GroupRoleMappingRow[]>([]);
  const [adminInvites, setAdminInvites] = useState<AdminInviteRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [syntheticIngestControl, setSyntheticIngestControl] = useState<SyntheticIngestControl | null>(null);
  const [syntheticControlLoading, setSyntheticControlLoading] = useState(false);
  const [adminToast, setAdminToast] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleIds, setInviteRoleIds] = useState('viewer');
  const [inviteAuthMode, setInviteAuthMode] = useState<'access_sso' | 'local_password'>('access_sso');
  const [inviteTokenPreview, setInviteTokenPreview] = useState('');

  const [newRoleId, setNewRoleId] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [newRolePermissions, setNewRolePermissions] = useState('search.read,dashboard.read');
  const [newRoleScope, setNewRoleScope] = useState('{\"indexes\":[\"*\"],\"services\":[\"*\"],\"envs\":[\"*\"],\"hosts\":[\"*\"]}');

  const [newMappingGroup, setNewMappingGroup] = useState('');
  const [newMappingRoleId, setNewMappingRoleId] = useState('viewer');
  const streamAbortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const querySuggestionsAbortRef = useRef<AbortController | null>(null);
  const querySuggestionsCacheRef = useRef<Map<string, { at: number; items: QuerySuggestionItem[] }>>(new Map());
  const searchActionsRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const queryTypeaheadRef = useRef<HTMLDivElement | null>(null);
  const explorerLayoutRef = useRef<HTMLDivElement | null>(null);

  const sessionIdFromUrl = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('session')?.trim() || null;
  }, []);

  useEffect(() => {
    if (sessionIdFromUrl && user) {
      setView('workspace');
    }
  }, [sessionIdFromUrl, user]);

  const highlightTerms = useMemo(() => extractHighlightTerms(query), [query]);
  const canOpenAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const navItems = useMemo<Array<{ key: ViewMode; label: string }>>(() => {
    const items: Array<{ key: ViewMode; label: string }> = [
      { key: 'search', label: 'Log Explorer' },
      { key: 'dashboard', label: 'Dashboards' },
      { key: 'alerts', label: 'Alerts' },
      { key: 'saved', label: 'Saved Searches' },
      { key: 'scheduled', label: 'Scheduled' },
      { key: 'livetail', label: 'Live Tail' },
      { key: 'workspace', label: 'Incident Workspace' }
    ];
    if (canOpenAdmin) {
      items.push({ key: 'admin', label: 'Settings' });
    }
    return items;
  }, [canOpenAdmin]);
  const onboardingChecklist = useMemo<OnboardingChecklistItem[]>(() => {
    const parseJsonObject = (raw: string): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    let starterCount = 0;
    let governedStarterCount = 0;
    for (const alert of alerts) {
      const params = parseJsonObject(alert.params_json);
      if (!params._starter_id) continue;
      starterCount += 1;
      const notify = parseJsonObject(alert.notify_json);
      if (
        String(notify.deep_link || '').trim() &&
        String(notify.runbook_url || '').trim() &&
        String(notify.owner_team || '').trim()
      ) {
        governedStarterCount += 1;
      }
    }

    const activeUsers = adminUsers.filter((row) => row.enabled === 1).length;
    const hasPendingInvite = adminInvites.length > 0;
    const hasStarterCoverage = starterCount >= 3 && governedStarterCount >= 3;

    return [
      {
        key: 'mappings',
        title: 'Access group mappings configured',
        done: adminMappings.length > 0,
        detail: adminMappings.length > 0
          ? `${adminMappings.length} mapping(s) active`
          : 'Add at least one IdP/Access group mapping'
      },
      {
        key: 'users',
        title: 'Users onboarded',
        done: activeUsers >= 2 || hasPendingInvite,
        detail: activeUsers >= 2
          ? `${activeUsers} active users`
          : hasPendingInvite
            ? `${adminInvites.length} pending invite(s)`
            : 'Invite at least one additional operator'
      },
      {
        key: 'alerts',
        title: 'Starter alerts with governance metadata',
        done: hasStarterCoverage,
        detail: hasStarterCoverage
          ? `${governedStarterCount}/${starterCount} starter alerts governed`
          : 'Apply starter pack and include runbook/deep-link/team metadata'
      },
      {
        key: 'synthetic',
        title: 'Synthetic ingest enabled',
        done: Boolean(syntheticIngestControl?.enabled),
        detail: syntheticIngestControl?.enabled ? 'Enabled' : 'Enable synthetic ingest to validate search and alerts'
      }
    ];
  }, [adminInvites, adminMappings, adminUsers, alerts, syntheticIngestControl?.enabled]);
  const onboardingDoneCount = useMemo(
    () => onboardingChecklist.filter((item) => item.done).length,
    [onboardingChecklist]
  );
  const resolvedTheme: ThemeMode = themePreference === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : themePreference;
  const hasScrollableResultsPanel = useMemo(() => {
    if (view !== 'search') return false;
    if (resultType === 'table') return tableRows.length > 0;
    return results.length > 0;
  }, [resultType, results.length, tableRows.length, view]);
  const setAddressableView = useCallback((nextView: ViewMode, options?: { replace?: boolean }) => {
    setView(nextView);
    writeViewToLocation(nextView, options);
  }, []);
  const focusGlobalSearch = useCallback(() => {
    setAddressableView('search');
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [setAddressableView]);
  const showSidebarTooltip = useCallback((label: string, target: EventTarget | null) => {
    if (navExpanded) return;
    if (!(target instanceof HTMLElement)) return;
    const rect = target.getBoundingClientRect();
    setSidebarTooltip({
      label,
      x: rect.right + 10,
      y: rect.top + (rect.height / 2)
    });
  }, [navExpanded]);
  const hideSidebarTooltip = useCallback(() => {
    setSidebarTooltip(null);
  }, []);
  const getTooltipHandlers = useCallback((label: string) => ({
    onMouseEnter: (event: { currentTarget: EventTarget | null }) => showSidebarTooltip(label, event.currentTarget),
    onFocus: (event: { currentTarget: EventTarget | null }) => showSidebarTooltip(label, event.currentTarget),
    onMouseLeave: hideSidebarTooltip,
    onBlur: hideSidebarTooltip
  }), [hideSidebarTooltip, showSidebarTooltip]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    mediaQuery.addEventListener('change', onSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', onSystemThemeChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target.isContentEditable) {
          return;
        }
      }
      event.preventDefault();
      focusGlobalSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusGlobalSearch]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!hasScrollableResultsPanel) {
      setExplorerPanelHeight(null);
      return;
    }

    const updateExplorerPanelHeight = () => {
      const panel = explorerLayoutRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const nextHeight = Math.max(220, Math.floor(window.innerHeight - rect.top - 10));
      setExplorerPanelHeight(nextHeight);
    };

    const frame = window.requestAnimationFrame(updateExplorerPanelHeight);
    window.addEventListener('resize', updateExplorerPanelHeight);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateExplorerPanelHeight);
    };
  }, [hasScrollableResultsPanel]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (themePreference === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }
  }, [themePreference]);

  const localFacets = useMemo(() => {
    return {
      indexes: toFacet(results.map((event) => event.index || 'default'), 8),
      services: toFacet(results.map((event) => event.service), 12),
      levels: toFacet(results.map((event) => event.level), 6),
      statuses: toFacet(results.map((event) => event.status), 8),
      hosts: toFacet(results.map((event) => event.host), 10)
    };
  }, [results]);

  const facets = summary?.facets || localFacets;
  const topTerms = summary?.top_terms || [];

  const localFieldPresence = useMemo(() => {
    return {
      trace_id: results.filter((event) => !!event.trace_id).length,
      span_id: results.filter((event) => !!event.span_id).length,
      parent_span_id: results.filter((event) => !!event.parent_span_id).length,
      request_id: results.filter((event) => !!event.request_id).length,
      user_id: results.filter((event) => !!event.user_id).length,
      src_ip: results.filter((event) => !!event.src_ip).length,
      status: results.filter((event) => event.status !== undefined).length,
      duration_ms: results.filter((event) => event.duration_ms !== undefined).length,
      attrs_json: results.filter((event) => !!event.attrs_json).length
    };
  }, [results]);

  const fieldPresence = summary?.field_presence || localFieldPresence;
  const fieldPresenceSampleSize = summary?.sampled_events ?? results.length;
  const fieldPresenceRows = useMemo(() => {
    const sampleSize = fieldPresenceSampleSize;
    const fields: Array<{
      key: keyof SearchSummaryResponse['field_presence'];
      label: string;
    }> = [
      { key: 'trace_id', label: 'Trace ID' },
      { key: 'span_id', label: 'Span ID' },
      { key: 'parent_span_id', label: 'Parent Span ID' },
      { key: 'request_id', label: 'Request ID' },
      { key: 'user_id', label: 'User ID' },
      { key: 'src_ip', label: 'Source IP' },
      { key: 'status', label: 'Status' },
      { key: 'duration_ms', label: 'Duration (ms)' },
      { key: 'attrs_json', label: 'Attributes JSON' }
    ];

    return fields
      .map((field) => {
        const count = fieldPresence[field.key];
        const percent = sampleSize > 0 ? Math.round((count / sampleSize) * 100) : 0;
        return {
          ...field,
          count,
          percent,
          missing: Math.max(sampleSize - count, 0)
        };
      })
      .sort((a, b) => b.percent - a.percent || b.count - a.count);
  }, [fieldPresence, fieldPresenceSampleSize]);
  const fieldCoverageAverage = useMemo(() => {
    if (fieldPresenceRows.length === 0) return 0;
    const total = fieldPresenceRows.reduce((acc, row) => acc + row.percent, 0);
    return Math.round(total / fieldPresenceRows.length);
  }, [fieldPresenceRows]);
  const fieldCoverageQuality = useMemo(() => {
    if (fieldCoverageAverage >= 80) return 'Strong';
    if (fieldCoverageAverage >= 50) return 'Mixed';
    return 'Sparse';
  }, [fieldCoverageAverage]);
  const fieldPresenceGroups = useMemo(() => {
    const rowsByKey = new Map(fieldPresenceRows.map((row) => [row.key, row]));
    const groups: Array<{
      key: string;
      title: string;
      rows: typeof fieldPresenceRows;
    }> = [
      {
        key: 'tracing',
        title: 'Tracing',
        rows: ['trace_id', 'span_id', 'parent_span_id']
          .map((key) => rowsByKey.get(key as keyof SearchSummaryResponse['field_presence']))
          .filter((value): value is (typeof fieldPresenceRows)[number] => Boolean(value))
      },
      {
        key: 'request',
        title: 'Request Context',
        rows: ['request_id', 'user_id', 'src_ip', 'status', 'duration_ms']
          .map((key) => rowsByKey.get(key as keyof SearchSummaryResponse['field_presence']))
          .filter((value): value is (typeof fieldPresenceRows)[number] => Boolean(value))
      },
      {
        key: 'payload',
        title: 'Payload',
        rows: ['attrs_json']
          .map((key) => rowsByKey.get(key as keyof SearchSummaryResponse['field_presence']))
          .filter((value): value is (typeof fieldPresenceRows)[number] => Boolean(value))
      }
    ];

    return groups
      .map((group) => {
        const average = group.rows.length > 0
          ? Math.round(group.rows.reduce((acc, row) => acc + row.percent, 0) / group.rows.length)
          : 0;
        return { ...group, average };
      })
      .filter((group) => group.rows.length > 0);
  }, [fieldPresenceRows]);
  const localTimeline = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of results) {
      const minute = `${event.ts.slice(0, 16)}:00Z`;
      counts.set(minute, (counts.get(minute) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-72)
      .map(([minute, count]) => ({ minute, count }));
  }, [results]);

  const levelTotals = useMemo(() => {
    return {
      error: readLevelCount(facets.levels, 'error'),
      warn: readLevelCount(facets.levels, 'warn'),
      info: readLevelCount(facets.levels, 'info'),
      debug: readLevelCount(facets.levels, 'debug')
    };
  }, [facets.levels]);

  const timeline = summary?.timeline || localTimeline;
  const timelineMax = useMemo(() => Math.max(1, ...timeline.map((item) => item.count)), [timeline]);
  const timelineStepMs = useMemo(() => {
    if (timeline.length < 2) return 60_000;
    const first = new Date(timeline[0].minute).getTime();
    const second = new Date(timeline[1].minute).getTime();
    const delta = Math.abs(second - first);
    return Number.isFinite(delta) && delta > 0 ? delta : 60_000;
  }, [timeline]);
  const timelineAxisMarks = useMemo(() => {
    if (timeline.length === 0) return [];
    const last = timeline.length - 1;
    const middle = Math.floor(last / 2);
    const marks = Array.from(new Set([0, middle, last]));
    return marks.map((index) => ({
      key: `${timeline[index].minute}-${index}`,
      label: formatTimelineTick(timeline[index].minute),
      align: index === 0 ? 'left' : index === last ? 'right' : 'center'
    }));
  }, [timeline]);

  const apiFetch = useCallback((path: string, init: RequestInit = {}) => {
    if (!API_BASE) {
      return Promise.reject(new Error(API_BASE_MISSING_ERROR));
    }
    const headers = new Headers(init.headers || {});
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (apiToken) {
      headers.set('Authorization', `Bearer ${apiToken}`);
    }
    return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: init.credentials ?? 'include' });
  }, [apiToken]);

  const closeQuerySuggestions = useCallback(() => {
    setQuerySuggestionsOpen(false);
    setQuerySuggestionIndex(-1);
  }, []);

  const applyQuerySuggestion = useCallback((item: QuerySuggestionItem) => {
    setQuery(item.next_query);
    setQuerySuggestionsOpen(false);
    setQuerySuggestionIndex(-1);
    if (searchInputRef.current) {
      const nextPos = item.next_query.length;
      searchInputRef.current.focus();
      searchInputRef.current.setSelectionRange(nextPos, nextPos);
    }
  }, []);

  useEffect(() => {
    if (!queryFocused || view !== 'search') {
      closeQuerySuggestions();
      return;
    }

    const topContextTerms = topTerms.map((item) => item.value).filter(Boolean).slice(0, 8);
    const cacheKey = JSON.stringify({ query, terms: topContextTerms });
    const cached = querySuggestionsCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.at < QUERY_SUGGESTION_CACHE_TTL_MS) {
      setQuerySuggestions(cached.items);
      setQuerySuggestionsOpen(cached.items.length > 0);
      setQuerySuggestionIndex(cached.items.length > 0 ? 0 : -1);
      return;
    }

    const timeout = globalThis.setTimeout(async () => {
      if (querySuggestionsAbortRef.current) {
        querySuggestionsAbortRef.current.abort();
      }
      const controller = new AbortController();
      querySuggestionsAbortRef.current = controller;
      setQuerySuggestionsLoading(true);
      try {
        const response = await apiFetch('/search/suggestions', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            query,
            cursorPos: query.length,
            maxItems: 8,
            context: { topTerms: topContextTerms }
          })
        });
        const body = await response.json() as QuerySuggestionResponse;
        if (!response.ok || !Array.isArray(body.suggestions)) {
          throw new Error('suggestions unavailable');
        }
        const nextItems = body.suggestions.slice(0, 8);
        querySuggestionsCacheRef.current.set(cacheKey, { at: Date.now(), items: nextItems });
        setQuerySuggestions(nextItems);
        setQuerySuggestionsOpen(nextItems.length > 0);
        setQuerySuggestionIndex(nextItems.length > 0 ? 0 : -1);
      } catch {
        if (!controller.signal.aborted) {
          const fallback = buildLocalFallbackSuggestions(query);
          setQuerySuggestions(fallback);
          setQuerySuggestionsOpen(fallback.length > 0);
          setQuerySuggestionIndex(fallback.length > 0 ? 0 : -1);
        }
      } finally {
        if (querySuggestionsAbortRef.current === controller) {
          querySuggestionsAbortRef.current = null;
        }
        setQuerySuggestionsLoading(false);
      }
    }, QUERY_SUGGESTION_DEBOUNCE_MS);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [apiFetch, closeQuerySuggestions, query, queryFocused, topTerms, view]);

  useEffect(() => {
    if (!querySuggestionsOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!queryTypeaheadRef.current?.contains(target)) {
        closeQuerySuggestions();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('touchstart', onPointerDown, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('touchstart', onPointerDown);
    };
  }, [closeQuerySuggestions, querySuggestionsOpen]);

  useEffect(() => {
    if (view !== 'search') {
      closeQuerySuggestions();
      setQueryFocused(false);
    }
  }, [closeQuerySuggestions, view]);

  const buildPpl = useCallback((overrides?: {
    queryOverride?: string;
    filterOverrides?: Partial<SearchFilterState>;
    pivotOverrides?: InvestigationPivots;
  }): string => {
    const filterState: SearchFilterState = {
      indexName,
      service,
      environment,
      host,
      level,
      statusCode,
      ...(overrides?.filterOverrides || {})
    };
    const pivots = overrides?.pivotOverrides ?? investigationPivots;

    const rawQuery = (overrides?.queryOverride ?? query).trim();
    const looksLikePipeline = /\|/.test(rawQuery) || /^(search|where|fields|sort|head|stats)\b/i.test(rawQuery);
    if (looksLikePipeline) return rawQuery;

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

    const searchExpr = rawQuery || '*';
    if (conditions.length === 0) return `search ${searchExpr}`;
    return `search ${searchExpr} | where ${conditions.join(' and ')}`;
  }, [indexName, query, service, environment, host, level, statusCode, investigationPivots]);

  const buildSearchPayload = useCallback((options?: {
    queryOverride?: string;
    filterOverrides?: Partial<SearchFilterState>;
    pivotOverrides?: InvestigationPivots;
    timeOverride?: { from: string; to: string };
    cursor?: { before_ts: string; before_event_id: string } | null;
    limit?: number;
  }): SearchRequestPayload => {
    const localTimeFrom = options?.timeOverride?.from ?? timeFrom;
    const localTimeTo = options?.timeOverride?.to ?? timeTo;
    return {
      time: {
        from: toUtcIso(localTimeFrom),
        to: toUtcIso(localTimeTo)
      },
      ppl: buildPpl({
        queryOverride: options?.queryOverride,
        filterOverrides: options?.filterOverrides,
        pivotOverrides: options?.pivotOverrides
      }),
      limit: options?.limit ?? 200,
      cursor: options?.cursor ?? null
    };
  }, [buildPpl, timeFrom, timeTo]);

  const loadSummary = useCallback(async (options?: {
    queryOverride?: string;
    filterOverrides?: Partial<SearchFilterState>;
    timeOverride?: { from: string; to: string };
  }) => {
    if (summaryUnavailable) {
      setSummary(null);
      setSummaryLoading(false);
      return;
    }

    if (summaryAbortRef.current) {
      summaryAbortRef.current.abort();
      summaryAbortRef.current = null;
    }

    const summaryController = new AbortController();
    summaryAbortRef.current = summaryController;
    const summaryTimeout = globalThis.setTimeout(() => summaryController.abort(), 8000);
    setSummaryLoading(true);

    try {
      const payload = buildSearchPayload({
        queryOverride: options?.queryOverride,
        filterOverrides: options?.filterOverrides,
        timeOverride: options?.timeOverride,
        cursor: null,
        limit: 500
      });

      const response = await apiFetch('/search/summary', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: summaryController.signal
      });

      if (response.status === 404) {
        setSummary(null);
        setSummaryUnavailable(true);
        return;
      }

      const body = await response.json() as SearchSummaryResponse;
      if (!response.ok || body.error) {
        setSummary(null);
        return;
      }
      setSummaryUnavailable(false);
      setSummary(body);
    } catch {
      if (!summaryController.signal.aborted) {
        setSummary(null);
      }
    } finally {
      globalThis.clearTimeout(summaryTimeout);
      if (summaryAbortRef.current === summaryController) {
        summaryAbortRef.current = null;
        setSummaryLoading(false);
      }
    }
  }, [apiFetch, buildSearchPayload, summaryUnavailable]);

  const cancelOngoingSearch = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    if (summaryAbortRef.current) {
      summaryAbortRef.current.abort();
      summaryAbortRef.current = null;
    }
    setStreaming(false);
    setSummaryLoading(false);
    setLoading(false);
  }, []);

  const runSearch = useCallback(async (options?: {
    append?: boolean;
    cursor?: { before_ts: string; before_event_id: string } | null;
    queryOverride?: string;
    filterOverrides?: Partial<SearchFilterState>;
    pivotOverrides?: InvestigationPivots;
    timeOverride?: { from: string; to: string };
  }) => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    if (summaryAbortRef.current) {
      summaryAbortRef.current.abort();
      summaryAbortRef.current = null;
    }
    setStreaming(false);
    setSummaryLoading(false);

    setLoading(true);
    setError(null);
    setGuardrailDetail(null);

    const append = options?.append || false;
    const requestCursor = append ? options?.cursor || cursor : null;
    const requestController = new AbortController();
    streamAbortRef.current = requestController;

    try {
      const payload = buildSearchPayload({
        queryOverride: options?.queryOverride,
        filterOverrides: options?.filterOverrides,
        pivotOverrides: options?.pivotOverrides,
        timeOverride: options?.timeOverride,
        cursor: requestCursor,
        limit: 200
      });

      if (!append && streamSearch) {
        setStreaming(true);
        setResultType('events');
        setCursor(null);
        setStats(null);
        setResults([]);
        setTableRows([]);
        setSelectedEvent(null);
        setSummary(null);

        const response = await apiFetch('/search/stream', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal: requestController.signal
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          const parsedError = parseErrorPayload(
            errorText,
            `Search stream failed with status ${response.status}`
          );
          if (parsedError.guardrail) {
            setGuardrailDetail(parsedError.guardrail);
          }
          throw new Error(parsedError.message);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let streamMode: SearchMode = 'structured';
        let streamResultType: 'events' | 'table' = 'events';
        let finalChunk: SearchStreamChunk | null = null;
        let pendingEvents: LogEvent[] = [];
        let pendingRows: DashboardRow[] = [];
        let pendingProgress: { scanned_objects?: number; candidates?: number; returned?: number } | null = null;

        const flushPending = (): void => {
          if (pendingProgress) {
            const snapshot = pendingProgress;
            pendingProgress = null;
            setStats((previous) => ({
              mode: previous?.mode || streamMode,
              scanned_partitions: previous?.scanned_partitions || 0,
              scanned_objects: snapshot.scanned_objects ?? previous?.scanned_objects ?? 0,
              candidates: snapshot.candidates ?? previous?.candidates ?? 0,
              returned: snapshot.returned ?? previous?.returned ?? 0
            }));
          }

          if (pendingEvents.length > 0) {
            const nextEvents = pendingEvents;
            pendingEvents = [];
            setResultType('events');
            setTableRows([]);
            setResults((previous) => sortEventsNewestFirst([...previous, ...nextEvents]));
          }

          if (pendingRows.length > 0) {
            const nextRows = pendingRows;
            pendingRows = [];
            setResultType('table');
            setCursor(null);
            setResults([]);
            setSelectedEvent(null);
            setSummary(null);
            setTableRows((previous) => [...previous, ...nextRows]);
          }
        };

        const handleChunks = (chunks: SearchStreamChunk[]): void => {
          for (const chunk of chunks) {
            if (chunk.type === 'meta') {
              if (chunk.mode) streamMode = chunk.mode;
              continue;
            }
            if (chunk.type === 'event' && chunk.event) {
              streamResultType = 'events';
              pendingEvents.push(chunk.event);
              continue;
            }
            if (chunk.type === 'row' && chunk.row) {
              streamResultType = 'table';
              pendingRows.push(chunk.row);
              continue;
            }
            if (chunk.type === 'progress') {
              pendingProgress = {
                scanned_objects: chunk.scanned_objects,
                candidates: chunk.candidates,
                returned: chunk.returned
              };
              continue;
            }
            if (chunk.type === 'error') {
              if (chunk.guardrail) {
                setGuardrailDetail(chunk.guardrail);
              }
              throw new Error(chunk.error || 'Search stream failed');
            }
            if (chunk.type === 'final') {
              finalChunk = chunk;
            }
          }
        };
        const flushTimer = globalThis.setInterval(flushPending, STREAM_FLUSH_INTERVAL_MS);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffered += decoder.decode(value, { stream: true });
            const lines = buffered.split('\n');
            buffered = lines.pop() || '';

            const chunks: SearchStreamChunk[] = [];
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                chunks.push(JSON.parse(trimmed) as SearchStreamChunk);
              } catch {
                continue;
              }
            }
            handleChunks(chunks);
          }

          buffered += decoder.decode();
          if (buffered.trim()) {
            try {
              handleChunks([JSON.parse(buffered.trim()) as SearchStreamChunk]);
            } catch {
              // Ignore malformed trailing chunk.
            }
          }
        } finally {
          globalThis.clearInterval(flushTimer);
          flushPending();
        }

        if (finalChunk) {
          const finalResultType = finalChunk.result_type || streamResultType;
          setResultType(finalResultType);
          setCursor(finalResultType === 'events' ? finalChunk.next_cursor || null : null);
          if (finalChunk.stats) setStats(finalChunk.stats);
          if (!append && finalResultType === 'events') {
            void loadSummary({
              queryOverride: options?.queryOverride,
              filterOverrides: options?.filterOverrides,
              timeOverride: options?.timeOverride
            });
          }
        }
        return;
      }

      const response = await apiFetch('/search', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: requestController.signal
      });

      const body = await response.json() as SearchResponse;
      if (!response.ok || body.error) {
        setGuardrailDetail(body.guardrail || null);
        setError(body.error || `Search failed with status ${response.status}`);
        setLoading(false);
        return;
      }

      setStats(body.stats);
      const nextResultType = body.result_type || 'events';
      setResultType(nextResultType);

      if (nextResultType === 'table') {
        const rows = body.results as DashboardRow[];
        setCursor(null);
        setResults([]);
        setSelectedEvent(null);
        setTableRows((previous) => append ? [...previous, ...rows] : rows);
        setSummary(null);
      } else {
        const eventRows = body.results as LogEvent[];
        setTableRows([]);
        setCursor(body.next_cursor);
        setResults((previous) => append ? sortEventsNewestFirst([...previous, ...eventRows]) : sortEventsNewestFirst(eventRows));
      }

      if (!append && nextResultType === 'events') {
        void loadSummary({
          queryOverride: options?.queryOverride,
          filterOverrides: options?.filterOverrides,
          timeOverride: options?.timeOverride
        });
      }
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      const raw = requestError instanceof Error ? requestError.message : String(requestError);
      const parsed = parseErrorPayload(raw, raw || 'Search failed');
      if (parsed.guardrail) {
        setGuardrailDetail(parsed.guardrail);
      }
      setError(parsed.message);
    } finally {
      if (streamAbortRef.current === requestController) {
        streamAbortRef.current = null;
      }
      setStreaming(false);
      setLoading(false);
    }
  }, [apiFetch, buildSearchPayload, cursor, loadSummary, streamSearch]);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    setDashboardError(null);

    try {
      const response = await apiFetch('/dashboards');
      const body = await response.json() as Array<{ id: string; name: string; description?: string | null; is_default: number }>;
      if (!response.ok) throw new Error('Failed to load dashboards');
      setPplDashboards(body || []);
      if (body.length > 0 && !selectedDashboardId) {
        setSelectedDashboardId(body[0].id);
      }
    } catch (requestError) {
      setDashboardError(String(requestError));
    } finally {
      setDashboardLoading(false);
    }
  }, [apiFetch, selectedDashboardId]);

  const loadDashboardPanels = useCallback(async (dashId: string) => {
    try {
      const response = await apiFetch(`/dashboards/${dashId}/panels`);
      const body = await response.json() as Array<{ id: string; title: string; ppl: string; viz_type: string; time_window_minutes: number; position: number }>;
      if (response.ok) {
        setDashboardPanels(body || []);
        setPanelResults({});
      }
    } catch {
      // best-effort
    }
  }, [apiFetch]);

  const executePanelQuery = useCallback(async (panelId: string, ppl: string, timeWindowMinutes: number) => {
    setPanelLoading(prev => ({ ...prev, [panelId]: true }));
    try {
      const now = new Date();
      const from = new Date(now.getTime() - timeWindowMinutes * 60 * 1000).toISOString();
      const to = now.toISOString();
      const response = await apiFetch('/search', {
        method: 'POST',
        body: JSON.stringify({ ppl, time: { from, to }, limit: 500 })
      });
      const body = await response.json() as { results?: DashboardRow[]; events?: DashboardRow[] };
      if (response.ok) {
        setPanelResults(prev => ({ ...prev, [panelId]: (body.results || body.events || []) as DashboardRow[] }));
      }
    } catch {
      setPanelResults(prev => ({ ...prev, [panelId]: [] }));
    } finally {
      setPanelLoading(prev => ({ ...prev, [panelId]: false }));
    }
  }, [apiFetch]);

  const refreshAllPanels = useCallback(() => {
    for (const panel of dashboardPanels) {
      void executePanelQuery(panel.id, panel.ppl, dashboardTimeMinutes);
    }
  }, [dashboardPanels, executePanelQuery, dashboardTimeMinutes]);

  const loadSavedSearches = useCallback(async () => {
    setSavedLoading(true);
    setSavedError(null);

    try {
      const response = await apiFetch('/saved-searches');
      const body = await response.json() as SavedSearch[] | { error?: string };

      if (!response.ok || ('error' in body && body.error)) {
        setSavedError(('error' in body && body.error) ? body.error : 'Failed to load saved searches');
        setSavedLoading(false);
        return;
      }

      setSavedSearches(body as SavedSearch[]);
    } catch (requestError) {
      setSavedError(String(requestError));
    } finally {
      setSavedLoading(false);
    }
  }, [apiFetch]);

  const saveCurrentSearch = useCallback(async () => {
    const name = saveName.trim();
    if (!name) {
      setSavedError('Enter a name before saving.');
      return;
    }

    setSavedError(null);
    try {
      const response = await apiFetch('/saved-searches', {
        method: 'POST',
        body: JSON.stringify({ name, query })
      });

      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setSavedError(body.error || 'Failed to save search');
        return;
      }

      setSaveName('');
      await loadSavedSearches();
      setAddressableView('saved');
    } catch (requestError) {
      setSavedError(String(requestError));
    }
  }, [apiFetch, loadSavedSearches, query, saveName, setAddressableView]);

  const deleteSavedSearch = useCallback(async (id: string) => {
    try {
      const response = await apiFetch(`/saved-searches/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || 'Failed to delete saved search');
      }
      await loadSavedSearches();
    } catch (requestError) {
      setSavedError(String(requestError));
    }
  }, [apiFetch, loadSavedSearches]);

  const loadScheduledSearches = useCallback(async () => {
    setScheduledLoading(true);
    setScheduledError(null);
    try {
      const response = await apiFetch('/scheduled-searches');
      const body = await response.json() as ScheduledSearchItem[] | { error?: string };
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Failed to load scheduled searches');
      setScheduledSearches(body as ScheduledSearchItem[]);
    } catch (err) {
      setScheduledError(String(err));
    } finally {
      setScheduledLoading(false);
    }
  }, [apiFetch]);

  const createScheduledSearch = useCallback(async () => {
    if (!scheduleFormName.trim() || !scheduleFormPpl.trim()) return;
    try {
      const response = await apiFetch('/scheduled-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scheduleFormName.trim(),
          ppl: scheduleFormPpl.trim(),
          schedule_cron: scheduleFormCron.trim(),
          time_window_minutes: scheduleFormWindow
        })
      });
      if (!response.ok) throw new Error('Failed to create scheduled search');
      setShowScheduleForm(false);
      setScheduleFormName('');
      setScheduleFormPpl('');
      await loadScheduledSearches();
    } catch (err) {
      setScheduledError(String(err));
    }
  }, [apiFetch, scheduleFormName, scheduleFormPpl, scheduleFormCron, scheduleFormWindow, loadScheduledSearches]);

  const deleteScheduledSearch = useCallback(async (id: string) => {
    try {
      const response = await apiFetch(`/scheduled-searches/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 204) throw new Error('Failed to delete');
      await loadScheduledSearches();
    } catch (err) {
      setScheduledError(String(err));
    }
  }, [apiFetch, loadScheduledSearches]);

  const toggleScheduledSearch = useCallback(async (id: string, enabled: boolean) => {
    try {
      await apiFetch(`/scheduled-searches/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled ? 1 : 0 })
      });
      await loadScheduledSearches();
    } catch (err) {
      setScheduledError(String(err));
    }
  }, [apiFetch, loadScheduledSearches]);

  const loadScheduledResults = useCallback(async (id: string) => {
    try {
      const response = await apiFetch(`/scheduled-searches/${id}/results`);
      if (response.ok) {
        const body = await response.json() as ScheduledSearchResult[];
        setScheduledResults(prev => ({ ...prev, [id]: body }));
      }
    } catch {
      // best-effort
    }
  }, [apiFetch]);

  const scheduleCurrentSearch = useCallback(() => {
    setScheduleFormPpl(query);
    setScheduleFormName('');
    setShowScheduleForm(true);
    setAddressableView('scheduled');
  }, [query, setAddressableView]);

  const loadAlerts = useCallback(async () => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const response = await apiFetch('/alerts');
      const body = await response.json() as AlertDefinition[] | { error?: string };
      if (!response.ok || ('error' in body && body.error)) {
        setAlertsError(('error' in body && body.error) ? body.error : 'Failed to load alerts');
        return;
      }
      setAlerts(body as AlertDefinition[]);
    } catch (requestError) {
      setAlertsError(String(requestError));
    } finally {
      setAlertsLoading(false);
    }
  }, [apiFetch]);

  const alertGovernance = useMemo(() => {
    const summary = {
      total: alerts.length,
      withDeepLink: 0,
      withRunbook: 0,
      withOwnerTeam: 0
    };
    for (const alert of alerts) {
      const notify = parseAlertNotifyConfig(alert.notify_json);
      if (notify.deep_link) summary.withDeepLink += 1;
      if (notify.runbook_url) summary.withRunbook += 1;
      if (notify.owner_team) summary.withOwnerTeam += 1;
    }
    return summary;
  }, [alerts]);

  const selectedAlertTemplate = useMemo(
    () => resolveAlertTemplatePreset(newAlertTemplateId),
    [newAlertTemplateId]
  );
  const isTokenAlertTemplate = selectedAlertTemplate.id === 'token_spike';

  useEffect(() => {
    setNewAlertThresholdOperator(selectedAlertTemplate.defaultThresholdOperator);
    setNewAlertThresholdValue(String(selectedAlertTemplate.defaultThresholdValue));
    setNewAlertWindowMinutes(String(selectedAlertTemplate.defaultWindowMinutes));
    setNewAlertSchedule(String(selectedAlertTemplate.defaultScheduleSeconds));
    setNewAlertCooldown(String(selectedAlertTemplate.defaultCooldownSeconds));
    setNewAlertSeverity(selectedAlertTemplate.defaultSeverity);
    setNewAlertToken(selectedAlertTemplate.defaultToken || '');
  }, [selectedAlertTemplate]);

  const alertPayloadPreview = useMemo(() => {
    const thresholdValue = Number(newAlertThresholdValue);
    const windowMinutes = Number(newAlertWindowMinutes);
    const normalizedParams: Record<string, unknown> = {
      window_minutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.trunc(windowMinutes) : null
    };
    const trimmedIndex = newAlertIndex.trim().toLowerCase();
    const trimmedService = newAlertService.trim();
    const trimmedEnv = newAlertEnv.trim();
    const trimmedToken = newAlertToken.trim();
    if (trimmedIndex) normalizedParams.index = trimmedIndex;
    if (trimmedService) normalizedParams.service = trimmedService;
    if (trimmedEnv) normalizedParams.env = trimmedEnv;
    if (isTokenAlertTemplate && trimmedToken) normalizedParams.token = trimmedToken;

    const deepQuery = buildAlertDeepQuery(selectedAlertTemplate.id, {
      index: trimmedIndex,
      service: trimmedService,
      env: trimmedEnv,
      token: trimmedToken
    }, thresholdValue);
    const autoDeepLink = buildDefaultAlertDeepLink(deepQuery);
    const deepLink = newAlertDeepLink.trim() || autoDeepLink;
    const runbookUrl = newAlertRunbookUrl.trim();
    const ownerTeam = newAlertOwnerTeam.trim();

    return {
      type: selectedAlertTemplate.type,
      query_template: selectedAlertTemplate.id,
      params_json: normalizedParams,
      threshold_json: {
        operator: newAlertThresholdOperator,
        value: Number.isFinite(thresholdValue) ? thresholdValue : null
      },
      notify_json: {
        slack: newAlertNotifySlack,
        webhook: newAlertNotifyWebhook,
        severity: newAlertSeverity,
        deep_link: deepLink || undefined,
        runbook_url: runbookUrl || undefined,
        owner_team: ownerTeam || undefined
      }
    };
  }, [
    isTokenAlertTemplate,
    newAlertDeepLink,
    newAlertEnv,
    newAlertIndex,
    newAlertNotifySlack,
    newAlertNotifyWebhook,
    newAlertOwnerTeam,
    newAlertRunbookUrl,
    newAlertService,
    newAlertSeverity,
    newAlertTemplateId,
    newAlertThresholdOperator,
    newAlertThresholdValue,
    newAlertToken,
    newAlertWindowMinutes,
    selectedAlertTemplate.id,
    selectedAlertTemplate.type
  ]);

  const createAlert = useCallback(async () => {
    const name = newAlertName.trim();
    if (!name) {
      setAlertsError('Alert name is required.');
      return;
    }

    const thresholdValue = Number(newAlertThresholdValue);
    if (!Number.isFinite(thresholdValue)) {
      setAlertsError('Threshold value must be a valid number.');
      return;
    }

    const windowMinutes = Math.trunc(Number(newAlertWindowMinutes));
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      setAlertsError('Window minutes must be greater than 0.');
      return;
    }

    const scheduleSeconds = Math.trunc(Number(newAlertSchedule));
    if (!Number.isFinite(scheduleSeconds) || scheduleSeconds <= 0) {
      setAlertsError('Schedule seconds must be greater than 0.');
      return;
    }

    const cooldownSeconds = Math.trunc(Number(newAlertCooldown));
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) {
      setAlertsError('Cooldown seconds must be greater than 0.');
      return;
    }

    const index = newAlertIndex.trim().toLowerCase() || indexName.trim().toLowerCase() || undefined;
    const service = newAlertService.trim() || undefined;
    const envName = newAlertEnv.trim() || undefined;
    const token = newAlertToken.trim() || undefined;
    if (isTokenAlertTemplate && !token) {
      setAlertsError('Token is required for token spike alerts.');
      return;
    }

    const params: Record<string, unknown> = { window_minutes: windowMinutes };
    if (index) params.index = index;
    if (service) params.service = service;
    if (envName) params.env = envName;
    if (isTokenAlertTemplate && token) params.token = token;

    const deepQuery = buildAlertDeepQuery(selectedAlertTemplate.id, {
      index,
      service,
      env: envName,
      token
    }, thresholdValue);
    const deepLink = newAlertDeepLink.trim() || buildDefaultAlertDeepLink(deepQuery);
    const runbookUrl = newAlertRunbookUrl.trim() || undefined;
    const ownerTeam = newAlertOwnerTeam.trim() || undefined;

    const notify: AlertNotifyConfig = {
      slack: newAlertNotifySlack,
      webhook: newAlertNotifyWebhook,
      severity: newAlertSeverity,
      deep_link: deepLink || undefined,
      runbook_url: runbookUrl,
      owner_team: ownerTeam
    };

    setAlertsError(null);
    setAlertsInfo(null);
    try {
      const response = await apiFetch('/alerts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          enabled: 1,
          type: selectedAlertTemplate.type,
          query_template: selectedAlertTemplate.id,
          params_json: JSON.stringify(params),
          schedule_seconds: scheduleSeconds,
          threshold_json: JSON.stringify({
            operator: newAlertThresholdOperator,
            value: thresholdValue
          }),
          notify_json: JSON.stringify(notify),
          cooldown_seconds: cooldownSeconds
        })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAlertsError(body.error || 'Failed to create alert');
        return;
      }

      setNewAlertName('');
      setAlertsInfo('Alert created.');
      await loadAlerts();
    } catch (requestError) {
      setAlertsError(String(requestError));
    }
  }, [
    apiFetch,
    indexName,
    isTokenAlertTemplate,
    loadAlerts,
    newAlertCooldown,
    newAlertDeepLink,
    newAlertEnv,
    newAlertIndex,
    newAlertName,
    newAlertNotifySlack,
    newAlertNotifyWebhook,
    newAlertOwnerTeam,
    newAlertRunbookUrl,
    newAlertSchedule,
    newAlertService,
    newAlertSeverity,
    newAlertThresholdOperator,
    newAlertThresholdValue,
    newAlertToken,
    newAlertWindowMinutes,
    selectedAlertTemplate.id,
    selectedAlertTemplate.type
  ]);

  const applyStarterAlertPack = useCallback(async () => {
    setStarterPackApplying(true);
    setAlertsError(null);
    setAlertsInfo(null);
    try {
      const response = await apiFetch('/alerts/starter-pack/apply', {
        method: 'POST',
        body: JSON.stringify({
          index: indexName.trim().toLowerCase() || 'default',
          deep_link_base: window.location.origin,
          runbook_base_url: starterRunbookBase.trim(),
          owner_team: starterOwnerTeam.trim()
        })
      });
      const body = await response.json() as {
        error?: string;
        inserted_count?: number;
        existing_count?: number;
      };
      if (!response.ok || body.error) {
        setAlertsError(body.error || 'Failed to apply starter alert pack');
        return;
      }

      const inserted = Number(body.inserted_count || 0);
      const existing = Number(body.existing_count || 0);
      setAlertsInfo(`Starter alert pack applied: ${inserted} added, ${existing} already present.`);
      await loadAlerts();
    } catch (requestError) {
      setAlertsError(String(requestError));
    } finally {
      setStarterPackApplying(false);
    }
  }, [apiFetch, indexName, loadAlerts, starterOwnerTeam, starterRunbookBase]);

  const toggleAlertEnabled = useCallback(async (alert: AlertDefinition) => {
    try {
      const response = await apiFetch(`/alerts/${alert.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: alert.enabled ? 0 : 1 })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAlertsError(body.error || 'Failed to update alert');
        return;
      }
      await loadAlerts();
    } catch (requestError) {
      setAlertsError(String(requestError));
    }
  }, [apiFetch, loadAlerts]);

  const deleteAlert = useCallback(async (id: string) => {
    try {
      const response = await apiFetch(`/alerts/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Failed to delete alert');
      }
      await loadAlerts();
    } catch (requestError) {
      setAlertsError(String(requestError));
    }
  }, [apiFetch, loadAlerts]);

  const loadAdminData = useCallback(async () => {
    setAdminLoading(true);
    setAdminError(null);
    try {
      const [usersRes, rolesRes, mappingsRes, invitesRes, auditRes, syntheticRes, alertsRes] = await Promise.all([
        apiFetch('/users'),
        apiFetch('/roles'),
        apiFetch('/rbac/mappings'),
        apiFetch('/auth/invites?status=pending&limit=200'),
        apiFetch('/audit?limit=100'),
        apiFetch('/admin/synthetic-ingest'),
        apiFetch('/alerts')
      ]);

      const usersBody = await usersRes.json() as AdminUserRow[] | { error?: string };
      const rolesBody = await rolesRes.json() as RoleRow[] | { error?: string };
      const mappingsBody = await mappingsRes.json() as GroupRoleMappingRow[] | { error?: string };
      const invitesBody = await invitesRes.json() as AdminInviteRow[] | { error?: string };
      const auditBody = await auditRes.json() as AuditLogRow[] | { error?: string };
      const syntheticBody = await syntheticRes.json() as SyntheticIngestControl | { error?: string };
      const alertsBody = await alertsRes.json() as AlertDefinition[] | { error?: string };

      if (!usersRes.ok || ('error' in usersBody && usersBody.error)) {
        throw new Error(('error' in usersBody && usersBody.error) ? usersBody.error : 'Failed to load users');
      }
      if (!rolesRes.ok || ('error' in rolesBody && rolesBody.error)) {
        throw new Error(('error' in rolesBody && rolesBody.error) ? rolesBody.error : 'Failed to load roles');
      }
      if (!mappingsRes.ok || ('error' in mappingsBody && mappingsBody.error)) {
        throw new Error(('error' in mappingsBody && mappingsBody.error) ? mappingsBody.error : 'Failed to load mappings');
      }
      if (!invitesRes.ok || ('error' in invitesBody && invitesBody.error)) {
        throw new Error(('error' in invitesBody && invitesBody.error) ? invitesBody.error : 'Failed to load invites');
      }
      if (!auditRes.ok || ('error' in auditBody && auditBody.error)) {
        throw new Error(('error' in auditBody && auditBody.error) ? auditBody.error : 'Failed to load audit');
      }
      if (!syntheticRes.ok || ('error' in syntheticBody && syntheticBody.error)) {
        throw new Error(('error' in syntheticBody && syntheticBody.error) ? syntheticBody.error : 'Failed to load synthetic ingest control');
      }
      if (!alertsRes.ok || ('error' in alertsBody && alertsBody.error)) {
        throw new Error(('error' in alertsBody && alertsBody.error) ? alertsBody.error : 'Failed to load alerts');
      }

      setAdminUsers(usersBody as AdminUserRow[]);
      setAdminRoles(rolesBody as RoleRow[]);
      setAdminMappings(mappingsBody as GroupRoleMappingRow[]);
      setAdminInvites(invitesBody as AdminInviteRow[]);
      setAuditRows(auditBody as AuditLogRow[]);
      setSyntheticIngestControl(syntheticBody as SyntheticIngestControl);
      setAlerts(alertsBody as AlertDefinition[]);
    } catch (requestError) {
      setAdminError(String(requestError));
    } finally {
      setAdminLoading(false);
    }
  }, [apiFetch]);

  const setSyntheticIngestEnabled = useCallback(async (enabled: boolean) => {
    setSyntheticControlLoading(true);
    setAdminError(null);
    try {
      const response = await apiFetch('/admin/synthetic-ingest', {
        method: 'POST',
        body: JSON.stringify({ enabled, trigger_run: enabled })
      });
      const body = await response.json() as {
        error?: string;
        control?: SyntheticIngestControl;
      };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to update synthetic ingest control');
        return;
      }
      if (body.control) {
        setSyntheticIngestControl(body.control);
      }
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    } finally {
      setSyntheticControlLoading(false);
    }
  }, [apiFetch, loadAdminData]);

  const runSyntheticIngestNow = useCallback(async () => {
    setSyntheticControlLoading(true);
    setAdminError(null);
    try {
      const response = await apiFetch('/admin/synthetic-ingest/run', {
        method: 'POST'
      });
      const body = await response.json() as {
        error?: string;
      };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to trigger synthetic ingest run');
        return;
      }
      setAdminToast('Synthetic ingest run triggered.');
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    } finally {
      setSyntheticControlLoading(false);
    }
  }, [apiFetch, loadAdminData]);

  useEffect(() => {
    if (!adminToast) return;
    const timeoutId = globalThis.setTimeout(() => setAdminToast(null), 2600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [adminToast]);

  const createInvite = useCallback(async () => {
    const email = inviteEmail.trim().toLowerCase();
    const roleIds = inviteRoleIds
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!email) {
      setAdminError('Invite email is required.');
      return;
    }
    if (roleIds.length === 0) {
      setAdminError('At least one role id is required.');
      return;
    }
    try {
      const response = await apiFetch('/auth/invite', {
        method: 'POST',
        body: JSON.stringify({
          email,
          auth_mode: inviteAuthMode,
          role_ids: roleIds
        })
      });
      const body = await response.json() as { error?: string; invite_token?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to create invite');
        return;
      }
      setInviteTokenPreview(body.invite_token || '');
      setInviteEmail('');
      setAdminToast(`Invite created for ${email}.`);
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, inviteAuthMode, inviteEmail, inviteRoleIds, loadAdminData]);

  const resendInvite = useCallback(async (invite: AdminInviteRow) => {
    try {
      const response = await apiFetch('/auth/invite/resend', {
        method: 'POST',
        body: JSON.stringify({ id: invite.id })
      });
      const body = await response.json() as { error?: string; invite_token?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to resend invite');
        return;
      }
      setInviteTokenPreview(body.invite_token || '');
      setAdminToast(`Invite resent for ${invite.email}.`);
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, loadAdminData]);

  const revokeInvite = useCallback(async (invite: AdminInviteRow) => {
    try {
      const response = await apiFetch('/auth/invite/revoke', {
        method: 'POST',
        body: JSON.stringify({ id: invite.id })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to revoke invite');
        return;
      }
      setAdminToast(`Invite revoked for ${invite.email}.`);
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, loadAdminData]);

  const updateUserEnabled = useCallback(async (userRow: AdminUserRow, enabled: number) => {
    try {
      const response = await apiFetch(`/users/${userRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to update user');
        return;
      }
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, loadAdminData]);

  const updateUserRoles = useCallback(async (userRow: AdminUserRow, roleIdsCsv: string) => {
    const roleIds = roleIdsCsv.split(',').map((item) => item.trim()).filter(Boolean);
    if (roleIds.length === 0) {
      setAdminError('At least one role id is required.');
      return;
    }
    try {
      const response = await apiFetch(`/users/${userRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role_ids: roleIds })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to update user roles');
        return;
      }
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, loadAdminData]);

  const createRole = useCallback(async () => {
    const id = newRoleId.trim();
    const name = newRoleName.trim() || id;
    const permissions = newRolePermissions.split(',').map((item) => item.trim()).filter(Boolean);
    if (!id) {
      setAdminError('Role id is required.');
      return;
    }
    if (permissions.length === 0) {
      setAdminError('At least one permission is required.');
      return;
    }
    let scope: { indexes?: string[]; services: string[]; envs: string[]; hosts: string[] };
    try {
      scope = JSON.parse(newRoleScope) as { indexes?: string[]; services: string[]; envs: string[]; hosts: string[] };
    } catch {
      setAdminError('Role scope must be valid JSON.');
      return;
    }

    try {
      const response = await apiFetch('/roles', {
        method: 'POST',
        body: JSON.stringify({
          id,
          name,
          permissions_json: permissions,
          scope_json: scope
        })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to create role');
        return;
      }
      setNewRoleId('');
      setNewRoleName('');
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, loadAdminData, newRoleId, newRoleName, newRolePermissions, newRoleScope]);

  const createMapping = useCallback(async () => {
    const group = newMappingGroup.trim();
    const roleId = newMappingRoleId.trim();
    if (!group || !roleId) {
      setAdminError('Access group and role id are required.');
      return;
    }
    try {
      const response = await apiFetch('/rbac/mappings', {
        method: 'POST',
        body: JSON.stringify({
          access_group: group,
          role_id: roleId
        })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) {
        setAdminError(body.error || 'Failed to create mapping');
        return;
      }
      setNewMappingGroup('');
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, loadAdminData, newMappingGroup, newMappingRoleId]);

  const applySavedSearch = useCallback((saved: SavedSearch) => {
    setQuery(saved.query);
    setAddressableView('search');
  }, [setAddressableView]);

  const runWorkspaceStarterQuery = useCallback((selection: WorkspaceStarterSelection) => {
    const nextQuery = (selection.ppl || '').trim() || 'search *';
    const nextScope = selection.scope;
    const nextPivots = selection.pivots || {};
    const nextFrom = new Date(selection.time.from);
    const nextTo = new Date(selection.time.to);
    const hasValidRange = !Number.isNaN(nextFrom.getTime()) && !Number.isNaN(nextTo.getTime());
    const nextTimeLocal = hasValidRange
      ? {
          from: formatDateTimeLocalValue(nextFrom),
          to: formatDateTimeLocalValue(nextTo)
        }
      : null;

    setQuery(nextQuery);
    setIndexName(nextScope.index);
    setService(nextScope.service);
    setEnvironment(nextScope.env);
    setHost('');
    setLevel('');
    setStatusCode('');
    setInvestigationPivots(nextPivots);
    if (nextTimeLocal) {
      setTimeFrom(nextTimeLocal.from);
      setTimeTo(nextTimeLocal.to);
      setActiveTimePreset(null);
    }
    setWorkspaceLaunchInfo(`Opened starter query: ${selection.title}`);
    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({
      append: false,
      cursor: null,
      queryOverride: nextQuery,
      filterOverrides: {
        indexName: nextScope.index,
        service: nextScope.service,
        environment: nextScope.env,
        host: '',
        level: '',
        statusCode: ''
      },
      pivotOverrides: nextPivots,
      timeOverride: selection.time
    });
  }, [runSearch, setAddressableView]);

  const applyFacetFilter = useCallback((key: 'indexName' | 'service' | 'level' | 'host' | 'statusCode', value: string) => {
    const nextState: Partial<SearchFilterState> = {};
    if (key === 'indexName') {
      setIndexName(value);
      nextState.indexName = value;
    } else if (key === 'service') {
      setService(value);
      nextState.service = value;
    } else if (key === 'level') {
      setLevel(value);
      nextState.level = value;
    } else if (key === 'host') {
      setHost(value);
      nextState.host = value;
    } else {
      setStatusCode(value);
      nextState.statusCode = value;
    }

    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, filterOverrides: nextState });
  }, [runSearch, setAddressableView]);

  const runPivot = useCallback((term: string) => {
    if (loading || streaming) {
      const shouldCancel = globalThis.confirm('A search is already in progress. Cancel it and run this pivot query?');
      if (!shouldCancel) return;
      cancelOngoingSearch();
    }
    const nextQuery = `${query} ${term}`.trim();
    setQuery(nextQuery);
    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, queryOverride: nextQuery });
  }, [cancelOngoingSearch, loading, query, runSearch, setAddressableView, streaming]);

  const runFieldCoverageQuery = useCallback((field: keyof SearchSummaryResponse['field_presence'], mode: 'present' | 'missing') => {
    if (loading || streaming) {
      const shouldCancel = globalThis.confirm('A search is already in progress. Cancel it and run this field filter?');
      if (!shouldCancel) return;
      cancelOngoingSearch();
    }
    const fieldCondition = mode === 'present'
      ? `${field}!=""`
      : `${field}=""`;
    const baseQuery = query.trim() || '*';
    const nextQuery = `${baseQuery} | where ${fieldCondition}`;
    setFieldCoverageFilter({
      field,
      mode,
      previousQuery: baseQuery
    });
    setQuery(nextQuery);
    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, queryOverride: nextQuery });
  }, [cancelOngoingSearch, loading, query, runSearch, setAddressableView, streaming]);

  const clearFieldCoverageFilter = useCallback(() => {
    if (!fieldCoverageFilter) return;
    if (loading || streaming) {
      const shouldCancel = globalThis.confirm('A search is already in progress. Cancel it and clear the field filter?');
      if (!shouldCancel) return;
      cancelOngoingSearch();
    }
    const nextQuery = fieldCoverageFilter.previousQuery.trim() || '*';
    setFieldCoverageFilter(null);
    setQuery(nextQuery);
    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, queryOverride: nextQuery });
  }, [cancelOngoingSearch, fieldCoverageFilter, loading, runSearch, setAddressableView, streaming]);

  const openTraceContextFromEvent = useCallback((event: LogEvent) => {
    const traceId = String(event.trace_id || '').trim();
    if (!traceId) return;
    const nextQuery = buildTraceContextPplFromEvent(event);
    setQuery(nextQuery);
    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    setWorkspaceLaunchInfo('Opened starter query: Trace context');
    void runSearch({ append: false, cursor: null, queryOverride: nextQuery });
  }, [runSearch, setAddressableView]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncViewFromLocation = () => {
      const nextView = readViewFromLocation(window.location);
      if (!nextView) return;
      setView((current) => (current === nextView ? current : nextView));
    };

    window.addEventListener('popstate', syncViewFromLocation);
    window.addEventListener('hashchange', syncViewFromLocation);
    return () => {
      window.removeEventListener('popstate', syncViewFromLocation);
      window.removeEventListener('hashchange', syncViewFromLocation);
    };
  }, []);

  const handlePivotClick = useCallback((key: PivotKey, _value: string) => {
    if (loading || streaming) {
      const shouldCancel = globalThis.confirm('A search is already in progress. Cancel it and run this pivot query?');
      if (!shouldCancel) return;
      cancelOngoingSearch();
    }
    const nextPivots = { ...investigationPivots };
    delete nextPivots[key];
    setInvestigationPivots(nextPivots);
    setView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, pivotOverrides: nextPivots });
  }, [cancelOngoingSearch, investigationPivots, loading, runSearch, streaming]);

  const handleSelectRelatedEvent = useCallback((ev: RelatedEvent) => {
    const nextPivots = pivotsFromRelatedEvent(ev);
    if (!hasPivots(nextPivots)) return;
    if (loading || streaming) {
      const shouldCancel = globalThis.confirm('A search is already in progress. Cancel it and run this pivot query?');
      if (!shouldCancel) return;
      cancelOngoingSearch();
    }
    setInvestigationPivots(nextPivots);
    setView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, pivotOverrides: nextPivots });
  }, [cancelOngoingSearch, loading, runSearch, streaming]);

  useEffect(() => {
    if (view === 'saved') {
      void loadSavedSearches();
    } else if (view === 'scheduled') {
      void loadScheduledSearches();
    } else if (view === 'alerts') {
      void loadAlerts();
    } else if (view === 'admin') {
      if (canOpenAdmin) {
        void loadAdminData();
      } else {
        setAddressableView('search', { replace: true });
      }
    }
  }, [view, canOpenAdmin, loadAdminData, loadSavedSearches, loadScheduledSearches, loadAlerts, setAddressableView]);

  useEffect(() => {
    if (!workspaceLaunchInfo) return;
    const timeout = globalThis.setTimeout(() => setWorkspaceLaunchInfo(null), 2500);
    return () => globalThis.clearTimeout(timeout);
  }, [workspaceLaunchInfo]);

  useEffect(() => {
    return () => {
      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
        streamAbortRef.current = null;
      }
      if (summaryAbortRef.current) {
        summaryAbortRef.current.abort();
        summaryAbortRef.current = null;
      }
      if (querySuggestionsAbortRef.current) {
        querySuggestionsAbortRef.current.abort();
        querySuggestionsAbortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!authLoading && !user && view !== 'search') {
      setAddressableView('search', { replace: true });
    }
  }, [authLoading, user, view, setAddressableView]);

  useEffect(() => {
    if (resultType !== 'events' || results.length === 0) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((index) => (index >= 0 && index < results.length ? index : 0));
  }, [resultType, results]);

  useEffect(() => {
    if (view !== 'search' || resultType !== 'events') return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      if (isTyping) return;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        if (!results.length) return;
        event.preventDefault();
        const next = Math.min(results.length - 1, activeIndex < 0 ? 0 : activeIndex + 1);
        setActiveIndex(next);
        document.querySelector(`[data-event-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }

      if (event.key === 'k' || event.key === 'ArrowUp') {
        if (!results.length) return;
        event.preventDefault();
        const next = Math.max(0, activeIndex <= 0 ? 0 : activeIndex - 1);
        setActiveIndex(next);
        document.querySelector(`[data-event-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }

      if (event.key === 'Enter') {
        if (activeIndex < 0 || activeIndex >= results.length) return;
        event.preventDefault();
        setSelectedEvent(results[activeIndex]);
        return;
      }

      if (event.key === 'Escape' && selectedEvent) {
        event.preventDefault();
        setSelectedEvent(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, resultType, results, selectedEvent, view]);

  if (authLoading) {
    return <div className="app-loading">Loading...</div>;
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <div className="app">
      <aside className={`side-nav ${navExpanded ? 'expanded' : 'collapsed'}`} aria-label="Application navigation">
        <div className="side-nav-top">
          <a className="nav-brand nav-brand-link" href="/" aria-label="Go to home page">
            <span className="nav-brand-mark" aria-hidden="true">
              <Database size={14} strokeWidth={2.1} />
            </span>
            {navExpanded && <span className="nav-brand-text">EdgeData</span>}
            {navExpanded && <span className="nav-brand-badge">Cloud</span>}
          </a>
          <button
            type="button"
            className="side-nav-toggle"
            onClick={() => setNavExpanded((value) => !value)}
            aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
            data-tooltip={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
            {...getTooltipHandlers(navExpanded ? 'Collapse navigation' : 'Expand navigation')}
          >
            {navExpanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>

        <div className="side-nav-tabs" role="tablist" aria-label="Primary">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`side-nav-tab ${view === item.key ? 'active' : ''}`}
              onClick={() => setAddressableView(item.key)}
              data-tooltip={item.label}
              {...getTooltipHandlers(item.label)}
            >
              <span className="side-nav-tab-icon" aria-hidden="true">{renderNavIcon(item.key)}</span>
              {navExpanded && <span className="side-nav-tab-label">{item.label}</span>}
            </button>
          ))}
        </div>

      </aside>
      {sidebarTooltip && (
        <div
          className="side-nav-flyout-tooltip"
          role="status"
          aria-live="polite"
          style={{ left: `${sidebarTooltip.x}px`, top: `${sidebarTooltip.y}px` }}
        >
          {sidebarTooltip.label}
        </div>
      )}

      <main className={`main ${hasScrollableResultsPanel ? 'main-search-scroll-lock' : ''}`}>
        <div className="top-utility-bar">
          <div className="theme-toggle-popover">
            <button
              type="button"
              className="theme-toggle-trigger"
              aria-label="Theme options"
            >
              <SunMoon size={14} />
            </button>
            <div className="theme-toggle-menu" role="group" aria-label="Theme preference">
              <button
                type="button"
                className={`theme-icon-btn ${themePreference === 'system' ? 'active' : ''}`}
                onClick={() => setThemePreference('system')}
                title="System theme"
                aria-label="Use system theme"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`theme-icon-btn ${themePreference === 'light' ? 'active' : ''}`}
                onClick={() => setThemePreference('light')}
                title="Light theme"
                aria-label="Use light theme"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.2 2.2M16.8 16.8L19 19M19 5l-2.2 2.2M7.2 16.8L5 19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`theme-icon-btn ${themePreference === 'dark' ? 'active' : ''}`}
                onClick={() => setThemePreference('dark')}
                title="Dark theme"
                aria-label="Use dark theme"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14.7 3.6a8.7 8.7 0 1 0 5.7 12.4A9 9 0 1 1 14.7 3.6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div className="nav-user-badge">
            <span className="nav-user">{user.email || user.id}</span>
            <span className="nav-role">{user.role}</span>
          </div>
          <button type="button" className="nav-logout" onClick={logout} aria-label="Sign out" title="Sign out">
            <span className="side-nav-tab-icon" aria-hidden="true">{renderNavIcon('signout')}</span>
          </button>
        </div>
        {view === 'livetail' && <LiveTailView apiBase={API_BASE} apiToken={apiToken || null} onSelectEvent={setSelectedEvent} />}
        {view === 'workspace' && (
          <IncidentWorkspacePage
            apiToken={apiToken}
            sessionIdFromUrl={sessionIdFromUrl}
            onRunStarterQuery={runWorkspaceStarterQuery}
          />
        )}
        {view === 'search' && (
          <div className="search-view">
            {workspaceLaunchInfo && <div className="success-banner">{workspaceLaunchInfo}</div>}
            <div className="search-bar sticky">
              <div className="search-filters search-filters-primary">
                <div className="filter-group">
                  <label>Time Range</label>
                  <div className="time-inputs">
                    <input
                      type="datetime-local"
                      value={timeFrom}
                      onChange={(event) => {
                        setTimeFrom(event.target.value);
                        setActiveTimePreset(null);
                      }}
                    />
                    <span>to</span>
                    <input
                      type="datetime-local"
                      value={timeTo}
                      onChange={(event) => {
                        setTimeTo(event.target.value);
                        setActiveTimePreset(null);
                      }}
                    />
                  </div>
                  <div className="time-presets">
                    {TIME_RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={activeTimePreset === preset.label ? 'active' : ''}
                        onClick={() => applyTimePreset(preset.fromOffsetMinutes, preset.toOffsetMinutes, preset.label)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="search-top-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShowAdvancedFilters((value) => !value)}
                  >
                    {showAdvancedFilters ? 'Hide Filters' : `Advanced Filters${activeAdvancedFilterCount > 0 ? ` (${activeAdvancedFilterCount})` : ''}`}
                  </button>
                </div>
              </div>

              {showAdvancedFilters && (
                <div className="search-filters search-filters-advanced">
                  <div className="filter-group">
                    <label>Index</label>
                    <input type="text" value={indexName} onChange={(event) => setIndexName(event.target.value)} placeholder="all indexes" />
                  </div>

                  <div className="filter-group">
                    <label>Service</label>
                    <input type="text" value={service} onChange={(event) => setService(event.target.value)} placeholder="paymentservice" />
                  </div>

                  <div className="filter-group">
                    <label>Env</label>
                    <input type="text" value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder="demo" />
                  </div>

                  <div className="filter-group">
                    <label>Host</label>
                    <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="otel-demo-node-1" />
                  </div>

                  <div className="filter-group">
                    <label>Level</label>
                    <input type="text" value={level} onChange={(event) => setLevel(event.target.value)} placeholder="error" />
                  </div>

                  <div className="filter-group">
                    <label>Status</label>
                    <input type="number" value={statusCode} onChange={(event) => setStatusCode(event.target.value)} placeholder="500" />
                  </div>
                </div>
              )}

              <div className="search-input">
                <div className="query-input-wrapper" ref={queryTypeaheadRef}>
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onFocus={() => {
                      setQueryFocused(true);
                      setQuerySuggestionsOpen(querySuggestions.length > 0);
                    }}
                    onBlur={() => {
                      setQueryFocused(false);
                    }}
                    placeholder='search * | where index="otel-demo" | sort -ts | head 200'
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
                        event.preventDefault();
                        setQuerySuggestionsOpen(querySuggestions.length > 0);
                        setQuerySuggestionIndex(querySuggestions.length > 0 ? 0 : -1);
                        return;
                      }

                      if (querySuggestionsOpen && querySuggestions.length > 0) {
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setQuerySuggestionIndex((index) => (index + 1) % querySuggestions.length);
                          return;
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setQuerySuggestionIndex((index) => (index <= 0 ? querySuggestions.length - 1 : index - 1));
                          return;
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          closeQuerySuggestions();
                          return;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                          if (querySuggestionIndex >= 0 && querySuggestionIndex < querySuggestions.length) {
                            event.preventDefault();
                            applyQuerySuggestion(querySuggestions[querySuggestionIndex]);
                            return;
                          }
                        }
                      }

                      if (event.key === 'Enter') {
                        setCursor(null);
                        setActiveIndex(-1);
                        closeQuerySuggestions();
                        void runSearch({ append: false, cursor: null });
                      }
                    }}
                  />
                  {querySuggestionsOpen && (
                    <div className="query-typeahead-dropdown" role="listbox" aria-label="Search suggestions">
                      {querySuggestionsLoading && (
                        <div className="query-typeahead-status">Loading suggestions...</div>
                      )}
                      {!querySuggestionsLoading && querySuggestions.length === 0 && (
                        <div className="query-typeahead-status">No suggestions yet.</div>
                      )}
                      {querySuggestions.map((item, index) => (
                        <button
                          key={`${item.kind}-${item.label}-${index}`}
                          type="button"
                          className={`query-typeahead-item ${index === querySuggestionIndex ? 'active' : ''}`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applyQuerySuggestion(item);
                          }}
                          onMouseEnter={() => setQuerySuggestionIndex(index)}
                        >
                          <span className="query-typeahead-row">
                            <strong>{item.label}</strong>
                            <span className="query-typeahead-kind">{item.kind}</span>
                          </span>
                          {item.detail && <span className="query-typeahead-detail">{item.detail}</span>}
                          {item.example && <span className="query-typeahead-example">{item.example}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    setCursor(null);
                    setActiveIndex(-1);
                    closeQuerySuggestions();
                    void runSearch({ append: false, cursor: null });
                  }}
                  disabled={loading}
                >
                  {loading ? 'Searching...' : 'Search'}
                </button>
                {loading && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={cancelOngoingSearch}
                  >
                    Cancel
                  </button>
                )}
                <label className="stream-toggle">
                  <input
                    type="checkbox"
                    checked={streamSearch}
                    onChange={(event) => setStreamSearch(event.target.checked)}
                  />
                  Stream
                </label>
                <div className="search-actions-anchor" ref={searchActionsRef}>
                  <button
                    type="button"
                    className="secondary"
                    aria-label="More search actions"
                    onClick={() => setShowSearchActions((value) => !value)}
                  >
                    ...
                  </button>
                  {showSearchActions && (
                    <div className="search-actions-menu">
                      <button
                        className="secondary search-action-item"
                        type="button"
                        onClick={() => {
                          setShowSaveSearchInline(true);
                          setShowSearchActions(false);
                        }}
                      >
                        <span className="action-icon" aria-hidden="true">S</span>
                        Save current search
                      </button>
                      {query.trim() && (
                        <button
                          className="secondary search-action-item"
                          type="button"
                          onClick={() => {
                            scheduleCurrentSearch();
                            setShowSearchActions(false);
                          }}
                        >
                          <span className="action-icon" aria-hidden="true">T</span>
                          Schedule current search
                        </button>
                      )}
                      {hasActiveAdvancedFilters && (
                        <button
                          className="secondary search-action-item"
                          type="button"
                          onClick={() => {
                            setIndexName('');
                            setService('');
                            setEnvironment('');
                            setHost('');
                            setLevel('');
                            setStatusCode('');
                            setShowAdvancedFilters(false);
                            setShowSearchActions(false);
                          }}
                        >
                          <span className="action-icon" aria-hidden="true">C</span>
                          Clear advanced filters
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {showSaveSearchInline && (
                <div className="save-search-row">
                  <input
                    type="text"
                    value={saveName}
                    onChange={(event) => setSaveName(event.target.value)}
                    placeholder="Saved search name"
                  />
                  <button className="secondary" type="button" onClick={() => void saveCurrentSearch()}>Save Search</button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      setShowSaveSearchInline(false);
                      setSaveName('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {hasPivots(investigationPivots) && (
                <PivotChips pivots={investigationPivots} onPivotClick={handlePivotClick} />
              )}
            </div>

            {error && <div className="error-banner">{error}</div>}
            {guardrailDetail && (
              <div className="guardrail-banner" role="status" aria-live="polite">
                <div className="guardrail-title">{guardrailDetail.title}</div>
                <div className="guardrail-reason">{guardrailDetail.reason}</div>
                <div className="guardrail-suggestion"><strong>Try:</strong> {guardrailDetail.suggestion}</div>
              </div>
            )}

            {stats && (
              <div className="search-stats">
                {streaming && <span className="streaming-pill">Streaming results...</span>}
                {!streaming && summaryLoading && <span className="streaming-pill">Updating summary...</span>}
                <span><strong>Mode:</strong> {modeLabel(stats.mode)}</span>
                <span><strong>Lang:</strong> PPL</span>
                <span><strong>Returned:</strong> {stats.returned}</span>
                <span><strong>Partitions:</strong> {stats.scanned_partitions}</span>
                <span><strong>Objects:</strong> {stats.scanned_objects}</span>
                <span><strong>Indexes:</strong> {facets.indexes.length}</span>
                <span><strong>Services:</strong> {facets.services.length}</span>
                <span><strong>Hosts:</strong> {facets.hosts.length}</span>
                {stats.candidates > 0 && <span><strong>Candidates:</strong> {stats.candidates}</span>}
                {resultType === 'events' && <span><strong>Keys:</strong> j/k move, Enter open, Esc close</span>}
              </div>
            )}

            <div className="level-strip">
              <div className="pill error">Error {levelTotals.error}</div>
              <div className="pill warn">Warn {levelTotals.warn}</div>
              <div className="pill info">Info {levelTotals.info}</div>
              <div className="pill debug">Debug {levelTotals.debug}</div>
            </div>

            <div className="timeline-card card">
              <div className="timeline-head">
                <h4>Activity Timeline</h4>
                <span>
                  {streaming
                    ? 'Streaming...'
                    : summary
                      ? (summary.truncated ? 'Sampled timeline' : 'Timeline')
                      : results.length > 0
                        ? 'Timeline'
                        : summaryLoading
                          ? 'Updating summary...'
                          : 'Run a search to load summary'}
                </span>
              </div>
              <div className="timeline-bars">
                {timeline.length === 0 ? (
                  <p className="facet-empty">No timeline data yet.</p>
                ) : (
                  timeline.map((point) => (
                    <div
                      key={point.minute}
                      className="timeline-col"
                      title={`${formatDateTime(point.minute)} to ${formatDateTime(new Date(new Date(point.minute).getTime() + timelineStepMs).toISOString())} - ${point.count} events`}
                    >
                      <div className="timeline-bar" style={{ height: `${Math.max(8, (point.count / timelineMax) * 58)}px` }} />
                    </div>
                  ))
                )}
              </div>
              {timelineAxisMarks.length > 0 && (
                <div className="timeline-axis">
                  {timelineAxisMarks.map((mark) => (
                    <span key={mark.key} className={`timeline-axis-label ${mark.align}`}>{mark.label}</span>
                  ))}
                </div>
              )}
            </div>

            {loading && results.length === 0 && !error ? (
              <div className="search-loading-state card" role="status" aria-live="polite">
                <div className="search-loading-header">
                  <div className="search-loading-dot" aria-hidden="true" />
                  <div>
                    <h4>Searching logs...</h4>
                    <p>
                      {streamSearch
                        ? 'Streaming first matches as soon as they arrive.'
                        : 'Scanning partitions and preparing your results.'}
                    </p>
                  </div>
                </div>
                <div className="search-loading-meta">
                  <span>
                    <strong>Query:</strong>{' '}
                    {query.trim()
                      ? (query.trim().length > 90 ? `${query.trim().slice(0, 90)}...` : query.trim())
                      : 'search *'}
                  </span>
                  <span>
                    <strong>Window:</strong>{' '}
                    {Number.isNaN(Date.parse(timeFrom)) || Number.isNaN(Date.parse(timeTo))
                      ? 'Custom range'
                      : `${formatDateTime(new Date(timeFrom).toISOString())} to ${formatDateTime(new Date(timeTo).toISOString())}`}
                  </span>
                  <span><strong>Tip:</strong> Use Cancel to stop long-running scans.</span>
                </div>
                <div className="search-loading-grid" aria-hidden="true">
                  <div className="search-loading-col search-loading-col-facets">
                    <div className="search-loading-col-title">Facets</div>
                    <div className="search-loading-skeleton" />
                    <div className="search-loading-skeleton short" />
                    <div className="search-loading-skeleton" />
                    <div className="search-loading-skeleton short" />
                  </div>
                  <div className="search-loading-col">
                    <div className="search-loading-col-title">Results</div>
                    <div className="search-loading-skeleton tall" />
                    <div className="search-loading-skeleton" />
                    <div className="search-loading-skeleton" />
                    <div className="search-loading-skeleton short" />
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="explorer-layout"
                ref={explorerLayoutRef}
                style={explorerPanelHeight ? { height: `${explorerPanelHeight}px` } : undefined}
              >
                <aside className="facet-panel">
                <div className="facet-card">
                  <h4>Indexes</h4>
                  {facets.indexes.length === 0 && <p className="facet-empty">No data</p>}
                  {facets.indexes.map((facet) => (
                    <button key={`idx-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('indexName', facet.value)}>
                      <span>{facet.value}</span>
                      <div className="facet-right">
                        <strong>{facet.count}</strong>
                        <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.indexes)) * 100}%` }} /></div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="facet-card">
                  <h4>Services</h4>
                  {facets.services.length === 0 && <p className="facet-empty">No data</p>}
                  {facets.services.map((facet) => (
                    <button key={`svc-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('service', facet.value)}>
                      <span>{facet.value}</span>
                      <div className="facet-right">
                        <strong>{facet.count}</strong>
                        <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.services)) * 100}%` }} /></div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="facet-card">
                  <h4>Levels</h4>
                  {facets.levels.length === 0 && <p className="facet-empty">No data</p>}
                  {facets.levels.map((facet) => (
                    <button key={`lvl-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('level', facet.value)}>
                      <span>{facet.value}</span>
                      <div className="facet-right">
                        <strong>{facet.count}</strong>
                        <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.levels)) * 100}%` }} /></div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="facet-card">
                  <h4>Status</h4>
                  {facets.statuses.length === 0 && <p className="facet-empty">No data</p>}
                  {facets.statuses.map((facet) => (
                    <button key={`status-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('statusCode', facet.value)}>
                      <span>{facet.value}</span>
                      <div className="facet-right">
                        <strong>{facet.count}</strong>
                        <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.statuses)) * 100}%` }} /></div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="facet-card">
                  <h4>Hosts</h4>
                  {facets.hosts.length === 0 && <p className="facet-empty">No data</p>}
                  {facets.hosts.map((facet) => (
                    <button key={`host-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('host', facet.value)}>
                      <span>{facet.value}</span>
                      <div className="facet-right">
                        <strong>{facet.count}</strong>
                        <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.hosts)) * 100}%` }} /></div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="facet-card">
                  <h4>Top Terms</h4>
                  {topTerms.length === 0 && <p className="facet-empty">No data</p>}
                  {topTerms.map((facet) => (
                    <button key={`term-${facet.value}`} className="facet-item" onClick={() => runPivot(facet.value)}>
                      <span>{facet.value}</span>
                      <div className="facet-right">
                        <strong>{facet.count}</strong>
                        <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(topTerms)) * 100}%` }} /></div>
                      </div>
                    </button>
                  ))}
                </div>

                {hasPivots(investigationPivots) && (
                  <RelatedEventsPanel
                    apiFetch={apiFetch}
                    scope={{
                      index: indexName.trim() || 'default',
                      service: service.trim() || 'unknown',
                      env: environment.trim() || 'prod'
                    }}
                    time={{
                      from: new Date(timeFrom).toISOString(),
                      to: new Date(timeTo).toISOString()
                    }}
                    pivots={investigationPivots}
                    onSelectRelatedEvent={handleSelectRelatedEvent}
                  />
                )}

                <div className="facet-card">
                  <h4>Field Coverage</h4>
                  <p className="field-coverage-subtitle">
                    {fieldPresenceSampleSize > 0
                      ? `Coverage across ${fieldPresenceSampleSize} event${fieldPresenceSampleSize === 1 ? '' : 's'}`
                      : 'Run a search to calculate field coverage'}
                  </p>
                  <div className="field-coverage-kpis">
                    <div className="field-coverage-kpi">
                      <span className="field-coverage-kpi-label">Overall</span>
                      <strong>{fieldCoverageAverage}%</strong>
                    </div>
                    <div className="field-coverage-kpi">
                      <span className="field-coverage-kpi-label">Quality</span>
                      <strong>{fieldCoverageQuality}</strong>
                    </div>
                  </div>
                  {summaryUnavailable && (
                    <p className="field-coverage-warning">
                      Summary endpoint unavailable (404). Showing coverage from loaded results only.
                    </p>
                  )}
                  {fieldCoverageFilter && (
                    <div className="field-coverage-filter-chip">
                      <span>
                        Applied filter: {fieldCoverageFilter.field} {fieldCoverageFilter.mode === 'present' ? 'present' : 'missing'}
                      </span>
                      <button type="button" onClick={clearFieldCoverageFilter}>Clear</button>
                    </div>
                  )}
                  <div className="field-presence-list">
                    {fieldPresenceGroups.map((group) => (
                      <details key={group.key} className="field-coverage-group" open>
                        <summary className="field-coverage-group-summary">
                          <span>{group.title}</span>
                          <strong>{group.average}%</strong>
                        </summary>
                        {group.rows.map((row) => (
                          <div key={row.key} className={`field-presence-row coverage-${row.percent >= 80 ? 'strong' : row.percent >= 50 ? 'mixed' : 'sparse'}`}>
                            <div className="field-coverage-topline">
                              <button
                                type="button"
                                className="field-coverage-action field-label-action"
                                onClick={() => runFieldCoverageQuery(row.key, 'present')}
                                title={`Filter to events where ${row.key} is present`}
                              >
                                {row.label}
                              </button>
                              <strong>{row.percent}%</strong>
                            </div>
                            <div className="field-coverage-track">
                              <div className="field-coverage-bar" style={{ width: `${row.percent}%` }} />
                            </div>
                            <div className="field-coverage-footnote">
                              <span>{row.count} present</span>
                              {fieldPresenceSampleSize > 0 && (
                                <button
                                  type="button"
                                  className="field-coverage-action field-missing-action"
                                  onClick={() => runFieldCoverageQuery(row.key, 'missing')}
                                  title={`Filter to events where ${row.key} is missing`}
                                >
                                  {row.missing} missing
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </details>
                    ))}
                    {fieldPresenceGroups.length === 0 && (
                      <div className="field-presence-row">
                        <div className="field-coverage-topline">
                          <span>No field coverage data yet</span>
                          <strong>0%</strong>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </aside>

                <section className="events-panel">
                {resultType === 'events' && results.length === 0 && !loading && !error && (
                  <div className="empty-state card">
                    <p>No results found. Adjust time range, filters, or PPL query.</p>
                  </div>
                )}

                {resultType === 'table' ? (
                  <div className="card tabular-results">
                    {tableRows.length === 0 ? (
                      <p className="empty-card">No tabular rows returned.</p>
                    ) : (
                      <table className="tabular-results-table">
                        <thead>
                          <tr>
                            {Object.keys(tableRows[0]).map((key) => (
                              <th key={key}>{key}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.map((row, index) => (
                            <tr key={`row-${index}`}>
                              {Object.keys(tableRows[0]).map((key) => (
                                <td key={`${index}-${key}`}>
                                  {String(row[key] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : (
                  <div className="event-feed">
                    {results.map((event, index) => {
                      const preview = event.message.length > 340 ? `${event.message.slice(0, 340)}...` : event.message;
                      const attrPairs = attrsPreviewPairs(event.attrs_json);
                      return (
                        <article
                          key={event.event_id}
                          data-event-index={index}
                          className={`event-card level-${event.level} ${index === activeIndex ? 'active' : ''}`}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => {
                            setActiveIndex(index);
                            setSelectedEvent(event);
                          }}
                        >
                          <header className="event-head">
                            <div className="event-time">{formatDateTime(event.ts)}</div>
                            <div className="event-service">{event.service}</div>
                            <span className={`badge ${event.level}`}>{event.level}</span>
                          </header>

                          <div className="event-message">{highlightText(preview, highlightTerms)}</div>

                          <footer className="event-meta">
                            <span className="meta-chip">idx:{event.index || 'default'}</span>
                            <span className="meta-chip">env:{event.env}</span>
                            <span className="meta-chip">host:{event.host}</span>
                            {event.status !== undefined && <span className="meta-chip">status:{event.status}</span>}
                            {event.duration_ms !== undefined && <span className="meta-chip">dur:{event.duration_ms}ms</span>}
                            {event.trace_id && <span className="meta-chip">trace:{event.trace_id.slice(0, 16)}</span>}
                            {event.span_id && <span className="meta-chip">span:{event.span_id.slice(0, 16)}</span>}
                            {event.request_id && <span className="meta-chip">req:{event.request_id.slice(0, 16)}</span>}
                            {attrPairs.map((pair) => (
                              <span key={`${event.event_id}-${pair.key}`} className="meta-chip attr-chip">
                                {pair.key}:{pair.value}
                              </span>
                            ))}
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                )}

                {resultType === 'events' && cursor && results.length > 0 && (
                  <button className="load-more" disabled={loading} onClick={() => void runSearch({ append: true, cursor })}>
                    {loading ? 'Loading...' : 'Load More'}
                  </button>
                )}
                </section>
              </div>
            )}
          </div>
        )}

        {view === 'dashboard' && (
          <Suspense fallback={<div className="empty-state"><p>Loading dashboard builder...</p></div>}>
            <DashboardPage apiFetch={apiFetch} />
          </Suspense>
        )}

        {view === 'alerts' && (
          <div className="alerts-view">
            {alertsError && <div className="error-banner">{alertsError}</div>}
            {alertsInfo && <p className="empty-card">{alertsInfo}</p>}

            <div className="alerts-layout">
              <div className="card alert-form-card">
                <h3>Create Alert</h3>
                <div className="alert-form-grid">
                  <label className="alert-form-field">
                    <span>Alert Name</span>
                    <input
                      type="text"
                      value={newAlertName}
                      onChange={(event) => setNewAlertName(event.target.value)}
                      placeholder="API error spike in prod"
                    />
                  </label>

                  <label className="alert-form-field">
                    <span>Template</span>
                    <select
                      value={newAlertTemplateId}
                      onChange={(event) => setNewAlertTemplateId(event.target.value as AlertQueryTemplate)}
                    >
                      {ALERT_TEMPLATE_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.label}</option>
                      ))}
                    </select>
                  </label>

                  <p className="alert-template-hint">{selectedAlertTemplate.description}</p>

                  <div className="alert-form-row cols-3">
                    <label className="alert-form-field">
                      <span>Window (minutes)</span>
                      <input
                        type="number"
                        min={1}
                        value={newAlertWindowMinutes}
                        onChange={(event) => setNewAlertWindowMinutes(event.target.value)}
                      />
                    </label>
                    <label className="alert-form-field">
                      <span>Schedule (seconds)</span>
                      <input
                        type="number"
                        min={1}
                        value={newAlertSchedule}
                        onChange={(event) => setNewAlertSchedule(event.target.value)}
                      />
                    </label>
                    <label className="alert-form-field">
                      <span>Cooldown (seconds)</span>
                      <input
                        type="number"
                        min={1}
                        value={newAlertCooldown}
                        onChange={(event) => setNewAlertCooldown(event.target.value)}
                      />
                    </label>
                  </div>

                  <div className="alert-form-row cols-2">
                    <label className="alert-form-field">
                      <span>Threshold Rule</span>
                      <select
                        value={newAlertThresholdOperator}
                        onChange={(event) => setNewAlertThresholdOperator(event.target.value as AlertThresholdOperator)}
                      >
                        {ALERT_THRESHOLD_OPERATOR_OPTIONS.map((operator) => (
                          <option key={operator.value} value={operator.value}>{operator.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="alert-form-field">
                      <span>Threshold Value</span>
                      <input
                        type="number"
                        value={newAlertThresholdValue}
                        onChange={(event) => setNewAlertThresholdValue(event.target.value)}
                      />
                    </label>
                  </div>

                  <div className="alert-form-row cols-3">
                    <label className="alert-form-field">
                      <span>Index (optional)</span>
                      <input
                        type="text"
                        value={newAlertIndex}
                        onChange={(event) => setNewAlertIndex(event.target.value)}
                        placeholder={indexName.trim().toLowerCase() || 'default'}
                      />
                    </label>
                    <label className="alert-form-field">
                      <span>Service (optional)</span>
                      <input
                        type="text"
                        value={newAlertService}
                        onChange={(event) => setNewAlertService(event.target.value)}
                        placeholder="checkout-api"
                      />
                    </label>
                    <label className="alert-form-field">
                      <span>Environment (optional)</span>
                      <input
                        type="text"
                        value={newAlertEnv}
                        onChange={(event) => setNewAlertEnv(event.target.value)}
                        placeholder="prod"
                      />
                    </label>
                  </div>

                  {isTokenAlertTemplate && (
                    <label className="alert-form-field">
                      <span>Token</span>
                      <input
                        type="text"
                        value={newAlertToken}
                        onChange={(event) => setNewAlertToken(event.target.value)}
                        placeholder="unauthorized"
                      />
                    </label>
                  )}

                  <div className="alert-form-row cols-2">
                    <label className="alert-form-field">
                      <span>Severity</span>
                      <select
                        value={newAlertSeverity}
                        onChange={(event) => setNewAlertSeverity(event.target.value as 'critical' | 'warn' | 'info')}
                      >
                        <option value="critical">critical</option>
                        <option value="warn">warn</option>
                        <option value="info">info</option>
                      </select>
                    </label>
                    <div className="alert-form-field">
                      <span>Notify Channels</span>
                      <div className="alert-channel-group">
                        <label className="alert-check">
                          <input
                            type="checkbox"
                            checked={newAlertNotifySlack}
                            onChange={(event) => setNewAlertNotifySlack(event.target.checked)}
                          />
                          Slack
                        </label>
                        <label className="alert-check">
                          <input
                            type="checkbox"
                            checked={newAlertNotifyWebhook}
                            onChange={(event) => setNewAlertNotifyWebhook(event.target.checked)}
                          />
                          Webhook
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="alert-form-row cols-2">
                    <label className="alert-form-field">
                      <span>Owner Team (optional)</span>
                      <input
                        type="text"
                        value={newAlertOwnerTeam}
                        onChange={(event) => setNewAlertOwnerTeam(event.target.value)}
                        placeholder="edge-ops"
                      />
                    </label>
                    <label className="alert-form-field">
                      <span>Runbook URL (optional)</span>
                      <input
                        type="url"
                        value={newAlertRunbookUrl}
                        onChange={(event) => setNewAlertRunbookUrl(event.target.value)}
                        placeholder="https://runbooks.example.com/edge/error-rate"
                      />
                    </label>
                  </div>

                  <label className="alert-form-field">
                    <span>Deep Link URL Override (optional)</span>
                    <input
                      type="url"
                      value={newAlertDeepLink}
                      onChange={(event) => setNewAlertDeepLink(event.target.value)}
                      placeholder="Auto-generated from template + filters"
                    />
                  </label>

                  <div className="alert-starter-pack">
                    <h4>Starter Pack Defaults</h4>
                    <div className="alert-form-row cols-2">
                      <label className="alert-form-field">
                        <span>Runbook Base URL</span>
                        <input
                          type="text"
                          value={starterRunbookBase}
                          onChange={(event) => setStarterRunbookBase(event.target.value)}
                          placeholder="https://runbooks.example.com/edge"
                        />
                      </label>
                      <label className="alert-form-field">
                        <span>Owner Team</span>
                        <input
                          type="text"
                          value={starterOwnerTeam}
                          onChange={(event) => setStarterOwnerTeam(event.target.value)}
                          placeholder="edge-ops"
                        />
                      </label>
                    </div>
                  </div>

                  <div className="alert-json-preview">
                    <strong>Payload Preview</strong>
                    <pre>{JSON.stringify(alertPayloadPreview, null, 2)}</pre>
                  </div>
                </div>
                <div className="alert-actions">
                  <button className="secondary" onClick={() => void createAlert()}>Create Alert</button>
                  <button className="secondary" disabled={starterPackApplying} onClick={() => void applyStarterAlertPack()}>
                    {starterPackApplying ? 'Applying...' : 'Apply Starter Pack'}
                  </button>
                </div>
              </div>

              <div className="card alerts-list-card">
                <h3>Alert Definitions</h3>
                <div className="alert-governance-summary">
                  <span><strong>Total:</strong> {alertGovernance.total}</span>
                  <span><strong>Deep links:</strong> {alertGovernance.withDeepLink}/{alertGovernance.total}</span>
                  <span><strong>Runbooks:</strong> {alertGovernance.withRunbook}/{alertGovernance.total}</span>
                  <span><strong>Owner team:</strong> {alertGovernance.withOwnerTeam}/{alertGovernance.total}</span>
                </div>
                {alertsLoading && <p className="empty-card">Loading alerts...</p>}
                {!alertsLoading && alerts.length === 0 && <p className="empty-card">No alerts configured.</p>}
                {!alertsLoading && alerts.map((alert) => {
                  const notify = parseAlertNotifyConfig(alert.notify_json);
                  const params = parseAlertParamsConfig(alert.params_json);
                  const workspaceHref = buildAlertWorkspaceHref(alert);
                  const missing: string[] = [];
                  if (!notify.deep_link) missing.push('deep-link');
                  if (!notify.runbook_url) missing.push('runbook');
                  if (!notify.owner_team) missing.push('owner-team');

                  return (
                    <div key={alert.id} className="alert-row">
                      <div className="alert-main">
                        <div className="alert-name">{alert.name}</div>
                        <div className="alert-meta">
                          <span>{alert.type}</span>
                          <span>template:{alert.query_template}</span>
                          <span>every {alert.schedule_seconds}s</span>
                          <span>{alert.enabled ? 'enabled' : 'disabled'}</span>
                          {notify.severity && <span>severity:{notify.severity}</span>}
                          {params.window_minutes && <span>window:{params.window_minutes}m</span>}
                          {params.token && <span>token:{params.token}</span>}
                          {params.service && <span>service:{params.service}</span>}
                          {params.env && <span>env:{params.env}</span>}
                          {params.index && <span>index:{params.index}</span>}
                        </div>
                        <div className="alert-governance">
                          {notify.owner_team && <span className="alert-governance-pill ok">team:{notify.owner_team}</span>}
                          {notify.runbook_url && <span className="alert-governance-pill ok">runbook attached</span>}
                          {notify.deep_link && <span className="alert-governance-pill ok">deep-link attached</span>}
                          {missing.length > 0 && (
                            <span className="alert-governance-pill missing">missing {missing.join(', ')}</span>
                          )}
                        </div>
                      </div>
                      <div className="alert-actions">
                        {workspaceHref && (
                          <a className="secondary alert-link-btn" href={workspaceHref}>Investigate</a>
                        )}
                        {notify.deep_link && (
                          <a className="secondary alert-link-btn" href={notify.deep_link} target="_blank" rel="noreferrer">Open Deep Link</a>
                        )}
                        {notify.runbook_url && (
                          <a className="secondary alert-link-btn" href={notify.runbook_url} target="_blank" rel="noreferrer">Runbook</a>
                        )}
                        <button className="secondary" onClick={() => void toggleAlertEnabled(alert)}>
                          {alert.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="danger" onClick={() => void deleteAlert(alert.id)}>Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {view === 'admin' && (
          <div className="admin-view">
            <div className="admin-header">
              <h2>Administration</h2>
              <span className="admin-subtitle">{adminUsers.length} user{adminUsers.length !== 1 ? 's' : ''} &middot; {adminRoles.length} role{adminRoles.length !== 1 ? 's' : ''}</span>
            </div>

            {adminToast && <div className="success-banner">{adminToast}</div>}
            {adminError && <div className="error-banner">{adminError}</div>}
            {adminLoading && <div className="empty-state"><p>Loading admin data...</p></div>}

            {!adminLoading && (
              <div className="admin-grid">
                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon synthetic">S</span>
                    Synthetic Ingest Control
                  </div>
                  <div className="admin-form-row">
                    <div className="admin-form-group">
                      <label>Current runtime state</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className={`status-badge ${syntheticIngestControl?.enabled ? 'active' : 'disabled'}`}>
                          {syntheticIngestControl?.enabled ? 'enabled' : 'disabled'}
                        </span>
                        {syntheticIngestControl?.updated_at && (
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                            updated {formatDateTime(syntheticIngestControl.updated_at)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="admin-submit"
                      onClick={() => void setSyntheticIngestEnabled(true)}
                      disabled={syntheticControlLoading || !!syntheticIngestControl?.enabled}
                    >
                      {syntheticControlLoading ? 'Updating...' : 'Start Synthetic Ingest'}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => void runSyntheticIngestNow()}
                      disabled={syntheticControlLoading}
                    >
                      Run Once Now
                    </button>
                    <button
                      className="danger"
                      onClick={() => void setSyntheticIngestEnabled(false)}
                      disabled={syntheticControlLoading || !syntheticIngestControl?.enabled}
                    >
                      Stop
                    </button>
                  </div>
                  <p style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                    Start also triggers an immediate synthetic run so Live Tail shows fresh events quickly.
                  </p>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon invite">+</span>
                    Invite User
                  </div>
                  <div className="admin-form-row">
                    <div className="admin-form-group">
                      <label>Email address</label>
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        placeholder="user@company.com"
                      />
                    </div>
                  </div>
                  <div className="admin-form-row cols-2">
                    <div className="admin-form-group">
                      <label>Auth mode</label>
                      <select value={inviteAuthMode} onChange={(event) => setInviteAuthMode(event.target.value as 'access_sso' | 'local_password')}>
                        <option value="access_sso">Access SSO</option>
                        <option value="local_password">Local Password</option>
                      </select>
                    </div>
                    <div className="admin-form-group">
                      <label>Roles</label>
                      <input
                        type="text"
                        value={inviteRoleIds}
                        onChange={(event) => setInviteRoleIds(event.target.value)}
                        placeholder="viewer, analyst"
                      />
                    </div>
                  </div>
                  <button className="admin-submit" onClick={() => void createInvite()}>Create Invite</button>
                  {inviteTokenPreview && (
                    <div className="invite-token-box">
                      <strong>One-time invite token</strong>
                      <code>{inviteTokenPreview}</code>
                    </div>
                  )}
                </div>

                <div className="admin-card admin-span-2">
                  <div className="admin-section-title">
                    <span className="section-icon onboarding">O</span>
                    Onboarding Checklist
                  </div>
                  <div className="onboarding-summary">
                    <strong>{onboardingDoneCount}/{onboardingChecklist.length}</strong> steps complete
                  </div>
                  <div className="onboarding-checklist">
                    {onboardingChecklist.map((item) => (
                      <div key={item.key} className={`onboarding-check ${item.done ? 'done' : 'todo'}`}>
                        <span className={`status-badge ${item.done ? 'active' : 'disabled'}`}>
                          {item.done ? 'Done' : 'Pending'}
                        </span>
                        <div className="onboarding-check-copy">
                          <strong>{item.title}</strong>
                          <span>{item.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon invite">I</span>
                    Invite Queue
                  </div>
                  <div className="table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Email</th>
                          <th>Auth Mode</th>
                          <th>Roles</th>
                          <th>Expires</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminInvites.map((invite) => (
                          <tr key={invite.id}>
                            <td><strong>{invite.email}</strong></td>
                            <td>{invite.auth_mode === 'access_sso' ? 'Access SSO' : 'Local Password'}</td>
                            <td>{invite.role_ids.map((roleId) => <span key={roleId} className="permission-tag">{roleId}</span>)}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(invite.expires_at)}</td>
                            <td>
                              <div className="invite-actions">
                                <button className="secondary" onClick={() => void resendInvite(invite)}>Resend</button>
                                <button className="danger" onClick={() => void revokeInvite(invite)}>Revoke</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {adminInvites.length === 0 && (
                          <tr className="empty-row">
                            <td colSpan={5}>No pending invites</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon role">R</span>
                    Create Role
                  </div>
                  <div className="admin-form-row cols-2">
                    <div className="admin-form-group">
                      <label>Role ID</label>
                      <input
                        type="text"
                        value={newRoleId}
                        onChange={(event) => setNewRoleId(event.target.value)}
                        placeholder="e.g. zeek_viewer"
                      />
                    </div>
                    <div className="admin-form-group">
                      <label>Display name</label>
                      <input
                        type="text"
                        value={newRoleName}
                        onChange={(event) => setNewRoleName(event.target.value)}
                        placeholder="Zeek Viewer"
                      />
                    </div>
                  </div>
                  <div className="admin-form-row">
                    <div className="admin-form-group">
                      <label>Permissions</label>
                      <input
                        type="text"
                        value={newRolePermissions}
                        onChange={(event) => setNewRolePermissions(event.target.value)}
                        placeholder="search.read, dashboard.read"
                      />
                    </div>
                  </div>
                  <div className="admin-form-row">
                    <div className="admin-form-group">
                      <label>Data scope (JSON)</label>
                      <textarea
                        value={newRoleScope}
                        onChange={(event) => setNewRoleScope(event.target.value)}
                        placeholder='{"indexes":["*"],"services":["*"],"envs":["*"],"hosts":["*"]}'
                      />
                    </div>
                  </div>
                  <button className="admin-submit" onClick={() => void createRole()}>Create Role</button>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon mapping">G</span>
                    Access Group Mapping
                  </div>
                  <div className="admin-form-row cols-2">
                    <div className="admin-form-group">
                      <label>IdP / Access group</label>
                      <input
                        type="text"
                        value={newMappingGroup}
                        onChange={(event) => setNewMappingGroup(event.target.value)}
                        placeholder="engineering-team"
                      />
                    </div>
                    <div className="admin-form-group">
                      <label>Role ID</label>
                      <input
                        type="text"
                        value={newMappingRoleId}
                        onChange={(event) => setNewMappingRoleId(event.target.value)}
                        placeholder="analyst"
                      />
                    </div>
                  </div>
                  <button className="admin-submit" onClick={() => void createMapping()}>Add Mapping</button>

                  <div className="table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Access Group</th>
                          <th>Role</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminMappings.map((mapping) => (
                          <tr key={mapping.id}>
                            <td>{mapping.access_group}</td>
                            <td><span className="permission-tag">{mapping.role_id}</span></td>
                          </tr>
                        ))}
                        {adminMappings.length === 0 && (
                          <tr className="empty-row">
                            <td colSpan={2}>No mappings yet</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="admin-card admin-span-2">
                  <div className="admin-section-title">
                    <span className="section-icon users">U</span>
                    Users
                  </div>
                  <div className="table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Email</th>
                          <th>Roles</th>
                          <th>Status</th>
                          <th>Last Login</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminUsers.map((row) => (
                          <tr key={row.id}>
                            <td><strong>{row.email}</strong></td>
                            <td>
                              <form
                                className="admin-inline-form"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  const form = event.currentTarget as HTMLFormElement;
                                  const input = form.elements.namedItem(`roles-${row.id}`) as HTMLInputElement | null;
                                  if (!input) return;
                                  void updateUserRoles(row, input.value);
                                }}
                              >
                                <input
                                  name={`roles-${row.id}`}
                                  defaultValue={row.role_ids.join(',')}
                                  placeholder="viewer,analyst"
                                />
                                <button className="secondary" type="submit">Set</button>
                              </form>
                            </td>
                            <td>
                              <span className={`status-badge ${row.enabled ? 'active' : 'disabled'}`}>
                                {row.enabled ? 'Active' : 'Disabled'}
                              </span>
                            </td>
                            <td>{row.last_login_at ? formatDateTime(row.last_login_at) : <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>never</span>}</td>
                            <td>
                              {row.enabled ? (
                                <button className="danger" onClick={() => void updateUserEnabled(row, 0)}>Disable</button>
                              ) : (
                                <button className="secondary" onClick={() => void updateUserEnabled(row, 1)}>Enable</button>
                              )}
                            </td>
                          </tr>
                        ))}
                        {adminUsers.length === 0 && (
                          <tr className="empty-row">
                            <td colSpan={5}>No users</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon roles">R</span>
                    Roles
                  </div>
                  <div className="table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Permissions</th>
                          <th>Scope</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminRoles.map((role) => (
                          <tr key={role.id}>
                            <td>
                              <strong>{role.id}</strong>
                              {role.system_role && <span className="system-badge">system</span>}
                            </td>
                            <td>{parseStringArray(role.permissions_json).map((p) => <span key={p} className="permission-tag">{p}</span>)}</td>
                            <td><span className="scope-cell" title={role.scope_json}>{role.scope_json}</span></td>
                          </tr>
                        ))}
                        {adminRoles.length === 0 && (
                          <tr className="empty-row">
                            <td colSpan={3}>No roles</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon audit">A</span>
                    Audit Log
                  </div>
                  <div className="table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Actor</th>
                          <th>Action</th>
                          <th>Target</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditRows.map((row) => (
                          <tr key={row.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.created_at)}</td>
                            <td>{row.actor_email || row.actor_principal || <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>system</span>}</td>
                            <td><span className="audit-action">{row.action}</span></td>
                            <td><span className="audit-target">{row.target_type || '-'}:{row.target_id || '-'}</span></td>
                          </tr>
                        ))}
                        {auditRows.length === 0 && (
                          <tr className="empty-row">
                            <td colSpan={4}>No audit records</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'scheduled' && (
          <div className="saved-view">
            {scheduledError && <div className="error-banner">{scheduledError}</div>}

            <div className="saved-list card">
              <div className="scheduled-header">
                <h3>Scheduled Searches</h3>
                <button onClick={() => setShowScheduleForm(f => !f)}>{showScheduleForm ? 'Cancel' : '+ New'}</button>
              </div>

              {showScheduleForm && (
                <div className="card scheduled-form-card">
                  <input type="text" value={scheduleFormName} onChange={e => setScheduleFormName(e.target.value)} placeholder="Search name" />
                  <input type="text" value={scheduleFormPpl} onChange={e => setScheduleFormPpl(e.target.value)} placeholder="PPL query (e.g. search * | where level=&quot;error&quot; | stats count() by service)" />
                  <div className="scheduled-form-row">
                    <input type="text" value={scheduleFormCron} onChange={e => setScheduleFormCron(e.target.value)} placeholder="Cron (0 * * * *)" className="scheduled-form-cron" />
                    <input type="number" value={scheduleFormWindow} onChange={e => setScheduleFormWindow(Number(e.target.value) || 60)} placeholder="Window (min)" className="scheduled-form-window" />
                  </div>
                  <button onClick={() => void createScheduledSearch()}>Create Scheduled Search</button>
                </div>
              )}

              {scheduledLoading && <p className="empty-card">Loading...</p>}

              {!scheduledLoading && scheduledSearches.length === 0 && <p className="empty-card">No scheduled searches yet.</p>}

              {scheduledSearches.map(ss => (
                <div key={ss.id} className="saved-row scheduled-row">
                  <div className="scheduled-row-top">
                    <div className="scheduled-row-main">
                      <div className="saved-name">
                        {ss.name}
                        <span className={`status-badge ${ss.enabled ? 'active' : 'disabled'}`}>
                          {ss.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className="scheduled-meta-inline">
                          {ss.schedule_cron} · {ss.time_window_minutes}m window
                        </span>
                      </div>
                      <div className="saved-query">{ss.ppl}</div>
                    </div>
                    <div className="saved-actions">
                      <button className="secondary" onClick={() => { void toggleScheduledSearch(ss.id, !ss.enabled); }}>
                        {ss.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => {
                          if (scheduledResults[ss.id]) {
                            setScheduledResults((prev) => {
                              const next = { ...prev };
                              delete next[ss.id];
                              return next;
                            });
                            return;
                          }
                          void loadScheduledResults(ss.id);
                        }}
                      >
                        {scheduledResults[ss.id] ? 'Hide Runs' : 'Results'}
                      </button>
                      <button className="danger" onClick={() => void deleteScheduledSearch(ss.id)}>Delete</button>
                    </div>
                  </div>

                  {scheduledResults[ss.id] && (
                    <div className="scheduled-runs">
                      <div className="scheduled-runs-header">
                        <strong>Recent runs</strong>
                        <span>{scheduledResults[ss.id].slice(0, 5).length} shown</span>
                      </div>
                      {scheduledResults[ss.id].length === 0 && <span className="scheduled-runs-empty">No runs yet</span>}
                      <div className="scheduled-run-list">
                        {scheduledResults[ss.id].slice(0, 5).map((r) => (
                          <div key={r.id} className="scheduled-run-row">
                            <span className="scheduled-run-time">{formatDateTime(r.run_at)}</span>
                            <span className={`scheduled-run-status status-${r.status === 'success' ? 'success' : 'error'}`}>
                              {r.status}
                            </span>
                            <span className="scheduled-run-count">{r.result_count} results</span>
                            {r.error_message && <span className="scheduled-run-error">{r.error_message}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {view === 'saved' && (
          <div className="saved-view">
            {savedError && <div className="error-banner">{savedError}</div>}
            {savedLoading && <div className="empty-state"><p>Loading saved searches...</p></div>}

            {!savedLoading && (
              <div className="saved-list card">
                <h3>Saved Searches</h3>
                {savedSearches.length === 0 && <p className="empty-card">No saved searches yet.</p>}

                {savedSearches.map((saved) => (
                  <div key={saved.id} className="saved-row">
                    <div>
                      <div className="saved-name">{saved.name}</div>
                      <div className="saved-query">{saved.query}</div>
                    </div>
                    <div className="saved-actions">
                      <button className="secondary" onClick={() => applySavedSearch(saved)}>Apply</button>
                      <button className="danger" onClick={() => void deleteSavedSearch(saved.id)}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {selectedEvent && (
        <div className="drawer-overlay" onClick={() => setSelectedEvent(null)}>
          <div className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <h3>Event Inspector</h3>
              <button onClick={() => setSelectedEvent(null)}>x</button>
            </div>

            <div className="drawer-content">
              <div className="detail-grid">
                <div className="detail-row"><strong>Time</strong>{selectedEvent.ts}</div>
                <div className="detail-row"><strong>Index</strong>{selectedEvent.index || 'default'}</div>
                <div className="detail-row"><strong>Service</strong>{selectedEvent.service}</div>
                <div className="detail-row"><strong>Env</strong>{selectedEvent.env}</div>
                <div className="detail-row"><strong>Host</strong>{selectedEvent.host}</div>
                <div className="detail-row"><strong>Level</strong>{selectedEvent.level}</div>
                {selectedEvent.status !== undefined && <div className="detail-row"><strong>Status</strong>{selectedEvent.status}</div>}
                {selectedEvent.duration_ms !== undefined && <div className="detail-row"><strong>Duration</strong>{selectedEvent.duration_ms}ms</div>}
                {selectedEvent.trace_id && <div className="detail-row"><strong>Trace ID</strong>{selectedEvent.trace_id}</div>}
                {selectedEvent.span_id && <div className="detail-row"><strong>Span ID</strong>{selectedEvent.span_id}</div>}
                {selectedEvent.parent_span_id && <div className="detail-row"><strong>Parent Span ID</strong>{selectedEvent.parent_span_id}</div>}
                {selectedEvent.request_id && <div className="detail-row"><strong>Request ID</strong>{selectedEvent.request_id}</div>}
                {selectedEvent.user_id && <div className="detail-row"><strong>User ID</strong>{selectedEvent.user_id}</div>}
                {selectedEvent.src_ip && <div className="detail-row"><strong>Source IP</strong>{selectedEvent.src_ip}</div>}
                {selectedEvent.msg_hash && <div className="detail-row"><strong>Message Hash</strong>{selectedEvent.msg_hash}</div>}
              </div>

              <div className="detail-row">
                <strong>Message</strong>
                {prettyJsonOrNull(selectedEvent.message) ? (
                  <pre className="syntax-block json" dangerouslySetInnerHTML={{ __html: jsonSyntaxHtml(prettyJsonOrNull(selectedEvent.message) || '') }} />
                ) : (
                  <pre className="syntax-block">{highlightText(selectedEvent.message, highlightTerms)}</pre>
                )}
              </div>

              {selectedEvent.attrs_json && (
                <div className="detail-row">
                  <strong>Attributes</strong>
                  {prettyJsonOrNull(selectedEvent.attrs_json) ? (
                    <pre className="syntax-block json" dangerouslySetInnerHTML={{ __html: jsonSyntaxHtml(prettyJsonOrNull(selectedEvent.attrs_json) || '') }} />
                  ) : (
                    <pre className="syntax-block">{highlightText(selectedEvent.attrs_json, highlightTerms)}</pre>
                  )}
                </div>
              )}

              <div className="detail-row">
                <strong>Event ID</strong>
                <code>{selectedEvent.event_id}</code>
              </div>

              <div className="pivot-row">
                <button onClick={() => runPivot(`index=${selectedEvent.index || 'default'}`)}>Pivot Index</button>
                {selectedEvent.trace_id && <button onClick={() => runPivot(`trace_id=${selectedEvent.trace_id}`)}>Pivot Trace</button>}
                {selectedEvent.trace_id && <button onClick={() => openTraceContextFromEvent(selectedEvent)}>Trace Context</button>}
                {selectedEvent.span_id && <button onClick={() => runPivot(`span_id=${selectedEvent.span_id}`)}>Pivot Span</button>}
                {selectedEvent.parent_span_id && <button onClick={() => runPivot(`parent_span_id=${selectedEvent.parent_span_id}`)}>Pivot Parent Span</button>}
                {selectedEvent.request_id && <button onClick={() => runPivot(`request_id=${selectedEvent.request_id}`)}>Pivot Request</button>}
                {selectedEvent.user_id && <button onClick={() => runPivot(`user_id=${selectedEvent.user_id}`)}>Pivot User</button>}
                {selectedEvent.src_ip && <button onClick={() => runPivot(`src_ip=${selectedEvent.src_ip}`)}>Pivot IP</button>}
                {selectedEvent.msg_hash && <button onClick={() => runPivot(`msg_hash=${selectedEvent.msg_hash}`)}>Pivot MsgHash</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
