const COMMANDS = new Set(['search', 'where', 'fields', 'sort', 'head', 'stats']);

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

function parseStatsClause(body) {
  const match = body.match(
    /^count\s*\(\s*(?:\*|)\s*\)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s+by\s+(.+)$/i
  );
  if (!match) {
    throw new Error('stats currently supports: count() by <field>[, <field>...]');
  }
  const as = (match[1] || 'count').trim();
  const by = parseFieldsClause(match[2]);
  if (by.length === 0) throw new Error('stats requires at least one group-by field');
  return { fn: 'count', as, by };
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
  }

  return {
    raw: String(input || '').trim(),
    stages
  };
}
