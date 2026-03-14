export type ViewMode = 'search' | 'dashboard' | 'saved' | 'scheduled' | 'alerts' | 'admin' | 'livetail' | 'workspace';
export type SearchMode = 'structured' | 'token' | 'phrase';
export type QueryInputMode = 'search' | 'ask_ai';
export type ThemeMode = 'light' | 'dark';
export type ThemePreference = 'system' | ThemeMode;
export type NavIconKey = ViewMode | 'signout' | 'user';
export type AlertThresholdOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type AlertQueryTemplate = 'error_rate_over_threshold' | 'latency_p95_over_threshold' | 'token_spike';
export type AlertType = 'wae_sql' | 'r2sql_token_spike';

export interface AlertTemplatePreset {
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

export interface LogEvent {
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

export interface SearchStats {
  mode: SearchMode;
  scanned_partitions: number;
  scanned_objects: number;
  candidates: number;
  returned: number;
}

export interface GuardrailExplanation {
  code: string;
  title: string;
  reason: string;
  suggestion: string;
}

export interface SearchResponse {
  result_type?: 'events' | 'table';
  results: Array<LogEvent | DashboardRow>;
  next_cursor: { before_ts: string; before_event_id: string } | null;
  stats: SearchStats;
  warning?: string;
  error?: string;
  guardrail?: GuardrailExplanation;
}

export interface FacetItem {
  value: string;
  count: number;
}

export interface SearchSummaryResponse {
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

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  created_at: string;
  updated_at?: string;
}

export interface ScheduledSearchItem {
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

export interface ScheduledSearchRunSummary {
  headline?: string | null;
  status?: string;
  result_count?: number;
  warning?: string | null;
  error_message?: string | null;
  preview_fields?: string[];
  has_results?: boolean;
}

export interface ScheduledSearchResult {
  id: string;
  scheduled_search_id: string;
  run_at: string;
  time_from: string;
  time_to: string;
  status: string;
  result_count: number;
  trigger_type?: string;
  requested_by?: string | null;
  summary?: ScheduledSearchRunSummary;
  stats?: Record<string, unknown>;
  started_at?: string | null;
  completed_at?: string | null;
  materialized_result_id?: string | null;
  has_full_results?: boolean;
  error_message?: string | null;
}

export interface ScheduledSearchRunDetail extends ScheduledSearchResult {
  preview?: Record<string, unknown>[];
  query_request?: Record<string, unknown>;
  artifact?: {
    id: string;
    status: string;
    result_count: number;
    computed_at: string;
    expires_at: string;
  } | null;
}

export interface ScheduledSearchRunResultsPayload {
  run_id: string;
  scheduled_search_id: string;
  result_type: 'events' | 'table';
  results: Record<string, unknown>[];
  total_results: number;
  partial?: boolean;
  warning?: string | null;
  stats?: Record<string, unknown>;
}

export interface AlertDefinition {
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

export interface AlertNotifyConfig {
  slack?: boolean;
  webhook?: boolean;
  severity?: string;
  deep_link?: string;
  runbook_url?: string;
  owner_team?: string;
}

export interface AlertParamsConfig {
  index?: string;
  service?: string;
  env?: string;
  window_minutes?: number;
  token?: string;
  _starter_id?: string;
  _starter_version?: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  enabled: number;
  legacy_role?: string;
  role_ids: string[];
  created_at: string;
  updated_at?: string | null;
  last_login_at?: string | null;
}

export interface RoleRow {
  id: string;
  name: string;
  system_role: number;
  enabled: number;
  permissions_json: string;
  scope_json: string;
  created_at: string;
  updated_at?: string | null;
}

export interface GroupRoleMappingRow {
  id: string;
  access_group: string;
  role_id: string;
  created_at: string;
  updated_at?: string | null;
}

export interface AdminInviteRow {
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

export interface OnboardingChecklistItem {
  key: string;
  title: string;
  done: boolean;
  detail: string;
}

export interface AuditLogRow {
  id: string;
  actor_principal?: string | null;
  actor_email?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  metadata_json?: string | null;
  created_at: string;
}

export interface SyntheticIngestControl {
  ok?: boolean;
  enabled: boolean;
  configured_enabled: boolean;
  persisted_enabled?: boolean | null;
  updated_at?: string | null;
}

export interface DashboardRow {
  [key: string]: string | number;
}

export interface DashboardData {
  error_rate_by_service: DashboardRow[];
  latency_p95_by_service: DashboardRow[];
  top_errors: DashboardRow[];
  throughput: DashboardRow[];
  top_hosts: DashboardRow[];
}

export interface SearchFilterState {
  indexName: string;
  service: string;
  environment: string;
  host: string;
  level: string;
  statusCode: string;
}

export interface SearchRequestPayload {
  time: { from: string; to: string };
  ppl: string;
  limit: number;
  cursor: { before_ts: string; before_event_id: string } | null;
}

export interface AskAiPlan {
  intentLabel: string;
  confidence: 'high' | 'medium' | 'low';
  generatedPpl: string;
  reasoning: string[];
  passthrough: boolean;
}

export interface SearchStreamChunk {
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

export interface QuerySuggestionItem {
  label: string;
  kind: 'command' | 'template' | 'field' | 'term';
  detail?: string;
  example?: string;
  next_query: string;
  score?: number;
}

export interface QuerySuggestionResponse {
  suggestions?: QuerySuggestionItem[];
  meta?: {
    context_stage?: string;
    latency_ms?: number;
  };
}

export interface LiveTailFilters {
  service: string;
  env: string;
  level: string;
  keywords: string;
}
