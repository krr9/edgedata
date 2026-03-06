const COMMANDS = new Set(['search', 'where', 'fields', 'sort', 'head', 'stats', 'timechart', 'top', 'rare']);

const FIELD_ALIASES = {
  '@timestamp': 'ts',
  timestamp: 'ts',
  idx: 'index',
  environment: 'env',
  status_code: 'status'
};

function normalizeField(field) {
  const normalized = String(field || '').trim().toLowerCase();
  return FIELD_ALIASES[normalized] || normalized;
}

function unquote(value) {
  const raw = String(value || '').trim();
  if (raw.length < 2) return raw;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    const body = raw.slice(1, -1);
    return body
      .replace(/\\'/g, '\'')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return raw;
}

function parseLiteral(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith('\'') && raw.endsWith('\''))
  ) {
    return unquote(raw);
  }

  if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(raw)) return Number(raw);
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  return raw;
}

function splitPipeline(input) {
  const text = String(input || '').trim();
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (quote) throw new Error('Unclosed quote in PPL query');
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function splitWhereConditions(input) {
  const text = String(input || '').trim();
  if (!text) return [];

  const parts = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    const rest = text.slice(i);
    const andMatch = rest.match(/^\s+and\s+/i);
    const orMatch = rest.match(/^\s+or\s+/i);
    if (orMatch) {
      throw new Error('PPL where currently supports only AND conditions');
    }
    if (andMatch) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += andMatch[0].length - 1;
      continue;
    }

    current += char;
  }

  if (quote) throw new Error('Unclosed quote in where clause');
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseWhereClause(body) {
  const clauses = splitWhereConditions(body);
  if (clauses.length === 0) throw new Error('where requires at least one condition');
  return clauses.map((clause) => {
    const match = clause.match(/^([@a-zA-Z_][a-zA-Z0-9_@.]*)\s*(=|!=|>=|<=|>|<)\s*(.+)$/);
    if (!match) {
      throw new Error(`Invalid where condition: ${clause}`);
    }
    const field = normalizeField(match[1]);
    const operator = match[2];
    const value = parseLiteral(match[3]);
    return { field, operator, value };
  });
}

function parseFieldsClause(body) {
  if (!body.trim()) throw new Error('fields requires one or more field names');
  const fields = body
    .split(',')
    .flatMap((part) => part.trim().split(/\s+/))
    .map((field) => normalizeField(field))
    .filter(Boolean);
  if (fields.length === 0) throw new Error('fields requires one or more field names');
  return Array.from(new Set(fields));
}

function parseSortClause(body) {
  if (!body.trim()) throw new Error('sort requires at least one key');
  const keys = body
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('-') || part.startsWith('+')) {
        const direction = part[0] === '-' ? 'desc' : 'asc';
        const field = normalizeField(part.slice(1));
        if (!field) throw new Error(`Invalid sort key: ${part}`);
        return { field, direction };
      }

      const match = part.match(/^([@a-zA-Z_][a-zA-Z0-9_@.]*)(?:\s+(asc|desc))?$/i);
      if (!match) throw new Error(`Invalid sort key: ${part}`);
      const field = normalizeField(match[1]);
      const direction = (match[2] || 'asc').toLowerCase();
      return { field, direction };
    });
  return keys;
}

function parseHeadClause(body) {
  const count = Number(body.trim());
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('head requires a positive integer');
  }
  return Math.min(5000, Math.trunc(count));
}

const STATS_FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'dc', 'values', 'earliest', 'latest']);

function parseStatsClause(body) {
  const byMatch = body.match(/^(.+?)\s+by\s+(.+)$/i);
  if (!byMatch) {
    throw new Error('stats requires: <agg_fn>(<field>) [as <alias>] [<agg_fn>...] by <field>[, <field>...]');
  }

  const aggPart = byMatch[1].trim();
  const by = parseFieldsClause(byMatch[2]);
  if (by.length === 0) throw new Error('stats requires at least one group-by field');

  const aggRegex = /(\w+)\s*\(\s*(\*|[a-zA-Z_][a-zA-Z0-9_@.]*)?\s*\)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  const aggregations = [];
  let match;

  while ((match = aggRegex.exec(aggPart)) !== null) {
    const fn = match[1].toLowerCase();
    if (!STATS_FUNCTIONS.has(fn)) {
      throw new Error(`Unsupported stats function: ${fn}`);
    }
    const field = (fn === 'count') ? null : normalizeField(match[2] || '');
    if (fn !== 'count' && !field) {
      throw new Error(`${fn}() requires a field argument`);
    }
    const as = match[3] || (fn === 'count' ? 'count' : `${fn}_${field}`);
    aggregations.push({ fn, field, as });
  }

  if (aggregations.length === 0) {
    throw new Error('stats requires at least one aggregation function');
  }

  return { fn: aggregations[0].fn, as: aggregations[0].as, by, aggregations };
}

function parseTopRareClause(body) {
  const byMatch = body.match(/^(.+?)\s+by\s+(\S+)$/i);
  const mainPart = byMatch ? byMatch[1].trim() : body.trim();
  const by = byMatch ? normalizeField(byMatch[2]) : null;

  const parts = mainPart.split(/\s+/);
  if (parts.length < 2) throw new Error('top/rare requires: <N> <field>');
  const count = parseInt(parts[0], 10);
  if (!Number.isFinite(count) || count <= 0) throw new Error('top/rare requires a positive integer count');
  const field = normalizeField(parts[1]);
  if (!field) throw new Error('top/rare requires a field name');

  return { count: Math.min(count, 1000), field, by };
}

const SPAN_REGEX = /^(\d+)(m|h|d)$/;
const SPAN_MULTIPLIERS = { m: 60000, h: 3600000, d: 86400000 };

function parseSpan(span) {
  const match = span.match(SPAN_REGEX);
  if (!match) throw new Error(`Invalid timechart span: ${span}. Use Nm, Nh, or Nd.`);
  return { span, spanMs: parseInt(match[1], 10) * SPAN_MULTIPLIERS[match[2]] };
}

function parseTimechartClause(body) {
  const spanMatch = body.match(/span\s*=\s*(\S+)/i);
  if (!spanMatch) throw new Error('timechart requires span=<interval> (e.g., span=5m)');
  const { span, spanMs } = parseSpan(spanMatch[1]);

  const rest = body.replace(/span\s*=\s*\S+/i, '').trim();
  const byMatch = rest.match(/^(.+?)\s+by\s+(\S+)$/i);
  const aggPart = byMatch ? byMatch[1].trim() : rest;
  const by = byMatch ? normalizeField(byMatch[2]) : null;

  const aggRegex = /(\w+)\s*\(\s*(\*|[a-zA-Z_][a-zA-Z0-9_@.]*)?\s*\)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  const aggregations = [];
  let m;
  while ((m = aggRegex.exec(aggPart)) !== null) {
    const fn = m[1].toLowerCase();
    if (!STATS_FUNCTIONS.has(fn)) throw new Error(`Unsupported timechart function: ${fn}`);
    const field = fn === 'count' ? null : normalizeField(m[2] || '');
    if (fn !== 'count' && !field) throw new Error(`${fn}() requires a field argument`);
    const as = m[3] || (fn === 'count' ? 'count' : `${fn}_${field}`);
    aggregations.push({ fn, field, as });
  }
  if (aggregations.length === 0) throw new Error('timechart requires at least one aggregation');

  return { span, spanMs, aggregations, by };
}

export function parsePplPipeline(input) {
  const segments = splitPipeline(input);
  if (segments.length === 0) {
    throw new Error('ppl query is required');
  }

  const stages = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const firstToken = segment.split(/\s+/, 1)[0].toLowerCase();
    if (index === 0 && !COMMANDS.has(firstToken)) {
      stages.push({ command: 'search', expression: segment, implicit: true });
      continue;
    }

    if (!COMMANDS.has(firstToken)) {
      throw new Error(`Unsupported PPL command: ${firstToken}`);
    }

    const body = segment.slice(firstToken.length).trim();
    if (firstToken === 'search') {
      if (!body) throw new Error('search requires a query expression');
      stages.push({ command: 'search', expression: body, implicit: false });
      continue;
    }
    if (firstToken === 'where') {
      stages.push({ command: 'where', conditions: parseWhereClause(body) });
      continue;
    }
    if (firstToken === 'fields') {
      stages.push({ command: 'fields', fields: parseFieldsClause(body) });
      continue;
    }
    if (firstToken === 'sort') {
      stages.push({ command: 'sort', keys: parseSortClause(body) });
      continue;
    }
    if (firstToken === 'head') {
      stages.push({ command: 'head', count: parseHeadClause(body) });
      continue;
    }
    if (firstToken === 'stats') {
      stages.push({ command: 'stats', ...parseStatsClause(body) });
      continue;
    }
    if (firstToken === 'timechart') {
      stages.push({ command: 'timechart', ...parseTimechartClause(body) });
      continue;
    }
    if (firstToken === 'top') {
      stages.push({ command: 'top', ...parseTopRareClause(body) });
      continue;
    }
    if (firstToken === 'rare') {
      stages.push({ command: 'rare', ...parseTopRareClause(body) });
      continue;
    }
  }

  return {
    raw: String(input || '').trim(),
    stages
  };
}
