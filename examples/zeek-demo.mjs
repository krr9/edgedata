#!/usr/bin/env node

const INGEST_URL = process.env.INGEST_URL || 'https://ingest-worker.example.workers.dev';
const QUERY_URL = process.env.QUERY_URL || 'https://query-worker.example.workers.dev';
const ALERT_URL = process.env.ALERT_URL || 'https://alert-worker.example.workers.dev';
const INGEST_SECRET = process.env.INGEST_SECRET || 'edgedata-test-secret';
const ALERT_RUN_SECRET = process.env.ALERT_RUN_SECRET || '';
const QUERY_AUTH_TOKEN = process.env.QUERY_AUTH_TOKEN || '';

const MAX_FILES = Number(process.env.ZEEK_MAX_FILES || 75);
const MAX_EVENTS = Number(process.env.ZEEK_MAX_EVENTS || 1800);
const BATCH_SIZE = Number(process.env.ZEEK_BATCH_SIZE || 200);

const TREE_API = 'https://api.github.com/repos/zeek/zeek/git/trees/master?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/zeek/zeek/master/';

const state = {
  baseMs: Date.now() - (45 * 60 * 1000),
  eventIndex: 0
};

function decodeEscaped(value) {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function directiveValue(line) {
  const tab = line.indexOf('\t');
  if (tab !== -1) return line.slice(tab + 1);
  const space = line.indexOf(' ');
  if (space !== -1) return line.slice(space + 1);
  return '';
}

function asNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildMessage(pathName, record) {
  const uid = record.uid || '-';
  const orig = record['id.orig_h'] || '-';
  const origPort = record['id.orig_p'] || '-';
  const resp = record['id.resp_h'] || '-';
  const respPort = record['id.resp_p'] || '-';

  if (pathName === 'conn') {
    return `zeek conn ${record.proto || '-'} ${orig}:${origPort} -> ${resp}:${respPort} service=${record.service || '-'} state=${record.conn_state || '-'} bytes=${record.orig_bytes || 0}/${record.resp_bytes || 0}`;
  }
  if (pathName === 'dns') {
    return `zeek dns ${orig}:${origPort} -> ${resp}:${respPort} query=${record.query || '-'} qtype=${record.qtype_name || record.qtype || '-'} rcode=${record.rcode_name || record.rcode || '-'}`;
  }
  if (pathName === 'http') {
    const method = record.method || '-';
    const host = record.host || record['id.resp_h'] || '-';
    const uri = record.uri || '/';
    return `zeek http ${method} ${host}${uri} status=${record.status_code || '-'} ua=${record.user_agent || '-'}`;
  }
  if (pathName === 'ssl') {
    return `zeek ssl ${orig}:${origPort} -> ${resp}:${respPort} server_name=${record.server_name || '-'} version=${record.version || '-'} cipher=${record.cipher || '-'}`;
  }
  if (pathName === 'notice') {
    return `zeek notice ${record.note || '-'} msg=${record.msg || '-'}`;
  }

  return `zeek ${pathName} uid=${uid} ${orig}:${origPort} -> ${resp}:${respPort}`;
}

function inferLevel(pathName, record) {
  if (pathName === 'notice') return 'error';

  if (pathName === 'http') {
    const status = asNumber(record.status_code);
    if (status !== undefined && status >= 500) return 'error';
    if (status !== undefined && status >= 400) return 'warn';
    return 'info';
  }

  if (pathName === 'dns') {
    const rcode = String(record.rcode_name || record.rcode || '').toUpperCase();
    if (rcode.includes('NXDOMAIN') || rcode.includes('SERVFAIL')) return 'warn';
    return 'info';
  }

  if (pathName === 'conn') {
    const stateName = String(record.conn_state || '').toUpperCase();
    if (['S0', 'REJ', 'RSTO', 'RSTR', 'RSTOS0', 'SH', 'SHR'].includes(stateName)) return 'warn';
    return 'info';
  }

  return 'info';
}

function toEvent(pathName, sourcePath, record) {
  const eventTs = new Date(state.baseMs + (state.eventIndex * 1000)).toISOString();
  state.eventIndex += 1;

  const service = `zeek-${pathName || 'unknown'}`;
  const level = inferLevel(pathName, record);
  const status = asNumber(record.status_code);
  const durationSeconds = asNumber(record.duration);
  const durationMs = durationSeconds !== undefined ? Math.round(durationSeconds * 1000) : undefined;

  const attrs = {
    zeek_path: pathName,
    source_path: sourcePath,
    ...record
  };

  return {
    ts: eventTs,
    service,
    env: 'demo',
    host: String(record['id.orig_h'] || record['id.resp_h'] || 'zeek-sensor'),
    level,
    message: buildMessage(pathName, record),
    trace_id: record.uid || undefined,
    request_id: record.fuid || record.uid || undefined,
    status,
    duration_ms: durationMs,
    src_ip: record['id.orig_h'] || undefined,
    user_id: record.uid || undefined,
    attrs_json: JSON.stringify(attrs)
  };
}

function parseZeekLog(sourcePath, body) {
  const lines = body.split(/\r?\n/);
  let separator = '\t';
  let emptyField = '(empty)';
  let unsetField = '-';
  let pathName = 'unknown';
  let fields = [];

  const events = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith('### BTest baseline')) continue;

    if (line.startsWith('#separator')) {
      separator = decodeEscaped(directiveValue(line));
      continue;
    }
    if (line.startsWith('#empty_field')) {
      emptyField = directiveValue(line);
      continue;
    }
    if (line.startsWith('#unset_field')) {
      unsetField = directiveValue(line);
      continue;
    }
    if (line.startsWith('#path')) {
      pathName = directiveValue(line);
      continue;
    }
    if (line.startsWith('#fields')) {
      fields = line.split(separator).slice(1);
      continue;
    }
    if (line.startsWith('#')) continue;
    if (fields.length === 0) continue;

    const cols = line.split(separator);
    if (cols.length !== fields.length) continue;

    const record = {};
    for (let i = 0; i < fields.length; i++) {
      const key = fields[i];
      const value = cols[i];
      if (value === unsetField) continue;
      record[key] = value === emptyField ? '' : value;
    }

    events.push(toEvent(pathName, sourcePath, record));
  }

  return events;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'edgedata-zeek-demo/1.0' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url, init) {
  const headers = new Headers(init?.headers || {});
  if (url.startsWith(QUERY_URL) && QUERY_AUTH_TOKEN) {
    headers.set('authorization', `Bearer ${QUERY_AUTH_TOKEN}`);
  }
  const response = await fetch(url, { ...init, headers });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function listZeekLogPaths() {
  const tree = await fetchJson(TREE_API, { headers: { 'user-agent': 'edgedata-zeek-demo/1.0' } });
  const all = (tree.tree || [])
    .map((node) => node.path)
    .filter((path) => typeof path === 'string')
    .filter((path) => path.startsWith('testing/btest/Baseline/'))
    .filter((path) => /\.(log)$/.test(path))
    .filter((path) => /(conn|dns|http|ssl|notice)\.log$/.test(path))
    .sort();

  const selected = [];
  const used = new Set();

  const take = (pattern, limit) => {
    for (const path of all) {
      if (selected.length >= MAX_FILES) return;
      if (used.has(path)) continue;
      if (!pattern.test(path)) continue;
      used.add(path);
      selected.push(path);
      if (selected.filter((p) => pattern.test(p)).length >= limit) return;
    }
  };

  take(/conn\.log$/, 35);
  take(/dns\.log$/, 18);
  take(/http\.log$/, 18);
  take(/ssl\.log$/, 6);
  take(/notice\.log$/, 4);

  for (const path of all) {
    if (selected.length >= MAX_FILES) break;
    if (used.has(path)) continue;
    used.add(path);
    selected.push(path);
  }

  return selected.slice(0, MAX_FILES);
}

async function ingestEvents(events) {
  let ingested = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const response = await fetch(`${INGEST_URL}/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INGEST_SECRET}`,
        'x-service': 'zeek-demo',
        'x-env': 'demo',
        'x-host': 'zeek-loader'
      },
      body: JSON.stringify({ events: batch })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Ingest failed: ${response.status} ${JSON.stringify(body)}`);
    }
    ingested += Number(body.ingested || 0);
    process.stdout.write(`Ingested batch ${Math.floor(i / BATCH_SIZE) + 1} (${ingested}/${events.length})\n`);
  }
}

function timeWindow() {
  const from = new Date(state.baseMs - (5 * 60 * 1000)).toISOString();
  const to = new Date(Date.now() + (5 * 60 * 1000)).toISOString();
  return { from, to };
}

async function postQuery(path, payload) {
  const response = await fetch(`${QUERY_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(QUERY_AUTH_TOKEN ? { authorization: `Bearer ${QUERY_AUTH_TOKEN}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function ensureSavedSearch(name, query) {
  const existing = await fetchJson(`${QUERY_URL}/saved-searches`);
  if (Array.isArray(existing) && existing.find((item) => item.name === name)) return;

  await postQuery('/saved-searches', { name, query });
}

async function ensureAlert(name, def) {
  const existing = await fetchJson(`${QUERY_URL}/alerts`);
  if (Array.isArray(existing) && existing.find((item) => item.name === name)) return;

  await postQuery('/alerts', { name, ...def });
}

async function runShowcase(events, paths) {
  const tw = timeWindow();
  const basePayload = {
    time: tw,
    limit: 50,
    cursor: null
  };

  const searches = [
    { label: 'Conn anomalies', payload: { ...basePayload, ppl: 'search s0 rej rst | where index="default" and service="zeek-conn" and env="demo" | head 50' } },
    { label: 'DNS activity', payload: { ...basePayload, ppl: 'search query rcode | where index="default" and service="zeek-dns" and env="demo" | head 50' } },
    { label: 'HTTP errors', payload: { ...basePayload, ppl: 'search * | where index="default" and service="zeek-http" and env="demo" and status>=400 | head 50' } }
  ];

  process.stdout.write('\nSearch showcase\n');
  for (const item of searches) {
    const resp = await postQuery('/search', item.payload);
    const summary = await postQuery('/search/summary', item.payload);
    process.stdout.write(`- ${item.label}: returned=${resp.results.length}, mode=${resp.stats.mode}, candidates=${resp.stats.candidates}, top_terms=${(summary.top_terms || []).slice(0, 4).map((x) => x.value).join(', ')}\n`);
  }

  process.stdout.write('\nDashboard showcase\n');
  for (const query of ['throughput', 'top_hosts', 'top_errors', 'error_rate_by_service', 'latency_p95_by_service']) {
    const body = await postQuery('/dashboards/query', { query, params: { window_minutes: 120 } });
    process.stdout.write(`- ${query}: rows=${(body.results || []).length}\n`);
  }

  await ensureSavedSearch('Zeek Demo - Conn Issues', 'search s0 rej rst | where index="default" and service="zeek-conn" and env="demo"');
  await ensureSavedSearch('Zeek Demo - DNS Overview', 'search query rcode | where index="default" and service="zeek-dns" and env="demo"');
  await ensureSavedSearch('Zeek Demo - HTTP Failures', 'search * | where index="default" and service="zeek-http" and env="demo" and status>=400');

  await ensureAlert('Zeek Demo - S0 Spike', {
    enabled: 1,
    type: 'r2sql_token_spike',
    query_template: 'token_spike',
    params_json: '{"token":"s0","service":"zeek-conn","env":"demo","window_minutes":30}',
    schedule_seconds: 300,
    threshold_json: '{"operator":"gt","value":3}',
    notify_json: '{}',
    cooldown_seconds: 300
  });

  await ensureAlert('Zeek Demo - HTTP Error Rate', {
    enabled: 1,
    type: 'wae_sql',
    query_template: 'error_rate_over_threshold',
    params_json: '{"service":"zeek-http","env":"demo","window_minutes":30}',
    schedule_seconds: 300,
    threshold_json: '{"operator":"gt","value":1}',
    notify_json: '{}',
    cooldown_seconds: 300
  });

  const runResp = await fetchJson(`${ALERT_URL}/run`, {
    method: 'POST',
    headers: ALERT_RUN_SECRET ? { authorization: `Bearer ${ALERT_RUN_SECRET}` } : undefined
  });
  const alerts = await fetchJson(`${QUERY_URL}/alerts`);

  const perService = events.reduce((acc, event) => {
    acc[event.service] = (acc[event.service] || 0) + 1;
    return acc;
  }, {});

  process.stdout.write('\nDemo summary\n');
  process.stdout.write(`- source: ${RAW_BASE}testing/btest/Baseline/... (public Zeek repository)\n`);
  process.stdout.write(`- files_used: ${paths.length}\n`);
  process.stdout.write(`- events_ingested: ${events.length}\n`);
  process.stdout.write(`- services: ${Object.entries(perService).map(([k, v]) => `${k}=${v}`).join(', ')}\n`);
  process.stdout.write(`- alerts_total: ${Array.isArray(alerts) ? alerts.length : 0}\n`);
  process.stdout.write(`- alert_run: evaluated=${runResp.evaluated || 0}, failed=${runResp.failed || 0}\n`);
}

async function main() {
  process.stdout.write('Loading public Zeek log paths...\n');
  const selectedPaths = await listZeekLogPaths();
  process.stdout.write(`Selected ${selectedPaths.length} Zeek files\n`);

  const events = [];

  for (const path of selectedPaths) {
    if (events.length >= MAX_EVENTS) break;
    const url = `${RAW_BASE}${path}`;
    try {
      const body = await fetchText(url);
      const parsed = parseZeekLog(path, body);
      if (parsed.length === 0) continue;
      const remaining = MAX_EVENTS - events.length;
      events.push(...parsed.slice(0, remaining));
      process.stdout.write(`- ${path}: events=${parsed.length}\n`);
    } catch (error) {
      process.stdout.write(`- skipped ${path}: ${String(error)}\n`);
    }
  }

  if (events.length === 0) {
    throw new Error('No Zeek events parsed from selected public sources');
  }

  process.stdout.write(`\nIngesting ${events.length} events to ${INGEST_URL}\n`);
  await ingestEvents(events);

  process.stdout.write('Waiting for async index writes...\n');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  await runShowcase(events, selectedPaths);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
