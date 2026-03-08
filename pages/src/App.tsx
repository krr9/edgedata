import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { AuthScreen } from './AuthScreen';
import { IncidentWorkspacePage } from './investigation/IncidentWorkspacePage';
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
const TAB_QUERY_PARAM = 'tab';
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

interface SearchResponse {
  result_type?: 'events' | 'table';
  results: Array<LogEvent | DashboardRow>;
  next_cursor: { before_ts: string; before_event_id: string } | null;
  stats: SearchStats;
  warning?: string;
  error?: string;
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

const API_BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_QUERY_API_BASE || 'https://query-worker.example.workers.dev';
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

  const wsUrl = apiToken
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
            {connected ? 'Waiting for events…' : 'Connecting…'}
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
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'search';
    return readViewFromLocation(window.location) || 'search';
  });

  const [query, setQuery] = useState('');
  const [queryFocused, setQueryFocused] = useState(false);
  const [querySuggestions, setQuerySuggestions] = useState<QuerySuggestionItem[]>([]);
  const [querySuggestionsOpen, setQuerySuggestionsOpen] = useState(false);
  const [querySuggestionsLoading, setQuerySuggestionsLoading] = useState(false);
  const [querySuggestionIndex, setQuerySuggestionIndex] = useState(-1);
  const [timeFrom, setTimeFrom] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return d.toISOString().slice(0, 16);
  });
  const [timeTo, setTimeTo] = useState(() => new Date().toISOString().slice(0, 16));
  const [activeTimePreset, setActiveTimePreset] = useState<string | null>('Last 24h');

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
    setTimeFrom(from.toISOString().slice(0, 16));
    setTimeTo(to.toISOString().slice(0, 16));
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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user, token: authToken, loading: authLoading, logout } = useAuth();
  const apiToken = authToken || '';

  const [activeIndex, setActiveIndex] = useState(-1);
  const [selectedEvent, setSelectedEvent] = useState<LogEvent | null>(null);
  const [bootstrappedSearch, setBootstrappedSearch] = useState(false);
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
  const [newAlertType, setNewAlertType] = useState('wae_sql');
  const [newAlertSchedule, setNewAlertSchedule] = useState('300');
  const [newAlertQueryTemplate, setNewAlertQueryTemplate] = useState('error_rate_over_threshold');
  const [newAlertThreshold, setNewAlertThreshold] = useState('{\"operator\":\"gt\",\"value\":5}');
  const [newAlertParams, setNewAlertParams] = useState('{\"window_minutes\":5}');
  const [newAlertNotify, setNewAlertNotify] = useState('{\"slack\":true}');

  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUserRow[]>([]);
  const [adminRoles, setAdminRoles] = useState<RoleRow[]>([]);
  const [adminMappings, setAdminMappings] = useState<GroupRoleMappingRow[]>([]);
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
  const setAddressableView = useCallback((nextView: ViewMode, options?: { replace?: boolean }) => {
    setView(nextView);
    writeViewToLocation(nextView, options);
  }, []);

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
      request_id: results.filter((event) => !!event.request_id).length,
      user_id: results.filter((event) => !!event.user_id).length,
      src_ip: results.filter((event) => !!event.src_ip).length,
      status: results.filter((event) => event.status !== undefined).length,
      duration_ms: results.filter((event) => event.duration_ms !== undefined).length,
      attrs_json: results.filter((event) => !!event.attrs_json).length
    };
  }, [results]);

  const fieldPresence = summary?.field_presence || localFieldPresence;
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
    const headers = new Headers(init.headers || {});
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (apiToken) {
      headers.set('Authorization', `Bearer ${apiToken}`);
    }
    return fetch(`${API_BASE}${path}`, { ...init, headers });
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

    const quote = (value: string): string => {
      if (!/[\s"'=<>]/.test(value)) return value;
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    };

    const conditions: string[] = [];
    if (filterState.indexName.trim()) conditions.push(`index=${quote(filterState.indexName.trim().toLowerCase())}`);
    if (filterState.service.trim()) conditions.push(`service=${quote(filterState.service.trim())}`);
    if (filterState.environment.trim()) conditions.push(`env=${quote(filterState.environment.trim())}`);
    if (filterState.host.trim()) conditions.push(`host=${quote(filterState.host.trim())}`);
    if (filterState.level.trim()) conditions.push(`level=${quote(filterState.level.trim().toLowerCase())}`);
    if (filterState.statusCode.trim()) {
      const numeric = Number(filterState.statusCode.trim());
      if (!Number.isNaN(numeric)) conditions.push(`status=${Math.trunc(numeric)}`);
    }
    if (pivots.trace_id) conditions.push(`trace_id=${quote(pivots.trace_id)}`);
    if (pivots.request_id) conditions.push(`request_id=${quote(pivots.request_id)}`);
    if (pivots.user_id) conditions.push(`user_id=${quote(pivots.user_id)}`);
    if (pivots.msg_hash) conditions.push(`msg_hash=${quote(pivots.msg_hash)}`);

    const searchExpr = rawQuery || '*';
    if (conditions.length === 0) return `search ${searchExpr}`;
    return `search ${searchExpr} | where ${conditions.join(' and ')}`;
  }, [indexName, query, service, environment, host, level, statusCode, investigationPivots]);

  const buildSearchPayload = useCallback((options?: {
    queryOverride?: string;
    filterOverrides?: Partial<SearchFilterState>;
    pivotOverrides?: InvestigationPivots;
    cursor?: { before_ts: string; before_event_id: string } | null;
    limit?: number;
  }): SearchRequestPayload => {
    return {
      time: {
        from: new Date(timeFrom).toISOString(),
        to: new Date(timeTo).toISOString()
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

  const loadSummary = useCallback(async (options?: { queryOverride?: string; filterOverrides?: Partial<SearchFilterState> }) => {
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
        cursor: null,
        limit: 500
      });

      const response = await apiFetch('/search/summary', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: summaryController.signal
      });

      const body = await response.json() as SearchSummaryResponse;
      if (!response.ok || body.error) {
        setSummary(null);
        return;
      }
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
  }, [apiFetch, buildSearchPayload]);

  const runSearch = useCallback(async (options?: {
    append?: boolean;
    cursor?: { before_ts: string; before_event_id: string } | null;
    queryOverride?: string;
    filterOverrides?: Partial<SearchFilterState>;
    pivotOverrides?: InvestigationPivots;
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

    const append = options?.append || false;
    const requestCursor = append ? options?.cursor || cursor : null;
    let streamController: AbortController | null = null;

    try {
      const payload = buildSearchPayload({
        queryOverride: options?.queryOverride,
        filterOverrides: options?.filterOverrides,
        pivotOverrides: options?.pivotOverrides,
        cursor: requestCursor,
        limit: 200
      });

      if (!append && streamSearch) {
        streamController = new AbortController();
        streamAbortRef.current = streamController;
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
          signal: streamController.signal
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          throw new Error(errorText || `Search stream failed with status ${response.status}`);
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
              filterOverrides: options?.filterOverrides
            });
          }
        }
        return;
      }

      const response = await apiFetch('/search', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      const body = await response.json() as SearchResponse;
      if (!response.ok || body.error) {
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
          filterOverrides: options?.filterOverrides
        });
      }
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      setError(String(requestError));
    } finally {
      if (streamController && streamAbortRef.current === streamController) {
        streamAbortRef.current = null;
        setStreaming(false);
      } else if (!streamController) {
        setStreaming(false);
      }
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

  const createAlert = useCallback(async () => {
    const name = newAlertName.trim();
    if (!name) {
      setAlertsError('Alert name is required.');
      return;
    }

    let thresholdJson = '{}';
    let paramsJson = '{}';
    let notifyJson = '{}';
    try {
      thresholdJson = JSON.stringify(JSON.parse(newAlertThreshold));
      paramsJson = JSON.stringify(JSON.parse(newAlertParams));
      notifyJson = JSON.stringify(JSON.parse(newAlertNotify));
    } catch {
      setAlertsError('Threshold/params/notify must be valid JSON.');
      return;
    }

    setAlertsError(null);
    setAlertsInfo(null);
    try {
      const response = await apiFetch('/alerts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          enabled: 1,
          type: newAlertType,
          query_template: newAlertQueryTemplate,
          params_json: paramsJson,
          schedule_seconds: Number(newAlertSchedule) || 300,
          threshold_json: thresholdJson,
          notify_json: notifyJson,
          cooldown_seconds: 300
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
    loadAlerts,
    newAlertName,
    newAlertNotify,
    newAlertParams,
    newAlertQueryTemplate,
    newAlertSchedule,
    newAlertThreshold,
    newAlertType
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
          deep_link_base: window.location.origin
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
  }, [apiFetch, indexName, loadAlerts]);

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
      const [usersRes, rolesRes, mappingsRes, auditRes, syntheticRes] = await Promise.all([
        apiFetch('/users'),
        apiFetch('/roles'),
        apiFetch('/rbac/mappings'),
        apiFetch('/audit?limit=100'),
        apiFetch('/admin/synthetic-ingest')
      ]);

      const usersBody = await usersRes.json() as AdminUserRow[] | { error?: string };
      const rolesBody = await rolesRes.json() as RoleRow[] | { error?: string };
      const mappingsBody = await mappingsRes.json() as GroupRoleMappingRow[] | { error?: string };
      const auditBody = await auditRes.json() as AuditLogRow[] | { error?: string };
      const syntheticBody = await syntheticRes.json() as SyntheticIngestControl | { error?: string };

      if (!usersRes.ok || ('error' in usersBody && usersBody.error)) {
        throw new Error(('error' in usersBody && usersBody.error) ? usersBody.error : 'Failed to load users');
      }
      if (!rolesRes.ok || ('error' in rolesBody && rolesBody.error)) {
        throw new Error(('error' in rolesBody && rolesBody.error) ? rolesBody.error : 'Failed to load roles');
      }
      if (!mappingsRes.ok || ('error' in mappingsBody && mappingsBody.error)) {
        throw new Error(('error' in mappingsBody && mappingsBody.error) ? mappingsBody.error : 'Failed to load mappings');
      }
      if (!auditRes.ok || ('error' in auditBody && auditBody.error)) {
        throw new Error(('error' in auditBody && auditBody.error) ? auditBody.error : 'Failed to load audit');
      }
      if (!syntheticRes.ok || ('error' in syntheticBody && syntheticBody.error)) {
        throw new Error(('error' in syntheticBody && syntheticBody.error) ? syntheticBody.error : 'Failed to load synthetic ingest control');
      }

      setAdminUsers(usersBody as AdminUserRow[]);
      setAdminRoles(rolesBody as RoleRow[]);
      setAdminMappings(mappingsBody as GroupRoleMappingRow[]);
      setAuditRows(auditBody as AuditLogRow[]);
      setSyntheticIngestControl(syntheticBody as SyntheticIngestControl);
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
      await loadAdminData();
    } catch (requestError) {
      setAdminError(String(requestError));
    }
  }, [apiFetch, inviteAuthMode, inviteEmail, inviteRoleIds, loadAdminData]);

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
    const nextQuery = `${query} ${term}`.trim();
    setQuery(nextQuery);
    setAddressableView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, queryOverride: nextQuery });
  }, [query, runSearch, setAddressableView]);

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
    const nextPivots = { ...investigationPivots };
    delete nextPivots[key];
    setInvestigationPivots(nextPivots);
    setView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, pivotOverrides: nextPivots });
  }, [investigationPivots, runSearch]);

  const handleSelectRelatedEvent = useCallback((ev: RelatedEvent) => {
    const nextPivots = pivotsFromRelatedEvent(ev);
    if (!hasPivots(nextPivots)) return;
    setInvestigationPivots(nextPivots);
    setView('search');
    setCursor(null);
    setActiveIndex(-1);
    void runSearch({ append: false, cursor: null, pivotOverrides: nextPivots });
  }, [runSearch]);

  useEffect(() => {
    if (view === 'dashboard') {
      void loadDashboard();
    } else if (view === 'saved') {
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
  }, [view, canOpenAdmin, loadAdminData, loadDashboard, loadSavedSearches, loadScheduledSearches, loadAlerts, setAddressableView]);

  useEffect(() => {
    if (selectedDashboardId && view === 'dashboard') {
      void loadDashboardPanels(selectedDashboardId);
    }
  }, [selectedDashboardId, view, loadDashboardPanels]);

  useEffect(() => {
    if (view === 'dashboard' && dashboardPanels.length > 0) {
      refreshAllPanels();
    }
  }, [view, dashboardPanels.length, refreshAllPanels]);

  useEffect(() => {
    if (view === 'dashboard' && dashboardPanels.length > 0) {
      refreshAllPanels();
    }
  }, [dashboardTimeMinutes, view, dashboardPanels.length, refreshAllPanels]);

  useEffect(() => {
    if (!user || view !== 'search' || bootstrappedSearch) return;
    setBootstrappedSearch(true);
    void runSearch({ append: false, cursor: null });
  }, [bootstrappedSearch, runSearch, user, view]);

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
      <nav className="nav">
        <div className="nav-brand">EdgeData</div>
        <div className="nav-tabs">
          <button className={view === 'search' ? 'active' : ''} onClick={() => setAddressableView('search')}>Log Explorer</button>
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setAddressableView('dashboard')}>Dashboards</button>
          <button className={view === 'alerts' ? 'active' : ''} onClick={() => setAddressableView('alerts')}>Alerts</button>
          <button className={view === 'saved' ? 'active' : ''} onClick={() => setAddressableView('saved')}>Saved Searches</button>
          <button className={view === 'scheduled' ? 'active' : ''} onClick={() => setAddressableView('scheduled')}>Scheduled</button>
          <button className={view === 'livetail' ? 'active' : ''} onClick={() => setAddressableView('livetail')}>Live Tail</button>
          <button className={view === 'workspace' ? 'active' : ''} onClick={() => setAddressableView('workspace')}>Incident Workspace</button>
          {canOpenAdmin && (
            <button className={view === 'admin' ? 'active' : ''} onClick={() => setAddressableView('admin')}>Admin</button>
          )}
        </div>
        <div className="nav-auth">
          <span className="nav-user">
            {user.email || user.id} <span className="nav-role">({user.role})</span>
          </span>
          <button className="nav-logout" onClick={logout}>Sign Out</button>
        </div>
      </nav>

      <main className="main">
        {view === 'livetail' && <LiveTailView apiBase={API_BASE} apiToken={apiToken || null} onSelectEvent={setSelectedEvent} />}
        {view === 'workspace' && (
          <IncidentWorkspacePage
            apiToken={apiToken}
            sessionIdFromUrl={sessionIdFromUrl}
          />
        )}
        {view === 'search' && (
          <div className="search-view">
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
                    placeholder='search timeout postgres | where index="otel-demo" and service="paymentservice" and status>=500 | sort -ts | head 200'
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

            <div className="explorer-layout">
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
                  <div className="field-presence-list">
                    <div className="field-presence-row"><span>trace_id</span><strong>{fieldPresence.trace_id}</strong></div>
                    <div className="field-presence-row"><span>request_id</span><strong>{fieldPresence.request_id}</strong></div>
                    <div className="field-presence-row"><span>user_id</span><strong>{fieldPresence.user_id}</strong></div>
                    <div className="field-presence-row"><span>src_ip</span><strong>{fieldPresence.src_ip}</strong></div>
                    <div className="field-presence-row"><span>status</span><strong>{fieldPresence.status}</strong></div>
                    <div className="field-presence-row"><span>duration_ms</span><strong>{fieldPresence.duration_ms}</strong></div>
                    <div className="field-presence-row"><span>attrs_json</span><strong>{fieldPresence.attrs_json}</strong></div>
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
                  <div className="card" style={{ overflowX: 'auto' }}>
                    {tableRows.length === 0 ? (
                      <p className="empty-card">No tabular rows returned.</p>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            {Object.keys(tableRows[0]).map((key) => (
                              <th key={key} style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: '8px' }}>{key}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.map((row, index) => (
                            <tr key={`row-${index}`}>
                              {Object.keys(tableRows[0]).map((key) => (
                                <td key={`${index}-${key}`} style={{ borderBottom: '1px solid #f1f5f9', padding: '8px' }}>
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
                  <input
                    type="text"
                    value={newAlertName}
                    onChange={(event) => setNewAlertName(event.target.value)}
                    placeholder="Alert name"
                  />
                  <input
                    type="text"
                    value={newAlertType}
                    onChange={(event) => setNewAlertType(event.target.value)}
                    placeholder="Type (wae_sql or r2sql_token_spike)"
                  />
                  <input
                    type="number"
                    value={newAlertSchedule}
                    onChange={(event) => setNewAlertSchedule(event.target.value)}
                    placeholder="Schedule seconds"
                  />
                  <input
                    type="text"
                    value={newAlertQueryTemplate}
                    onChange={(event) => setNewAlertQueryTemplate(event.target.value)}
                    placeholder="Query template"
                  />
                  <textarea
                    value={newAlertThreshold}
                    onChange={(event) => setNewAlertThreshold(event.target.value)}
                    placeholder='Threshold JSON e.g. {"operator":"gt","value":5}'
                  />
                  <textarea
                    value={newAlertParams}
                    onChange={(event) => setNewAlertParams(event.target.value)}
                    placeholder='Params JSON e.g. {"window_minutes":5}'
                  />
                  <textarea
                    value={newAlertNotify}
                    onChange={(event) => setNewAlertNotify(event.target.value)}
                    placeholder='Notify JSON e.g. {"slack":true}'
                  />
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
                {alertsLoading && <p className="empty-card">Loading alerts...</p>}
                {!alertsLoading && alerts.length === 0 && <p className="empty-card">No alerts configured.</p>}
                {!alertsLoading && alerts.map((alert) => (
                  <div key={alert.id} className="alert-row">
                    <div>
                      <div className="alert-name">{alert.name}</div>
                      <div className="alert-meta">
                        <span>{alert.type}</span>
                        <span>every {alert.schedule_seconds}s</span>
                        <span>{alert.enabled ? 'enabled' : 'disabled'}</span>
                      </div>
                    </div>
                    <div className="alert-actions">
                      <button className="secondary" onClick={() => void toggleAlertEnabled(alert)}>
                        {alert.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="danger" onClick={() => void deleteAlert(alert.id)}>Delete</button>
                    </div>
                  </div>
                ))}
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3>Scheduled Searches</h3>
                <button onClick={() => setShowScheduleForm(f => !f)}>{showScheduleForm ? 'Cancel' : '+ New'}</button>
              </div>

              {showScheduleForm && (
                <div className="card" style={{ marginBottom: 16, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input type="text" value={scheduleFormName} onChange={e => setScheduleFormName(e.target.value)} placeholder="Search name" />
                  <input type="text" value={scheduleFormPpl} onChange={e => setScheduleFormPpl(e.target.value)} placeholder="PPL query (e.g. search * | where level=&quot;error&quot; | stats count() by service)" />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="text" value={scheduleFormCron} onChange={e => setScheduleFormCron(e.target.value)} placeholder="Cron (0 * * * *)" style={{ flex: 1 }} />
                    <input type="number" value={scheduleFormWindow} onChange={e => setScheduleFormWindow(Number(e.target.value) || 60)} placeholder="Window (min)" style={{ width: 120 }} />
                  </div>
                  <button onClick={() => void createScheduledSearch()}>Create Scheduled Search</button>
                </div>
              )}

              {scheduledLoading && <p className="empty-card">Loading...</p>}

              {!scheduledLoading && scheduledSearches.length === 0 && <p className="empty-card">No scheduled searches yet.</p>}

              {scheduledSearches.map(ss => (
                <div key={ss.id} className="saved-row" style={{ flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="saved-name">
                        {ss.name}
                        <span style={{ marginLeft: 8, fontSize: '0.75rem', opacity: 0.6 }}>
                          {ss.enabled ? 'Enabled' : 'Disabled'} &middot; {ss.schedule_cron} &middot; {ss.time_window_minutes}m window
                        </span>
                      </div>
                      <div className="saved-query">{ss.ppl}</div>
                    </div>
                    <div className="saved-actions">
                      <button className="secondary" onClick={() => { toggleScheduledSearch(ss.id, !ss.enabled); }}>
                        {ss.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="secondary" onClick={() => void loadScheduledResults(ss.id)}>Results</button>
                      <button className="danger" onClick={() => void deleteScheduledSearch(ss.id)}>Delete</button>
                    </div>
                  </div>
                  {scheduledResults[ss.id] && (
                    <div style={{ fontSize: '0.8rem', marginTop: 4 }}>
                      <strong>Recent runs:</strong>
                      {scheduledResults[ss.id].length === 0 && <span style={{ marginLeft: 8, opacity: 0.6 }}>No runs yet</span>}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                        {scheduledResults[ss.id].slice(0, 5).map(r => (
                          <div key={r.id} style={{ display: 'flex', gap: 12 }}>
                            <span>{new Date(r.run_at).toLocaleString()}</span>
                            <span style={{ color: r.status === 'success' ? '#22c55e' : '#ef4444' }}>{r.status}</span>
                            <span>{r.result_count} results</span>
                            {r.error_message && <span style={{ color: '#ef4444' }}>{r.error_message}</span>}
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
