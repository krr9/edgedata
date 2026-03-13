export { TailHub } from './tail-hub.js';
export { DashboardCache } from './dashboard-cache.js';
import {
  cacheShardNameForKey,
  normalizeBooleanFlag,
  normalizeCacheTtlSeconds,
  normalizeExecutionMode,
  normalizeMaterializeIntervalSeconds,
  normalizeMaxStalenessSeconds,
  normalizePerformanceProfile
} from './performance-policy.mjs';
import {
  buildMaterializationBucket,
  buildScopeKey,
  hashQueryText
} from '../../shared/materialization-core.mjs';
import {
  classifyGuardrailError,
  enforceTimeGuardrails,
  getDateRange,
  inferSearchMode,
  mergeFilters,
  parseISODate,
  parseQueryInput,
  tokenize
} from './query-core.mjs';
import { parsePplPipeline } from './ppl-core.mjs';
import { getPplSuggestions } from './ppl-suggestions.mjs';
import {
  isIncrementalStreamPipeline,
  resolvePipelineLimit,
  rowMatchesWhereStages,
  applyPostPipeline,
  executeLookupPipeline,
  executeRexPipeline,
  executeRenamePipeline,
  executeTransactionPipeline
} from './search-stream-core.mjs';
import { allowsCredentialedCors, resolveCorsOriginFromPatterns } from './cors-utils.mjs';
import { resolveAccessStartReturnTo } from './access-sso-utils.mjs';
import {
  buildStarterAlertPackDefinitions,
  extractStarterIdFromParamsJson
} from './starter-alert-pack.mjs';
import {
  validateBootstrapRequest,
  buildBootstrapPayload,
  validateRelatedEventsRequest,
  normalizePivots,
  rankRelatedEvents,
  buildSessionRecord,
  validateSessionSaveRequest,
  canAccessInvestigationSession
} from './investigation-core.mjs';
import { statusFromError } from './error-utils.mjs';
import { seedStarterDashboards } from './starter-dashboards.mjs';
import { mergePermissionsWithDefaults } from './rbac-core.mjs';
import { validateQueryAccessJwtConfig } from '../../shared/access-config.mjs';

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

type SearchMode = 'structured' | 'token' | 'phrase';
type UserRole = 'viewer' | 'analyst' | 'admin' | 'superadmin';
type AuthMode = 'access_sso' | 'local_password';

interface DataScope {
  indexes: string[];
  services: string[];
  envs: string[];
  hosts: string[];
}

interface AuthContext {
  principal: string;
  email?: string;
  role: UserRole;
  roleIds: string[];
  permissions: Set<string>;
  scope: DataScope;
  authMode: AuthMode;
  groups: string[];
}

interface AccessJwtHeader {
  alg?: string;
  kid?: string;
}

interface AccessJwtPayload {
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

interface SearchRequest {
  time: { from: string; to: string };
  filters?: Record<string, string | number>;
  q?: string;
  phrase?: string | null;
  limit?: number;
  cursor?: { before_ts: string; before_event_id: string } | null;
}

interface PplSearchRequest {
  time: { from: string; to: string };
  ppl: string;
  limit?: number;
  cursor?: { before_ts: string; before_event_id: string } | null;
}

interface PplSuggestionsRequest {
  query?: string;
  cursorPos?: number;
  maxItems?: number;
  context?: {
    topTerms?: string[];
  };
}

interface SearchEvent {
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

interface SearchResponse {
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

interface PplSearchResponse {
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

interface DashboardBatchWidgetRequest {
  widget_id: string;
  ppl: string;
  limit?: number;
}

interface DashboardBatchWidgetResult {
  response?: PplSearchResponse;
  error?: string;
}

interface GuardrailExplanation {
  code: string;
  title: string;
  reason: string;
  suggestion: string;
}

interface FacetCount {
  value: string;
  count: number;
}

interface SearchSummaryResponse {
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

interface ParsedQuery {
  phrase: string | null;
  tokens: string[];
  extractedFilters: Record<string, string>;
}

interface SearchFilters {
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

type PplConditionOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

interface PplCondition {
  field: string;
  operator: PplConditionOperator;
  value: string | number | boolean;
}

interface StatsAggregation {
  fn: string;
  field: string | null;
  as: string;
}

type PplStage =
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

interface PplPipeline {
  raw: string;
  stages: PplStage[];
}

interface SavedSearchRow {
  id: string;
  name: string;
  query: string;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface ScheduledSearchRow {
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

interface ScheduledSearchResultRow {
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

interface DashboardRow {
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

interface DashboardPanelRow {
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

type DashboardWidgetType = 'timeseries' | 'bar' | 'pie' | 'table' | 'kpi' | 'topn' | 'markdown';

interface LookupTableRow {
  id: string;
  name: string;
  description?: string | null;
  key_field: string;
  schema_json: string;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface LookupRowEntry {
  lookup_id: string;
  key_value: string;
  data_json: string;
}

interface AlertRow {
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

interface StarterAlertApplyRequest {
  index?: string;
  service?: string;
  env?: string;
  deep_link_base?: string;
  runbook_base_url?: string;
  owner_team?: string;
  notify_slack?: boolean;
  notify_webhook?: boolean;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole | string;
  enabled: number;
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

interface UserRoleAssignmentRow {
  user_id: string;
  role_id: string;
}

interface AccessGroupRoleMappingRow {
  id: string;
  access_group: string;
  role_id: string;
  created_at: string;
  updated_at?: string | null;
}

interface InvitationRow {
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

interface InvitationViewRow {
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

interface WAERow {
  [key: string]: string | number | null;
}

interface OpsMetricRow {
  blobs: string[];
  doubles: number[];
  timestamp: Date;
}

interface SearchContext {
  mode: SearchMode;
  phrase: string | null;
  filters: SearchFilters;
  fromMs: number;
  toMs: number;
  dates: string[];
  parsed: ParsedQuery;
}

interface ListingTracker {
  prefixes: Set<string>;
  listing_calls: number;
  listed_objects: number;
  listing_fallbacks: number;
}

interface ListingStatsSnapshot {
  listed_prefixes: number;
  listing_calls: number;
  listed_objects: number;
  listing_fallbacks: number;
}

interface TimingTracker {
  listingMs: number;
  objectReadMs: number;
  parseFilterMs: number;
  postPipelineMs: number;
}

interface TimingStatsSnapshot {
  listing: number;
  object_read: number;
  parse_filter: number;
  post_pipeline: number;
  total: number;
}

type ExecutionMode = 'live' | 'cached' | 'materialized';
type PerformanceProfile = 'economy' | 'balanced' | 'fast';

interface ExecutionPolicy {
  execution_mode: ExecutionMode;
  cache_ttl_seconds: number;
  materialize_enabled: boolean;
  materialize_interval_seconds: number;
  max_staleness_seconds: number;
  priority: number;
}

interface MaterializedResultRow {
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

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const MAX_CANDIDATES = 5000;
const MAX_SUMMARY_EVENTS = 5000;
const PPL_MAX_LIMIT = 5000;
const R2_READ_CONCURRENCY = 8;
const DEFAULT_EVENT_INDEX = 'default';
const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const PPL_PREFILTER_EQ_FIELDS = new Set([
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

const BASE_CORS_HEADERS = {
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,CF-Access-Jwt-Assertion,Authorization',
  'vary': 'Origin'
};

let jwksCache: { expiresAt: number; keysByKid: Map<string, JsonWebKey> } | null = null;

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_INVITE_TTL_HOURS = 48;
const DEFAULT_SCOPE: DataScope = { indexes: ['*'], services: ['*'], envs: ['*'], hosts: ['*'] };
const ALL_PERMISSIONS = ['*'];

const ROLE_PERMISSION_DEFAULTS: Record<string, string[]> = {
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

let rbacInitPromise: Promise<void> | null = null;

function parseCsvSet(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseJsonArray(input: string | undefined, fallback: string[] = []): string[] {
  if (!input) return [...fallback];
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return [...fallback];
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return [...fallback];
  }
}

function parsePermissionsInput(input: unknown, fallback: string[] = []): string[] {
  if (typeof input === 'string' || input === undefined) {
    return parseJsonArray(input, fallback);
  }
  if (Array.isArray(input)) {
    return input.map((item) => String(item)).filter(Boolean);
  }
  return [...fallback];
}

function parseScope(input: string | undefined): DataScope {
  if (!input) return { ...DEFAULT_SCOPE };
  try {
    const parsed = JSON.parse(input) as Partial<DataScope>;
    return {
      indexes: Array.isArray(parsed.indexes) && parsed.indexes.length > 0 ? parsed.indexes.map(String) : ['*'],
      services: Array.isArray(parsed.services) && parsed.services.length > 0 ? parsed.services.map(String) : ['*'],
      envs: Array.isArray(parsed.envs) && parsed.envs.length > 0 ? parsed.envs.map(String) : ['*'],
      hosts: Array.isArray(parsed.hosts) && parsed.hosts.length > 0 ? parsed.hosts.map(String) : ['*']
    };
  } catch {
    return { ...DEFAULT_SCOPE };
  }
}

function parseScopeInput(input: unknown): DataScope {
  if (typeof input === 'string' || input === undefined) {
    return parseScope(input);
  }
  if (input && typeof input === 'object') {
    const scope = input as Partial<DataScope>;
    return {
      indexes: Array.isArray(scope.indexes) && scope.indexes.length > 0 ? scope.indexes.map(String) : ['*'],
      services: Array.isArray(scope.services) && scope.services.length > 0 ? scope.services.map(String) : ['*'],
      envs: Array.isArray(scope.envs) && scope.envs.length > 0 ? scope.envs.map(String) : ['*'],
      hosts: Array.isArray(scope.hosts) && scope.hosts.length > 0 ? scope.hosts.map(String) : ['*']
    };
  }
  return { ...DEFAULT_SCOPE };
}

function normalizeScope(scope: DataScope): DataScope {
  return {
    indexes: scope.indexes.length > 0 ? scope.indexes : ['*'],
    services: scope.services.length > 0 ? scope.services : ['*'],
    envs: scope.envs.length > 0 ? scope.envs : ['*'],
    hosts: scope.hosts.length > 0 ? scope.hosts : ['*']
  };
}

function asInviteTtlHours(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INVITE_TTL_HOURS;
  return Math.min(7 * 24, Math.max(1, Math.trunc(n)));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesScopedValue(value: string | undefined, patterns: string[]): boolean {
  if (patterns.length === 0 || patterns.includes('*')) return true;
  if (!value) return false;
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (!pattern.includes('*') && pattern.toLowerCase() === value.toLowerCase()) return true;
    if (pattern.includes('*') && globToRegExp(pattern).test(value)) return true;
  }
  return false;
}

function mergeScope(scopes: DataScope[]): DataScope {
  if (scopes.length === 0) return { ...DEFAULT_SCOPE };
  const mergeDimension = (extractor: (scope: DataScope) => string[]): string[] => {
    const union = new Set<string>();
    for (const scope of scopes) {
      const values = extractor(scope);
      if (values.includes('*')) return ['*'];
      for (const value of values) union.add(value);
    }
    return union.size > 0 ? Array.from(union) : ['*'];
  };
  return {
    indexes: mergeDimension((scope) => scope.indexes),
    services: mergeDimension((scope) => scope.services),
    envs: mergeDimension((scope) => scope.envs),
    hosts: mergeDimension((scope) => scope.hosts)
  };
}

function highestRole(roleIds: string[]): UserRole {
  if (roleIds.includes('superadmin')) return 'superadmin';
  if (roleIds.includes('admin')) return 'admin';
  if (roleIds.includes('analyst')) return 'analyst';
  return 'viewer';
}

function ensureRoleId(role: string): string {
  return role.trim().toLowerCase();
}

function resolveCorsOrigin(request: Request, env: Env): string {
  return resolveCorsOriginFromPatterns(
    request.headers.get('origin') || '',
    Array.from(parseCsvSet(env.CORS_ORIGINS))
  );
}

function resolveAccessReturnTo(request: Request, env: Env): string {
  const url = new URL(request.url);
  return resolveAccessStartReturnTo({
    requestUrl: request.url,
    requestedReturnTo: url.searchParams.get('return_to') || '',
    allowedOrigins: Array.from(parseCsvSet(env.CORS_ORIGINS)),
    originHeader: request.headers.get('origin') || '',
    refererHeader: request.headers.get('referer') || ''
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = resolveCorsOrigin(request, env);
  return {
    'access-control-allow-origin': origin,
    ...(allowsCredentialedCors(origin) ? { 'access-control-allow-credentials': 'true' } : {}),
    ...BASE_CORS_HEADERS
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders
    }
  });
}

function textResponse(text: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: extraHeaders
  });
}

function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...extraHeaders
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown-ip';
}

function asRateLimitPerMinute(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

async function enforceRateLimit(
  env: Env,
  scope: string,
  key: string,
  perMinute: number
): Promise<void> {
  if (perMinute <= 0) return;

  const now = Date.now();
  const windowStartMs = Math.floor(now / 60000) * 60000;
  const nowIso = new Date(now).toISOString();

  await env.DB.prepare(
    `INSERT INTO rate_limits (scope, limit_key, window_start_ms, count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, limit_key, window_start_ms) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at`
  ).bind(scope, key, windowStartMs, nowIso).run();

  const row = await env.DB.prepare(
    `SELECT count
     FROM rate_limits
     WHERE scope = ? AND limit_key = ? AND window_start_ms = ?`
  ).bind(scope, key, windowStartMs).first<{ count?: number }>();

  if (Number(row?.count || 0) > perMinute) {
    throw new Error('Rate limit exceeded');
  }
}

function bytesToHex(input: Uint8Array): string {
  return Array.from(input).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex input');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, (i * 2) + 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (const byte of bytes) chars.push(String.fromCharCode(byte));
  return btoa(chars.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function asSessionTtlSeconds(value: string | undefined): number {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return SESSION_TTL_SECONDS;
  return Math.min(7 * 24 * 60 * 60, Math.max(300, Math.trunc(ttl)));
}

async function pbkdf2Hash(password: string, saltHex: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: hexToBytes(saltHex),
      iterations
    },
    key,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(salt);
  const hashHex = await pbkdf2Hash(password, saltHex, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, rawIterations, saltHex, expectedHash] = stored.split('$');
  if (algo !== 'pbkdf2_sha256' || !rawIterations || !saltHex || !expectedHash) return false;
  const iterations = Number(rawIterations);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const computed = await pbkdf2Hash(password, saltHex, Math.trunc(iterations));
  return timingSafeEqual(computed, expectedHash);
}

async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function ensureRbacInitialized(env: Env): Promise<void> {
  if (rbacInitPromise) {
    return rbacInitPromise;
  }

  rbacInitPromise = (async () => {
    const bootstrapStatements = [
      `CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        system_role INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        permissions_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        assigned_by TEXT,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      )`,
      `CREATE TABLE IF NOT EXISTS access_group_role_mappings (
        id TEXT PRIMARY KEY,
        access_group TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        role_ids_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor_principal TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_roles_enabled ON roles(enabled)',
      'CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_role_map_group ON access_group_role_mappings(access_group)',
      'CREATE INDEX IF NOT EXISTS idx_invites_email ON invitations(email)',
      'CREATE INDEX IF NOT EXISTS idx_invites_status ON invitations(status)',
      'CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC)'
    ];
    for (const statement of bootstrapStatements) {
      await env.DB.prepare(statement).run();
    }

    const now = new Date().toISOString();
    const roleIds = ['superadmin', 'admin', 'analyst', 'viewer'];
    for (const roleId of roleIds) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO roles (id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at)
         VALUES (?, ?, 1, 1, ?, ?, ?, ?)`
      ).bind(
        roleId,
        roleId,
        JSON.stringify(ROLE_PERMISSION_DEFAULTS[roleId] || []),
        JSON.stringify(DEFAULT_SCOPE),
        now,
        now
      ).run();
    }

    const existingRoles = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles
       WHERE id IN (${roleIds.map(() => '?').join(', ')})`
    ).bind(...roleIds).all<RoleRow>();

    for (const role of existingRoles.results || []) {
      if (role.system_role !== 1) continue;
      const currentPermissions = parseJsonArray(role.permissions_json, []);
      const mergedPermissions = mergePermissionsWithDefaults(currentPermissions, ROLE_PERMISSION_DEFAULTS[role.id] || []);
      if (mergedPermissions.length === currentPermissions.length) continue;
      await env.DB.prepare(
        'UPDATE roles SET permissions_json = ?, updated_at = ? WHERE id = ?'
      ).bind(JSON.stringify(mergedPermissions), now, role.id).run();
    }

    const seedGroupMappings = async (csv: string | undefined, roleId: string) => {
      const groups = Array.from(parseCsvSet(csv));
      for (const group of groups) {
        const existing = await env.DB.prepare(
          'SELECT id FROM access_group_role_mappings WHERE access_group = ? AND role_id = ? LIMIT 1'
        ).bind(group, roleId).first<{ id?: string }>();
        if (existing?.id) continue;
        await env.DB.prepare(
          'INSERT INTO access_group_role_mappings (id, access_group, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), group, roleId, now, now).run();
      }
    };
    await seedGroupMappings(env.ACCESS_SUPERADMIN_GROUPS, 'superadmin');
    await seedGroupMappings(env.ACCESS_ADMIN_GROUPS, 'admin');
    await seedGroupMappings(env.ACCESS_ANALYST_GROUPS, 'analyst');
    await seedGroupMappings(env.ACCESS_VIEWER_GROUPS, 'viewer');

    const usersCountRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count?: number }>();
    const usersCount = Number(usersCountRow?.count || 0);
    if (usersCount === 0) {
      const bootstrapEmail = (env.AUTH_BOOTSTRAP_SUPERADMIN_EMAIL || env.AUTH_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
      if (bootstrapEmail) {
        const bootstrapPassword = env.AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD || env.AUTH_BOOTSTRAP_PASSWORD || '';
        const passwordHash = bootstrapPassword
          ? await hashPassword(bootstrapPassword)
          : '!access-sso-only!';
        const userId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
           VALUES (?, ?, ?, 'superadmin', 1, ?, ?)`
        ).bind(userId, bootstrapEmail, passwordHash, now, now).run();

        await env.DB.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
           VALUES (?, 'superadmin', 'bootstrap', ?)`
        ).bind(userId, now).run();
      }
    }

    const legacyUsers = await env.DB.prepare(
      `SELECT u.id, u.role
       FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`
    ).all<{ id: string; role?: string | null }>();

    for (const user of legacyUsers.results || []) {
      const roleId = ensureRoleId(String(user.role || 'viewer'));
      const fallback = ROLE_PERMISSION_DEFAULTS[roleId] ? roleId : 'viewer';
      await env.DB.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
         VALUES (?, ?, 'legacy', ?)`
      ).bind(user.id, fallback, now).run();
    }
  })();

  try {
    await rbacInitPromise;
  } catch (error) {
    rbacInitPromise = null;
    throw error;
  }
}

async function writeAuditLog(
  env: Env,
  auth: AuthContext | null,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO audit_log (
      id, actor_principal, actor_email, action, target_type, target_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    auth?.principal || null,
    auth?.email || null,
    action,
    targetType || null,
    targetId || null,
    metadata ? JSON.stringify(metadata) : null,
    now
  ).run();
}

function hasPermission(auth: AuthContext, permission: string): boolean {
  return auth.permissions.has('*') || auth.permissions.has(permission);
}

function assertPermission(auth: AuthContext, permission: string): void {
  if (!hasPermission(auth, permission)) {
    throw new Error('Forbidden');
  }
}

function roleDefinitionFromRow(row: RoleRow): { id: string; permissions: string[]; scope: DataScope } {
  return {
    id: row.id,
    permissions: parseJsonArray(row.permissions_json, ROLE_PERMISSION_DEFAULTS[row.id] || []),
    scope: normalizeScope(parseScope(row.scope_json))
  };
}

async function resolveAuthFromRoleIds(
  env: Env,
  principal: string,
  email: string | undefined,
  groups: string[],
  roleIds: string[],
  authMode: AuthMode
): Promise<AuthContext> {
  const normalizedRoleIds = Array.from(new Set(roleIds.map(ensureRoleId))).filter(Boolean);
  if (normalizedRoleIds.length === 0) {
    throw new Error('Access denied');
  }

  const placeholders = normalizedRoleIds.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
     FROM roles
     WHERE id IN (${placeholders}) AND enabled = 1`
  ).bind(...normalizedRoleIds).all<RoleRow>();

  const resolved = (rows.results || []).map(roleDefinitionFromRow);
  if (resolved.length === 0) {
    throw new Error('Access denied');
  }

  const permissions = new Set<string>();
  const scopes: DataScope[] = [];
  for (const role of resolved) {
    for (const permission of role.permissions) permissions.add(permission);
    scopes.push(role.scope);
  }

  const effectiveRoleIds = resolved.map((role) => role.id);
  return {
    principal,
    email,
    role: highestRole(effectiveRoleIds),
    roleIds: effectiveRoleIds,
    permissions,
    scope: mergeScope(scopes),
    authMode,
    groups
  };
}

async function createSessionToken(auth: AuthContext, env: Env): Promise<{ token: string; expiresAt: string }> {
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret) {
    throw new Error('Auth session secret is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = asSessionTtlSeconds(env.SESSION_TTL_SECONDS);
  const payload = {
    sub: auth.principal,
    email: auth.email || '',
    mode: 'session',
    iat: now,
    exp: now + ttl
  };
  const payloadSegment = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(payloadSegment, secret);
  return {
    token: `${payloadSegment}.${signature}`,
    expiresAt: new Date((now + ttl) * 1000).toISOString()
  };
}

async function verifySessionToken(token: string, env: Env): Promise<AuthContext | null> {
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadSegment, signatureSegment] = parts;
  if (!payloadSegment || !signatureSegment) return null;

  const expected = await hmacSign(payloadSegment, secret);
  if (!timingSafeEqual(expected, signatureSegment)) return null;

  let payload: { sub?: string; email?: string; exp?: number };
  try {
    payload = decodeJwtPart<{ sub?: string; email?: string; exp?: number }>(payloadSegment);
  } catch {
    return null;
  }

  if (!payload.sub) return null;
  if (!payload.exp || !Number.isFinite(payload.exp)) return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;

  await ensureRbacInitialized(env);
  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
     FROM users
     WHERE id = ?`
  ).bind(payload.sub).first<UserRow>();
  if (!user || user.enabled !== 1) return null;
  const roleIds = await resolveRoleIdsForUser(env, user, []);
  if (roleIds.length === 0) return null;

  try {
    return await resolveAuthFromRoleIds(env, user.id, user.email || payload.email || undefined, [], roleIds, 'local_password');
  } catch {
    return null;
  }
}

async function authenticateCredentials(email: string, password: string, env: Env): Promise<UserRow | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) return null;
  await ensureRbacInitialized(env);

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
     FROM users
     WHERE email = ?`
  ).bind(normalizedEmail).first<UserRow>();

  if (!user || user.enabled !== 1) return null;
  if (!user.password_hash || user.password_hash === '!access-sso-only!') return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;

  return user;
}

async function writeOpsMetric(
  env: Env,
  metric: string,
  value = 1,
  dimension = 'query-worker'
): Promise<void> {
  if (!env.OPS_WAE) return;
  const row: OpsMetricRow = {
    blobs: [metric, dimension],
    doubles: [value],
    timestamp: new Date()
  };
  await env.OPS_WAE.writeData([row]);
}

async function writeScanMetrics(
  env: Env,
  namespace: 'search' | 'search_summary' | 'dashboard_widget',
  stats: ListingStatsSnapshot & {
    scanned_objects: number;
    scanned_partitions: number;
    timing_ms?: Partial<TimingStatsSnapshot>;
  }
): Promise<void> {
  const metricValue = (value: unknown): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  await Promise.allSettled([
    writeOpsMetric(env, `${namespace}_scanned_partitions`, metricValue(stats.scanned_partitions)),
    writeOpsMetric(env, `${namespace}_scanned_objects`, metricValue(stats.scanned_objects)),
    writeOpsMetric(env, `${namespace}_listed_prefixes`, metricValue(stats.listed_prefixes)),
    writeOpsMetric(env, `${namespace}_listing_calls`, metricValue(stats.listing_calls)),
    writeOpsMetric(env, `${namespace}_listed_objects`, metricValue(stats.listed_objects)),
    writeOpsMetric(env, `${namespace}_listing_fallbacks`, metricValue(stats.listing_fallbacks)),
    writeOpsMetric(env, `${namespace}_listing_ms`, metricValue(stats.timing_ms?.listing)),
    writeOpsMetric(env, `${namespace}_object_read_ms`, metricValue(stats.timing_ms?.object_read)),
    writeOpsMetric(env, `${namespace}_parse_filter_ms`, metricValue(stats.timing_ms?.parse_filter)),
    writeOpsMetric(env, `${namespace}_post_pipeline_ms`, metricValue(stats.timing_ms?.post_pipeline)),
    writeOpsMetric(env, `${namespace}_total_ms`, metricValue(stats.timing_ms?.total))
  ]);
}

function createTimingTracker(): TimingTracker {
  return {
    listingMs: 0,
    objectReadMs: 0,
    parseFilterMs: 0,
    postPipelineMs: 0
  };
}

function snapshotTimingTracker(tracker: TimingTracker, totalMs: number): TimingStatsSnapshot {
  return {
    listing: Math.round(tracker.listingMs),
    object_read: Math.round(tracker.objectReadMs),
    parse_filter: Math.round(tracker.parseFilterMs),
    post_pipeline: Math.round(tracker.postPipelineMs),
    total: Math.round(totalMs)
  };
}

function clampLimit(limit: number | undefined, maxLimit = MAX_LIMIT): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), maxLimit));
}

function compareEventsDesc(a: SearchEvent, b: SearchEvent): number {
  if (a.ts !== b.ts) return b.ts.localeCompare(a.ts);
  return b.event_id.localeCompare(a.event_id);
}

function normalizeIndexValue(value: string | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || DEFAULT_EVENT_INDEX;
}

function eventIndex(event: SearchEvent): string {
  return normalizeIndexValue(event.index);
}

function isBeforeCursor(event: SearchEvent, cursor: { before_ts: string; before_event_id: string } | null | undefined): boolean {
  if (!cursor) return true;
  if (event.ts < cursor.before_ts) return true;
  if (event.ts > cursor.before_ts) return false;
  return event.event_id < cursor.before_event_id;
}

function eventMatchesFilters(event: SearchEvent, filters: SearchFilters): boolean {
  if (filters.index && eventIndex(event) !== normalizeIndexValue(filters.index)) return false;
  if (filters.service && event.service !== filters.service) return false;
  if (filters.env && event.env !== filters.env) return false;
  if (filters.host && event.host !== filters.host) return false;
  if (filters.level && event.level !== filters.level) return false;
  if (filters.status !== undefined && event.status !== filters.status) return false;
  if (filters.status_gt !== undefined && (event.status === undefined || event.status <= filters.status_gt)) return false;
  if (filters.status_gte !== undefined && (event.status === undefined || event.status < filters.status_gte)) return false;
  if (filters.status_lt !== undefined && (event.status === undefined || event.status >= filters.status_lt)) return false;
  if (filters.status_lte !== undefined && (event.status === undefined || event.status > filters.status_lte)) return false;
  if (filters.user_id && event.user_id !== filters.user_id) return false;
  if (filters.src_ip && event.src_ip !== filters.src_ip) return false;
  if (filters.trace_id && event.trace_id !== filters.trace_id) return false;
  if (filters.span_id && event.span_id !== filters.span_id) return false;
  if (filters.parent_span_id && event.parent_span_id !== filters.parent_span_id) return false;
  if (filters.request_id && event.request_id !== filters.request_id) return false;
  if (filters.msg_hash && event.msg_hash !== filters.msg_hash) return false;

  if (filters.duration_gt !== undefined && (event.duration_ms === undefined || event.duration_ms <= filters.duration_gt)) return false;
  if (filters.duration_gte !== undefined && (event.duration_ms === undefined || event.duration_ms < filters.duration_gte)) return false;
  if (filters.duration_lt !== undefined && (event.duration_ms === undefined || event.duration_ms >= filters.duration_lt)) return false;
  if (filters.duration_lte !== undefined && (event.duration_ms === undefined || event.duration_ms > filters.duration_lte)) return false;

  return true;
}

function eventMatchesScope(event: SearchEvent, scope: DataScope): boolean {
  if (!matchesScopedValue(eventIndex(event), scope.indexes)) return false;
  if (!matchesScopedValue(event.service, scope.services)) return false;
  if (!matchesScopedValue(event.env, scope.envs)) return false;
  if (!matchesScopedValue(event.host, scope.hosts)) return false;
  return true;
}

function assertFiltersWithinScope(filters: SearchFilters, scope: DataScope): void {
  if (filters.index && !matchesScopedValue(normalizeIndexValue(filters.index), scope.indexes)) {
    throw new Error('Forbidden: index outside role scope');
  }
  if (filters.service && !matchesScopedValue(filters.service, scope.services)) {
    throw new Error('Forbidden: service outside role scope');
  }
  if (filters.env && !matchesScopedValue(filters.env, scope.envs)) {
    throw new Error('Forbidden: env outside role scope');
  }
  if (filters.host && !matchesScopedValue(filters.host, scope.hosts)) {
    throw new Error('Forbidden: host outside role scope');
  }
}

function injectScopeFilters(filters: SearchFilters, scope: DataScope): SearchFilters {
  const next = { ...filters };
  const maybeInject = (
    key: 'index' | 'service' | 'env' | 'host',
    patterns: string[]
  ) => {
    if (next[key]) return;
    if (patterns.includes('*')) return;
    const exactOnly = patterns.filter((pattern) => !pattern.includes('*'));
    if (exactOnly.length === 1) {
      next[key] = exactOnly[0];
    }
  };
  maybeInject('index', scope.indexes);
  maybeInject('service', scope.services);
  maybeInject('env', scope.envs);
  maybeInject('host', scope.hosts);
  return next;
}

function isWithinWindow(eventTs: string, fromMs: number, toMs: number): boolean {
  const value = new Date(eventTs).getTime();
  return Number.isFinite(value) && value >= fromMs && value <= toMs;
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      keys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return keys;
}

function createListingTracker(): ListingTracker {
  return {
    prefixes: new Set<string>(),
    listing_calls: 0,
    listed_objects: 0,
    listing_fallbacks: 0
  };
}

function snapshotListingTracker(tracker: ListingTracker): ListingStatsSnapshot {
  return {
    listed_prefixes: tracker.prefixes.size,
    listing_calls: tracker.listing_calls,
    listed_objects: tracker.listed_objects,
    listing_fallbacks: tracker.listing_fallbacks
  };
}

function recordListing(tracker: ListingTracker | undefined, prefix: string, listedObjects: number): void {
  if (!tracker) return;
  tracker.prefixes.add(prefix);
  tracker.listing_calls += 1;
  tracker.listed_objects += listedObjects;
}

function isExactScopedValue(value: string | undefined): value is string {
  if (!value) return false;
  if (value === '*') return false;
  return !value.includes('*');
}

function encodePartitionValue(value: string): string {
  return encodeURIComponent(value);
}

function buildPartitionPrefix(
  kind: 'events' | 'tokens' | 'raw',
  date: string,
  filters: SearchFilters
): string {
  const base = `${kind}/date=${date}/`;
  const index = isExactScopedValue(filters.index) ? normalizeIndexValue(filters.index) : null;
  if (!index) return base;

  const indexPrefix = `${base}index=${encodePartitionValue(index)}/`;
  if (kind === 'raw') return indexPrefix;

  const service = isExactScopedValue(filters.service) ? filters.service : null;
  if (!service) return indexPrefix;

  const servicePrefix = `${indexPrefix}service=${encodePartitionValue(service)}/`;
  const env = isExactScopedValue(filters.env) ? filters.env : null;
  if (!env) return servicePrefix;
  return `${servicePrefix}env=${encodePartitionValue(env)}/`;
}

async function listObjectsWithPrefixFallback(
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

function keyDimensionValue(key: string, dimension: 'index' | 'service' | 'env'): string | null {
  const match = key.match(new RegExp(`/${dimension}=([^/]+)/`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function keyMatchesFiltersByPath(key: string, filters: SearchFilters): boolean {
  if (filters.index) {
    const keyIndex = normalizeIndexValue(keyDimensionValue(key, 'index') || DEFAULT_EVENT_INDEX);
    if (keyIndex !== normalizeIndexValue(filters.index)) return false;
  }
  if (filters.service) {
    const keyService = keyDimensionValue(key, 'service');
    if (keyService !== filters.service) return false;
  }
  if (filters.env) {
    const keyEnv = keyDimensionValue(key, 'env');
    if (keyEnv !== filters.env) return false;
  }
  return true;
}

async function listEventKeysForDate(
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

async function listTokenKeysForDate(
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

async function readObjectText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return object.text();
}

async function readObjectChunk(
  bucket: R2Bucket,
  keys: string[],
  timing?: TimingTracker
): Promise<Array<{ key: string; text: string | null }>> {
  const startedAt = Date.now();
  const results = await Promise.all(keys.map(async (key) => ({ key, text: await readObjectText(bucket, key) })));
  if (timing) timing.objectReadMs += Date.now() - startedAt;
  return results;
}

async function fetchEventsByIds(
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

async function scanEvents(
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
        }
        if (timing) timing.parseFilterMs += Date.now() - parseStartedAt;
      }
    }
  }

  matches.sort(compareEventsDesc);
  return { results: matches.slice(0, limit), scannedObjects };
}

async function scanTokenCandidates(
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
        }
        if (timing) timing.parseFilterMs += Date.now() - parseStartedAt;
      }
    }
  }

  const ids = Array.from(scoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([id]) => id);

  return { ids, scannedObjects };
}

async function fetchEventsByIdsStream(
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
    for (const key of keys) {
      if (eventIds.size === 0) break;

      const text = await readObjectText(env.RAW_BUCKET, key);
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

  return { scannedObjects };
}

async function scanEventsStream(
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

    for (const key of keys) {
      const text = await readObjectText(env.RAW_BUCKET, key);
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

  return { scannedObjects };
}

function nextCursor(results: SearchEvent[]): { before_ts: string; before_event_id: string } | null {
  if (results.length === 0) return null;
  const last = results[results.length - 1];
  return {
    before_ts: last.ts,
    before_event_id: last.event_id
  };
}

function countFacet(items: Array<string | number | undefined>, limit = 10): FacetCount[] {
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

function buildTimeline(events: SearchEvent[], limit = 60): Array<{ minute: string; count: number }> {
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

function buildTopTerms(events: SearchEvent[], limit = 20): FacetCount[] {
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

function buildFieldPresence(events: SearchEvent[]): SearchSummaryResponse['field_presence'] {
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

function buildSearchContext(request: SearchRequest, auth: AuthContext): SearchContext {
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

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart<T>(segment: string): T {
  try {
    const bytes = base64UrlToBytes(segment);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error('Invalid Access JWT');
  }
}

function normalizedIssuer(input: string | undefined): string | null {
  if (!input) return null;
  return input.replace(/\/+$/, '');
}

function resolveJwksUrl(env: Env): string | null {
  if (env.ACCESS_JWKS_URL) return env.ACCESS_JWKS_URL.trim();
  const issuer = normalizedIssuer(env.ACCESS_ISSUER);
  if (!issuer) return null;
  return `${issuer}/cdn-cgi/access/certs`;
}

async function getJwksKeysByKid(env: Env): Promise<Map<string, JsonWebKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) {
    return jwksCache.keysByKid;
  }

  const url = resolveJwksUrl(env);
  if (!url) {
    throw new Error('Access JWT verification misconfigured: ACCESS_JWKS_URL or ACCESS_ISSUER required');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Access JWKS: ${response.status}`);
  }

  const body = await response.json() as { keys?: JsonWebKey[] };
  const keys = body.keys || [];
  const keysByKid = new Map<string, JsonWebKey>();
  for (const key of keys) {
    if (key.kid) keysByKid.set(key.kid, key);
  }

  jwksCache = {
    expiresAt: now + (5 * 60 * 1000),
    keysByKid
  };

  return keysByKid;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<AccessJwtPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Access JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart<AccessJwtHeader>(encodedHeader);
  const payload = decodeJwtPart<AccessJwtPayload>(encodedPayload);

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported Access JWT algorithm: ${header.alg || 'unknown'}`);
  }
  if (!header.kid) {
    throw new Error('Missing Access JWT kid');
  }

  const keysByKid = await getJwksKeysByKid(env);
  const jwk = keysByKid.get(header.kid);
  if (!jwk) {
    jwksCache = null;
    throw new Error('Unknown Access JWT key id');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlToBytes(encodedSignature);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signed);
  if (!ok) {
    throw new Error('Invalid Access JWT signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && now >= payload.exp) {
    throw new Error('Access JWT expired');
  }
  if (payload.nbf !== undefined && now < payload.nbf) {
    throw new Error('Access JWT not yet valid');
  }

  const expectedIssuer = normalizedIssuer(env.ACCESS_ISSUER);
  if (expectedIssuer) {
    const tokenIssuer = normalizedIssuer(payload.iss);
    if (!tokenIssuer || tokenIssuer !== expectedIssuer) {
      throw new Error('Invalid Access JWT issuer');
    }
  }

  if (env.ACCESS_AUD) {
    const aud = payload.aud;
    const okAud = Array.isArray(aud) ? aud.includes(env.ACCESS_AUD) : aud === env.ACCESS_AUD;
    if (!okAud) {
      throw new Error('Invalid Access JWT audience');
    }
  }

  return payload;
}

function hasIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const item of left) {
    if (right.has(item)) return true;
  }
  return false;
}

async function authenticateWithBearerToken(request: Request, env: Env): Promise<AuthContext | null> {
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  if (env.QUERY_ADMIN_TOKEN && token === env.QUERY_ADMIN_TOKEN) {
    return resolveAuthFromRoleIds(env, 'token:admin', undefined, [], ['admin'], 'local_password');
  }
  if (env.QUERY_ANALYST_TOKEN && token === env.QUERY_ANALYST_TOKEN) {
    return resolveAuthFromRoleIds(env, 'token:analyst', undefined, [], ['analyst'], 'local_password');
  }
  if (env.QUERY_VIEWER_TOKEN && token === env.QUERY_VIEWER_TOKEN) {
    return resolveAuthFromRoleIds(env, 'token:viewer', undefined, [], ['viewer'], 'local_password');
  }

  const sessionAuth = await verifySessionToken(token, env);
  if (sessionAuth) return sessionAuth;

  return null;
}

function hasConfiguredQueryBearerTokens(env: Env): boolean {
  return Boolean(env.QUERY_VIEWER_TOKEN || env.QUERY_ANALYST_TOKEN || env.QUERY_ADMIN_TOKEN);
}

function assertAccessJwtRuntimeConfig(env: Env): void {
  const errors = validateQueryAccessJwtConfig(env as unknown as Record<string, string | undefined>);
  if (errors.length === 0) return;
  throw new Error(`Access JWT configuration misconfigured: ${errors.join('; ')}`);
}

function localLoginEnabled(env: Env): boolean {
  const raw = (env.AUTH_ENABLE_LOCAL_LOGIN || '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return Boolean(env.AUTH_BOOTSTRAP_SUPERADMIN_PASSWORD || env.AUTH_BOOTSTRAP_PASSWORD);
}

async function resolveRoleIdsForUser(
  env: Env,
  user: UserRow,
  jwtGroups: string[]
): Promise<string[]> {
  const roleIds = new Set<string>();

  const directRoles = await env.DB.prepare(
    `SELECT role_id
     FROM user_roles
     WHERE user_id = ?`
  ).bind(user.id).all<UserRoleAssignmentRow>();
  for (const row of directRoles.results || []) {
    roleIds.add(row.role_id);
  }

  if (jwtGroups.length > 0) {
    const placeholders = jwtGroups.map(() => '?').join(', ');
    const mapped = await env.DB.prepare(
      `SELECT role_id
       FROM access_group_role_mappings
       WHERE access_group IN (${placeholders})`
    ).bind(...jwtGroups).all<{ role_id: string }>();
    for (const row of mapped.results || []) {
      roleIds.add(row.role_id);
    }
  }

  const email = String(user.email || '').toLowerCase();
  const adminEmails = parseCsvSet(env.ACCESS_ADMIN_EMAILS);
  if (email && adminEmails.has(email)) {
    roleIds.add('superadmin');
  }

  if (roleIds.size === 0 && user.role) {
    const legacyRole = ensureRoleId(String(user.role));
    roleIds.add(ROLE_PERMISSION_DEFAULTS[legacyRole] ? legacyRole : 'viewer');
  }

  return Array.from(roleIds);
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthContext> {
  assertAccessJwtRuntimeConfig(env);
  await ensureRbacInitialized(env);

  const tokenAuth = await authenticateWithBearerToken(request, env);
  if (tokenAuth) {
    return tokenAuth;
  }

  const requireJwt = (env.REQUIRE_ACCESS_JWT || '').toLowerCase() === 'true';
  if (requireJwt) {
    const jwt = request.headers.get('CF-Access-Jwt-Assertion');
    if (!jwt) {
      throw new Error('Missing Access JWT');
    }

    const payload = await verifyAccessJwt(jwt, env);
    const emailHeader = request.headers.get('CF-Access-Authenticated-User-Email') || undefined;
    const email = String(payload.email || emailHeader || '').toLowerCase() || undefined;
    const groups = Array.isArray(payload.groups) ? payload.groups.map((item) => String(item)) : [];
    if (!email) {
      throw new Error('Access JWT missing email');
    }

    let user = await env.DB.prepare(
      `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
       FROM users
       WHERE email = ?`
    ).bind(email).first<UserRow>();

    if (!user) {
      const adminEmails = parseCsvSet(env.ACCESS_ADMIN_EMAILS);
      if (!adminEmails.has(email)) {
        throw new Error('User is not invited');
      }
      const now = new Date().toISOString();
      const userId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
         VALUES (?, ?, '!access-sso-only!', 'superadmin', 1, ?, ?)`
      ).bind(userId, email, now, now).run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
         VALUES (?, 'superadmin', 'auto-admin-email', ?)`
      ).bind(userId, now).run();

      user = await env.DB.prepare(
        `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
         FROM users
         WHERE id = ?`
      ).bind(userId).first<UserRow>();
    }
    if (!user || user.enabled !== 1) {
      throw new Error('Access denied');
    }

    const roleIds = await resolveRoleIdsForUser(env, user, groups);
    const auth = await resolveAuthFromRoleIds(env, user.id, email, groups, roleIds, 'access_sso');
    await env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), new Date().toISOString(), user.id)
      .run();

    return auth;
  }

  if (hasConfiguredQueryBearerTokens(env)) {
    throw new Error('Unauthorized');
  }

  return resolveAuthFromRoleIds(env, 'dev-admin', 'dev-admin@local', [], ['superadmin'], 'local_password');
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compareUnknownValues(left: unknown, right: unknown): number {
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

function rowMatchesCondition(row: Record<string, unknown>, condition: PplCondition): boolean {
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

function applyPplFields(rows: Array<Record<string, unknown>>, fields: string[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const field of fields) {
      projected[field] = row[field] ?? null;
    }
    return projected;
  });
}

function applyPplSort(
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

function applyPplStatsCount(
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

function isPplTableQuery(stages: PplStage[]): boolean {
  return stages.some((stage) => TABLE_COMMANDS.has(stage.command));
}

function buildSearchRequestFromPpl(request: PplSearchRequest, pipeline: PplPipeline): SearchRequest {
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

async function loadLookupCache(
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

function applyPplPipelineStages(
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

async function executeSearchWithContext(
  context: SearchContext,
  env: Env,
  auth: AuthContext,
  cursor: { before_ts: string; before_event_id: string } | null | undefined,
  limit: number,
  timing = createTimingTracker()
): Promise<{ results: SearchEvent[]; scannedObjects: number; candidates: number; listing: ListingStatsSnapshot }> {
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

async function performSearch(request: SearchRequest, env: Env, auth: AuthContext): Promise<SearchResponse> {
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

async function performSearchSummary(request: SearchRequest, env: Env, auth: AuthContext): Promise<SearchSummaryResponse> {
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

async function performPplSearch(request: PplSearchRequest, env: Env, auth: AuthContext): Promise<PplSearchResponse> {
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

async function writeNdjsonLine(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  payload: Record<string, unknown>
): Promise<void> {
  await writer.write(encoder.encode(`${JSON.stringify(payload)}\n`));
}

async function streamPplSearch(
  request: PplSearchRequest,
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

async function performPplSearchSummary(
  request: PplSearchRequest,
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

async function executeWAESQL(sql: string, env: Env): Promise<WAERow[]> {
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function collectRecentEvents(
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

async function computeDashboardFallback(query: string, windowMinutes: number, env: Env, scope: DataScope): Promise<WAERow[]> {
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

function asPositiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function valuesAreSqlExact(values: string[]): boolean {
  return values.every((value) => value === '*' || !value.includes('*'));
}

function buildWaeScopeWhere(scope: DataScope): { whereSql: string; requiresFallback: boolean } {
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

async function handleDashboardQuery(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { query: string; params?: Record<string, unknown> };
  const query = String(body.query || '').trim();
  const params = body.params || {};
  const windowMinutes = asPositiveInt(params.window_minutes, 60, 24 * 60);
  const requestedIndex = typeof params.index === 'string'
    ? normalizeIndexValue(params.index)
    : undefined;
  const scope: DataScope = requestedIndex
    ? { ...auth.scope, indexes: [requestedIndex] }
    : auth.scope;

  if (requestedIndex && !matchesScopedValue(requestedIndex, auth.scope.indexes)) {
    return jsonResponse({ error: 'Forbidden: index outside role scope', results: [] }, 403, requestCorsHeaders);
  }

  if (!query) {
    return jsonResponse({ error: 'query is required', results: [] }, 400, requestCorsHeaders);
  }

  const scopeCacheKey = buildScopeCacheKey(scope);
  const cacheApi = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = '/__cache/dashboard-query';
  cacheKeyUrl.searchParams.set('query', query);
  cacheKeyUrl.searchParams.set('window_minutes', String(windowMinutes));
  if (requestedIndex) cacheKeyUrl.searchParams.set('index', requestedIndex);
  cacheKeyUrl.searchParams.set('scope', scopeCacheKey);
  const cacheRequest = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  if (cacheApi) {
    const cached = await cacheApi.match(cacheRequest);
    if (cached) {
      const cachedBody = await cached.json() as {
        results: Array<Record<string, unknown>>;
        source?: string;
        warning?: string;
      };
      return jsonResponse({
        ...cachedBody,
        cache: 'hit'
      }, 200, requestCorsHeaders);
    }
  }

  const scopeSql = buildWaeScopeWhere(scope);

  const templates: Record<string, string> = {
    error_rate_by_service: `
      SELECT
        blob1 AS service,
        SUM(CASE WHEN blob4 = 'error' THEN double1 ELSE 0 END) AS errors,
        SUM(double1) AS total,
        100.0 * SUM(CASE WHEN blob4 = 'error' THEN double1 ELSE 0 END) / NULLIF(SUM(double1), 0) AS error_rate
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${scopeSql.whereSql}
      GROUP BY service
      ORDER BY error_rate DESC
      LIMIT 20
    `,
    latency_p95_by_service: `
      SELECT
        blob1 AS service,
        APPROX_PERCENTILE(double3, 0.95) AS p95_latency
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
        AND double3 > 0
      ${scopeSql.whereSql}
      GROUP BY service
      ORDER BY p95_latency DESC
      LIMIT 20
    `,
    top_errors: `
      SELECT
        blob1 AS service,
        blob5 AS msg_hash,
        SUM(double1) AS count
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
        AND blob4 = 'error'
      ${scopeSql.whereSql}
      GROUP BY service, msg_hash
      ORDER BY count DESC
      LIMIT 20
    `,
    throughput: `
      SELECT
        blob1 AS service,
        SUM(double1) AS count
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${scopeSql.whereSql}
      GROUP BY service
      ORDER BY count DESC
      LIMIT 20
    `,
    top_hosts: `
      SELECT
        blob3 AS host,
        SUM(double1) AS count
      FROM log_metrics
      WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} MINUTE'
      ${scopeSql.whereSql}
      GROUP BY host
      ORDER BY count DESC
      LIMIT 20
    `
  };

  const sql = templates[query];
  if (!sql) {
    return jsonResponse({ error: 'Unknown query', results: [] }, 400, requestCorsHeaders);
  }

  try {
    if (scopeSql.requiresFallback) {
      throw new Error('Scope requires fallback execution');
    }
    const results = await executeWAESQL(sql, env);
    const payload = { results, source: 'wae', cache: 'miss' };
    if (cacheApi) {
      await cacheApi.put(cacheRequest, new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${DASHBOARD_QUERY_CACHE_TTL_SECONDS}`
        }
      })).catch(() => undefined);
    }
    return jsonResponse(payload, 200, requestCorsHeaders);
  } catch (error) {
    const fallbackResults = await computeDashboardFallback(query, windowMinutes, env, scope);
    const payload = {
      results: fallbackResults,
      source: 'events_fallback',
      warning: String(error),
      cache: 'miss'
    };
    if (cacheApi) {
      await cacheApi.put(cacheRequest, new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${DASHBOARD_QUERY_CACHE_TTL_SECONDS}`
        }
      })).catch(() => undefined);
    }
    return jsonResponse(payload, 200, requestCorsHeaders);
  }
}

async function handleDashboardWidgetQuery(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as (PplSearchRequest & { widget_id?: string });
  const req: PplSearchRequest = {
    time: body.time,
    ppl: String(body.ppl || '').trim(),
    limit: Math.max(1, Math.min(2000, Number(body.limit) || 500)),
    cursor: body.cursor || null
  };
  if (!req.time || !req.time.from || !req.time.to || !req.ppl) {
    return jsonResponse({ error: 'time.from, time.to, and ppl are required' }, 400, requestCorsHeaders);
  }
  const widgetId = body.widget_id ? String(body.widget_id) : null;
  const policy = widgetId
    ? (await loadDashboardPanelPolicies(env, [widgetId])).get(widgetId) || DEFAULT_EXECUTION_POLICY
    : DEFAULT_EXECUTION_POLICY;
  const cacheKey = buildDashboardWidgetCacheKey(req, auth.scope, widgetId);
  const cacheKeyHash = hashCacheKey(cacheKey);
  const toMs = Date.parse(req.time.to);
  const cacheBucket = Number.isFinite(toMs) ? Math.floor(toMs / (DASHBOARD_QUERY_CACHE_BUCKET_SECONDS * 1000)) : null;
  const materialized = widgetId ? await readMaterializedWidgetResult(env, req, auth.scope, widgetId, policy) : null;
  if (materialized) {
    return jsonResponse(
      {
        ...materialized,
        cache: 'miss',
        cache_debug: {
          key_hash: cacheKeyHash,
          bucket: cacheBucket,
          bucket_seconds: DASHBOARD_QUERY_CACHE_BUCKET_SECONDS,
          ttl_seconds: policy.cache_ttl_seconds
        }
      },
      200,
      { ...requestCorsHeaders, 'x-edgedata-cache': 'materialized' }
    );
  }
  if (isWidgetCacheEnabled(policy)) {
    const cached = await getDashboardCachePayload(env, cacheKey);
    if (cached.hit && cached.payload) {
      await writeScanMetrics(env, 'dashboard_widget', {
        scanned_partitions: cached.payload.stats.scanned_partitions,
        scanned_objects: cached.payload.stats.scanned_objects,
        listed_prefixes: cached.payload.stats.listed_prefixes,
        listing_calls: cached.payload.stats.listing_calls,
        listed_objects: cached.payload.stats.listed_objects,
        listing_fallbacks: cached.payload.stats.listing_fallbacks,
        timing_ms: cached.payload.stats.timing_ms
      }).catch(() => undefined);
      return jsonResponse(
        {
          ...cached.payload,
          source: cached.payload.source || 'cache',
          cache: 'hit',
          cache_debug: {
            key_hash: cacheKeyHash,
            bucket: cacheBucket,
            bucket_seconds: DASHBOARD_QUERY_CACHE_BUCKET_SECONDS,
            ttl_seconds: policy.cache_ttl_seconds
          }
        },
        200,
        { ...requestCorsHeaders, 'x-edgedata-cache': 'hit' }
      );
    }
  }
  const response = await performPplSearch(req, env, auth);
  response.source = 'live';
  response.materialization_status = policy.materialize_enabled ? 'miss' : 'disabled';
  await writeScanMetrics(env, 'dashboard_widget', {
    scanned_partitions: response.stats.scanned_partitions,
    scanned_objects: response.stats.scanned_objects,
    listed_prefixes: response.stats.listed_prefixes,
    listing_calls: response.stats.listing_calls,
    listed_objects: response.stats.listed_objects,
    listing_fallbacks: response.stats.listing_fallbacks,
    timing_ms: response.stats.timing_ms
  }).catch(() => undefined);
  if (isWidgetCacheEnabled(policy)) {
    await setDashboardCachePayload(env, cacheKey, response, policy.cache_ttl_seconds);
  }
  return jsonResponse(
    {
      ...response,
      cache: 'miss',
      cache_debug: {
        key_hash: cacheKeyHash,
        bucket: cacheBucket,
        bucket_seconds: DASHBOARD_QUERY_CACHE_BUCKET_SECONDS,
        ttl_seconds: policy.cache_ttl_seconds
      }
    },
    200,
    { ...requestCorsHeaders, 'x-edgedata-cache': 'miss' }
  );
}

function normalizeJsonInput(input: unknown, fallback: string): string {
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

const DASHBOARD_WIDGET_TYPES: DashboardWidgetType[] = ['timeseries', 'bar', 'pie', 'table', 'kpi', 'topn', 'markdown'];
const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  execution_mode: 'live',
  cache_ttl_seconds: 120,
  materialize_enabled: false,
  materialize_interval_seconds: 300,
  max_staleness_seconds: 600,
  priority: 0
};

function mapLegacyVizToWidgetType(vizType: string | null | undefined): DashboardWidgetType {
  const value = String(vizType || 'table').toLowerCase();
  if (value === 'counter' || value === 'stat') return 'kpi';
  if (value === 'timechart') return 'timeseries';
  if (value === 'top') return 'topn';
  if ((DASHBOARD_WIDGET_TYPES as string[]).includes(value)) return value as DashboardWidgetType;
  return 'table';
}

function mapWidgetTypeToLegacyViz(widgetType: DashboardWidgetType): string {
  if (widgetType === 'timeseries') return 'timechart';
  if (widgetType === 'kpi') return 'stat';
  if (widgetType === 'topn') return 'bar';
  return widgetType;
}

function normalizeWidgetType(value: unknown): DashboardWidgetType {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'table';
  if (raw === 'counter' || raw === 'stat') return 'kpi';
  if (raw === 'timechart') return 'timeseries';
  if ((DASHBOARD_WIDGET_TYPES as string[]).includes(raw)) return raw as DashboardWidgetType;
  return 'table';
}

function defaultLayoutForPanel(position: number, widgetType: DashboardWidgetType): string {
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

function parseJsonObject(input: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
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

function parseJsonRecordArray(input: unknown): Record<string, unknown>[] {
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

function normalizeDashboardPanelRow(row: DashboardPanelRow): Record<string, unknown> {
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

function normalizeDashboardRow(row: DashboardRow): Record<string, unknown> {
  return {
    ...row,
    performance_profile: normalizePerformanceProfile(row.performance_profile, 'economy') as PerformanceProfile,
    default_execution_mode: normalizeExecutionMode(row.default_execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode) as ExecutionMode
  };
}

function normalizeScheduledSearchRow(row: ScheduledSearchRow): Record<string, unknown> {
  return {
    ...row,
    execution_mode: normalizeExecutionMode(row.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode),
    cache_ttl_seconds: normalizeCacheTtlSeconds(row.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds),
    materialize_enabled: normalizeBooleanFlag(row.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled),
    materialize_interval_seconds: normalizeMaterializeIntervalSeconds(row.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds),
    max_staleness_seconds: normalizeMaxStalenessSeconds(row.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds)
  };
}

function normalizeScheduledSearchResultRow(
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

const DASHBOARD_QUERY_CACHE_TTL_SECONDS = 120;
const DASHBOARD_QUERY_CACHE_BUCKET_SECONDS = 120;

function buildScopeCacheKey(scope: DataScope): string {
  return buildScopeKey(scope);
}

function asDashboardCacheShardCount(env: Env): number {
  const parsed = Number(env.DASHBOARD_CACHE_SHARDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 16;
  return Math.min(256, Math.max(1, Math.trunc(parsed)));
}

function getDashboardCacheStub(env: Env, key: string): DurableObjectStub {
  const shardName = cacheShardNameForKey(key, asDashboardCacheShardCount(env));
  return env.DASHBOARD_CACHE.get(env.DASHBOARD_CACHE.idFromName(shardName));
}

function normalizeExecutionPolicyRow(row: {
  execution_mode?: string | null;
  cache_ttl_seconds?: number | null;
  materialize_enabled?: number | boolean | null;
  materialize_interval_seconds?: number | null;
  max_staleness_seconds?: number | null;
  priority?: number | null;
}): ExecutionPolicy {
  return {
    execution_mode: normalizeExecutionMode(row.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode) as ExecutionMode,
    cache_ttl_seconds: normalizeCacheTtlSeconds(row.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds),
    materialize_enabled: normalizeBooleanFlag(row.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled),
    materialize_interval_seconds: normalizeMaterializeIntervalSeconds(row.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds),
    max_staleness_seconds: normalizeMaxStalenessSeconds(row.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds),
    priority: Number.isFinite(Number(row.priority)) ? Math.max(0, Math.trunc(Number(row.priority))) : DEFAULT_EXECUTION_POLICY.priority
  };
}

function isWidgetCacheEnabled(policy: ExecutionPolicy): boolean {
  return policy.execution_mode !== 'live' || policy.materialize_enabled;
}

async function loadDashboardPanelPolicies(
  env: Env,
  widgetIds: string[]
): Promise<Map<string, ExecutionPolicy>> {
  const ids = Array.from(new Set(widgetIds.map((value) => String(value || '').trim()).filter(Boolean)));
  const policies = new Map<string, ExecutionPolicy>();
  if (ids.length === 0) return policies;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT id, execution_mode, cache_ttl_seconds, materialize_enabled, materialize_interval_seconds, max_staleness_seconds, priority
     FROM dashboard_panels
     WHERE id IN (${placeholders})`
  ).bind(...ids).all<DashboardPanelRow>();

  for (const row of rows.results || []) {
    policies.set(row.id, normalizeExecutionPolicyRow(row));
  }

  return policies;
}

async function readMaterializedWidgetResult(
  env: Env,
  req: PplSearchRequest,
  scope: DataScope,
  widgetId: string,
  policy: ExecutionPolicy
): Promise<PplSearchResponse | null> {
  if (!policy.materialize_enabled && policy.execution_mode !== 'materialized') {
    return null;
  }

  const bucket = buildMaterializationBucket(req.time, policy.materialize_interval_seconds);
  const scopeKey = buildScopeCacheKey(scope);
  const queryHash = hashQueryText(req.ppl);
  const row = await env.DB.prepare(
    `SELECT *
     FROM materialized_results
     WHERE entity_type = 'dashboard_panel'
       AND entity_id = ?
       AND scope_key = ?
       AND query_hash = ?
       AND time_bucket_start = ?
       AND time_bucket_end = ?
     ORDER BY computed_at DESC
     LIMIT 1`
  ).bind(widgetId, scopeKey, queryHash, bucket.time_bucket_start, bucket.time_bucket_end).first<MaterializedResultRow>();

  if (!row?.payload_inline_json) return null;

  let payload: PplSearchResponse;
  try {
    payload = JSON.parse(row.payload_inline_json) as PplSearchResponse;
  } catch {
    return null;
  }

  const computedAtMs = Date.parse(row.computed_at);
  const expiresAtMs = Date.parse(row.expires_at);
  const now = Date.now();
  if (!Number.isFinite(computedAtMs) || !Number.isFinite(expiresAtMs)) return null;

  const freshnessBudgetMs = policy.max_staleness_seconds * 1000;
  const isFresh = expiresAtMs > now;
  const isStaleButAllowed = computedAtMs + freshnessBudgetMs > now;
  if (!isFresh && !isStaleButAllowed) return null;

  return {
    ...payload,
    source: isFresh ? 'materialized' : 'stale_materialized',
    computed_at: row.computed_at,
    expires_at: row.expires_at,
    materialization_status: isFresh ? 'fresh' : 'stale'
  };
}

function normalizePplForCache(ppl: string): string {
  return ppl.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildDashboardWidgetCacheKey(req: PplSearchRequest, scope: DataScope, widgetId: string | null): string {
  const fromMs = Date.parse(req.time.from);
  const toMs = Date.parse(req.time.to);
  const windowMs = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs ? toMs - fromMs : 0;
  const toBucket = Number.isFinite(toMs) ? Math.floor(toMs / (DASHBOARD_QUERY_CACHE_BUCKET_SECONDS * 1000)) : 0;
  return [
    `wid:${widgetId || '_'}`,
    `ppl:${normalizePplForCache(req.ppl)}`,
    `wm:${windowMs}`,
    `tb:${toBucket}`,
    `sc:${buildScopeCacheKey(scope)}`
  ].join('|');
}

function intersectSharedFilters(filtersList: SearchFilters[]): SearchFilters {
  if (filtersList.length === 0) return {};
  const keys = new Set<string>(Object.keys(filtersList[0]));
  for (let i = 1; i < filtersList.length; i++) {
    for (const key of Array.from(keys)) {
      if (!(key in filtersList[i]) || filtersList[i][key as keyof SearchFilters] !== filtersList[0][key as keyof SearchFilters]) {
        keys.delete(key);
      }
    }
  }
  const shared: SearchFilters = {};
  for (const key of keys) {
    const value = filtersList[0][key as keyof SearchFilters];
    if (value !== undefined) {
      shared[key as keyof SearchFilters] = value as never;
    }
  }
  return shared;
}

function canShareDashboardWidgetBase(
  compiledRequests: SearchRequest[],
  sharedFilters: SearchFilters
): boolean {
  if (compiledRequests.length <= 1) return false;
  const firstQ = compiledRequests[0]?.q || '';
  if (!compiledRequests.every((req) => (req.q || '') === firstQ)) return false;
  return Boolean(sharedFilters.index || sharedFilters.service || firstQ.trim());
}

async function executeSharedDashboardWidgetGroup(
  widgets: Array<{ widgetId: string; request: PplSearchRequest; pipeline: PplPipeline; compiled: SearchRequest }>,
  env: Env,
  auth: AuthContext
): Promise<Record<string, DashboardBatchWidgetResult>> {
  const results: Record<string, DashboardBatchWidgetResult> = {};
  const sharedFilters = intersectSharedFilters(widgets.map((widget) => widget.compiled.filters || {}));
  if (!canShareDashboardWidgetBase(widgets.map((widget) => widget.compiled), sharedFilters)) {
    for (const widget of widgets) {
      try {
        results[widget.widgetId] = { response: await performPplSearch(widget.request, env, auth) };
      } catch (error) {
        results[widget.widgetId] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return results;
  }

  const baseRequest: SearchRequest = {
    time: widgets[0].request.time,
    q: widgets[0].compiled.q,
    filters: sharedFilters,
    limit: MAX_SUMMARY_EVENTS,
    cursor: null
  };
  const sharedStartedAt = Date.now();
  const timing = createTimingTracker();
  const baseContext = buildSearchContext(baseRequest, auth);
  const baseExecution = await executeSearchWithContext(baseContext, env, auth, null, MAX_SUMMARY_EVENTS, timing);

  for (const widget of widgets) {
    try {
      const postPipelineStartedAt = Date.now();
      const lookupCache = await loadLookupCache(widget.pipeline, env);
      const transformed = applyPplPipelineStages(baseExecution.results, widget.pipeline, lookupCache);
      const widgetTiming: TimingTracker = {
        ...timing,
        postPipelineMs: timing.postPipelineMs + (Date.now() - postPipelineStartedAt)
      };
      const requestedLimit = clampLimit(widget.request.limit, PPL_MAX_LIMIT);
      const rows = transformed.rows.slice(0, requestedLimit);
      const nextCursorValue = transformed.resultType === 'events'
        ? nextCursor(rows as SearchEvent[])
        : null;
      results[widget.widgetId] = {
        response: {
          result_type: transformed.resultType,
          results: rows,
          next_cursor: nextCursorValue,
          source: 'live',
          materialization_status: 'disabled',
          stats: {
            mode: baseContext.mode,
            scanned_partitions: baseContext.dates.length,
            scanned_objects: baseExecution.scannedObjects,
            listed_prefixes: baseExecution.listing.listed_prefixes,
            listing_calls: baseExecution.listing.listing_calls,
            listed_objects: baseExecution.listing.listed_objects,
            listing_fallbacks: baseExecution.listing.listing_fallbacks,
            candidates: baseExecution.candidates,
            returned: rows.length,
            execution_path: 'shared_base',
            timing_ms: snapshotTimingTracker(widgetTiming, Date.now() - sharedStartedAt),
            language: 'ppl',
            stage_count: widget.pipeline.stages.length
          },
          warning: baseExecution.results.length >= MAX_SUMMARY_EVENTS && isPplTableQuery(widget.pipeline.stages)
            ? `PPL pipeline evaluated on first ${MAX_SUMMARY_EVENTS} matched events`
            : undefined
        }
      };
    } catch (error) {
      results[widget.widgetId] = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return results;
}

async function handleDashboardWidgetBatchQuery(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { time?: { from?: string; to?: string }; widgets?: DashboardBatchWidgetRequest[] };
  const time = body.time;
  const widgets = Array.isArray(body.widgets) ? body.widgets : [];
  if (!time?.from || !time?.to || widgets.length === 0) {
    return jsonResponse({ error: 'time.from, time.to, and widgets are required' }, 400, requestCorsHeaders);
  }

  const payloads: Record<string, DashboardBatchWidgetResult> = {};
  const pendingGroups = new Map<string, Array<{ widgetId: string; request: PplSearchRequest; pipeline: PplPipeline; compiled: SearchRequest }>>();
  const policyByWidgetId = await loadDashboardPanelPolicies(
    env,
    widgets.map((widget) => String(widget.widget_id || '').trim())
  );

  for (const widget of widgets) {
    const widgetId = String(widget.widget_id || '').trim();
    const ppl = String(widget.ppl || '').trim();
    if (!widgetId || !ppl) {
      if (widgetId) payloads[widgetId] = { error: 'widget_id and ppl are required' };
      continue;
    }
    const req: PplSearchRequest = {
      time,
      ppl,
      limit: Math.max(1, Math.min(2000, Number(widget.limit) || 500)),
      cursor: null
    };
    const policy = policyByWidgetId.get(widgetId) || DEFAULT_EXECUTION_POLICY;
    const cacheKey = buildDashboardWidgetCacheKey(req, auth.scope, widgetId);
    const materialized = await readMaterializedWidgetResult(env, req, auth.scope, widgetId, policy);
    if (materialized) {
      payloads[widgetId] = { response: materialized };
      continue;
    }
    if (isWidgetCacheEnabled(policy)) {
      const cached = await getDashboardCachePayload(env, cacheKey);
      if (cached.hit && cached.payload) {
        payloads[widgetId] = {
          response: {
            ...cached.payload,
            source: cached.payload.source || 'cache'
          }
        };
        continue;
      }
    }

    try {
      const pipeline = parsePplPipeline(req.ppl) as PplPipeline;
      const compiled = buildSearchRequestFromPpl(req, pipeline);
      const groupKey = JSON.stringify({
        q: compiled.q || '',
        index: compiled.filters?.index || '',
        service: compiled.filters?.service || '',
        env: compiled.filters?.env || ''
      });
      const group = pendingGroups.get(groupKey) || [];
      group.push({ widgetId, request: req, pipeline, compiled });
      pendingGroups.set(groupKey, group);
    } catch (error) {
      payloads[widgetId] = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  for (const group of pendingGroups.values()) {
    const groupResults = await executeSharedDashboardWidgetGroup(group, env, auth);
    for (const [widgetId, result] of Object.entries(groupResults)) {
      payloads[widgetId] = result;
      if (result.response) {
        const req = group.find((item) => item.widgetId === widgetId)?.request;
        const policy = policyByWidgetId.get(widgetId) || DEFAULT_EXECUTION_POLICY;
        if (req) {
          const cacheKey = buildDashboardWidgetCacheKey(req, auth.scope, widgetId);
          result.response.source = result.response.source || 'live';
          result.response.materialization_status = result.response.materialization_status || (policy.materialize_enabled ? 'miss' : 'disabled');
          if (isWidgetCacheEnabled(policy)) {
            await setDashboardCachePayload(env, cacheKey, result.response, policy.cache_ttl_seconds);
          }
        }
        await writeScanMetrics(env, 'dashboard_widget', {
          scanned_partitions: result.response.stats.scanned_partitions,
          scanned_objects: result.response.stats.scanned_objects,
          listed_prefixes: result.response.stats.listed_prefixes,
          listing_calls: result.response.stats.listing_calls,
          listed_objects: result.response.stats.listed_objects,
          listing_fallbacks: result.response.stats.listing_fallbacks,
          timing_ms: result.response.stats.timing_ms
        }).catch(() => undefined);
      }
    }
  }

  return jsonResponse({ widgets: payloads }, 200, requestCorsHeaders);
}

function hashCacheKey(raw: string): string {
  // Deterministic lightweight hash for debug visibility.
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function getDashboardCachePayload(
  env: Env,
  key: string
): Promise<{ hit: boolean; payload?: PplSearchResponse }> {
  try {
    const stub = getDashboardCacheStub(env, key);
    const response = await stub.fetch(`https://dashboard-cache/cache/get?key=${encodeURIComponent(key)}`);
    if (!response.ok) return { hit: false };
    const body = await response.json() as { hit?: boolean; payload?: PplSearchResponse };
    if (!body.hit || !body.payload) return { hit: false };
    return { hit: true, payload: body.payload };
  } catch {
    return { hit: false };
  }
}

async function setDashboardCachePayload(
  env: Env,
  key: string,
  payload: PplSearchResponse,
  ttlSeconds = DASHBOARD_QUERY_CACHE_TTL_SECONDS
): Promise<void> {
  try {
    const stub = getDashboardCacheStub(env, key);
    await stub.fetch('https://dashboard-cache/cache/set', {
      method: 'POST',
      body: JSON.stringify({
        key,
        ttl_seconds: normalizeCacheTtlSeconds(ttlSeconds, DASHBOARD_QUERY_CACHE_TTL_SECONDS),
        payload
      })
    });
  } catch {
    // cache failures are non-fatal
  }
}

async function handleAlerts(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;

  if (request.method === 'GET' && pathname === '/alerts/starter-pack') {
    assertPermission(auth, 'alert.read');
    const templates = buildStarterAlertPackDefinitions({}).map((template) => ({
      starter_id: template.starter_id,
      name: template.name,
      type: template.type,
      query_template: template.query_template,
      params_json: template.params_json,
      threshold_json: template.threshold_json,
      notify_json: template.notify_json,
      schedule_seconds: template.schedule_seconds,
      cooldown_seconds: template.cooldown_seconds
    }));
    return jsonResponse({ templates }, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/alerts/starter-pack/apply') {
    assertPermission(auth, 'alert.write');
    const body = await request.json().catch(() => ({})) as StarterAlertApplyRequest;
    const templates = buildStarterAlertPackDefinitions(body || {});
    const existingRows = await env.DB.prepare(
      `SELECT id, name, params_json
       FROM alerts
       ORDER BY created_at DESC
       LIMIT 1000`
    ).all<{ id: string; name: string; params_json: string }>();

    const existingByStarterId = new Map<string, { id: string; name: string }>();
    for (const row of existingRows.results || []) {
      const starterId = extractStarterIdFromParamsJson(row.params_json);
      if (!starterId) continue;
      if (!existingByStarterId.has(starterId)) {
        existingByStarterId.set(starterId, { id: row.id, name: row.name });
      }
    }

    const inserted: Array<{ starter_id: string; id: string; name: string }> = [];
    const existing: Array<{ starter_id: string; id: string; name: string }> = [];
    const now = new Date().toISOString();

    for (const template of templates) {
      const existingRow = existingByStarterId.get(template.starter_id);
      if (existingRow) {
        existing.push({ starter_id: template.starter_id, id: existingRow.id, name: existingRow.name });
        continue;
      }

      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO alerts (
          id, name, enabled, type, query_template, params_json,
          schedule_seconds, threshold_json, notify_json, cooldown_seconds, created_by,
          created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        template.name,
        template.type,
        template.query_template,
        template.params_json,
        template.schedule_seconds,
        template.threshold_json,
        template.notify_json,
        template.cooldown_seconds,
        principal,
        now,
        now
      ).run();

      inserted.push({ starter_id: template.starter_id, id, name: template.name });
    }

    await writeAuditLog(env, auth, 'alert.starter_pack.applied', 'alert', undefined, {
      inserted_count: inserted.length,
      existing_count: existing.length
    }).catch(() => undefined);

    return jsonResponse({
      ok: true,
      inserted_count: inserted.length,
      existing_count: existing.length,
      inserted,
      existing
    }, 200, requestCorsHeaders);
  }

  if (request.method === 'GET' && pathname === '/alerts') {
    assertPermission(auth, 'alert.read');
    const rows = await env.DB.prepare(
      `SELECT id, name, enabled, type, query_template, params_json, schedule_seconds,
              threshold_json, notify_json, cooldown_seconds, created_by, created_at, updated_at
       FROM alerts
       ORDER BY created_at DESC
       LIMIT 200`
    ).all<AlertRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/alerts') {
    assertPermission(auth, 'alert.write');
    const body = await request.json() as Partial<AlertRow>;
    const name = String(body.name || '').trim();
    const type = String(body.type || '').trim();
    const queryTemplate = String(body.query_template || '').trim();

    if (!name || !type || !queryTemplate) {
      return jsonResponse({ error: 'name, type, and query_template are required' }, 400, requestCorsHeaders);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const enabled = body.enabled === 0 ? 0 : 1;
    const scheduleSeconds = asPositiveInt(body.schedule_seconds, 60, 7 * 24 * 3600);
    const cooldownSeconds = asPositiveInt(body.cooldown_seconds, 300, 7 * 24 * 3600);
    const paramsJson = normalizeJsonInput(body.params_json, '{}');
    const thresholdJson = normalizeJsonInput(body.threshold_json, '{"operator":"gt","value":0}');
    const notifyJson = normalizeJsonInput(body.notify_json, '{}');

    await env.DB.prepare(
      `INSERT INTO alerts (
        id, name, enabled, type, query_template, params_json,
        schedule_seconds, threshold_json, notify_json, cooldown_seconds, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      name,
      enabled,
      type,
      queryTemplate,
      paramsJson,
      scheduleSeconds,
      thresholdJson,
      notifyJson,
      cooldownSeconds,
      principal,
      now,
      now
    ).run();

    return jsonResponse({
      id,
      name,
      enabled,
      type,
      query_template: queryTemplate,
      params_json: paramsJson,
      schedule_seconds: scheduleSeconds,
      threshold_json: thresholdJson,
      notify_json: notifyJson,
      cooldown_seconds: cooldownSeconds,
      created_by: principal,
      created_at: now,
      updated_at: now
    }, 201, requestCorsHeaders);
  }

  if (pathname.startsWith('/alerts/')) {
    const id = pathname.split('/').pop();
    if (!id) return jsonResponse({ error: 'Invalid alert id' }, 400, requestCorsHeaders);

    if (request.method === 'PUT') {
      assertPermission(auth, 'alert.write');
      const body = await request.json() as Partial<AlertRow>;
      const existing = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?').bind(id).first<AlertRow>();
      if (!existing) {
        return jsonResponse({ error: 'Alert not found' }, 404, requestCorsHeaders);
      }

      const now = new Date().toISOString();
      const name = String(body.name ?? existing.name).trim();
      const type = String(body.type ?? existing.type).trim();
      const queryTemplate = String(body.query_template ?? existing.query_template).trim();
      const enabled = body.enabled === undefined ? existing.enabled : (body.enabled === 0 ? 0 : 1);
      const scheduleSeconds = body.schedule_seconds === undefined
        ? existing.schedule_seconds
        : asPositiveInt(body.schedule_seconds, existing.schedule_seconds, 7 * 24 * 3600);
      const cooldownSeconds = body.cooldown_seconds === undefined
        ? existing.cooldown_seconds
        : asPositiveInt(body.cooldown_seconds, existing.cooldown_seconds, 7 * 24 * 3600);
      const paramsJson = body.params_json === undefined
        ? existing.params_json
        : normalizeJsonInput(body.params_json, existing.params_json);
      const thresholdJson = body.threshold_json === undefined
        ? existing.threshold_json
        : normalizeJsonInput(body.threshold_json, existing.threshold_json);
      const notifyJson = body.notify_json === undefined
        ? existing.notify_json
        : normalizeJsonInput(body.notify_json, existing.notify_json);

      await env.DB.prepare(
        `UPDATE alerts
         SET name = ?, enabled = ?, type = ?, query_template = ?, params_json = ?,
             schedule_seconds = ?, threshold_json = ?, notify_json = ?, cooldown_seconds = ?,
             updated_at = ?
         WHERE id = ?`
      ).bind(
        name,
        enabled,
        type,
        queryTemplate,
        paramsJson,
        scheduleSeconds,
        thresholdJson,
        notifyJson,
        cooldownSeconds,
        now,
        id
      ).run();

      return jsonResponse({
        id,
        name,
        enabled,
        type,
        query_template: queryTemplate,
        params_json: paramsJson,
        schedule_seconds: scheduleSeconds,
        threshold_json: thresholdJson,
        notify_json: notifyJson,
        cooldown_seconds: cooldownSeconds,
        created_by: existing.created_by || principal,
        updated_at: now
      }, 200, requestCorsHeaders);
    }

    if (request.method === 'DELETE') {
      assertPermission(auth, 'alert.delete');
      await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM alert_state WHERE alert_id = ?').bind(id).run();
      return new Response(null, { status: 204, headers: requestCorsHeaders });
    }
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleSavedSearches(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;

  if (request.method === 'GET' && pathname === '/saved-searches') {
    assertPermission(auth, 'saved_search.read');
    if (auth.role === 'admin' || auth.role === 'superadmin') {
      const rows = await env.DB.prepare(
        'SELECT id, name, query, created_by, created_at, updated_at FROM saved_searches ORDER BY created_at DESC LIMIT 100'
      ).all<SavedSearchRow>();
      return jsonResponse(rows.results || [], 200, requestCorsHeaders);
    }

    const rows = await env.DB.prepare(
      `SELECT id, name, query, created_by, created_at, updated_at
       FROM saved_searches
       WHERE created_by = ? OR created_by IS NULL
       ORDER BY created_at DESC
       LIMIT 100`
    ).bind(principal).all<SavedSearchRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/saved-searches') {
    assertPermission(auth, 'saved_search.write');
    const body = await request.json() as { name?: string; query?: string };
    const name = (body.name || '').trim();
    const query = (body.query || '').trim();

    if (!name || !query) {
      return jsonResponse({ error: 'name and query are required' }, 400, requestCorsHeaders);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      'INSERT INTO saved_searches (id, name, query, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, name, query, principal, now, now).run();

    return jsonResponse({ id, name, query, created_by: principal, created_at: now, updated_at: now }, 201, requestCorsHeaders);
  }

  if (pathname.startsWith('/saved-searches/')) {
    const id = pathname.split('/').pop();
    if (!id) return jsonResponse({ error: 'Invalid saved search id' }, 400, requestCorsHeaders);

    if (request.method === 'PUT') {
      assertPermission(auth, 'saved_search.write');
      const body = await request.json() as { name?: string; query?: string };
      const name = (body.name || '').trim();
      const query = (body.query || '').trim();
      if (!name || !query) {
        return jsonResponse({ error: 'name and query are required' }, 400, requestCorsHeaders);
      }

      const existing = await env.DB.prepare('SELECT id, created_by FROM saved_searches WHERE id = ?')
        .bind(id)
        .first<{ id: string; created_by?: string | null }>();
      if (!existing) {
        return jsonResponse({ error: 'Saved search not found' }, 404, requestCorsHeaders);
      }
      if (auth.role !== 'admin' && auth.role !== 'superadmin' && existing.created_by && existing.created_by !== principal) {
        throw new Error('Forbidden');
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE saved_searches SET name = ?, query = ?, updated_at = ? WHERE id = ?'
      ).bind(name, query, now, id).run();

      return jsonResponse({ id, name, query, updated_at: now }, 200, requestCorsHeaders);
    }

    if (request.method === 'DELETE') {
      assertPermission(auth, 'saved_search.delete');
      const existing = await env.DB.prepare('SELECT id, created_by FROM saved_searches WHERE id = ?')
        .bind(id)
        .first<{ id: string; created_by?: string | null }>();
      if (!existing) {
        return new Response(null, { status: 204, headers: requestCorsHeaders });
      }
      if (auth.role !== 'admin' && auth.role !== 'superadmin' && existing.created_by && existing.created_by !== principal) {
        throw new Error('Forbidden');
      }

      await env.DB.prepare('DELETE FROM saved_searches WHERE id = ?').bind(id).run();
      return new Response(null, { status: 204, headers: requestCorsHeaders });
    }
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleScheduledSearches(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;
  const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
  const loadAccessibleScheduledSearch = async (id: string): Promise<ScheduledSearchRow | null> => {
    const search = await env.DB.prepare('SELECT * FROM scheduled_searches WHERE id = ?')
      .bind(id)
      .first<ScheduledSearchRow>();
    if (!search) return null;
    if (!isAdmin && search.created_by && search.created_by !== principal) {
      throw new Error('Forbidden');
    }
    return search;
  };

  const loadScheduledSearchRun = async (searchId: string, runId: string): Promise<ScheduledSearchResultRow | null> => {
    const row = await env.DB.prepare(
      'SELECT * FROM scheduled_search_results WHERE id = ? AND scheduled_search_id = ?'
    ).bind(runId, searchId).first<ScheduledSearchResultRow>();
    return row || null;
  };

  if (request.method === 'GET' && pathname === '/scheduled-searches') {
    assertPermission(auth, 'scheduled_search.read');
    const rows = isAdmin
      ? await env.DB.prepare(
          'SELECT * FROM scheduled_searches ORDER BY created_at DESC LIMIT 100'
        ).all<ScheduledSearchRow>()
      : await env.DB.prepare(
          'SELECT * FROM scheduled_searches WHERE created_by = ? OR created_by IS NULL ORDER BY created_at DESC LIMIT 100'
        ).bind(principal).all<ScheduledSearchRow>();
    return jsonResponse((rows.results || []).map(normalizeScheduledSearchRow), 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/scheduled-searches') {
    assertPermission(auth, 'scheduled_search.write');
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const ppl = String(body.ppl || '').trim();
    if (!name || !ppl) {
      return jsonResponse({ error: 'name and ppl are required' }, 400, requestCorsHeaders);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const timeWindowMinutes = Math.max(1, Math.min(10080, Number(body.time_window_minutes) || 60));
    const scheduleCron = String(body.schedule_cron || '0 * * * *').trim();
    const enabled = body.enabled === 0 || body.enabled === false ? 0 : 1;
    const actionsJson = JSON.stringify(Array.isArray(body.actions) ? body.actions : []);
    const maxResults = Math.max(1, Math.min(5000, Number(body.max_results) || 500));
    const executionMode = normalizeExecutionMode(body.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode);
    const cacheTtlSeconds = normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds);
    const materializeEnabled = normalizeBooleanFlag(body.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled) ? 1 : 0;
    const materializeIntervalSeconds = normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds);
    const maxStalenessSeconds = normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds);

    await env.DB.prepare(
      `INSERT INTO scheduled_searches (
         id, name, ppl, time_window_minutes, schedule_cron, enabled, actions_json, max_results,
         execution_mode, cache_ttl_seconds, materialize_enabled, materialize_interval_seconds, max_staleness_seconds,
         created_by, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, name, ppl, timeWindowMinutes, scheduleCron, enabled, actionsJson, maxResults,
      executionMode, cacheTtlSeconds, materializeEnabled, materializeIntervalSeconds, maxStalenessSeconds,
      principal, now, now
    ).run();

    return jsonResponse(normalizeScheduledSearchRow({
      id,
      name,
      ppl,
      time_window_minutes: timeWindowMinutes,
      schedule_cron: scheduleCron,
      enabled,
      actions_json: actionsJson,
      max_results: maxResults,
      execution_mode: executionMode,
      cache_ttl_seconds: cacheTtlSeconds,
      materialize_enabled: materializeEnabled,
      materialize_interval_seconds: materializeIntervalSeconds,
      max_staleness_seconds: maxStalenessSeconds,
      created_by: principal,
      created_at: now,
      updated_at: now
    } satisfies ScheduledSearchRow), 201, requestCorsHeaders);
  }

  const runResultsMatch = pathname.match(/^\/scheduled-searches\/([^/]+)\/runs\/([^/]+)\/results$/);
  if (request.method === 'GET' && runResultsMatch) {
    assertPermission(auth, 'scheduled_search.read');
    const [, searchId, runId] = runResultsMatch;
    const search = await loadAccessibleScheduledSearch(searchId);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const run = await loadScheduledSearchRun(searchId, runId);
    if (!run) return jsonResponse({ error: 'Run not found' }, 404, requestCorsHeaders);

    const artifact = run.materialized_result_id
      ? await env.DB.prepare('SELECT * FROM materialized_results WHERE id = ?')
          .bind(run.materialized_result_id)
          .first<MaterializedResultRow>()
      : null;
    const preview = parseJsonRecordArray(run.preview_json || run.results_json);
    let payload = artifact?.payload_inline_json ? parseJsonObject(artifact.payload_inline_json, {}) : {};
    let results = parseJsonRecordArray(payload.results);
    if (results.length === 0) {
      results = preview;
    }

    return jsonResponse({
      run_id: run.id,
      scheduled_search_id: searchId,
      result_type: payload.result_type === 'events' ? 'events' : 'table',
      results,
      total_results: run.result_count,
      partial: !artifact,
      warning: typeof payload.warning === 'string' ? payload.warning : null,
      stats: Object.keys(payload).length > 0 ? parseJsonObject(payload.stats, {}) : parseJsonObject(run.stats_json, {})
    }, 200, requestCorsHeaders);
  }

  const runDetailMatch = pathname.match(/^\/scheduled-searches\/([^/]+)\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runDetailMatch) {
    assertPermission(auth, 'scheduled_search.read');
    const [, searchId, runId] = runDetailMatch;
    const search = await loadAccessibleScheduledSearch(searchId);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const run = await loadScheduledSearchRun(searchId, runId);
    if (!run) return jsonResponse({ error: 'Run not found' }, 404, requestCorsHeaders);
    const artifact = run.materialized_result_id
      ? await env.DB.prepare('SELECT id, status, result_count, computed_at, expires_at FROM materialized_results WHERE id = ?')
          .bind(run.materialized_result_id)
          .first<Pick<MaterializedResultRow, 'id' | 'status' | 'result_count' | 'computed_at' | 'expires_at'>>()
      : null;

    return jsonResponse({
      ...normalizeScheduledSearchResultRow(run, { includePreview: true }),
      search: normalizeScheduledSearchRow(search),
      query_request: parseJsonObject(run.query_request_json, {}),
      artifact: artifact ? {
        id: artifact.id,
        status: artifact.status,
        result_count: artifact.result_count,
        computed_at: artifact.computed_at,
        expires_at: artifact.expires_at
      } : null
    }, 200, requestCorsHeaders);
  }

  const idMatch = pathname.match(/^\/scheduled-searches\/([^/]+)/);
  if (!idMatch) return textResponse('Not found', 404, requestCorsHeaders);
  const id = idMatch[1];

  if (request.method === 'GET' && pathname.endsWith('/results')) {
    assertPermission(auth, 'scheduled_search.read');
    const search = await loadAccessibleScheduledSearch(id);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const rows = await env.DB.prepare(
      'SELECT * FROM scheduled_search_results WHERE scheduled_search_id = ? ORDER BY run_at DESC LIMIT 50'
    ).bind(id).all<ScheduledSearchResultRow>();
    return jsonResponse((rows.results || []).map((row) => normalizeScheduledSearchResultRow(row)), 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname.endsWith('/run')) {
    assertPermission(auth, 'scheduled_search.write');
    const search = await loadAccessibleScheduledSearch(id);
    if (!search) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const runResponse = await fetchAlertControl(env, `/internal/scheduled-searches/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ requested_by: principal })
    });
    const responseText = await runResponse.text();
    const runBody = responseText ? parseJsonObject(responseText, {}) : {};
    if (!runResponse.ok || runBody.error) {
      return jsonResponse(
        { error: String(runBody.error || `Scheduled search run failed (${runResponse.status})`) },
        runResponse.status >= 400 ? runResponse.status : 500,
        requestCorsHeaders
      );
    }
    await writeAuditLog(env, auth, 'scheduled_search.run.triggered', 'scheduled_search', id, {
      trigger_type: 'manual'
    }).catch(() => undefined);
    return jsonResponse(runBody, 200, requestCorsHeaders);
  }

  if (request.method === 'PUT') {
    assertPermission(auth, 'scheduled_search.write');
    const existing = await loadAccessibleScheduledSearch(id);
    if (!existing) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).trim()); }
    if (body.ppl !== undefined) { updates.push('ppl = ?'); values.push(String(body.ppl).trim()); }
    if (body.time_window_minutes !== undefined) { updates.push('time_window_minutes = ?'); values.push(Math.max(1, Math.min(10080, Number(body.time_window_minutes) || 60))); }
    if (body.schedule_cron !== undefined) { updates.push('schedule_cron = ?'); values.push(String(body.schedule_cron).trim()); }
    if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
    if (body.actions !== undefined) { updates.push('actions_json = ?'); values.push(JSON.stringify(Array.isArray(body.actions) ? body.actions : [])); }
    if (body.max_results !== undefined) { updates.push('max_results = ?'); values.push(Math.max(1, Math.min(5000, Number(body.max_results) || 500))); }
    if (body.execution_mode !== undefined) { updates.push('execution_mode = ?'); values.push(normalizeExecutionMode(body.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode)); }
    if (body.cache_ttl_seconds !== undefined) { updates.push('cache_ttl_seconds = ?'); values.push(normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds)); }
    if (body.materialize_enabled !== undefined) { updates.push('materialize_enabled = ?'); values.push(normalizeBooleanFlag(body.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled) ? 1 : 0); }
    if (body.materialize_interval_seconds !== undefined) { updates.push('materialize_interval_seconds = ?'); values.push(normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds)); }
    if (body.max_staleness_seconds !== undefined) { updates.push('max_staleness_seconds = ?'); values.push(normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds)); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);
    await env.DB.prepare(`UPDATE scheduled_searches SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    const updated = await env.DB.prepare('SELECT * FROM scheduled_searches WHERE id = ?').bind(id).first<ScheduledSearchRow>();
    return jsonResponse(updated ? normalizeScheduledSearchRow(updated) : { id, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'DELETE') {
    assertPermission(auth, 'scheduled_search.delete');
    const existing = await loadAccessibleScheduledSearch(id);
    if (!existing) return new Response(null, { status: 204, headers: requestCorsHeaders });
    await env.DB.prepare('DELETE FROM scheduled_search_results WHERE scheduled_search_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM scheduled_searches WHERE id = ?').bind(id).run();
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleDashboards(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  const principal = auth.email || auth.principal;
  const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';

  if (request.method === 'GET' && pathname === '/dashboards') {
    assertPermission(auth, 'dashboard.read');
    await seedStarterDashboards(env.DB).catch(() => undefined);
    const rows = await env.DB.prepare('SELECT * FROM dashboards ORDER BY is_default DESC, created_at DESC LIMIT 100').all<DashboardRow>();
    return jsonResponse((rows.results || []).map(normalizeDashboardRow), 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/dashboards') {
    assertPermission(auth, 'dashboard.write');
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    if (!name) return jsonResponse({ error: 'name is required' }, 400, requestCorsHeaders);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const performanceProfile = normalizePerformanceProfile(body.performance_profile, 'economy');
    const defaultExecutionMode = normalizeExecutionMode(body.default_execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode);
    await env.DB.prepare(
      `INSERT INTO dashboards (id, name, description, layout_json, is_default, performance_profile, default_execution_mode, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 0, ?, ?, ?, ?, ?)`
    ).bind(id, name, String(body.description || ''), performanceProfile, defaultExecutionMode, principal, now, now).run();
    return jsonResponse(normalizeDashboardRow({
      id,
      name,
      description: String(body.description || ''),
      layout_json: '[]',
      is_default: 0,
      performance_profile: performanceProfile,
      default_execution_mode: defaultExecutionMode,
      created_by: principal,
      created_at: now,
      updated_at: now
    } satisfies DashboardRow), 201, requestCorsHeaders);
  }

  const dashMatch = pathname.match(/^\/dashboards\/([^/]+)/);
  if (!dashMatch) return textResponse('Not found', 404, requestCorsHeaders);
  const dashboardId = dashMatch[1];
  const layoutMatch = pathname.match(/^\/dashboards\/[^/]+\/layout$/);

  if (layoutMatch !== null) {
    if (request.method !== 'PUT') return textResponse('Method not allowed', 405, requestCorsHeaders);
    assertPermission(auth, 'dashboard.write');
    const body = await request.json().catch(() => ({})) as { items?: Array<{ id?: string; layout_json?: unknown; layout?: unknown }> };
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return jsonResponse({ error: 'items is required' }, 400, requestCorsHeaders);
    const now = new Date().toISOString();
    let updated = 0;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const panelId = String(item.id || '').trim();
      if (!panelId) continue;
      const layoutInput = item.layout_json ?? item.layout ?? {};
      const layoutJson = normalizeJsonInput(layoutInput, defaultLayoutForPanel(index, 'table'));
      await env.DB.prepare(
        `UPDATE dashboard_panels
         SET layout_json = ?, position = ?, updated_at = ?
         WHERE id = ? AND dashboard_id = ?`
      ).bind(layoutJson, index, now, panelId, dashboardId).run();
      updated++;
    }
    return jsonResponse({ dashboard_id: dashboardId, updated, updated_at: now }, 200, requestCorsHeaders);
  }

  const panelMatch = pathname.match(/^\/dashboards\/[^/]+\/panels(?:\/([^/]+))?$/);

  if (panelMatch !== null) {
    const panelId = panelMatch[1] || null;

    if (request.method === 'GET' && !panelId) {
      assertPermission(auth, 'dashboard.read');
      const rows = await env.DB.prepare(
        'SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position ASC'
      ).bind(dashboardId).all<DashboardPanelRow>();
      return jsonResponse((rows.results || []).map(normalizeDashboardPanelRow), 200, requestCorsHeaders);
    }

    if (request.method === 'POST' && !panelId) {
      assertPermission(auth, 'dashboard.write');
      const body = await request.json() as Record<string, unknown>;
      const title = String(body.title || '').trim();
      const widgetType = normalizeWidgetType(body.widget_type ?? body.viz_type);
      const queryText = String(body.query_text ?? body.ppl ?? '').trim();
      if (!title) return jsonResponse({ error: 'title is required' }, 400, requestCorsHeaders);
      if (widgetType !== 'markdown' && !queryText) {
        return jsonResponse({ error: 'query_text is required for data widgets' }, 400, requestCorsHeaders);
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const vizType = mapWidgetTypeToLegacyViz(widgetType);
      const timeWindow = Math.max(1, Math.min(10080, Number(body.time_window_minutes) || 60));
      const refreshSec = Math.max(0, Math.min(3600, Number(body.refresh_seconds) || 0));
      const position = Math.max(0, Number(body.position) || 0);
      const queryMode = String(body.query_mode || 'ppl');
      const executionMode = normalizeExecutionMode(body.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode);
      const cacheTtlSeconds = normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds);
      const materializeEnabled = normalizeBooleanFlag(body.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled) ? 1 : 0;
      const materializeIntervalSeconds = normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds);
      const maxStalenessSeconds = normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds);
      const priority = Math.max(0, Math.min(100, Number(body.priority) || 0));
      const vizConfigJson = normalizeJsonInput(body.viz_config_json ?? body.viz_config ?? body.options_json, '{}');
      const layoutJson = normalizeJsonInput(body.layout_json ?? body.layout, defaultLayoutForPanel(position, widgetType));
      const bindingsJson = normalizeJsonInput(body.bindings_json ?? body.bindings, '{}');
      const displayOptionsJson = normalizeJsonInput(body.display_options_json ?? body.display_options, '{}');
      await env.DB.prepare(
        `INSERT INTO dashboard_panels (
          id, dashboard_id, title, ppl, viz_type, widget_type, query_text, query_mode,
          viz_config_json, layout_json, bindings_json, display_options_json,
          time_window_minutes, refresh_seconds, execution_mode, cache_ttl_seconds,
          materialize_enabled, materialize_interval_seconds, max_staleness_seconds, priority,
          options_json, position, created_at, updated_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        dashboardId,
        title,
        queryText,
        vizType,
        widgetType,
        queryText,
        queryMode,
        vizConfigJson,
        layoutJson,
        bindingsJson,
        displayOptionsJson,
        timeWindow,
        refreshSec,
        executionMode,
        cacheTtlSeconds,
        materializeEnabled,
        materializeIntervalSeconds,
        maxStalenessSeconds,
        priority,
        vizConfigJson,
        position,
        now,
        now
      ).run();
      return jsonResponse(
        normalizeDashboardPanelRow({
          id,
          dashboard_id: dashboardId,
          title,
          ppl: queryText,
          viz_type: vizType,
          widget_type: widgetType,
          query_text: queryText,
          query_mode: queryMode,
          viz_config_json: vizConfigJson,
          layout_json: layoutJson,
          bindings_json: bindingsJson,
          display_options_json: displayOptionsJson,
          time_window_minutes: timeWindow,
          refresh_seconds: refreshSec,
          execution_mode: executionMode,
          cache_ttl_seconds: cacheTtlSeconds,
          materialize_enabled: materializeEnabled,
          materialize_interval_seconds: materializeIntervalSeconds,
          max_staleness_seconds: maxStalenessSeconds,
          priority,
          options_json: vizConfigJson,
          position,
          created_at: now,
          updated_at: now
        }),
        201,
        requestCorsHeaders
      );
    }

    if (request.method === 'PUT' && panelId) {
      assertPermission(auth, 'dashboard.write');
      const body = await request.json() as Record<string, unknown>;
      const now = new Date().toISOString();
      const updates: string[] = [];
      const values: unknown[] = [];
      if (body.title !== undefined) { updates.push('title = ?'); values.push(String(body.title).trim()); }
      if (body.ppl !== undefined) { updates.push('ppl = ?'); values.push(String(body.ppl).trim()); }
      if (body.viz_type !== undefined) { updates.push('viz_type = ?'); values.push(String(body.viz_type)); }
      if (body.widget_type !== undefined) {
        const widgetType = normalizeWidgetType(body.widget_type);
        updates.push('widget_type = ?');
        values.push(widgetType);
        updates.push('viz_type = ?');
        values.push(mapWidgetTypeToLegacyViz(widgetType));
      }
      if (body.query_text !== undefined) {
        const queryText = String(body.query_text || '').trim();
        updates.push('query_text = ?');
        values.push(queryText);
        updates.push('ppl = ?');
        values.push(queryText);
      }
      if (body.query_mode !== undefined) { updates.push('query_mode = ?'); values.push(String(body.query_mode || 'ppl')); }
      if (body.execution_mode !== undefined) {
        updates.push('execution_mode = ?');
        values.push(normalizeExecutionMode(body.execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode));
      }
      if (body.cache_ttl_seconds !== undefined) {
        updates.push('cache_ttl_seconds = ?');
        values.push(normalizeCacheTtlSeconds(body.cache_ttl_seconds, DEFAULT_EXECUTION_POLICY.cache_ttl_seconds));
      }
      if (body.materialize_enabled !== undefined) {
        updates.push('materialize_enabled = ?');
        values.push(normalizeBooleanFlag(body.materialize_enabled, DEFAULT_EXECUTION_POLICY.materialize_enabled) ? 1 : 0);
      }
      if (body.materialize_interval_seconds !== undefined) {
        updates.push('materialize_interval_seconds = ?');
        values.push(normalizeMaterializeIntervalSeconds(body.materialize_interval_seconds, DEFAULT_EXECUTION_POLICY.materialize_interval_seconds));
      }
      if (body.max_staleness_seconds !== undefined) {
        updates.push('max_staleness_seconds = ?');
        values.push(normalizeMaxStalenessSeconds(body.max_staleness_seconds, DEFAULT_EXECUTION_POLICY.max_staleness_seconds));
      }
      if (body.priority !== undefined) {
        updates.push('priority = ?');
        values.push(Math.max(0, Math.min(100, Number(body.priority) || 0)));
      }
      if (body.viz_config_json !== undefined || body.viz_config !== undefined) {
        const configJson = normalizeJsonInput(body.viz_config_json ?? body.viz_config, '{}');
        updates.push('viz_config_json = ?');
        values.push(configJson);
        updates.push('options_json = ?');
        values.push(configJson);
      }
      if (body.layout_json !== undefined || body.layout !== undefined) {
        updates.push('layout_json = ?');
        values.push(normalizeJsonInput(body.layout_json ?? body.layout, '{}'));
      }
      if (body.bindings_json !== undefined || body.bindings !== undefined) {
        updates.push('bindings_json = ?');
        values.push(normalizeJsonInput(body.bindings_json ?? body.bindings, '{}'));
      }
      if (body.display_options_json !== undefined || body.display_options !== undefined) {
        updates.push('display_options_json = ?');
        values.push(normalizeJsonInput(body.display_options_json ?? body.display_options, '{}'));
      }
      if (body.time_window_minutes !== undefined) { updates.push('time_window_minutes = ?'); values.push(Number(body.time_window_minutes) || 60); }
      if (body.refresh_seconds !== undefined) { updates.push('refresh_seconds = ?'); values.push(Number(body.refresh_seconds) || 0); }
      if (body.position !== undefined) { updates.push('position = ?'); values.push(Number(body.position) || 0); }
      if (body.options_json !== undefined) { updates.push('options_json = ?'); values.push(typeof body.options_json === 'string' ? body.options_json : JSON.stringify(body.options_json)); }
      updates.push('updated_at = ?');
      values.push(now);
      values.push(panelId);
      if (updates.length > 1) {
        await env.DB.prepare(`UPDATE dashboard_panels SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      }
      const updatedRow = await env.DB.prepare(
        'SELECT * FROM dashboard_panels WHERE id = ? AND dashboard_id = ?'
      ).bind(panelId, dashboardId).first<DashboardPanelRow>();
      return jsonResponse(updatedRow ? normalizeDashboardPanelRow(updatedRow) : { id: panelId, updated_at: now }, 200, requestCorsHeaders);
    }

    if (request.method === 'DELETE' && panelId) {
      assertPermission(auth, 'dashboard.write');
      await env.DB.prepare('DELETE FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').bind(panelId, dashboardId).run();
      return new Response(null, { status: 204, headers: requestCorsHeaders });
    }

    return textResponse('Method not allowed', 405, requestCorsHeaders);
  }

  if (request.method === 'PUT') {
    assertPermission(auth, 'dashboard.write');
    const existing = await env.DB.prepare('SELECT id, is_default, created_by FROM dashboards WHERE id = ?')
      .bind(dashboardId).first<{ id: string; is_default: number; created_by?: string | null }>();
    if (!existing) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    if (existing.is_default && !isAdmin) throw new Error('Forbidden');
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).trim()); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(String(body.description)); }
    if (body.layout_json !== undefined) { updates.push('layout_json = ?'); values.push(typeof body.layout_json === 'string' ? body.layout_json : JSON.stringify(body.layout_json)); }
    if (body.performance_profile !== undefined) { updates.push('performance_profile = ?'); values.push(normalizePerformanceProfile(body.performance_profile, 'economy')); }
    if (body.default_execution_mode !== undefined) { updates.push('default_execution_mode = ?'); values.push(normalizeExecutionMode(body.default_execution_mode, DEFAULT_EXECUTION_POLICY.execution_mode)); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(dashboardId);
    await env.DB.prepare(`UPDATE dashboards SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    const updated = await env.DB.prepare('SELECT * FROM dashboards WHERE id = ?').bind(dashboardId).first<DashboardRow>();
    return jsonResponse(updated ? normalizeDashboardRow(updated) : { id: dashboardId, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'DELETE') {
    assertPermission(auth, 'dashboard.delete');
    const existing = await env.DB.prepare('SELECT id, is_default FROM dashboards WHERE id = ?')
      .bind(dashboardId).first<{ id: string; is_default: number }>();
    if (!existing) return new Response(null, { status: 204, headers: requestCorsHeaders });
    if (existing.is_default) return jsonResponse({ error: 'Cannot delete default dashboard' }, 403, requestCorsHeaders);
    await env.DB.prepare('DELETE FROM dashboard_panels WHERE dashboard_id = ?').bind(dashboardId).run();
    await env.DB.prepare('DELETE FROM dashboards WHERE id = ?').bind(dashboardId).run();
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

const MAX_LOOKUP_ROWS = 10000;
const MAX_LOOKUP_TABLES = 50;

async function handleLookupTables(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/lookup-tables') {
    assertPermission(auth, 'lookup.read');
    const rows = await env.DB.prepare('SELECT * FROM lookup_tables ORDER BY created_at DESC LIMIT 100').all<LookupTableRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/lookup-tables') {
    assertPermission(auth, 'lookup.write');
    const tableCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM lookup_tables').first<{ cnt: number }>();
    if (tableCount && tableCount.cnt >= MAX_LOOKUP_TABLES) {
      return jsonResponse({ error: `Maximum ${MAX_LOOKUP_TABLES} lookup tables allowed` }, 400, requestCorsHeaders);
    }
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const keyField = String(body.key_field || '').trim();
    if (!name || !keyField) return jsonResponse({ error: 'name and key_field are required' }, 400, requestCorsHeaders);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const principal = auth.email || auth.principal;
    const schemaJson = JSON.stringify(Array.isArray(body.schema) ? body.schema : []);
    await env.DB.prepare(
      `INSERT INTO lookup_tables (id, name, description, key_field, schema_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, String(body.description || ''), keyField, schemaJson, principal, now, now).run();

    if (Array.isArray(body.rows)) {
      const rowsToInsert = (body.rows as Array<Record<string, unknown>>).slice(0, MAX_LOOKUP_ROWS);
      for (const row of rowsToInsert) {
        const kv = String(row[keyField] ?? '');
        if (!kv) continue;
        const data = { ...row };
        delete data[keyField];
        await env.DB.prepare(
          'INSERT OR REPLACE INTO lookup_rows (lookup_id, key_value, data_json) VALUES (?, ?, ?)'
        ).bind(id, kv, JSON.stringify(data)).run();
      }
    }

    return jsonResponse({ id, name, key_field: keyField, created_at: now }, 201, requestCorsHeaders);
  }

  const idMatch = pathname.match(/^\/lookup-tables\/([^/]+)/);
  if (!idMatch) return textResponse('Not found', 404, requestCorsHeaders);
  const tableId = idMatch[1];

  if (request.method === 'GET' && pathname === `/lookup-tables/${tableId}`) {
    assertPermission(auth, 'lookup.read');
    const table = await env.DB.prepare('SELECT * FROM lookup_tables WHERE id = ?').bind(tableId).first<LookupTableRow>();
    if (!table) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const rows = await env.DB.prepare('SELECT key_value, data_json FROM lookup_rows WHERE lookup_id = ? LIMIT ?')
      .bind(tableId, MAX_LOOKUP_ROWS).all<{ key_value: string; data_json: string }>();
    return jsonResponse({
      ...table,
      rows: (rows.results || []).map(r => ({ key: r.key_value, ...JSON.parse(r.data_json) }))
    }, 200, requestCorsHeaders);
  }

  if (request.method === 'PATCH' && pathname.endsWith('/rows')) {
    assertPermission(auth, 'lookup.write');
    const table = await env.DB.prepare('SELECT id, key_field FROM lookup_tables WHERE id = ?').bind(tableId).first<{ id: string; key_field: string }>();
    if (!table) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const body = await request.json() as { rows?: Array<Record<string, unknown>>; delete_keys?: string[] };

    if (Array.isArray(body.delete_keys)) {
      for (const key of body.delete_keys) {
        await env.DB.prepare('DELETE FROM lookup_rows WHERE lookup_id = ? AND key_value = ?').bind(tableId, String(key)).run();
      }
    }

    if (Array.isArray(body.rows)) {
      const currentCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM lookup_rows WHERE lookup_id = ?').bind(tableId).first<{ cnt: number }>();
      const remaining = MAX_LOOKUP_ROWS - (currentCount?.cnt || 0);
      const rowsToInsert = body.rows.slice(0, Math.max(0, remaining + (body.delete_keys?.length || 0)));
      for (const row of rowsToInsert) {
        const kv = String(row[table.key_field] ?? '');
        if (!kv) continue;
        const data = { ...row };
        delete data[table.key_field];
        await env.DB.prepare(
          'INSERT OR REPLACE INTO lookup_rows (lookup_id, key_value, data_json) VALUES (?, ?, ?)'
        ).bind(tableId, kv, JSON.stringify(data)).run();
      }
    }

    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE lookup_tables SET updated_at = ? WHERE id = ?').bind(now, tableId).run();
    return jsonResponse({ id: tableId, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'PUT') {
    assertPermission(auth, 'lookup.write');
    const existing = await env.DB.prepare('SELECT id FROM lookup_tables WHERE id = ?').bind(tableId).first<{ id: string }>();
    if (!existing) return jsonResponse({ error: 'Not found' }, 404, requestCorsHeaders);
    const body = await request.json() as Record<string, unknown>;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).trim()); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(String(body.description)); }
    if (body.schema !== undefined) { updates.push('schema_json = ?'); values.push(JSON.stringify(Array.isArray(body.schema) ? body.schema : [])); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(tableId);
    await env.DB.prepare(`UPDATE lookup_tables SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    return jsonResponse({ id: tableId, updated_at: now }, 200, requestCorsHeaders);
  }

  if (request.method === 'DELETE') {
    assertPermission(auth, 'lookup.delete');
    await env.DB.prepare('DELETE FROM lookup_rows WHERE lookup_id = ?').bind(tableId).run();
    await env.DB.prepare('DELETE FROM lookup_tables WHERE id = ?').bind(tableId).run();
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function getUserRoleIds(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT role_id FROM user_roles WHERE user_id = ?'
  ).bind(userId).all<UserRoleAssignmentRow>();
  return (rows.results || []).map((row) => row.role_id);
}

async function setUserRoles(env: Env, userId: string, roleIds: string[], actor: string): Promise<void> {
  const normalized = Array.from(new Set(roleIds.map(ensureRoleId))).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error('At least one role is required');
  }

  const placeholders = normalized.map(() => '?').join(', ');
  const existingRoles = await env.DB.prepare(
    `SELECT id FROM roles WHERE enabled = 1 AND id IN (${placeholders})`
  ).bind(...normalized).all<{ id: string }>();
  const existingIds = new Set((existingRoles.results || []).map((row) => row.id));
  for (const roleId of normalized) {
    if (!existingIds.has(roleId)) {
      throw new Error(`Unknown role: ${roleId}`);
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(userId).run();
  for (const roleId of normalized) {
    await env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?)`
    ).bind(userId, roleId, actor, now).run();
  }
}

function parseInvitationRoleIds(roleIdsJson: string): string[] {
  return Array.from(new Set(parseJsonArray(roleIdsJson, []).map((roleId) => ensureRoleId(String(roleId))).filter(Boolean)));
}

async function expirePendingInvitations(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE invitations
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < ?`
  ).bind(new Date().toISOString()).run();
}

async function ensureInvitedUser(env: Env, email: string, authMode: AuthMode): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
     FROM users
     WHERE email = ?`
  ).bind(email).first<UserRow>();

  const now = new Date().toISOString();
  let userId = existing?.id || crypto.randomUUID();
  if (!existing) {
    const placeholderHash = authMode === 'local_password' ? '!invite-pending!' : '!access-sso-only!';
    const enabled = authMode === 'access_sso' ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, role, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'viewer', ?, ?, ?)`
    ).bind(userId, email, placeholderHash, enabled, now, now).run();
  } else if (authMode === 'access_sso' && existing.enabled !== 1) {
    await env.DB.prepare('UPDATE users SET enabled = 1, updated_at = ? WHERE id = ?').bind(now, existing.id).run();
    userId = existing.id;
  }

  return userId;
}

async function createInvitation(
  env: Env,
  email: string,
  authMode: AuthMode,
  roleIds: string[],
  invitedBy: string
): Promise<{ invitationId: string; expiresAt: string; inviteToken: string }> {
  const inviteToken = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const tokenHash = await sha256Hex(inviteToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (asInviteTtlHours(env.AUTH_INVITE_TTL_HOURS) * 60 * 60 * 1000)).toISOString();
  const invitationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO invitations (
      id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
  ).bind(
    invitationId,
    email,
    authMode,
    tokenHash,
    JSON.stringify(roleIds.map(ensureRoleId)),
    expiresAt,
    invitedBy,
    now
  ).run();
  return { invitationId, expiresAt, inviteToken };
}

async function handleUsers(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/users') {
    assertPermission(auth, 'user.read');
    const users = await env.DB.prepare(
      `SELECT id, email, role, enabled, created_at, updated_at, last_login_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 300`
    ).all<UserRow>();

    const out = [];
    for (const user of users.results || []) {
      const roleIds = await getUserRoleIds(env, user.id);
      out.push({
        id: user.id,
        email: user.email,
        enabled: user.enabled,
        legacy_role: user.role,
        role_ids: roleIds,
        created_at: user.created_at,
        updated_at: user.updated_at || null,
        last_login_at: user.last_login_at || null
      });
    }
    return jsonResponse(out, 200, requestCorsHeaders);
  }

  if (pathname.startsWith('/users/') && request.method === 'PATCH') {
    assertPermission(auth, 'user.disable');
    const id = pathname.split('/').pop();
    if (!id) return jsonResponse({ error: 'Invalid user id' }, 400, requestCorsHeaders);

    const existing = await env.DB.prepare(
      'SELECT id, email, role, enabled, created_at, updated_at, last_login_at FROM users WHERE id = ?'
    ).bind(id).first<UserRow>();
    if (!existing) return jsonResponse({ error: 'User not found' }, 404, requestCorsHeaders);

    const body = await request.json() as { enabled?: number; role_ids?: string[] };
    const enabled = body.enabled === undefined ? existing.enabled : (body.enabled === 0 ? 0 : 1);
    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled, now, id)
      .run();

    if (Array.isArray(body.role_ids)) {
      if (!hasPermission(auth, 'role.write')) {
        throw new Error('Forbidden');
      }
      await setUserRoles(env, id, body.role_ids, auth.email || auth.principal);
    }

    await writeAuditLog(env, auth, 'user.updated', 'user', id, { enabled, role_ids: body.role_ids || null }).catch(() => undefined);
    return jsonResponse({ id, enabled, updated_at: now }, 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleRoles(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/roles') {
    assertPermission(auth, 'role.read');
    const rows = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles
       ORDER BY system_role DESC, id ASC`
    ).all<RoleRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/roles') {
    assertPermission(auth, 'role.write');
    const body = await request.json() as Partial<RoleRow>;
    const id = ensureRoleId(String(body.id || body.name || '').replace(/\s+/g, '-'));
    const name = String(body.name || id).trim();
    if (!id || !name) {
      return jsonResponse({ error: 'id/name required' }, 400, requestCorsHeaders);
    }
    const permissions = parsePermissionsInput(body.permissions_json, []);
    if (permissions.length === 0) {
      return jsonResponse({ error: 'permissions_json must contain at least one permission' }, 400, requestCorsHeaders);
    }
    const scope = normalizeScope(parseScopeInput(body.scope_json));
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO roles (id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at)
       VALUES (?, ?, 0, 1, ?, ?, ?, ?)`
    ).bind(id, name, JSON.stringify(permissions), JSON.stringify(scope), now, now).run();
    await writeAuditLog(env, auth, 'role.created', 'role', id, { permissions_count: permissions.length }).catch(() => undefined);
    return jsonResponse({ id, name, permissions_json: JSON.stringify(permissions), scope_json: JSON.stringify(scope) }, 201, requestCorsHeaders);
  }

  if (pathname.startsWith('/roles/') && request.method === 'PATCH') {
    assertPermission(auth, 'role.write');
    const id = ensureRoleId(pathname.split('/').pop() || '');
    if (!id) return jsonResponse({ error: 'Invalid role id' }, 400, requestCorsHeaders);
    const existing = await env.DB.prepare(
      `SELECT id, name, system_role, enabled, permissions_json, scope_json, created_at, updated_at
       FROM roles WHERE id = ?`
    ).bind(id).first<RoleRow>();
    if (!existing) return jsonResponse({ error: 'Role not found' }, 404, requestCorsHeaders);

    const body = await request.json() as Partial<RoleRow>;
    const name = String(body.name ?? existing.name).trim();
    const enabled = body.enabled === undefined ? existing.enabled : (body.enabled === 0 ? 0 : 1);
    const permissions = body.permissions_json === undefined
      ? parseJsonArray(existing.permissions_json, [])
      : parsePermissionsInput(body.permissions_json, []);
    const scope = body.scope_json === undefined
      ? normalizeScope(parseScope(existing.scope_json))
      : normalizeScope(parseScopeInput(body.scope_json));

    if (existing.system_role === 1 && auth.role !== 'superadmin') {
      return jsonResponse({ error: 'Only superadmin can modify system roles' }, 403, requestCorsHeaders);
    }

    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE roles
       SET name = ?, enabled = ?, permissions_json = ?, scope_json = ?, updated_at = ?
       WHERE id = ?`
    ).bind(name, enabled, JSON.stringify(permissions), JSON.stringify(scope), now, id).run();
    await writeAuditLog(env, auth, 'role.updated', 'role', id, { enabled, permissions_count: permissions.length }).catch(() => undefined);
    return jsonResponse({ id, name, enabled, permissions_json: JSON.stringify(permissions), scope_json: JSON.stringify(scope), updated_at: now }, 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleRbacMappings(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/rbac/mappings') {
    assertPermission(auth, 'role.read');
    const rows = await env.DB.prepare(
      `SELECT id, access_group, role_id, created_at, updated_at
       FROM access_group_role_mappings
       ORDER BY access_group ASC, role_id ASC`
    ).all<AccessGroupRoleMappingRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/rbac/mappings') {
    assertPermission(auth, 'role.write');
    const body = await request.json() as { access_group?: string; role_id?: string };
    const group = String(body.access_group || '').trim();
    const roleId = ensureRoleId(String(body.role_id || ''));
    if (!group || !roleId) {
      return jsonResponse({ error: 'access_group and role_id required' }, 400, requestCorsHeaders);
    }
    const role = await env.DB.prepare('SELECT id FROM roles WHERE id = ? AND enabled = 1').bind(roleId).first<{ id?: string }>();
    if (!role?.id) {
      return jsonResponse({ error: `Unknown role: ${roleId}` }, 400, requestCorsHeaders);
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO access_group_role_mappings (id, access_group, role_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), group, roleId, now, now).run();
    await writeAuditLog(env, auth, 'rbac.mapping.created', 'mapping', group, { role_id: roleId }).catch(() => undefined);
    return jsonResponse({ access_group: group, role_id: roleId }, 201, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleAudit(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/audit') {
    assertPermission(auth, 'audit.read');
    const url = new URL(request.url);
    const limit = clampLimit(Number(url.searchParams.get('limit') || 200), 500);
    const rows = await env.DB.prepare(
      `SELECT id, actor_principal, actor_email, action, target_type, target_id, metadata_json, created_at
       FROM audit_log
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(limit).all<AuditLogRow>();
    return jsonResponse(rows.results || [], 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function fetchSyntheticControl(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!env.SYNTHETIC_SERVICE) {
    throw new Error('Synthetic control is not configured (missing SYNTHETIC_SERVICE binding)');
  }
  if (!env.SYNTHETIC_RUN_SECRET) {
    throw new Error('Synthetic control is not configured (missing SYNTHETIC_RUN_SECRET secret)');
  }
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.SYNTHETIC_RUN_SECRET}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return env.SYNTHETIC_SERVICE.fetch(
    new Request(`https://internal${path}`, { ...init, headers })
  );
}

async function fetchAlertControl(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!env.ALERT_SERVICE) {
    throw new Error('Alert control is not configured (missing ALERT_SERVICE binding)');
  }
  if (!env.ALERT_RUN_SECRET) {
    throw new Error('Alert control is not configured (missing ALERT_RUN_SECRET secret)');
  }
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.ALERT_RUN_SECRET}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return env.ALERT_SERVICE.fetch(
    new Request(`https://internal${path}`, { ...init, headers })
  );
}

async function handleSyntheticIngestAdmin(
  request: Request,
  env: Env,
  pathname: string,
  auth: AuthContext,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (!pathname.startsWith('/admin/synthetic-ingest')) {
    return textResponse('Not found', 404, requestCorsHeaders);
  }
  assertPermission(auth, 'role.write');

  if (request.method === 'POST' && pathname === '/admin/synthetic-ingest/run') {
    const runResponse = await fetchSyntheticControl(env, '/run', { method: 'POST' });
    const runBody = await runResponse.json() as Record<string, unknown>;
    if (!runResponse.ok || runBody.error) {
      return jsonResponse(
        { error: String(runBody.error || `Synthetic run failed (${runResponse.status})`) },
        runResponse.status >= 400 ? runResponse.status : 500,
        requestCorsHeaders
      );
    }
    await writeAuditLog(env, auth, 'synthetic.ingest.run.triggered', 'runtime_flags', 'synthetic_ingest_enabled', {
      source: 'admin'
    }).catch(() => undefined);
    return jsonResponse({ ok: true, run: runBody }, 200, requestCorsHeaders);
  }

  if (request.method === 'GET') {
    const response = await fetchSyntheticControl(env, '/control');
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || body.error) {
      return jsonResponse(
        { error: String(body.error || `Synthetic control request failed (${response.status})`) },
        response.status >= 400 ? response.status : 500,
        requestCorsHeaders
      );
    }
    return jsonResponse(body, 200, requestCorsHeaders);
  }

  if (request.method === 'POST') {
    const body = await request.json() as { enabled?: unknown; trigger_run?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return jsonResponse({ error: 'enabled boolean is required' }, 400, requestCorsHeaders);
    }

    const controlResponse = await fetchSyntheticControl(env, '/control', {
      method: 'POST',
      body: JSON.stringify({ enabled: body.enabled })
    });
    const controlBody = await controlResponse.json() as Record<string, unknown>;
    if (!controlResponse.ok || controlBody.error) {
      return jsonResponse(
        { error: String(controlBody.error || `Synthetic control update failed (${controlResponse.status})`) },
        controlResponse.status >= 400 ? controlResponse.status : 500,
        requestCorsHeaders
      );
    }

    let runBody: Record<string, unknown> | null = null;
    const triggerRun = body.trigger_run !== false;
    if (body.enabled && triggerRun) {
      const runResponse = await fetchSyntheticControl(env, '/run', { method: 'POST' });
      runBody = await runResponse.json() as Record<string, unknown>;
      if (!runResponse.ok || runBody.error) {
        return jsonResponse(
          {
            error: String(runBody.error || `Synthetic run failed (${runResponse.status})`),
            control: controlBody
          },
          runResponse.status >= 400 ? runResponse.status : 500,
          requestCorsHeaders
        );
      }
    }

    await writeAuditLog(env, auth, 'synthetic.ingest.control.updated', 'runtime_flags', 'synthetic_ingest_enabled', {
      enabled: body.enabled,
      trigger_run: body.enabled && triggerRun
    }).catch(() => undefined);

    return jsonResponse(
      {
        ok: true,
        control: controlBody,
        run: runBody
      },
      200,
      requestCorsHeaders
    );
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

async function handleAuth(
  request: Request,
  env: Env,
  pathname: string,
  requestCorsHeaders: Record<string, string>
): Promise<Response> {
  if (request.method === 'GET' && pathname === '/auth/access/start') {
    const returnTo = resolveAccessReturnTo(request, env);

    try {
      await authenticateRequest(request, env);
      return new Response(null, {
        status: 302,
        headers: {
          location: returnTo,
          'cache-control': 'no-store'
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      const escapedMessage = escapeHtml(message);
      const escapedReturnTo = escapeHtml(returnTo);
      return htmlResponse(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>EdgeData Access Sign-In</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f5f3ef; color: #1f2937; }
      main { max-width: 640px; margin: 64px auto; padding: 32px; background: #fffdf9; border: 1px solid #e7ded1; border-radius: 18px; box-shadow: 0 18px 50px rgba(36, 30, 18, 0.08); }
      h1 { margin: 0 0 12px; font-size: 1.75rem; }
      p { line-height: 1.6; margin: 0 0 14px; }
      code { background: #f3eee6; padding: 0.15rem 0.35rem; border-radius: 6px; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
      a { color: #8a3b12; font-weight: 600; }
      .button { display: inline-block; padding: 12px 16px; border-radius: 10px; text-decoration: none; background: #8a3b12; color: #fffdf9; }
      .muted { color: #5b6472; font-size: 0.95rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Cloudflare Access session not available</h1>
      <p>This login flow expects the browser to reach an Access-protected query API origin first, then return to the app.</p>
      <p><strong>Current result:</strong> ${escapedMessage}</p>
      <p class="muted">If you are using a <code>workers.dev</code> API URL, point <code>VITE_QUERY_API_BASE</code> at the Access-protected query-worker hostname or custom domain, then try again.</p>
      <div class="actions">
        <a class="button" href="${escapedReturnTo}">Back to EdgeData</a>
        <a href="${escapedReturnTo}">Retry from app</a>
      </div>
    </main>
  </body>
</html>`,
        401,
        {
          ...requestCorsHeaders,
          'cache-control': 'no-store'
        }
      );
    }
  }

  if (request.method === 'POST' && pathname === '/auth/login') {
    if (!localLoginEnabled(env)) {
      return jsonResponse({ error: 'Local login is disabled' }, 403, requestCorsHeaders);
    }

    const loginLimit = asRateLimitPerMinute(env.AUTH_LOGIN_RATE_LIMIT_PER_MIN, 60);
    await enforceRateLimit(env, 'auth_login_ip', clientIp(request), loginLimit);

    const body = await request.json() as { email?: string; password?: string };
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) {
      return jsonResponse({ error: 'email and password are required' }, 400, requestCorsHeaders);
    }

    const user = await authenticateCredentials(email, password, env);
    if (!user) {
      return jsonResponse({ error: 'Invalid credentials' }, 401, requestCorsHeaders);
    }

    const roleIds = await resolveRoleIdsForUser(env, user, []);
    const auth = await resolveAuthFromRoleIds(env, user.id, user.email, [], roleIds, 'local_password');

    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, user.id)
      .run();
    await writeAuditLog(env, auth, 'auth.login.local', 'user', user.id).catch(() => undefined);

    const session = await createSessionToken(auth, env);
    return jsonResponse({
      token: session.token,
      expires_at: session.expiresAt,
      user: {
        id: user.id,
        email: user.email,
        role: auth.role,
        role_ids: auth.roleIds,
        permissions: Array.from(auth.permissions),
        scope: auth.scope
      },
      auth_mode: 'local_password'
    }, 200, requestCorsHeaders);
  }

  if (request.method === 'GET' && pathname === '/auth/me') {
    try {
      const auth = await authenticateRequest(request, env);
      return jsonResponse({
        authenticated: true,
        user: {
          id: auth.principal,
          email: auth.email,
          role: auth.role,
          role_ids: auth.roleIds,
          permissions: Array.from(auth.permissions),
          scope: auth.scope
        },
        auth_mode: auth.authMode
      }, 200, requestCorsHeaders);
    } catch (error) {
      return errorResponse(error, requestCorsHeaders, 401);
    }
  }

  if (request.method === 'GET' && pathname === '/auth/invites') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');
    await expirePendingInvitations(env);

    const url = new URL(request.url);
    const limit = clampLimit(Number(url.searchParams.get('limit') || 200), 500);
    const requestedStatus = String(url.searchParams.get('status') || 'pending').trim().toLowerCase();
    const allowedStatuses = new Set(['pending', 'accepted', 'revoked', 'expired', 'all']);
    const status = allowedStatuses.has(requestedStatus) ? requestedStatus : 'pending';

    const rows = status === 'all'
      ? await env.DB.prepare(
        `SELECT id, email, auth_mode, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
         FROM invitations
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(limit).all<InvitationViewRow>()
      : await env.DB.prepare(
        `SELECT id, email, auth_mode, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
         FROM invitations
         WHERE status = ?
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(status, limit).all<InvitationViewRow>();

    const out = (rows.results || []).map((row) => ({
      id: row.id,
      email: row.email,
      auth_mode: row.auth_mode,
      role_ids: parseInvitationRoleIds(row.role_ids_json),
      expires_at: row.expires_at,
      invited_by: row.invited_by,
      status: row.status,
      created_at: row.created_at,
      accepted_at: row.accepted_at || null
    }));

    return jsonResponse(out, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');

    const body = await request.json() as { email?: string; auth_mode?: AuthMode; role_ids?: string[] };
    const email = String(body.email || '').trim().toLowerCase();
    const authMode = body.auth_mode === 'local_password' ? 'local_password' : 'access_sso';
    const roleIds = Array.isArray(body.role_ids) && body.role_ids.length > 0 ? body.role_ids : ['viewer'];
    if (!email) {
      return jsonResponse({ error: 'email is required' }, 400, requestCorsHeaders);
    }

    const userId = await ensureInvitedUser(env, email, authMode);
    await setUserRoles(env, userId, roleIds, auth.email || auth.principal);
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE email = ? AND status = 'pending'`
    ).bind(email).run();
    const invite = await createInvitation(env, email, authMode, roleIds, auth.email || auth.principal);

    await writeAuditLog(env, auth, 'auth.invite.created', 'user', userId, { email, auth_mode: authMode, role_ids: roleIds }).catch(() => undefined);
    return jsonResponse({
      email,
      auth_mode: authMode,
      role_ids: roleIds,
      expires_at: invite.expiresAt,
      invite_token: invite.inviteToken
    }, 201, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite/resend') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');
    await expirePendingInvitations(env);

    const body = await request.json() as { id?: string; auth_mode?: AuthMode; role_ids?: string[] };
    const invitationId = String(body.id || '').trim();
    if (!invitationId) {
      return jsonResponse({ error: 'id is required' }, 400, requestCorsHeaders);
    }

    const existingInvite = await env.DB.prepare(
      `SELECT id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
       FROM invitations
       WHERE id = ?`
    ).bind(invitationId).first<InvitationRow>();
    if (!existingInvite) {
      return jsonResponse({ error: 'Invitation not found' }, 404, requestCorsHeaders);
    }
    if (existingInvite.status === 'accepted') {
      return jsonResponse({ error: 'Invitation already accepted' }, 400, requestCorsHeaders);
    }

    const authMode = body.auth_mode === 'local_password' ? 'local_password' : existingInvite.auth_mode;
    let roleIds = Array.isArray(body.role_ids) && body.role_ids.length > 0
      ? body.role_ids.map(ensureRoleId).filter(Boolean)
      : parseInvitationRoleIds(existingInvite.role_ids_json);
    if (roleIds.length === 0) {
      const user = await env.DB.prepare(
        `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
         FROM users
         WHERE email = ?`
      ).bind(existingInvite.email).first<UserRow>();
      roleIds = user ? await getUserRoleIds(env, user.id) : ['viewer'];
    }

    const userId = await ensureInvitedUser(env, existingInvite.email, authMode);
    await setUserRoles(env, userId, roleIds, auth.email || auth.principal);
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE email = ? AND status = 'pending'`
    ).bind(existingInvite.email).run();

    const invite = await createInvitation(env, existingInvite.email, authMode, roleIds, auth.email || auth.principal);
    await writeAuditLog(env, auth, 'auth.invite.resent', 'user', userId, {
      email: existingInvite.email,
      auth_mode: authMode,
      role_ids: roleIds,
      previous_invitation_id: existingInvite.id
    }).catch(() => undefined);

    return jsonResponse({
      id: invite.invitationId,
      email: existingInvite.email,
      auth_mode: authMode,
      role_ids: roleIds,
      expires_at: invite.expiresAt,
      invite_token: invite.inviteToken
    }, 201, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite/revoke') {
    const auth = await authenticateRequest(request, env);
    assertPermission(auth, 'user.invite');
    await expirePendingInvitations(env);

    const body = await request.json() as { id?: string };
    const invitationId = String(body.id || '').trim();
    if (!invitationId) {
      return jsonResponse({ error: 'id is required' }, 400, requestCorsHeaders);
    }

    const invitation = await env.DB.prepare(
      `SELECT id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
       FROM invitations
       WHERE id = ?`
    ).bind(invitationId).first<InvitationRow>();
    if (!invitation) {
      return jsonResponse({ error: 'Invitation not found' }, 404, requestCorsHeaders);
    }
    if (invitation.status !== 'pending') {
      return jsonResponse({ error: `Invitation is already ${invitation.status}` }, 400, requestCorsHeaders);
    }

    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE id = ?`
    ).bind(invitation.id).run();
    await writeAuditLog(env, auth, 'auth.invite.revoked', 'user', undefined, {
      invitation_id: invitation.id,
      email: invitation.email
    }).catch(() => undefined);
    return jsonResponse({ ok: true, id: invitation.id, status: 'revoked' }, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/invite/accept') {
    await expirePendingInvitations(env);
    const body = await request.json() as { token?: string; password?: string };
    const token = String(body.token || '').trim();
    if (!token) {
      return jsonResponse({ error: 'token is required' }, 400, requestCorsHeaders);
    }

    const tokenHash = await sha256Hex(token);
    const invitation = await env.DB.prepare(
      `SELECT id, email, auth_mode, token_hash, role_ids_json, expires_at, invited_by, status, created_at, accepted_at
       FROM invitations
       WHERE token_hash = ?`
    ).bind(tokenHash).first<InvitationRow>();
    if (!invitation || invitation.status !== 'pending') {
      return jsonResponse({ error: 'Invalid invitation token' }, 400, requestCorsHeaders);
    }
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      return jsonResponse({ error: 'Invitation expired' }, 400, requestCorsHeaders);
    }
    if (invitation.auth_mode === 'access_sso') {
      return jsonResponse({ error: 'Access SSO invitations are activated on first SSO login' }, 400, requestCorsHeaders);
    }

    const password = String(body.password || '');
    if (!password || password.length < 10) {
      return jsonResponse({ error: 'password must be at least 10 characters' }, 400, requestCorsHeaders);
    }

    const user = await env.DB.prepare(
      `SELECT id, email, password_hash, role, enabled, created_at, updated_at, last_login_at
       FROM users
       WHERE email = ?`
    ).bind(invitation.email).first<UserRow>();
    if (!user) {
      return jsonResponse({ error: 'Invitation user not found' }, 400, requestCorsHeaders);
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      `UPDATE users
       SET password_hash = ?, enabled = 1, updated_at = ?
       WHERE id = ?`
    ).bind(passwordHash, now, user.id).run();
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'accepted', accepted_at = ?
       WHERE id = ?`
    ).bind(now, invitation.id).run();
    await env.DB.prepare(
      `UPDATE invitations
       SET status = 'revoked'
       WHERE email = ? AND status = 'pending' AND id != ?`
    ).bind(invitation.email, invitation.id).run();

    await writeAuditLog(env, null, 'auth.invite.accepted', 'user', user.id, { email: invitation.email }).catch(() => undefined);
    return jsonResponse({ ok: true, email: invitation.email }, 200, requestCorsHeaders);
  }

  if (request.method === 'POST' && pathname === '/auth/logout') {
    return jsonResponse({ ok: true }, 200, requestCorsHeaders);
  }

  return textResponse('Method not allowed', 405, requestCorsHeaders);
}

function errorResponse(
  error: unknown,
  requestCorsHeaders: Record<string, string>,
  fallback = 500
): Response {
  const status = statusFromError(error, fallback);
  const message = error instanceof Error ? error.message : String(error);
  const guardrail = classifyGuardrailError(message);
  return jsonResponse(
    {
      error: message,
      ...(guardrail ? { guardrail: guardrail as GuardrailExplanation } : {})
    },
    status,
    requestCorsHeaders
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const startedAt = Date.now();
    const requestCorsHeaders = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: requestCorsHeaders });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'query-worker', version: '1.3.0' }, 200, requestCorsHeaders);
    }

    if (url.pathname === '/tail' && request.headers.get('Upgrade') === 'websocket') {
      try {
        const tokenParam = url.searchParams.get('token');
        const authRequest = tokenParam
          ? new Request(request.url, {
              headers: new Headers([
                ...Array.from(request.headers.entries()),
                ['Authorization', `Bearer ${tokenParam}`]
              ])
            })
          : request;
        await ensureRbacInitialized(env);
        const auth = await authenticateRequest(authRequest, env);
        assertPermission(auth, 'search.read');

        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/ws';
        const doRequest = new Request(doUrl.toString(), {
          headers: new Headers([
            ['Upgrade', 'websocket'],
            ['X-Tail-Scope', JSON.stringify(auth.scope)]
          ])
        });
        return stub.fetch(doRequest);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Auth failed' },
          { status: 401 }
        );
      }
    }

    if (url.pathname === '/internal/tail-push' && request.method === 'POST') {
      try {
        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        const doRequest = new Request(new URL('/push', request.url).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body
        });
        return stub.fetch(doRequest);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Push failed' },
          { status: 500 }
        );
      }
    }

    if (url.pathname === '/tail/stats' && request.method === 'GET') {
      try {
        await ensureRbacInitialized(env);
        const auth = await authenticateRequest(request, env);
        assertPermission(auth, 'search.read');
        const id = env.TAIL_HUB.idFromName('global');
        const stub = env.TAIL_HUB.get(id);
        return stub.fetch(new Request(new URL('/stats', request.url).toString()));
      } catch (error) {
        return errorResponse(error, requestCorsHeaders, 401);
      }
    }

    await ensureRbacInitialized(env);

    if (url.pathname.startsWith('/auth/')) {
      try {
        return await handleAuth(request, env, url.pathname, requestCorsHeaders);
      } catch (error) {
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    try {
      const ipLimit = asRateLimitPerMinute(env.QUERY_RATE_LIMIT_PER_MIN, 600);
      await enforceRateLimit(env, 'query_ip', clientIp(request), ipLimit);
    } catch (error) {
      await writeOpsMetric(env, 'query_rate_limited', 1).catch(() => undefined);
      return errorResponse(error, requestCorsHeaders, 429);
    }

    let auth: AuthContext;
    try {
      auth = await authenticateRequest(request, env);
    } catch (error) {
      await writeOpsMetric(env, 'query_auth_failures', 1).catch(() => undefined);
      return errorResponse(error, requestCorsHeaders, 401);
    }

    try {
      const principalLimit = asRateLimitPerMinute(env.QUERY_RATE_LIMIT_PER_MIN, 600);
      await enforceRateLimit(env, 'query_principal', auth.email || auth.principal, principalLimit);
    } catch (error) {
      await writeOpsMetric(env, 'query_rate_limited', 1).catch(() => undefined);
      return errorResponse(error, requestCorsHeaders, 429);
    }

    if (url.pathname === '/search' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = await request.json() as PplSearchRequest;
        const response = await performPplSearch(req, env, auth);
        await writeOpsMetric(env, 'r2sql_calls_total', response.stats.scanned_objects).catch(() => undefined);
        await writeScanMetrics(env, 'search', {
          scanned_partitions: response.stats.scanned_partitions,
          scanned_objects: response.stats.scanned_objects,
          listed_prefixes: response.stats.listed_prefixes,
          listing_calls: response.stats.listing_calls,
          listed_objects: response.stats.listed_objects,
          listing_fallbacks: response.stats.listing_fallbacks,
          timing_ms: response.stats.timing_ms
        }).catch(() => undefined);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return jsonResponse(response, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/search/stream' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_stream_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = await request.json() as PplSearchRequest;
        return await streamPplSearch(req, env, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/search/summary' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_summary_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = await request.json() as PplSearchRequest;
        const summary = await performPplSearchSummary(req, env, auth);
        await writeOpsMetric(env, 'r2sql_calls_total', summary.scanned_objects).catch(() => undefined);
        await writeScanMetrics(env, 'search_summary', {
          scanned_partitions: summary.scanned_partitions,
          scanned_objects: summary.scanned_objects,
          listed_prefixes: summary.listed_prefixes,
          listing_calls: summary.listing_calls,
          listed_objects: summary.listed_objects,
          listing_fallbacks: summary.listing_fallbacks,
          timing_ms: summary.timing_ms
        }).catch(() => undefined);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return jsonResponse(summary, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/search/suggestions' && request.method === 'POST') {
      await writeOpsMetric(env, 'search_suggestions_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'search.read');
        const req = await request.json().catch(() => ({})) as PplSuggestionsRequest;
        const response = getPplSuggestions({
          query: String(req.query || ''),
          cursorPos: typeof req.cursorPos === 'number' ? req.cursorPos : undefined,
          maxItems: typeof req.maxItems === 'number' ? req.maxItems : undefined,
          context: {
            topTerms: Array.isArray(req.context?.topTerms)
              ? req.context.topTerms.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50)
              : []
          }
        });
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return jsonResponse({
          suggestions: response.suggestions,
          meta: {
            context_stage: response.contextStage,
            latency_ms: Date.now() - startedAt
          }
        }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 400);
      }
    }

    if (url.pathname === '/dashboards/query' && request.method === 'POST') {
      await writeOpsMetric(env, 'dashboard_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'dashboard.read');
        const response = await handleDashboardQuery(request, env, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname === '/dashboards/widgets/query' && request.method === 'POST') {
      await writeOpsMetric(env, 'dashboard_widget_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'dashboard.read');
        const response = await handleDashboardWidgetQuery(request, env, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname === '/dashboards/widgets/query-batch' && request.method === 'POST') {
      await writeOpsMetric(env, 'dashboard_widget_batch_requests_total', 1).catch(() => undefined);
      try {
        assertPermission(auth, 'dashboard.read');
        const response = await handleDashboardWidgetBatchQuery(request, env, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname === '/investigations/demo-scenarios' && request.method === 'GET') {
      try {
        assertPermission(auth, 'search.read');
        const demoEnabled = env.DEMO_SCENARIOS_ENABLED === 'true';
        if (!demoEnabled) {
          return jsonResponse({ demo_mode: false, scenarios: [] }, 200, requestCorsHeaders);
        }
        const to = new Date();
        const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
        const timeRange = { from: from.toISOString(), to: to.toISOString() };
        const scenarios = [
          {
            id: 'synthetic-errors',
            label: 'Synthetic errors (frontend)',
            scope: { index: 'otel-demo', service: 'frontend', env: 'demo' },
            time: timeRange,
            pivot_chips: [],
            starter_queries: [
              { id: 'errors', title: 'Errors', ppl: 'search * | where level="error" | where index="otel-demo" and service="frontend" and env="demo" | head 50' },
              { id: 'volume', title: 'Volume', ppl: 'search * | where index="otel-demo" and service="frontend" and env="demo" | timechart span=5m count() | head 100' }
            ]
          },
          {
            id: 'checkout-service',
            label: 'Checkout service anomalies',
            scope: { index: 'otel-checkout', service: 'checkoutservice', env: 'demo' },
            time: timeRange,
            pivot_chips: [],
            starter_queries: [
              { id: 'errors', title: 'Errors', ppl: 'search * | where level="error" | where index="otel-checkout" and service="checkoutservice" and env="demo" | head 50' },
              { id: 'volume', title: 'Volume', ppl: 'search * | where index="otel-checkout" and service="checkoutservice" and env="demo" | timechart span=5m count() | head 100' }
            ]
          },
          {
            id: 'payment-service',
            label: 'Payment service failures',
            scope: { index: 'otel-payments', service: 'paymentservice', env: 'demo' },
            time: timeRange,
            pivot_chips: [],
            starter_queries: [
              { id: 'http-errors', title: 'HTTP 4xx/5xx', ppl: 'search * | where index="otel-payments" and service="paymentservice" and env="demo" and status>=400 | head 50' },
              { id: 'volume', title: 'Volume', ppl: 'search * | where index="otel-payments" and service="paymentservice" and env="demo" | timechart span=5m count() | head 100' }
            ]
          }
        ];
        return jsonResponse({ demo_mode: true, scenarios }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/bootstrap' && request.method === 'POST') {
      try {
        assertPermission(auth, 'search.read');
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const validation = validateBootstrapRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        const payload = buildBootstrapPayload(body);
        return jsonResponse(payload, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/related-events' && request.method === 'POST') {
      try {
        assertPermission(auth, 'search.read');
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const validation = validateRelatedEventsRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        const pivots = normalizePivots(body.pivots);
        const pivotTokens = Array.isArray(body.pivot_tokens) ? body.pivot_tokens : [];
        const maxCandidates = body.max_candidates != null
          ? Math.min(Number(body.max_candidates), 100)
          : 100;
        // Candidate retrieval from R2/query planner intentionally deferred; ranking wired for future integration.
        const candidates: Array<Record<string, unknown>> = [];
        const ranked = rankRelatedEvents(pivots, pivotTokens, candidates, { maxCandidates });
        return jsonResponse({ related_events: ranked }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname === '/investigations/session' && request.method === 'POST') {
      try {
        assertPermission(auth, 'search.read');
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const validation = validateSessionSaveRequest(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400, requestCorsHeaders);
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const principal = auth.email || auth.principal;
        const recordInput = {
          id,
          owner_user_id: principal,
          source_type: validation.source_type,
          scope_json: validation.scope_json,
          state_json: validation.state_json,
          created_at: now,
          expires_at: validation.expires_at
        };
        const built = buildSessionRecord(recordInput);
        if (!built.ok) {
          return jsonResponse({ error: built.error }, 400, requestCorsHeaders);
        }
        await env.DB.prepare(
          `INSERT INTO investigation_sessions (id, owner_user_id, source_type, scope_json, state_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          built.id,
          built.owner_user_id ?? null,
          built.source_type ?? null,
          built.scope_json,
          built.state_json,
          built.created_at,
          built.expires_at ?? null
        ).run();
        return jsonResponse({ id: built.id, created_at: built.created_at }, 201, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    const sessionMatch = url.pathname.match(/^\/investigations\/session\/([^/]+)$/);
    if (sessionMatch && request.method === 'GET') {
      try {
        assertPermission(auth, 'search.read');
        const sessionId = sessionMatch[1];
        if (!sessionId) {
          return jsonResponse({ error: 'Session id required' }, 400, requestCorsHeaders);
        }
        const row = await env.DB.prepare(
          'SELECT id, owner_user_id, source_type, scope_json, state_json, created_at, expires_at FROM investigation_sessions WHERE id = ?'
        ).bind(sessionId).first<{
          id: string;
          owner_user_id: string | null;
          source_type: string | null;
          scope_json: string;
          state_json: string;
          created_at: string;
          expires_at: string | null;
        }>();
        if (!row) {
          return jsonResponse({ error: 'Session not found' }, 404, requestCorsHeaders);
        }
        const principal = auth.email || auth.principal;
        const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
        if (!canAccessInvestigationSession(row.owner_user_id, principal, isAdmin)) {
          throw new Error('Forbidden');
        }
        return jsonResponse({
          id: row.id,
          owner_user_id: row.owner_user_id,
          source_type: row.source_type,
          scope_json: row.scope_json,
          state_json: row.state_json,
          created_at: row.created_at,
          expires_at: row.expires_at
        }, 200, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders);
      }
    }

    if (url.pathname.startsWith('/users')) {
      try {
        return await handleUsers(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/admin/synthetic-ingest')) {
      try {
        return await handleSyntheticIngestAdmin(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/roles')) {
      try {
        return await handleRoles(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/rbac/mappings')) {
      try {
        return await handleRbacMappings(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/audit')) {
      try {
        return await handleAudit(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/alerts')) {
      try {
        const response = await handleAlerts(request, env, url.pathname, auth, requestCorsHeaders);
        await writeOpsMetric(env, 'query_latency_ms', Date.now() - startedAt).catch(() => undefined);
        return response;
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/saved-searches')) {
      try {
        return await handleSavedSearches(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/lookup-tables')) {
      try {
        return await handleLookupTables(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/dashboards')) {
      try {
        return await handleDashboards(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    if (url.pathname.startsWith('/scheduled-searches')) {
      try {
        return await handleScheduledSearches(request, env, url.pathname, auth, requestCorsHeaders);
      } catch (error) {
        await writeOpsMetric(env, 'query_errors_total', 1).catch(() => undefined);
        return errorResponse(error, requestCorsHeaders, 500);
      }
    }

    return textResponse('Not found', 404, requestCorsHeaders);
  }
};
