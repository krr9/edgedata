/**
 * Types, interfaces, type aliases, and constants extracted from query-worker index.
 * No functions or mutable module state.
 */

export interface Env {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  ACCESS_AUD?: string;
  ACCESS_ISSUER?: string;
  ACCESS_JWKS_URL?: string;
  ACCESS_SUPERADMIN_GROUPS?: string;
  ACCESS_VIEWER_GROUPS?: string;
  ACCESS_ANALYST_GROUPS?: string;
  ACCESS_ADMIN_GROUPS?: string;
  ACCESS_ADMIN_EMAILS?: string;
  REQUIRE_ACCESS_JWT?: string;
  CORS_ORIGINS?: string;
  QUERY_VIEWER_TOKEN?: string;
  QUERY_ANALYST_TOKEN?: string;
  QUERY_ADMIN_TOKEN?: string;
  AUTH_SESSION_SECRET?: string;
  AUTH_ENABLE_LOCAL_LOGIN?: string;
  AUTH_BOOTSTRAP_SUPERADMIN_EMAIL?: string;
  AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD?: string;
  AUTH_BOOTSTRAP_EMAIL?: string;
  AUTH_BOOTSTRAP_PASSWORD?: string;
  AUTH_INVITE_TTL_HOURS?: string;
  SESSION_TTL_SECONDS?: string;
  QUERY_RATE_LIMIT_PER_MIN?: string;
  AUTH_LOGIN_RATE_LIMIT_PER_MIN?: string;
  OPS_WAE?: AnalyticsEngineDataset;
  SYNTHETIC_SERVICE?: Fetcher;
  ALERT_SERVICE?: Fetcher;
  SYNTHETIC_RUN_SECRET?: string;
  ALERT_RUN_SECRET?: string;
  TAIL_HUB: DurableObjectNamespace;
  DASHBOARD_CACHE: DurableObjectNamespace;
  DASHBOARD_CACHE_SHARDS?: string;
  DEMO_SCENARIOS_ENABLED?: string;
}

export type SearchMode = 'structured' | 'token' | 'phrase';
export type UserRole = 'viewer' | 'analyst' | 'admin' | 'superadmin';
export type AuthMode = 'access_sso' | 'local_password';

export interface DataScope {
  indexes: string[];
  services: string[];
  envs: string[];
  hosts: string[];
}

export interface AuthContext {
  principal: string;
  email?: string;
  role: UserRole;
  roleIds: string[];
  permissions: Set<string>;
  scope: DataScope;
  authMode: AuthMode;
  groups: string[];
}

export interface AccessJwtHeader {
  alg?: string;
  kid?: string;
}

export interface AccessJwtPayload {
  sub?: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  groups?: string[];
  [key: string]: unknown;
}

export interface SearchRequest {
  time: { from: string; to: string };
  filters?: Record<string, string | number>;
  q?: string;
  phrase?: string | null;
  limit?: number;
  cursor?: { before_ts: string; before_event_id: string } | null;
}

export interface PplSearchRequest {
  time: { from: string; to: string };
  ppl: string;
  limit?: number;
  cursor?: { before_ts: string; before_event_id: string } | null;
}

export interface PplSuggestionsRequest {
  query?: string;
  cursorPos?: number;
  maxItems?: number;
  context?: {
    topTerms?: string[];
  };
}

export interface SearchEvent {
  event_id: string;
  ts: string;
  date?: string;
  hour?: number;
  index?: string;
  service: string;
  env: string;
  host: string;
  level: string;
  message: string;
  message_lc?: string;
  msg_hash?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  request_id?: string;
  status?: number;
  duration_ms?: number;
  src_ip?: string;
  user_id?: string;
  attrs_json?: string;
}

export interface SearchResponse {
  results: SearchEvent[];
  next_cursor: { before_ts: string; before_event_id: string } | null;
  stats: {
    mode: SearchMode;
    scanned_partitions: number;
    scanned_objects: number;
    listed_prefixes: number;
    listing_calls: number;
    listed_objects: number;
    listing_fallbacks: number;
    candidates: number;
    returned: number;
    execution_path?: 'single' | 'shared_base';
    timing_ms?: {
      listing: number;
      object_read: number;
      parse_filter: number;
      post_pipeline: number;
      total: number;
    };
  };
}

export interface PplSearchResponse {
  result_type: 'events' | 'table';
  results: Array<SearchEvent | Record<string, unknown>>;
  next_cursor: { before_ts: string; before_event_id: string } | null;
  source?: 'live' | 'cache' | 'materialized' | 'stale_materialized';
  computed_at?: string;
  expires_at?: string;
  materialization_status?: 'fresh' | 'stale' | 'miss' | 'disabled';
  stats: SearchResponse['stats'] & {
    language: 'ppl';
    stage_count: number;
  };
  warning?: string;
}

export interface DashboardBatchWidgetRequest {
  widget_id: string;
  ppl: string;
  limit?: number;
}

export interface DashboardBatchWidgetResult {
  response?: PplSearchResponse;
  error?: string;
}

export interface GuardrailExplanation {
  code: string;
  title: string;
  reason: string;
  suggestion: string;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface SearchSummaryResponse {
  mode: SearchMode;
  scanned_partitions: number;
  sampled_events: number;
  sampled_candidates: number;
  scanned_objects: number;
  listed_prefixes: number;
  listing_calls: number;
  listed_objects: number;
  listing_fallbacks: number;
  timing_ms?: {
    listing: number;
    object_read: number;
    parse_filter: number;
    post_pipeline: number;
    total: number;
  };
  truncated: boolean;
  top_terms: FacetCount[];
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
    indexes: FacetCount[];
    services: FacetCount[];
    levels: FacetCount[];
    statuses: FacetCount[];
    hosts: FacetCount[];
  };
  timeline: Array<{ minute: string; count: number }>;
}

export interface ParsedQuery {
  phrase: string | null;
  tokens: string[];
  extractedFilters: Record<string, string>;
}

export interface SearchFilters {
  index?: string;
  service?: string;
  env?: string;
  host?: string;
  level?: string;
  status?: number;
  status_gt?: number;
  status_gte?: number;
  status_lt?: number;
  status_lte?: number;
  user_id?: string;
  src_ip?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  request_id?: string;
  msg_hash?: string;
  duration_gt?: number;
  duration_gte?: number;
  duration_lt?: number;
  duration_lte?: number;
}

export type PplConditionOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

export interface PplCondition {
  field: string;
  operator: PplConditionOperator;
  value: string | number | boolean;
}

export interface StatsAggregation {
  fn: string;
  field: string | null;
  as: string;
}

export type PplStage =
  | { command: 'search'; expression: string; implicit?: boolean }
  | { command: 'where'; conditions: PplCondition[] }
  | { command: 'fields'; fields: string[] }
  | { command: 'sort'; keys: Array<{ field: string; direction: 'asc' | 'desc' }> }
  | { command: 'head'; count: number }
  | { command: 'stats'; fn: string; as: string; by: string[]; aggregations: StatsAggregation[] }
  | { command: 'timechart'; span: string; spanMs: number; aggregations: StatsAggregation[]; by: string | null }
  | { command: 'top'; count: number; field: string; by: string | null }
  | { command: 'rare'; count: number; field: string; by: string | null }
  | { command: 'dedup'; fields: string[] }
  | { command: 'eval'; field: string; expression: string }
  | { command: 'lookup'; table: string; field: string; outputFields: string[] | null }
  | { command: 'rex'; sourceField: string; pattern: string }
  | { command: 'rename'; oldField: string; newField: string }
  | { command: 'table'; fields: string[] }
  | { command: 'transaction'; field: string; maxSpanMs: number; maxEvents: number };

export interface PplPipeline {
  raw: string;
  stages: PplStage[];
}

export interface SavedSearchRow {
  id: string;
  name: string;
  query: string;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface ScheduledSearchRow {
  id: string;
  name: string;
  ppl: string;
  time_window_minutes: number;
  schedule_cron: string;
  enabled: number;
  actions_json: string;
  max_results: number;
  execution_mode?: string | null;
  cache_ttl_seconds?: number | null;
  materialize_enabled?: number | null;
  materialize_interval_seconds?: number | null;
  max_staleness_seconds?: number | null;
  last_materialized_at?: string | null;
  last_materialization_status?: string | null;
  last_materialization_error?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface ScheduledSearchResultRow {
  id: string;
  scheduled_search_id: string;
  run_at: string;
  time_from: string;
  time_to: string;
  status: string;
  result_count: number;
  results_json: string;
  trigger_type?: string | null;
  requested_by?: string | null;
  query_request_json?: string | null;
  preview_json?: string | null;
  summary_json?: string | null;
  materialized_result_id?: string | null;
  comparison_json?: string | null;
  stats_json: string;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  baseline_run_id?: string | null;
  created_at: string;
}

export interface DashboardRow {
  id: string;
  name: string;
  description?: string | null;
  layout_json: string;
  is_default: number;
  performance_profile?: string | null;
  default_execution_mode?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface DashboardPanelRow {
  id: string;
  dashboard_id: string;
  title: string;
  ppl: string;
  viz_type: string;
  widget_type?: string | null;
  query_text?: string | null;
  query_mode?: string | null;
  viz_config_json?: string | null;
  layout_json?: string | null;
  bindings_json?: string | null;
  display_options_json?: string | null;
  time_window_minutes: number;
  refresh_seconds: number;
  execution_mode?: string | null;
  cache_ttl_seconds?: number | null;
  materialize_enabled?: number | null;
  materialize_interval_seconds?: number | null;
  max_staleness_seconds?: number | null;
  priority?: number | null;
  last_materialized_at?: string | null;
  last_materialization_status?: string | null;
  last_materialization_error?: string | null;
  options_json: string;
  position: number;
  created_at: string;
  updated_at?: string | null;
}

export type DashboardWidgetType = 'timeseries' | 'bar' | 'pie' | 'table' | 'kpi' | 'topn' | 'markdown';

export interface LookupTableRow {
  id: string;
  name: string;
  description?: string | null;
  key_field: string;
  schema_json: string;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface LookupRowEntry {
  lookup_id: string;
  key_value: string;
  data_json: string;
}

export interface AlertRow {
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
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface StarterAlertApplyRequest {
  index?: string;
  service?: string;
  env?: string;
  deep_link_base?: string;
  runbook_base_url?: string;
  owner_team?: string;
  notify_slack?: boolean;
  notify_webhook?: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole | string;
  enabled: number;
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

export interface UserRoleAssignmentRow {
  user_id: string;
  role_id: string;
}

export interface AccessGroupRoleMappingRow {
  id: string;
  access_group: string;
  role_id: string;
  created_at: string;
  updated_at?: string | null;
}

export interface InvitationRow {
  id: string;
  email: string;
  auth_mode: AuthMode;
  token_hash: string;
  role_ids_json: string;
  expires_at: string;
  invited_by: string;
  status: string;
  created_at: string;
  accepted_at?: string | null;
}

export interface InvitationViewRow {
  id: string;
  email: string;
  auth_mode: AuthMode;
  role_ids_json: string;
  expires_at: string;
  invited_by: string;
  status: string;
  created_at: string;
  accepted_at?: string | null;
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

export interface WAERow {
  [key: string]: string | number | null;
}

export interface OpsMetricRow {
  blobs: string[];
  doubles: number[];
  timestamp: Date;
}

export interface SearchContext {
  mode: SearchMode;
  phrase: string | null;
  filters: SearchFilters;
  fromMs: number;
  toMs: number;
  dates: string[];
  parsed: ParsedQuery;
}

export interface ListingTracker {
  prefixes: Set<string>;
  listing_calls: number;
  listed_objects: number;
  listing_fallbacks: number;
}

export interface ListingStatsSnapshot {
  listed_prefixes: number;
  listing_calls: number;
  listed_objects: number;
  listing_fallbacks: number;
}

export interface TimingTracker {
  listingMs: number;
  objectReadMs: number;
  parseFilterMs: number;
  postPipelineMs: number;
}

export interface TimingStatsSnapshot {
  listing: number;
  object_read: number;
  parse_filter: number;
  post_pipeline: number;
  total: number;
}

export type ExecutionMode = 'live' | 'cached' | 'materialized';
export type PerformanceProfile = 'economy' | 'balanced' | 'fast';

export interface ExecutionPolicy {
  execution_mode: ExecutionMode;
  cache_ttl_seconds: number;
  materialize_enabled: boolean;
  materialize_interval_seconds: number;
  max_staleness_seconds: number;
  priority: number;
}

export interface MaterializedResultRow {
  id: string;
  entity_type: string;
  entity_id: string;
  scope_key: string;
  query_hash: string;
  time_bucket_start: string;
  time_bucket_end: string;
  status: string;
  result_count: number;
  payload_r2_key?: string | null;
  payload_inline_json?: string | null;
  stats_json: string;
  computed_at: string;
  expires_at: string;
}

// --- Constants ---

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 200;
export const MAX_CANDIDATES = 5000;
export const MAX_SUMMARY_EVENTS = 5000;
export const PPL_MAX_LIMIT = 5000;
export const R2_READ_CONCURRENCY = 8;
export const DEFAULT_EVENT_INDEX = 'default';
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
export const PPL_PREFILTER_EQ_FIELDS = new Set([
  'index',
  'service',
  'env',
  'host',
  'level',
  'user_id',
  'src_ip',
  'trace_id',
  'span_id',
  'parent_span_id',
  'request_id',
  'msg_hash'
]);

export const BASE_CORS_HEADERS = {
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,CF-Access-Jwt-Assertion,Authorization',
  'vary': 'Origin'
};

export const PBKDF2_ITERATIONS = 100_000;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const DEFAULT_INVITE_TTL_HOURS = 48;
export const DEFAULT_SCOPE: DataScope = { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] };
export const ALL_PERMISSIONS = ['*'];

export const ROLE_PERMISSION_DEFAULTS: Record<string, string[]> = {
  superadmin: ALL_PERMISSIONS,
  admin: [
    'search.read',
    'dashboard.read',
    'dashboard.write',
    'dashboard.delete',
    'saved_search.read',
    'saved_search.write',
    'saved_search.delete',
    'scheduled_search.read',
    'scheduled_search.write',
    'scheduled_search.delete',
    'alert.read',
    'alert.write',
    'alert.delete',
    'lookup.read',
    'lookup.write',
    'lookup.delete',
    'user.read',
    'user.invite',
    'user.disable',
    'role.read',
    'role.write',
    'audit.read'
  ],
  analyst: [
    'search.read',
    'dashboard.read',
    'dashboard.write',
    'saved_search.read',
    'saved_search.write',
    'saved_search.delete',
    'scheduled_search.read',
    'scheduled_search.write',
    'alert.read',
    'lookup.read',
    'lookup.write'
  ],
  viewer: ['search.read', 'dashboard.read', 'saved_search.read', 'scheduled_search.read', 'lookup.read']
};
