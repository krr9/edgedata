const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'from',
  'of', 'in', 'on', 'at', 'by', 'with', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'as', 'it', 'this', 'that', 'these', 'those', 'not'
]);

const MAX_DATES = 31;
const MAX_TIME_WINDOW_DAYS = {
  structured: 7,
  token: 14,
  phrase: 0.25
};

export function tokenize(text) {
  const cleaned = String(text || '').toLowerCase().normalize('NFKD').replace(/[-_]/g, ' ');
  const parts = cleaned.split(/[^a-z0-9]+/).map((token) => token.trim()).filter(Boolean);

  const result = [];
  const seen = new Set();
  for (const token of parts) {
    if (token.length < 2 || token.length > 32) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }

  return result.slice(0, 12);
}

export function parseQueryInput(input) {
  let remaining = String(input || '').trim();
  let phrase = null;

  const phraseMatch = remaining.match(/phrase\s*=\s*"([^"]+)"|"([^"]+)"/i);
  if (phraseMatch) {
    phrase = (phraseMatch[1] || phraseMatch[2] || '').trim().toLowerCase() || null;
    remaining = remaining.replace(phraseMatch[0], ' ').trim();
  }

  const extractedFilters = {};
  const comparatorRegex = /\b(status|duration_ms)\s*(>=|<=|>|<)\s*([0-9]+(?:\.[0-9]+)?)/g;
  const opToSuffix = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };

  let cmp;
  while ((cmp = comparatorRegex.exec(remaining)) !== null) {
    const field = cmp[1];
    const suffix = opToSuffix[cmp[2]];
    extractedFilters[`${field}__${suffix}`] = cmp[3];
  }
  remaining = remaining.replace(comparatorRegex, ' ');

  const filterRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("[^"]+"|[^\s]+)/g;
  let match;
  while ((match = filterRegex.exec(remaining)) !== null) {
    const key = match[1].trim();
    const rawValue = match[2].trim();
    const value = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    extractedFilters[key] = value;
  }

  const withoutFilters = remaining.replace(filterRegex, ' ').replace(/\s+/g, ' ').trim();
  const tokens = tokenize(withoutFilters.replace(/\bq\s*=\s*/gi, ' '));

  return { phrase, tokens, extractedFilters };
}

export function mergeFilters(raw, parsed) {
  const merged = {};

  for (const [key, value] of Object.entries(raw || {})) {
    if (value === undefined || value === null || value === '') continue;
    merged[key] = String(value);
  }

  for (const [key, value] of Object.entries(parsed || {})) {
    merged[key] = String(value);
  }

  const filters = {};
  if (merged.index) filters.index = String(merged.index).toLowerCase();
  if (merged.service) filters.service = merged.service;
  if (merged.env) filters.env = merged.env;
  if (merged.host) filters.host = merged.host;
  if (merged.level) filters.level = merged.level.toLowerCase();
  if (merged.user_id) filters.user_id = merged.user_id;
  if (merged.src_ip) filters.src_ip = merged.src_ip;
  if (merged.trace_id) filters.trace_id = merged.trace_id;
  if (merged.request_id) filters.request_id = merged.request_id;
  if (merged.msg_hash) filters.msg_hash = merged.msg_hash;

  if (merged.status !== undefined) {
    const status = Number(merged.status);
    if (Number.isFinite(status)) filters.status = Math.trunc(status);
  }
  if (merged.status__gt !== undefined) {
    const status = Number(merged.status__gt);
    if (Number.isFinite(status)) filters.status_gt = Math.trunc(status);
  }
  if (merged.status__gte !== undefined) {
    const status = Number(merged.status__gte);
    if (Number.isFinite(status)) filters.status_gte = Math.trunc(status);
  }
  if (merged.status__lt !== undefined) {
    const status = Number(merged.status__lt);
    if (Number.isFinite(status)) filters.status_lt = Math.trunc(status);
  }
  if (merged.status__lte !== undefined) {
    const status = Number(merged.status__lte);
    if (Number.isFinite(status)) filters.status_lte = Math.trunc(status);
  }

  if (merged.duration_ms !== undefined) {
    const duration = Number(merged.duration_ms);
    if (Number.isFinite(duration)) filters.duration_gte = duration;
  }
  if (merged.duration_ms__gt !== undefined) {
    const duration = Number(merged.duration_ms__gt);
    if (Number.isFinite(duration)) filters.duration_gt = duration;
  }
  if (merged.duration_ms__gte !== undefined) {
    const duration = Number(merged.duration_ms__gte);
    if (Number.isFinite(duration)) filters.duration_gte = duration;
  }
  if (merged.duration_ms__lt !== undefined) {
    const duration = Number(merged.duration_ms__lt);
    if (Number.isFinite(duration)) filters.duration_lt = duration;
  }
  if (merged.duration_ms__lte !== undefined) {
    const duration = Number(merged.duration_ms__lte);
    if (Number.isFinite(duration)) filters.duration_lte = duration;
  }

  return filters;
}

export function inferSearchMode(parsed, explicitPhrase) {
  if ((explicitPhrase && explicitPhrase.trim()) || parsed?.phrase) return 'phrase';
  if ((parsed?.tokens || []).length > 0) return 'token';
  return 'structured';
}

export function parseISODate(input) {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${input}`);
  }
  return parsed;
}

export function getDateRange(fromIso, toIso) {
  const from = parseISODate(fromIso);
  const to = parseISODate(toIso);

  if (from > to) {
    throw new Error('Invalid time range: from must be before to');
  }

  const dates = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (dates.length > MAX_DATES) break;
  }

  return dates;
}

export function enforceTimeGuardrails(fromIso, toIso, mode) {
  const from = parseISODate(fromIso).getTime();
  const to = parseISODate(toIso).getTime();
  const diffDays = (to - from) / (1000 * 60 * 60 * 24);

  if (diffDays < 0) {
    throw new Error('Invalid time range');
  }

  const maxDays = MAX_TIME_WINDOW_DAYS[mode];
  if (diffDays > maxDays) {
    if (mode === 'phrase') {
      throw new Error('Phrase search limited to 6 hours');
    }
    throw new Error(`${mode} search limited to ${maxDays} days`);
  }
}
