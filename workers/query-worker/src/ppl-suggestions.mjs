const COMMAND_SPECS = [
  { command: 'search', detail: 'Free text query over indexed logs', example: 'search timeout postgres' },
  { command: 'where', detail: 'Filter rows using field comparisons', example: 'where service="payments" and status>=500' },
  { command: 'fields', detail: 'Keep only selected fields', example: 'fields ts, service, level, message' },
  { command: 'sort', detail: 'Sort rows by one or more fields', example: 'sort -ts' },
  { command: 'head', detail: 'Return first N rows', example: 'head 100' },
  { command: 'stats', detail: 'Aggregate and group results', example: 'stats count() by service' },
  { command: 'timechart', detail: 'Time-bucketed aggregation', example: 'timechart span=5m count() by level' },
  { command: 'top', detail: 'Most frequent values', example: 'top 10 host' },
  { command: 'rare', detail: 'Least frequent values', example: 'rare 10 src_ip' },
  { command: 'dedup', detail: 'Keep first row per key', example: 'dedup trace_id' },
  { command: 'eval', detail: 'Compute derived fields', example: 'eval duration_sec=duration_ms/1000' },
  { command: 'lookup', detail: 'Enrich from lookup table', example: 'lookup service_owners service output team, oncall' },
  { command: 'rex', detail: 'Extract regex capture groups', example: 'rex field=message "(?<code>E[0-9]{4})"' },
  { command: 'transaction', detail: 'Group related events', example: 'transaction trace_id maxspan=5m maxevents=100' },
  { command: 'rename', detail: 'Rename output fields', example: 'rename duration_ms as latency_ms' },
  { command: 'table', detail: 'Alias of fields projection', example: 'table ts, service, message' }
];

const COMMAND_SET = new Set(COMMAND_SPECS.map((item) => item.command));
const FIELD_SUGGESTIONS = [
  'index',
  'service',
  'env',
  'host',
  'level',
  'status',
  'trace_id',
  'request_id',
  'user_id',
  'msg_hash',
  'src_ip',
  'duration_ms',
  'message',
  'ts'
];

function splitPipeline(input) {
  const text = String(input || '');
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
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function rankByPrefix(candidate, prefix) {
  if (!prefix) return 30;
  const lcCandidate = candidate.toLowerCase();
  const lcPrefix = prefix.toLowerCase();
  if (lcCandidate === lcPrefix) return 120;
  if (lcCandidate.startsWith(lcPrefix)) return 90 - lcCandidate.length;
  if (lcCandidate.includes(lcPrefix)) return 45 - lcCandidate.indexOf(lcPrefix);
  return -1000;
}

function buildNextQuery(prefixQuery, segmentStart, segmentEnd, replacement) {
  const rawPrefix = prefixQuery.slice(0, segmentStart);
  const suffix = prefixQuery.slice(segmentEnd);
  let left = rawPrefix;
  if (left.endsWith('|')) {
    left += ' ';
  }
  const right = suffix;
  return `${left}${replacement}${right}`;
}

function uniqPush(target, byKey, key, value) {
  if (byKey.has(key)) return;
  byKey.add(key);
  target.push(value);
}

function normalizeContext(context) {
  const topTerms = Array.isArray(context?.topTerms)
    ? context.topTerms.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return { topTerms };
}

export function getPplSuggestions(options = {}) {
  const query = String(options.query || '');
  const cursorPos = Number.isInteger(options.cursorPos)
    ? Math.max(0, Math.min(options.cursorPos, query.length))
    : query.length;
  const maxItems = Math.max(1, Math.min(20, Number(options.maxItems) || 8));
  const context = normalizeContext(options.context);

  const segments = splitPipeline(query.slice(0, cursorPos));
  const currentSegmentRaw = segments[segments.length - 1] || '';
  const currentSegment = currentSegmentRaw.trim();
  const hasPipe = segments.length > 1;
  const firstToken = currentSegment.split(/\s+/, 1)[0]?.toLowerCase() || '';
  const hasCommandBody = currentSegment.length > firstToken.length;

  const suggestions = [];
  const seen = new Set();
  const segmentStart = query.slice(0, cursorPos).lastIndexOf('|') + 1;
  const segmentEnd = cursorPos;

  const addSuggestion = (entry) => {
    const key = `${entry.kind}:${entry.label}:${entry.next_query}`;
    uniqPush(suggestions, seen, key, entry);
  };

  const addCommandSuggestions = (prefix) => {
    for (const spec of COMMAND_SPECS) {
      const score = rankByPrefix(spec.command, prefix);
      if (score < 0) continue;
      addSuggestion({
        label: spec.command,
        kind: 'command',
        detail: spec.detail,
        example: spec.example,
        score,
        next_query: buildNextQuery(query, segmentStart, segmentEnd, `${spec.command} `)
      });
    }
  };

  if (!currentSegment) {
    addSuggestion({
      label: 'where',
      kind: 'template',
      detail: 'Add field filters to current pipeline',
      example: 'where service="payments" and status>=500',
      score: 60,
      next_query: buildNextQuery(query, segmentStart, segmentEnd, 'where service=')
    });
    addSuggestion({
      label: 'stats',
      kind: 'template',
      detail: 'Count by service',
      example: 'stats count() by service',
      score: 58,
      next_query: buildNextQuery(query, segmentStart, segmentEnd, 'stats count() by service')
    });
    addSuggestion({
      label: 'timechart',
      kind: 'template',
      detail: 'Volume trend by 5m buckets',
      example: 'timechart span=5m count()',
      score: 56,
      next_query: buildNextQuery(query, segmentStart, segmentEnd, 'timechart span=5m count()')
    });
    addCommandSuggestions('');
  } else if (!hasCommandBody && !COMMAND_SET.has(firstToken)) {
    addCommandSuggestions(firstToken);
  } else if (firstToken === 'search') {
    for (const term of context.topTerms) {
      const score = 110 - term.length;
      addSuggestion({
        label: term,
        kind: 'term',
        detail: 'Top term from current dataset',
        example: `search ${term}`,
        score,
        next_query: buildNextQuery(query, segmentStart, segmentEnd, `search ${term}`)
      });
    }

    addSuggestion({
      label: 'where',
      kind: 'template',
      detail: 'Filter after search',
      example: 'search timeout | where service="payments"',
      score: 52,
      next_query: buildNextQuery(query, segmentStart, segmentEnd, 'search * | where service=')
    });
  } else if (firstToken === 'where') {
    const body = currentSegment.slice('where'.length).trim();
    for (const field of FIELD_SUGGESTIONS) {
      const score = rankByPrefix(field, body || '');
      if (score < 0) continue;
      addSuggestion({
        label: field,
        kind: 'field',
        detail: 'Filterable field',
        example: `${field}=`,
        score: score + 10,
        next_query: buildNextQuery(query, segmentStart, segmentEnd, `where ${field}=`)
      });
    }
  } else if (firstToken === 'stats' || firstToken === 'timechart') {
    addSuggestion({
      label: 'count() by service',
      kind: 'template',
      detail: 'Aggregate event count per service',
      example: `${firstToken} count() by service`,
      score: 70,
      next_query: buildNextQuery(query, segmentStart, segmentEnd, `${firstToken} count() by service`)
    });
    addSuggestion({
      label: 'avg(duration_ms) by service',
      kind: 'template',
      detail: 'Latency trend/aggregation per service',
      example: `${firstToken} avg(duration_ms) by service`,
      score: 64,
      next_query: buildNextQuery(query, segmentStart, segmentEnd, `${firstToken} avg(duration_ms) by service`)
    });
  } else {
    addCommandSuggestions('');
  }

  suggestions.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return {
    contextStage: hasPipe ? firstToken || 'pipeline' : firstToken || 'root',
    suggestions: suggestions.slice(0, maxItems)
  };
}

