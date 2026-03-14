import {
  Activity,
  Bell,
  Bookmark,
  Briefcase,
  Clock3,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  UserRound,
  type LucideIcon
} from 'lucide-react';
import type { AlertTemplatePreset, AlertThresholdOperator, NavIconKey, ViewMode } from './types';

export const TAB_QUERY_PARAM = 'tab';
export const THEME_STORAGE_KEY = 'edgedata.theme';
export const VIEW_MODES = new Set<ViewMode>(['search', 'dashboard', 'saved', 'scheduled', 'alerts', 'admin', 'livetail', 'workspace']);
export const TIME_RANGE_PRESETS: Array<{ label: string; fromOffsetMinutes: number; toOffsetMinutes: number }> = [
  { label: 'Last 15m', fromOffsetMinutes: 15, toOffsetMinutes: 0 },
  { label: 'Last 1h', fromOffsetMinutes: 60, toOffsetMinutes: 0 },
  { label: 'Last 6h', fromOffsetMinutes: 6 * 60, toOffsetMinutes: 0 },
  { label: 'Last 24h', fromOffsetMinutes: 24 * 60, toOffsetMinutes: 0 },
  { label: 'Previous 24h', fromOffsetMinutes: 48 * 60, toOffsetMinutes: 24 * 60 },
  { label: 'Last 7d', fromOffsetMinutes: 7 * 24 * 60, toOffsetMinutes: 0 },
  { label: 'Last 30d', fromOffsetMinutes: 30 * 24 * 60, toOffsetMinutes: 0 }
];

export const ALERT_TEMPLATE_PRESETS: AlertTemplatePreset[] = [
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

export const ALERT_THRESHOLD_OPERATOR_OPTIONS: Array<{ value: AlertThresholdOperator; label: string }> = [
  { value: 'gt', label: 'Greater than (>)' },
  { value: 'gte', label: 'Greater than or equal (>=)' },
  { value: 'lt', label: 'Less than (<)' },
  { value: 'lte', label: 'Less than or equal (<=)' },
  { value: 'eq', label: 'Equal (=)' }
];

export const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
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

export const PPL_COMMAND_PREFIX = /^(search|where|fields|sort|head|stats|timechart|top|rare|dedup|eval|lookup|rex|transaction|rename|table)\b/i;
export const ASK_AI_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'do', 'find', 'for', 'from', 'get', 'how',
  'i', 'in', 'into', 'is', 'last', 'me', 'of', 'on', 'over', 'show', 'that', 'the', 'these',
  'those', 'to', 'under', 'using', 'was', 'what', 'where', 'which', 'who', 'with', 'within'
]);
export const ASK_AI_INTENT_WORDS = new Set([
  'error', 'errors', 'fail', 'failed', 'failing', 'failure', 'latency', 'slow', 'slower',
  'trace', 'request', 'requests', 'status', 'warn', 'warning', 'warnings', 'timeout',
  'timeouts', 'spike', 'spikes', 'investigate', 'look', 'lookup', 'up'
]);

export const API_BASE = ((import.meta as { env?: Record<string, string> }).env?.VITE_QUERY_API_BASE || '').trim();
export const API_BASE_MISSING_ERROR = 'Missing VITE_QUERY_API_BASE. Configure your deployed query-worker URL.';
export const STREAM_FLUSH_INTERVAL_MS = 250;
export const QUERY_SUGGESTION_DEBOUNCE_MS = 120;
export const QUERY_SUGGESTION_CACHE_TTL_MS = 30_000;
export const MAX_QUERY_SUGGESTION_CACHE_SIZE = 100;

export const LOCAL_FALLBACK_SNIPPETS = [
  { label: 'search', kind: 'command', detail: 'Search logs by free text', insert: 'search ' },
  { label: 'where', kind: 'command', detail: 'Filter fields and values', insert: 'where service=' },
  { label: 'stats', kind: 'template', detail: 'Count by service', insert: 'stats count() by service' },
  { label: 'timechart', kind: 'template', detail: 'Trend by 5-minute buckets', insert: 'timechart span=5m count()' },
  { label: 'sort', kind: 'command', detail: 'Sort newest first', insert: 'sort -ts' },
  { label: 'head', kind: 'command', detail: 'Limit returned rows', insert: 'head 100' }
] as const;

export const MAX_LIVETAIL_EVENTS = 2000;
