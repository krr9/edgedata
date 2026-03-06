export const STARTER_ALERT_PACK_VERSION = 'v1';

const BASE_TEMPLATES = [
  {
    starter_id: 'error-rate-spike',
    name: 'Starter: Service Error Rate Spike',
    type: 'wae_sql',
    query_template: 'error_rate_over_threshold',
    params: { window_minutes: 5 },
    threshold: { operator: 'gt', value: 5 },
    schedule_seconds: 60,
    cooldown_seconds: 300,
    deep_query: 'search * | where level="error" and status>=500',
    runbook_slug: 'error-rate-spike',
    severity: 'critical'
  },
  {
    starter_id: 'latency-p95-regression',
    name: 'Starter: Service Latency p95 Regression',
    type: 'wae_sql',
    query_template: 'latency_p95_over_threshold',
    params: { window_minutes: 10 },
    threshold: { operator: 'gt', value: 1200 },
    schedule_seconds: 60,
    cooldown_seconds: 300,
    deep_query: 'search * | where duration_ms>=1200',
    runbook_slug: 'latency-regression',
    severity: 'warn'
  },
  {
    starter_id: 'auth-failure-token-spike',
    name: 'Starter: Authentication Failure Token Spike',
    type: 'r2sql_token_spike',
    query_template: 'token_spike',
    params: { token: 'unauthorized', window_minutes: 5 },
    threshold: { operator: 'gt', value: 20 },
    schedule_seconds: 60,
    cooldown_seconds: 300,
    deep_query: 'search unauthorized | where status>=401',
    runbook_slug: 'auth-failure-spike',
    severity: 'critical'
  }
];

function trimTrailingSlash(input) {
  return String(input || '').trim().replace(/\/+$/, '');
}

function buildDeepLink(base, query) {
  const normalizedBase = trimTrailingSlash(base);
  if (!normalizedBase) return '';
  return `${normalizedBase}/?view=search&query=${encodeURIComponent(query)}`;
}

function buildRunbookUrl(base, slug) {
  const normalizedBase = trimTrailingSlash(base);
  if (!normalizedBase) return '';
  return `${normalizedBase}/${slug}`;
}

function injectIndexIntoDeepQuery(query, index) {
  const indexValue = String(index || '').trim().toLowerCase();
  if (!indexValue) return query;
  const trimmed = String(query || '').trim();
  if (!trimmed) return `search * | where index="${indexValue}"`;
  const whereMatch = trimmed.match(/^search\s+(.+?)\s+\|\s+where\s+(.+)$/i);
  if (whereMatch) {
    return `search ${whereMatch[1]} | where index="${indexValue}" and ${whereMatch[2]}`;
  }
  return `${trimmed} | where index="${indexValue}"`;
}

export function extractStarterIdFromParamsJson(paramsJson) {
  if (!paramsJson) return null;
  try {
    const parsed = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
    const id = parsed?._starter_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

export function buildStarterAlertPackDefinitions(options = {}) {
  const index = String(options.index || '').trim().toLowerCase();
  const service = String(options.service || '').trim();
  const env = String(options.env || '').trim();
  const deepLinkBase = String(options.deep_link_base || '').trim();
  const runbookBase = String(options.runbook_base_url || '').trim();
  const ownerTeam = String(options.owner_team || '').trim();
  const notifySlack = options.notify_slack !== false;
  const notifyWebhook = options.notify_webhook === true;

  return BASE_TEMPLATES.map((template) => {
    const params = {
      ...template.params,
      _starter_id: template.starter_id,
      _starter_version: STARTER_ALERT_PACK_VERSION
    };
    if (service) params.service = service;
    if (env) params.env = env;
    if (index) params.index = index;

    const notify = {
      slack: notifySlack,
      webhook: notifyWebhook,
      severity: template.severity,
      deep_link: buildDeepLink(deepLinkBase, injectIndexIntoDeepQuery(template.deep_query, index)),
      runbook_url: buildRunbookUrl(runbookBase, template.runbook_slug),
      owner_team: ownerTeam || undefined
    };

    return {
      starter_id: template.starter_id,
      name: template.name,
      type: template.type,
      query_template: template.query_template,
      params_json: JSON.stringify(params),
      threshold_json: JSON.stringify(template.threshold),
      notify_json: JSON.stringify(notify),
      schedule_seconds: template.schedule_seconds,
      cooldown_seconds: template.cooldown_seconds
    };
  });
}
