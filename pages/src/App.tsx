import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SunMoon } from 'lucide-react';
import { useAuth } from './AuthContext';
import { AuthScreen } from './AuthScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { useApiClient } from './hooks/useApiClient';
import { IncidentWorkspacePage, type WorkspaceStarterSelection } from './investigation/IncidentWorkspacePage';
import {
  type InvestigationPivots,
  type RelatedEvent,
  hasPivots,
  parseInvestigationParams,
  pivotsFromRelatedEvent
} from './investigation/types';
import { AlertsPage } from './pages/AlertsPage';
import { AdminPage } from './pages/AdminPage';
import { SavedPage } from './pages/SavedPage';
import { ScheduledPage } from './pages/ScheduledPage';
import { SearchPage } from './pages/SearchPage';
import { API_BASE, MAX_LIVETAIL_EVENTS } from './constants';
import {
  ALERT_TEMPLATE_PRESETS,
  ALERT_THRESHOLD_OPERATOR_OPTIONS,
  MAX_QUERY_SUGGESTION_CACHE_SIZE,
  QUERY_SUGGESTION_CACHE_TTL_MS,
  QUERY_SUGGESTION_DEBOUNCE_MS,
  STREAM_FLUSH_INTERVAL_MS,
  THEME_STORAGE_KEY,
  TIME_RANGE_PRESETS
} from './constants';
import {
  buildAskAiPlan,
  buildAlertDeepQuery,
  buildDefaultAlertDeepLink,
  buildLocalFallbackSuggestions,
  buildTraceContextPplFromEvent,
  extractHighlightTerms,
  formatDateTime,
  formatDateTimeLocalValue,
  formatTimeCompact,
  formatTimelineTick,
  highlightText,
  jsonSyntaxHtml,
  maxFacetCount,
  modeLabel,
  parseAlertNotifyConfig,
  parseErrorPayload,
  parseViewMode,
  prettyJsonOrNull,
  readLevelCount,
  readStoredThemePreference,
  readSystemPrefersDark,
  readViewFromLocation,
  renderNavIcon,
  resolveAlertTemplatePreset,
  sortEventsNewestFirst,
  toFacet,
  toUtcIso,
  writeViewToLocation
} from './utils';
import type {
  AlertDefinition,
  AlertQueryTemplate,
  AlertThresholdOperator,
  DashboardRow,
  GuardrailExplanation,
  LiveTailFilters,
  LogEvent,
  QueryInputMode,
  QuerySuggestionItem,
  SearchFilterState,
  SearchRequestPayload,
  SearchStats,
  SearchStreamChunk,
  SearchSummaryResponse,
  ThemePreference,
  ViewMode
} from './types';

const DashboardPage = lazy(async () => {
  const mod = await import('./dashboard/DashboardPage');
  return { default: mod.DashboardPage };
});

function evictOldest<V>(map: Map<string, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const toDelete = map.size - maxSize;
  const iter = map.keys();
  for (let i = 0; i < toDelete; i++) {
    const next = iter.next();
    if (!next.done) map.delete(next.value);
  }
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

  const [queryInputMode, setQueryInputMode] = useState<QueryInputMode>('search');
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
  const [hasCompletedSearch, setHasCompletedSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardrailDetail, setGuardrailDetail] = useState<GuardrailExplanation | null>(null);
  const [workspaceLaunchInfo, setWorkspaceLaunchInfo] = useState<string | null>(null);
  const { user, token: authToken, loading: authLoading, logout } = useAuth();
  const apiToken = authToken || '';
  const { apiFetch } = useApiClient(apiToken);

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
  const [scheduledRunDetails, setScheduledRunDetails] = useState<Record<string, ScheduledSearchRunDetail>>({});
  const [scheduledRunResults, setScheduledRunResults] = useState<Record<string, ScheduledSearchRunResultsPayload>>({});
  const [scheduledRunLoading, setScheduledRunLoading] = useState<Record<string, boolean>>({});
  const [scheduledActiveRunBySearch, setScheduledActiveRunBySearch] = useState<Record<string, string>>({});
  const [scheduledRunTriggering, setScheduledRunTriggering] = useState<Record<string, boolean>>({});
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
  const searchVersionRef = useRef(0);
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
  const assistantPlan = useMemo(() => buildAskAiPlan({
    prompt: query,
    filters: {
      indexName,
      service,
      environment,
      host,
      level,
      statusCode
    },
    pivots: investigationPivots,
    topTerms: topTerms.map((item) => item.value).filter(Boolean)
  }), [environment, host, indexName, investigationPivots, level, query, service, statusCode, topTerms]);
  const highlightTerms = useMemo(
    () => extractHighlightTerms(queryInputMode === 'ask_ai' ? assistantPlan.generatedPpl : query),
    [assistantPlan.generatedPpl, query, queryInputMode]
  );

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
    if (!queryFocused || view !== 'search' || queryInputMode !== 'search') {
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
        evictOldest(querySuggestionsCacheRef.current, MAX_QUERY_SUGGESTION_CACHE_SIZE);
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
  }, [apiFetch, closeQuerySuggestions, query, queryFocused, queryInputMode, topTerms, view]);

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

    if (queryInputMode === 'ask_ai') {
      return buildAskAiPlan({
        prompt: rawQuery,
        filters: filterState,
        pivots,
        topTerms: topTerms.map((item) => item.value).filter(Boolean)
      }).generatedPpl;
    }

    const looksLikePipeline = /\|/.test(rawQuery) || /^(search|where|fields|sort|head|stats)\b/i.test(rawQuery);
    if (looksLikePipeline) return rawQuery;

    const conditions = buildScopedConditions(filterState, pivots);

    const searchExpr = rawQuery || '*';
    if (conditions.length === 0) return `search ${searchExpr}`;
    return `search ${searchExpr} | where ${conditions.join(' and ')}`;
  }, [environment, host, indexName, investigationPivots, level, query, queryInputMode, service, statusCode, topTerms]);

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
    const thisVersion = ++searchVersionRef.current;
    const isStale = (): boolean => searchVersionRef.current !== thisVersion;

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
          if (!isStale() && parsedError.guardrail) {
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
          if (isStale()) return;
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
              if (!isStale() && chunk.guardrail) {
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
          if (isStale()) return;
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
        if (!isStale()) setHasCompletedSearch(true);
        return;
      }

      const response = await apiFetch('/search', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: requestController.signal
      });

      const body = await response.json() as SearchResponse;
      if (!response.ok || body.error) {
        if (!isStale()) {
          setGuardrailDetail(body.guardrail || null);
          setError(body.error || `Search failed with status ${response.status}`);
          setLoading(false);
        }
        return;
      }

      if (isStale()) return;
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
      setHasCompletedSearch(true);
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
      const persistedQuery = queryInputMode === 'ask_ai' ? assistantPlan.generatedPpl : query;
      const response = await apiFetch('/saved-searches', {
        method: 'POST',
        body: JSON.stringify({ name, query: persistedQuery })
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
  }, [apiFetch, assistantPlan.generatedPpl, loadSavedSearches, query, queryInputMode, saveName, setAddressableView]);

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
    } catch (err) {
      setScheduledError(String(err));
    }
  }, [apiFetch]);

  const loadScheduledRunDetail = useCallback(async (searchId: string, runId: string) => {
    setScheduledRunLoading((prev) => ({ ...prev, [runId]: true }));
    try {
      const response = await apiFetch(`/scheduled-searches/${searchId}/runs/${runId}`);
      const body = await response.json() as ScheduledSearchRunDetail | { error?: string };
      if (!response.ok || ('error' in body && body.error)) {
        throw new Error(('error' in body && body.error) ? body.error : 'Failed to load run detail');
      }
      setScheduledRunDetails((prev) => ({ ...prev, [runId]: body as ScheduledSearchRunDetail }));
      setScheduledActiveRunBySearch((prev) => ({ ...prev, [searchId]: runId }));
    } catch (err) {
      setScheduledError(String(err));
    } finally {
      setScheduledRunLoading((prev) => ({ ...prev, [runId]: false }));
    }
  }, [apiFetch]);

  const loadScheduledRunResults = useCallback(async (searchId: string, runId: string) => {
    setScheduledRunLoading((prev) => ({ ...prev, [runId]: true }));
    try {
      const response = await apiFetch(`/scheduled-searches/${searchId}/runs/${runId}/results`);
      const body = await response.json() as ScheduledSearchRunResultsPayload | { error?: string };
      if (!response.ok || ('error' in body && body.error)) {
        throw new Error(('error' in body && body.error) ? body.error : 'Failed to load run results');
      }
      setScheduledRunResults((prev) => ({ ...prev, [runId]: body as ScheduledSearchRunResultsPayload }));
      setScheduledActiveRunBySearch((prev) => ({ ...prev, [searchId]: runId }));
    } catch (err) {
      setScheduledError(String(err));
    } finally {
      setScheduledRunLoading((prev) => ({ ...prev, [runId]: false }));
    }
  }, [apiFetch]);

  const runScheduledSearch = useCallback(async (id: string) => {
    setScheduledRunTriggering((prev) => ({ ...prev, [id]: true }));
    setScheduledError(null);
    try {
      const response = await apiFetch(`/scheduled-searches/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const body = await response.json() as { error?: string; run_id?: string };
      if (!response.ok || body.error || !body.run_id) {
        throw new Error(body.error || 'Failed to run scheduled search');
      }
      await loadScheduledResults(id);
      await Promise.all([
        loadScheduledRunDetail(id, body.run_id),
        loadScheduledRunResults(id, body.run_id)
      ]);
    } catch (err) {
      setScheduledError(String(err));
    } finally {
      setScheduledRunTriggering((prev) => ({ ...prev, [id]: false }));
    }
  }, [apiFetch, loadScheduledResults, loadScheduledRunDetail, loadScheduledRunResults]);

  const scheduleCurrentSearch = useCallback(() => {
    setScheduleFormPpl(queryInputMode === 'ask_ai' ? assistantPlan.generatedPpl : query);
    setScheduleFormName('');
    setShowScheduleForm(true);
    setAddressableView('scheduled');
  }, [assistantPlan.generatedPpl, query, queryInputMode, setAddressableView]);

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
    setQueryInputMode('search');
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
    setQueryInputMode('search');
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
    cancelOngoingSearch();
  }, [view, cancelOngoingSearch]);

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
    <ErrorBoundary>
      <div className="app">
        <Sidebar
        navExpanded={navExpanded}
        setNavExpanded={setNavExpanded}
        navItems={navItems}
        view={view}
        setAddressableView={setAddressableView}
        getTooltipHandlers={getTooltipHandlers}
      />
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
          {!navExpanded && (
            <div className="main-panel-brand" aria-label="EdgeData brand">
              EdgeData
            </div>
          )}
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
          <SearchPage
            workspaceLaunchInfo={workspaceLaunchInfo}
            timeFrom={timeFrom}
            setTimeFrom={setTimeFrom}
            timeTo={timeTo}
            setTimeTo={setTimeTo}
            activeTimePreset={activeTimePreset}
            applyTimePreset={applyTimePreset}
            showAdvancedFilters={showAdvancedFilters}
            setShowAdvancedFilters={setShowAdvancedFilters}
            activeAdvancedFilterCount={activeAdvancedFilterCount}
            indexName={indexName}
            setIndexName={setIndexName}
            service={service}
            setService={setService}
            environment={environment}
            setEnvironment={setEnvironment}
            host={host}
            setHost={setHost}
            level={level}
            setLevel={setLevel}
            statusCode={statusCode}
            setStatusCode={setStatusCode}
            queryInputMode={queryInputMode}
            setQueryInputMode={setQueryInputMode}
            query={query}
            setQuery={setQuery}
            querySuggestions={querySuggestions}
            querySuggestionsOpen={querySuggestionsOpen}
            querySuggestionsLoading={querySuggestionsLoading}
            querySuggestionIndex={querySuggestionIndex}
            setQuerySuggestionIndex={setQuerySuggestionIndex}
            closeQuerySuggestions={closeQuerySuggestions}
            applyQuerySuggestion={applyQuerySuggestion}
            runSearch={runSearch}
            cancelOngoingSearch={cancelOngoingSearch}
            loading={loading}
            streamSearch={streamSearch}
            setStreamSearch={setStreamSearch}
            streaming={streaming}
            showSearchActions={showSearchActions}
            setShowSearchActions={setShowSearchActions}
            setShowSaveSearchInline={setShowSaveSearchInline}
            scheduleCurrentSearch={scheduleCurrentSearch}
            hasActiveAdvancedFilters={hasActiveAdvancedFilters}
            setActiveTimePreset={setActiveTimePreset}
            setQuerySuggestionsOpen={setQuerySuggestionsOpen}
            setQueryFocused={setQueryFocused}
            setCursor={setCursor}
            queryTypeaheadRef={queryTypeaheadRef}
            searchInputRef={searchInputRef}
            searchActionsRef={searchActionsRef}
            assistantPlan={assistantPlan}
            showSaveSearchInline={showSaveSearchInline}
            saveName={saveName}
            setSaveName={setSaveName}
            saveCurrentSearch={saveCurrentSearch}
            investigationPivots={investigationPivots}
            apiFetch={apiFetch}
            error={error}
            guardrailDetail={guardrailDetail}
            stats={stats}
            summary={summary}
            summaryLoading={summaryLoading}
            results={results}
            tableRows={tableRows}
            resultType={resultType}
            cursor={cursor}
            hasCompletedSearch={hasCompletedSearch}
            levelTotals={levelTotals}
            timeline={timeline}
            timelineStepMs={timelineStepMs}
            timelineMax={timelineMax}
            timelineAxisMarks={timelineAxisMarks}
            facets={facets}
            topTerms={topTerms}
            fieldPresenceSampleSize={fieldPresenceSampleSize}
            fieldCoverageAverage={fieldCoverageAverage}
            fieldCoverageQuality={fieldCoverageQuality}
            fieldPresenceGroups={fieldPresenceGroups}
            fieldCoverageFilter={fieldCoverageFilter}
            summaryUnavailable={summaryUnavailable}
            applyFacetFilter={applyFacetFilter}
            runPivot={runPivot}
            runFieldCoverageQuery={runFieldCoverageQuery}
            clearFieldCoverageFilter={clearFieldCoverageFilter}
            handlePivotClick={handlePivotClick}
            handleSelectRelatedEvent={handleSelectRelatedEvent}
            activeIndex={activeIndex}
            setActiveIndex={setActiveIndex}
            setSelectedEvent={setSelectedEvent}
            explorerLayoutRef={explorerLayoutRef}
            explorerPanelHeight={explorerPanelHeight}
          />
        )}

                {view === 'dashboard' && (
          <Suspense fallback={<div className="empty-state"><p>Loading dashboard builder...</p></div>}>
            <DashboardPage apiFetch={apiFetch} />
          </Suspense>
        )}

        {view === 'alerts' && (
          <AlertsPage
            alertsError={alertsError}
            alertsInfo={alertsInfo}
            alertsLoading={alertsLoading}
            alerts={alerts}
            alertGovernance={alertGovernance}
            newAlertName={newAlertName}
            setNewAlertName={setNewAlertName}
            newAlertTemplateId={newAlertTemplateId}
            setNewAlertTemplateId={setNewAlertTemplateId}
            selectedAlertTemplate={selectedAlertTemplate}
            isTokenAlertTemplate={isTokenAlertTemplate}
            newAlertWindowMinutes={newAlertWindowMinutes}
            setNewAlertWindowMinutes={setNewAlertWindowMinutes}
            newAlertSchedule={newAlertSchedule}
            setNewAlertSchedule={setNewAlertSchedule}
            newAlertCooldown={newAlertCooldown}
            setNewAlertCooldown={setNewAlertCooldown}
            newAlertThresholdOperator={newAlertThresholdOperator}
            setNewAlertThresholdOperator={setNewAlertThresholdOperator}
            newAlertThresholdValue={newAlertThresholdValue}
            setNewAlertThresholdValue={setNewAlertThresholdValue}
            newAlertIndex={newAlertIndex}
            setNewAlertIndex={setNewAlertIndex}
            newAlertService={newAlertService}
            setNewAlertService={setNewAlertService}
            newAlertEnv={newAlertEnv}
            setNewAlertEnv={setNewAlertEnv}
            newAlertToken={newAlertToken}
            setNewAlertToken={setNewAlertToken}
            newAlertSeverity={newAlertSeverity}
            setNewAlertSeverity={setNewAlertSeverity}
            newAlertNotifySlack={newAlertNotifySlack}
            setNewAlertNotifySlack={setNewAlertNotifySlack}
            newAlertNotifyWebhook={newAlertNotifyWebhook}
            setNewAlertNotifyWebhook={setNewAlertNotifyWebhook}
            newAlertOwnerTeam={newAlertOwnerTeam}
            setNewAlertOwnerTeam={setNewAlertOwnerTeam}
            newAlertRunbookUrl={newAlertRunbookUrl}
            setNewAlertRunbookUrl={setNewAlertRunbookUrl}
            newAlertDeepLink={newAlertDeepLink}
            setNewAlertDeepLink={setNewAlertDeepLink}
            starterRunbookBase={starterRunbookBase}
            setStarterRunbookBase={setStarterRunbookBase}
            starterOwnerTeam={starterOwnerTeam}
            setStarterOwnerTeam={setStarterOwnerTeam}
            indexName={indexName}
            alertPayloadPreview={alertPayloadPreview}
            starterPackApplying={starterPackApplying}
            createAlert={createAlert}
            applyStarterAlertPack={applyStarterAlertPack}
            toggleAlertEnabled={toggleAlertEnabled}
            deleteAlert={deleteAlert}
          />
        )}

        {view === 'admin' && (
          <AdminPage
            adminToast={adminToast}
            adminError={adminError}
            adminLoading={adminLoading}
            adminUsers={adminUsers}
            adminRoles={adminRoles}
            adminMappings={adminMappings}
            adminInvites={adminInvites}
            auditRows={auditRows}
            syntheticIngestControl={syntheticIngestControl}
            syntheticControlLoading={syntheticControlLoading}
            onboardingChecklist={onboardingChecklist}
            onboardingDoneCount={onboardingDoneCount}
            inviteEmail={inviteEmail}
            setInviteEmail={setInviteEmail}
            inviteAuthMode={inviteAuthMode}
            setInviteAuthMode={setInviteAuthMode}
            inviteRoleIds={inviteRoleIds}
            setInviteRoleIds={setInviteRoleIds}
            inviteTokenPreview={inviteTokenPreview}
            newRoleId={newRoleId}
            setNewRoleId={setNewRoleId}
            newRoleName={newRoleName}
            setNewRoleName={setNewRoleName}
            newRolePermissions={newRolePermissions}
            setNewRolePermissions={setNewRolePermissions}
            newRoleScope={newRoleScope}
            setNewRoleScope={setNewRoleScope}
            newMappingGroup={newMappingGroup}
            setNewMappingGroup={setNewMappingGroup}
            newMappingRoleId={newMappingRoleId}
            setNewMappingRoleId={setNewMappingRoleId}
            setSyntheticIngestEnabled={setSyntheticIngestEnabled}
            runSyntheticIngestNow={runSyntheticIngestNow}
            createInvite={createInvite}
            resendInvite={resendInvite}
            revokeInvite={revokeInvite}
            updateUserEnabled={updateUserEnabled}
            updateUserRoles={updateUserRoles}
            createRole={createRole}
            createMapping={createMapping}
          />
        )}

                {view === 'scheduled' && (
          <ScheduledPage
            scheduledError={scheduledError}
            scheduledLoading={scheduledLoading}
            scheduledSearches={scheduledSearches}
            scheduledResults={scheduledResults}
            scheduledRunDetails={scheduledRunDetails}
            scheduledRunResults={scheduledRunResults}
            scheduledActiveRunBySearch={scheduledActiveRunBySearch}
            scheduledRunLoading={scheduledRunLoading}
            scheduledRunTriggering={scheduledRunTriggering}
            showScheduleForm={showScheduleForm}
            setShowScheduleForm={setShowScheduleForm}
            scheduleFormName={scheduleFormName}
            setScheduleFormName={setScheduleFormName}
            scheduleFormPpl={scheduleFormPpl}
            setScheduleFormPpl={setScheduleFormPpl}
            scheduleFormCron={scheduleFormCron}
            setScheduleFormCron={setScheduleFormCron}
            scheduleFormWindow={scheduleFormWindow}
            setScheduleFormWindow={setScheduleFormWindow}
            createScheduledSearch={createScheduledSearch}
            deleteScheduledSearch={deleteScheduledSearch}
            toggleScheduledSearch={toggleScheduledSearch}
            loadScheduledResults={loadScheduledResults}
            loadScheduledRunDetail={loadScheduledRunDetail}
            loadScheduledRunResults={loadScheduledRunResults}
            runScheduledSearch={runScheduledSearch}
            setScheduledResults={setScheduledResults}
            setScheduledActiveRunBySearch={setScheduledActiveRunBySearch}
          />
        )}

                {view === 'saved' && (
          <SavedPage
            savedError={savedError}
            savedLoading={savedLoading}
            savedSearches={savedSearches}
            applySavedSearch={applySavedSearch}
            deleteSavedSearch={deleteSavedSearch}
          />
        )}
      </main>

      {selectedEvent && (
        <div className="drawer-overlay" onClick={() => setSelectedEvent(null)}>
          <div className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <h3>Event Inspector</h3>
              <button onClick={() => setSelectedEvent(null)} aria-label="Close event inspector">x</button>
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
                <button onClick={() => runPivot(`index=${selectedEvent.index || 'default'}`)} aria-label="Pivot by index">Pivot Index</button>
                {selectedEvent.trace_id && <button onClick={() => runPivot(`trace_id=${selectedEvent.trace_id}`)} aria-label="Pivot by trace_id">Pivot Trace</button>}
                {selectedEvent.trace_id && <button onClick={() => openTraceContextFromEvent(selectedEvent)}>Trace Context</button>}
                {selectedEvent.span_id && <button onClick={() => runPivot(`span_id=${selectedEvent.span_id}`)} aria-label="Pivot by span_id">Pivot Span</button>}
                {selectedEvent.parent_span_id && <button onClick={() => runPivot(`parent_span_id=${selectedEvent.parent_span_id}`)} aria-label="Pivot by parent_span_id">Pivot Parent Span</button>}
                {selectedEvent.request_id && <button onClick={() => runPivot(`request_id=${selectedEvent.request_id}`)} aria-label="Pivot by request_id">Pivot Request</button>}
                {selectedEvent.user_id && <button onClick={() => runPivot(`user_id=${selectedEvent.user_id}`)} aria-label="Pivot by user_id">Pivot User</button>}
                {selectedEvent.src_ip && <button onClick={() => runPivot(`src_ip=${selectedEvent.src_ip}`)} aria-label="Pivot by src_ip">Pivot IP</button>}
                {selectedEvent.msg_hash && <button onClick={() => runPivot(`msg_hash=${selectedEvent.msg_hash}`)} aria-label="Pivot by msg_hash">Pivot MsgHash</button>}
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </ErrorBoundary>
  );
}

export default App;
