# Operational Workflows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add scheduled searches, expanded PPL commands, search-powered dashboards, and lookup tables to shift EdgeData's moat from infrastructure to operational workflows.

**Architecture:** All new PPL commands execute in-worker on the event stream — no storage layer changes. Scheduled searches extend the alert-worker cron. Dashboards and lookups are CRUD-backed by D1 with PPL-based rendering. Everything composes through the existing PPL pipeline.

**Tech Stack:** Cloudflare Workers (TypeScript/JS), D1 (SQLite), existing PPL parser/executor in `ppl-core.mjs` and `search-stream-core.mjs`.

**Design doc:** `docs/plans/2026-03-05-operational-workflows-design.md`

**Test runner:** `node --test workers/query-worker/test/*.test.mjs`

---

## Phase 1: PPL Expansion (Foundation)

Everything else depends on richer PPL. Ship this first.

---

### Task 1: Expand `stats` aggregation functions

The current `stats` command only supports `count()`. Add `sum`, `avg`, `min`, `max`, `dc`, `values`, `earliest`, `latest` and support multiple aggregations per stats clause.

**Files:**
- Modify: `workers/query-worker/src/ppl-core.mjs` (parseStatsClause)
- Modify: `workers/query-worker/src/search-stream-core.mjs` (stats executor)
- Test: `workers/query-worker/test/ppl-core.test.mjs`
- Test: `workers/query-worker/test/search-stream-core.test.mjs`

**Step 1: Write failing parser tests**

Add to `workers/query-worker/test/ppl-core.test.mjs`:

```javascript
test('stats parses sum aggregation', () => {
  const result = parsePplPipeline('search * | stats sum(duration_ms) by service');
  const stats = result.stages[1];
  assert.strictEqual(stats.command, 'stats');
  assert.deepStrictEqual(stats.aggregations, [
    { fn: 'sum', field: 'duration_ms', as: 'sum_duration_ms' }
  ]);
  assert.deepStrictEqual(stats.by, ['service']);
});

test('stats parses multiple aggregations', () => {
  const result = parsePplPipeline('search * | stats count() avg(duration_ms) max(status) by service, env');
  const stats = result.stages[1];
  assert.strictEqual(stats.aggregations.length, 3);
  assert.strictEqual(stats.aggregations[0].fn, 'count');
  assert.strictEqual(stats.aggregations[1].fn, 'avg');
  assert.strictEqual(stats.aggregations[1].field, 'duration_ms');
  assert.strictEqual(stats.aggregations[2].fn, 'max');
  assert.deepStrictEqual(stats.by, ['service', 'env']);
});

test('stats parses dc aggregation', () => {
  const result = parsePplPipeline('search * | stats dc(src_ip) by service');
  const stats = result.stages[1];
  assert.deepStrictEqual(stats.aggregations, [
    { fn: 'dc', field: 'src_ip', as: 'dc_src_ip' }
  ]);
});

test('stats parses with custom alias', () => {
  const result = parsePplPipeline('search * | stats count() as total by service');
  const stats = result.stages[1];
  assert.deepStrictEqual(stats.aggregations, [
    { fn: 'count', field: null, as: 'total' }
  ]);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test workers/query-worker/test/ppl-core.test.mjs`
Expected: New tests FAIL (parseStatsClause only handles `count() by ...` pattern)

**Step 3: Rewrite `parseStatsClause` in `ppl-core.mjs`**

Replace the existing `parseStatsClause` function:

```javascript
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
```

Note: the `fn` and `as` top-level fields are kept for backward compatibility with existing code that reads `stats.fn === 'count'`.

**Step 4: Run tests to verify they pass**

Run: `node --test workers/query-worker/test/ppl-core.test.mjs`
Expected: All tests PASS

**Step 5: Write failing executor tests**

Add to `workers/query-worker/test/search-stream-core.test.mjs`:

```javascript
import { executeStatsPipeline } from '../src/search-stream-core.mjs';

test('executeStatsPipeline computes sum and avg', () => {
  const events = [
    { service: 'api', duration_ms: 100 },
    { service: 'api', duration_ms: 200 },
    { service: 'web', duration_ms: 50 },
  ];
  const stage = {
    command: 'stats',
    aggregations: [
      { fn: 'sum', field: 'duration_ms', as: 'total_ms' },
      { fn: 'avg', field: 'duration_ms', as: 'avg_ms' },
      { fn: 'count', field: null, as: 'count' }
    ],
    by: ['service']
  };
  const result = executeStatsPipeline(events, stage);
  const api = result.find(r => r.service === 'api');
  assert.strictEqual(api.total_ms, 300);
  assert.strictEqual(api.avg_ms, 150);
  assert.strictEqual(api.count, 2);
  const web = result.find(r => r.service === 'web');
  assert.strictEqual(web.total_ms, 50);
  assert.strictEqual(web.count, 1);
});

test('executeStatsPipeline computes dc', () => {
  const events = [
    { service: 'api', src_ip: '1.1.1.1' },
    { service: 'api', src_ip: '1.1.1.1' },
    { service: 'api', src_ip: '2.2.2.2' },
  ];
  const stage = {
    command: 'stats',
    aggregations: [{ fn: 'dc', field: 'src_ip', as: 'unique_ips' }],
    by: ['service']
  };
  const result = executeStatsPipeline(events, stage);
  assert.strictEqual(result[0].unique_ips, 2);
});
```

**Step 6: Implement `executeStatsPipeline` in `search-stream-core.mjs`**

```javascript
export function executeStatsPipeline(events, stage) {
  const groups = new Map();
  const { aggregations, by } = stage;

  for (const event of events) {
    const key = by.map(f => String(event[f] ?? '')).join('\x00');
    if (!groups.has(key)) {
      const base = {};
      for (const f of by) base[f] = event[f] ?? '';
      groups.set(key, { base, rows: [] });
    }
    groups.get(key).rows.push(event);
  }

  const results = [];
  for (const { base, rows } of groups.values()) {
    const row = { ...base };
    for (const agg of aggregations) {
      row[agg.as] = computeAggregation(agg.fn, agg.field, rows);
    }
    results.push(row);
  }
  return results;
}

function computeAggregation(fn, field, rows) {
  if (fn === 'count') return rows.length;

  const values = rows.map(r => r[field]).filter(v => v !== undefined && v !== null);

  if (fn === 'dc') return new Set(values.map(String)).size;
  if (fn === 'values') return [...new Set(values.map(String))];

  const nums = values.map(Number).filter(Number.isFinite);
  if (fn === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'avg') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  if (fn === 'min') return nums.length ? Math.min(...nums) : null;
  if (fn === 'max') return nums.length ? Math.max(...nums) : null;

  if (fn === 'earliest') return values.length ? values.sort()[0] : null;
  if (fn === 'latest') return values.length ? values.sort().reverse()[0] : null;

  return null;
}
```

**Step 7: Run tests to verify they pass**

Run: `node --test workers/query-worker/test/search-stream-core.test.mjs`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add workers/query-worker/src/ppl-core.mjs workers/query-worker/src/search-stream-core.mjs workers/query-worker/test/ppl-core.test.mjs workers/query-worker/test/search-stream-core.test.mjs
git commit -m "feat(ppl): expand stats to support sum, avg, min, max, dc, values, earliest, latest and multiple aggregations"
```

---

### Task 2: Add `timechart` command

The most important PPL command for operational investigation — buckets events into time intervals with aggregation.

**Files:**
- Modify: `workers/query-worker/src/ppl-core.mjs` (add to COMMANDS, parseTimechartClause)
- Modify: `workers/query-worker/src/search-stream-core.mjs` (executeTimechartPipeline)
- Test: `workers/query-worker/test/ppl-core.test.mjs`
- Test: `workers/query-worker/test/search-stream-core.test.mjs`

**Step 1: Write failing parser tests**

```javascript
test('timechart parses span and count by field', () => {
  const result = parsePplPipeline('search * | timechart span=5m count() by level');
  const tc = result.stages[1];
  assert.strictEqual(tc.command, 'timechart');
  assert.strictEqual(tc.span, '5m');
  assert.strictEqual(tc.spanMs, 300000);
  assert.deepStrictEqual(tc.aggregations, [{ fn: 'count', field: null, as: 'count' }]);
  assert.strictEqual(tc.by, 'level');
});

test('timechart parses span with avg', () => {
  const result = parsePplPipeline('search * | timechart span=1h avg(duration_ms)');
  const tc = result.stages[1];
  assert.strictEqual(tc.spanMs, 3600000);
  assert.strictEqual(tc.aggregations[0].fn, 'avg');
  assert.strictEqual(tc.aggregations[0].field, 'duration_ms');
  assert.strictEqual(tc.by, null);
});

test('timechart rejects invalid span', () => {
  assert.throws(() => parsePplPipeline('search * | timechart span=abc count()'), /Invalid timechart span/);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test workers/query-worker/test/ppl-core.test.mjs`
Expected: FAIL — `timechart` not in COMMANDS

**Step 3: Implement parser**

In `ppl-core.mjs`, add `'timechart'` to COMMANDS set. Add span parsing helper and clause parser:

```javascript
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
```

Add the dispatch in `parsePplPipeline`:

```javascript
if (firstToken === 'timechart') {
  stages.push({ command: 'timechart', ...parseTimechartClause(body) });
  continue;
}
```

**Step 4: Run parser tests to verify they pass**

Run: `node --test workers/query-worker/test/ppl-core.test.mjs`
Expected: PASS

**Step 5: Write failing executor tests**

```javascript
import { executeTimechartPipeline } from '../src/search-stream-core.mjs';

test('executeTimechartPipeline buckets events by 5m span', () => {
  const events = [
    { ts: '2026-03-05T10:01:00Z', level: 'error' },
    { ts: '2026-03-05T10:03:00Z', level: 'error' },
    { ts: '2026-03-05T10:06:00Z', level: 'info' },
    { ts: '2026-03-05T10:08:00Z', level: 'error' },
  ];
  const stage = {
    command: 'timechart',
    spanMs: 300000,
    aggregations: [{ fn: 'count', field: null, as: 'count' }],
    by: 'level'
  };
  const result = executeTimechartPipeline(events, stage);
  assert.ok(result.length > 0);
  assert.ok(result[0]._time);
  const errorBucket1 = result.find(r => r._time === '2026-03-05T10:00:00.000Z' && r.level === 'error');
  assert.strictEqual(errorBucket1.count, 2);
});

test('executeTimechartPipeline without by field', () => {
  const events = [
    { ts: '2026-03-05T10:01:00Z', duration_ms: 100 },
    { ts: '2026-03-05T10:03:00Z', duration_ms: 200 },
  ];
  const stage = {
    command: 'timechart',
    spanMs: 300000,
    aggregations: [{ fn: 'avg', field: 'duration_ms', as: 'avg_ms' }],
    by: null
  };
  const result = executeTimechartPipeline(events, stage);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].avg_ms, 150);
});
```

**Step 6: Implement `executeTimechartPipeline`**

```javascript
export function executeTimechartPipeline(events, stage) {
  const { spanMs, aggregations, by } = stage;
  const buckets = new Map();

  for (const event of events) {
    const tsMs = new Date(event.ts).getTime();
    if (!Number.isFinite(tsMs)) continue;
    const bucketMs = Math.floor(tsMs / spanMs) * spanMs;
    const bucketKey = new Date(bucketMs).toISOString();
    const groupVal = by ? String(event[by] ?? '') : '_all';
    const key = `${bucketKey}\x00${groupVal}`;

    if (!buckets.has(key)) {
      buckets.set(key, { _time: bucketKey, _group: groupVal, rows: [] });
    }
    buckets.get(key).rows.push(event);
  }

  const results = [];
  for (const { _time, _group, rows } of buckets.values()) {
    const row = { _time };
    if (by) row[by] = _group;
    for (const agg of aggregations) {
      row[agg.as] = computeAggregation(agg.fn, agg.field, rows);
    }
    results.push(row);
  }

  results.sort((a, b) => a._time.localeCompare(b._time));
  return results;
}
```

**Step 7: Run all tests**

Run: `node --test workers/query-worker/test/ppl-core.test.mjs workers/query-worker/test/search-stream-core.test.mjs`
Expected: All PASS

**Step 8: Commit**

```bash
git add workers/query-worker/src/ppl-core.mjs workers/query-worker/src/search-stream-core.mjs workers/query-worker/test/ppl-core.test.mjs workers/query-worker/test/search-stream-core.test.mjs
git commit -m "feat(ppl): add timechart command with time-bucketed aggregation"
```

---

### Task 3: Add `top` and `rare` commands

**Files:**
- Modify: `workers/query-worker/src/ppl-core.mjs`
- Modify: `workers/query-worker/src/search-stream-core.mjs`
- Test: `workers/query-worker/test/ppl-core.test.mjs`
- Test: `workers/query-worker/test/search-stream-core.test.mjs`

**Step 1: Write failing parser tests**

```javascript
test('top parses count and field', () => {
  const result = parsePplPipeline('search * | top 10 msg_hash');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'top');
  assert.strictEqual(stage.count, 10);
  assert.strictEqual(stage.field, 'msg_hash');
  assert.strictEqual(stage.by, null);
});

test('top parses with by field', () => {
  const result = parsePplPipeline('search * | top 5 host by service');
  const stage = result.stages[1];
  assert.strictEqual(stage.count, 5);
  assert.strictEqual(stage.field, 'host');
  assert.strictEqual(stage.by, 'service');
});

test('rare parses count and field', () => {
  const result = parsePplPipeline('search * | rare 10 src_ip');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'rare');
  assert.strictEqual(stage.count, 10);
  assert.strictEqual(stage.field, 'src_ip');
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement parsers**

Add `'top'` and `'rare'` to COMMANDS. Add:

```javascript
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
```

Dispatch in `parsePplPipeline`:

```javascript
if (firstToken === 'top') {
  stages.push({ command: 'top', ...parseTopRareClause(body) });
  continue;
}
if (firstToken === 'rare') {
  stages.push({ command: 'rare', ...parseTopRareClause(body) });
  continue;
}
```

**Step 4: Run parser tests — expect PASS**

**Step 5: Write failing executor tests**

```javascript
import { executeTopPipeline, executeRarePipeline } from '../src/search-stream-core.mjs';

test('executeTopPipeline returns most frequent values', () => {
  const events = [
    { msg_hash: 'aaa' }, { msg_hash: 'aaa' }, { msg_hash: 'aaa' },
    { msg_hash: 'bbb' }, { msg_hash: 'bbb' },
    { msg_hash: 'ccc' },
  ];
  const stage = { command: 'top', count: 2, field: 'msg_hash', by: null };
  const result = executeTopPipeline(events, stage);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].msg_hash, 'aaa');
  assert.strictEqual(result[0].count, 3);
  assert.strictEqual(result[1].msg_hash, 'bbb');
});

test('executeRarePipeline returns least frequent values', () => {
  const events = [
    { src_ip: '1.1.1.1' }, { src_ip: '1.1.1.1' }, { src_ip: '1.1.1.1' },
    { src_ip: '2.2.2.2' }, { src_ip: '2.2.2.2' },
    { src_ip: '3.3.3.3' },
  ];
  const stage = { command: 'rare', count: 2, field: 'src_ip', by: null };
  const result = executeRarePipeline(events, stage);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].src_ip, '3.3.3.3');
  assert.strictEqual(result[0].count, 1);
});
```

**Step 6: Implement executors**

```javascript
export function executeTopPipeline(events, stage) {
  return executeFrequencyPipeline(events, stage, 'desc');
}

export function executeRarePipeline(events, stage) {
  return executeFrequencyPipeline(events, stage, 'asc');
}

function executeFrequencyPipeline(events, stage, order) {
  const { count, field, by } = stage;
  const groups = new Map();
  const total = events.length;

  for (const event of events) {
    const groupKey = by ? String(event[by] ?? '') : '_all';
    if (!groups.has(groupKey)) groups.set(groupKey, new Map());
    const freq = groups.get(groupKey);
    const val = String(event[field] ?? '');
    freq.set(val, (freq.get(val) || 0) + 1);
  }

  const results = [];
  for (const [groupKey, freq] of groups) {
    const sorted = [...freq.entries()]
      .sort((a, b) => order === 'desc' ? b[1] - a[1] : a[1] - b[1])
      .slice(0, count);
    for (const [val, cnt] of sorted) {
      const row = { [field]: val, count: cnt, percent: total ? +(cnt / total * 100).toFixed(2) : 0 };
      if (by) row[by] = groupKey;
      results.push(row);
    }
  }
  return results;
}
```

**Step 7: Run all tests — expect PASS**

**Step 8: Commit**

```bash
git add workers/query-worker/src/ppl-core.mjs workers/query-worker/src/search-stream-core.mjs workers/query-worker/test/ppl-core.test.mjs workers/query-worker/test/search-stream-core.test.mjs
git commit -m "feat(ppl): add top and rare commands for frequency analysis"
```

---

### Task 4: Add `dedup` command

**Files:** Same as above.

**Step 1: Write failing tests**

```javascript
test('dedup parses single field', () => {
  const result = parsePplPipeline('search * | dedup trace_id');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'dedup');
  assert.deepStrictEqual(stage.fields, ['trace_id']);
});

test('dedup parses multiple fields', () => {
  const result = parsePplPipeline('search * | dedup service, host');
  const stage = result.stages[1];
  assert.deepStrictEqual(stage.fields, ['service', 'host']);
});
```

**Step 2: Run — expect FAIL**

**Step 3: Implement parser**

```javascript
function parseDedupClause(body) {
  const fields = parseFieldsClause(body);
  if (fields.length === 0) throw new Error('dedup requires at least one field');
  return { fields };
}
```

Dispatch: `if (firstToken === 'dedup') { stages.push({ command: 'dedup', ...parseDedupClause(body) }); continue; }`

**Step 4: Run parser tests — PASS**

**Step 5: Write failing executor test**

```javascript
import { executeDedupPipeline } from '../src/search-stream-core.mjs';

test('executeDedupPipeline removes duplicate trace_ids', () => {
  const events = [
    { event_id: '1', trace_id: 'aaa', ts: '2026-03-05T10:01:00Z' },
    { event_id: '2', trace_id: 'aaa', ts: '2026-03-05T10:02:00Z' },
    { event_id: '3', trace_id: 'bbb', ts: '2026-03-05T10:03:00Z' },
  ];
  const stage = { command: 'dedup', fields: ['trace_id'] };
  const result = executeDedupPipeline(events, stage);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].event_id, '1');
  assert.strictEqual(result[1].event_id, '3');
});
```

**Step 6: Implement**

```javascript
export function executeDedupPipeline(events, stage) {
  const seen = new Set();
  const results = [];
  for (const event of events) {
    const key = stage.fields.map(f => String(event[f] ?? '')).join('\x00');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(event);
  }
  return results;
}
```

**Step 7: Run tests — PASS**

**Step 8: Commit**

```bash
git add workers/query-worker/src/ppl-core.mjs workers/query-worker/src/search-stream-core.mjs workers/query-worker/test/ppl-core.test.mjs workers/query-worker/test/search-stream-core.test.mjs
git commit -m "feat(ppl): add dedup command for field-based deduplication"
```

---

### Task 5: Add `eval` command

**Files:** Same as above, plus a new `workers/query-worker/src/eval-engine.mjs` for safe expression evaluation.

**Step 1: Write failing parser tests**

```javascript
test('eval parses simple arithmetic', () => {
  const result = parsePplPipeline('search * | eval duration_sec=duration_ms/1000');
  const stage = result.stages[1];
  assert.strictEqual(stage.command, 'eval');
  assert.strictEqual(stage.field, 'duration_sec');
  assert.strictEqual(stage.expression, 'duration_ms/1000');
});

test('eval parses if expression', () => {
  const result = parsePplPipeline('search * | eval is_error=if(status>=500, "yes", "no")');
  const stage = result.stages[1];
  assert.strictEqual(stage.field, 'is_error');
  assert.ok(stage.expression.includes('if('));
});
```

**Step 2: Run — FAIL**

**Step 3: Implement parser**

```javascript
function parseEvalClause(body) {
  const eqPos = body.indexOf('=');
  if (eqPos < 1) throw new Error('eval requires: <field>=<expression>');
  const field = normalizeField(body.slice(0, eqPos).trim());
  const expression = body.slice(eqPos + 1).trim();
  if (!field || !expression) throw new Error('eval requires: <field>=<expression>');
  return { field, expression };
}
```

Dispatch: `if (firstToken === 'eval') { stages.push({ command: 'eval', ...parseEvalClause(body) }); continue; }`

**Step 4: Run parser tests — PASS**

**Step 5: Write failing executor tests (new file or add to existing)**

```javascript
import { executeEvalPipeline } from '../src/search-stream-core.mjs';

test('executeEvalPipeline computes arithmetic', () => {
  const events = [{ duration_ms: 1500 }];
  const stage = { command: 'eval', field: 'duration_sec', expression: 'duration_ms/1000' };
  const result = executeEvalPipeline(events, stage);
  assert.strictEqual(result[0].duration_sec, 1.5);
});

test('executeEvalPipeline computes if expression', () => {
  const events = [{ status: 503 }, { status: 200 }];
  const stage = { command: 'eval', field: 'is_error', expression: 'if(status>=500, "yes", "no")' };
  const result = executeEvalPipeline(events, stage);
  assert.strictEqual(result[0].is_error, 'yes');
  assert.strictEqual(result[1].is_error, 'no');
});

test('executeEvalPipeline computes string functions', () => {
  const events = [{ message: 'Connection Refused' }];
  const stage = { command: 'eval', field: 'msg_lower', expression: 'lower(message)' };
  const result = executeEvalPipeline(events, stage);
  assert.strictEqual(result[0].msg_lower, 'connection refused');
});
```

**Step 6: Implement eval engine**

Create `workers/query-worker/src/eval-engine.mjs`:

```javascript
const FUNCTIONS = {
  lower: (args) => String(args[0] ?? '').toLowerCase(),
  upper: (args) => String(args[0] ?? '').toUpperCase(),
  len: (args) => String(args[0] ?? '').length,
  substr: (args) => String(args[0] ?? '').substring(Number(args[1]) || 0, args[2] !== undefined ? Number(args[2]) : undefined),
  replace: (args) => String(args[0] ?? '').replaceAll(String(args[1] ?? ''), String(args[2] ?? '')),
  coalesce: (args) => args.find(a => a !== null && a !== undefined && a !== '') ?? null,
  if: (args) => args[0] ? args[1] : args[2],
};

export function evaluateExpression(expression, event) {
  const ifMatch = expression.match(/^if\s*\((.+)\)$/);
  if (ifMatch) {
    return evaluateIf(ifMatch[1], event);
  }

  const fnMatch = expression.match(/^(\w+)\s*\((.+)\)$/);
  if (fnMatch && FUNCTIONS[fnMatch[1].toLowerCase()]) {
    const fn = FUNCTIONS[fnMatch[1].toLowerCase()];
    const args = splitArgs(fnMatch[2]).map(a => resolveValue(a.trim(), event));
    return fn(args);
  }

  return evaluateArithmetic(expression, event);
}

function evaluateIf(argsStr, event) {
  const parts = splitArgs(argsStr);
  if (parts.length !== 3) return null;
  const condition = evaluateCondition(parts[0].trim(), event);
  return condition ? resolveValue(parts[1].trim(), event) : resolveValue(parts[2].trim(), event);
}

function evaluateCondition(cond, event) {
  const match = cond.match(/^(\S+)\s*(>=|<=|!=|>|<|=)\s*(\S+)$/);
  if (!match) return !!resolveValue(cond, event);
  const left = resolveValue(match[1], event);
  const right = resolveValue(match[3], event);
  const op = match[2];
  const l = Number(left), r = Number(right);
  const numCompare = Number.isFinite(l) && Number.isFinite(r);
  if (op === '>=') return numCompare ? l >= r : String(left) >= String(right);
  if (op === '<=') return numCompare ? l <= r : String(left) <= String(right);
  if (op === '>') return numCompare ? l > r : String(left) > String(right);
  if (op === '<') return numCompare ? l < r : String(left) < String(right);
  if (op === '=') return numCompare ? l === r : String(left) === String(right);
  if (op === '!=') return numCompare ? l !== r : String(left) !== String(right);
  return false;
}

function evaluateArithmetic(expr, event) {
  const tokens = expr.match(/([a-zA-Z_][a-zA-Z0-9_.]*|[0-9]+(?:\.[0-9]+)?|[+\-*/()])/g);
  if (!tokens) return null;
  const resolved = tokens.map(t => {
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(t)) return t;
    if (/^[+\-*/()]$/.test(t)) return t;
    const val = event[t];
    return val !== undefined && val !== null ? String(val) : '0';
  }).join(' ');
  try {
    const result = Function('"use strict"; return (' + resolved + ')')();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function resolveValue(token, event) {
  const trimmed = token.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) return Number(trimmed);
  return event[trimmed] ?? null;
}

function splitArgs(argsStr) {
  const args = [];
  let depth = 0, current = '', quote = null;
  for (const ch of argsStr) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current);
  return args;
}
```

In `search-stream-core.mjs`:

```javascript
import { evaluateExpression } from './eval-engine.mjs';

export function executeEvalPipeline(events, stage) {
  return events.map(event => ({
    ...event,
    [stage.field]: evaluateExpression(stage.expression, event)
  }));
}
```

**Step 7: Run all tests — PASS**

**Step 8: Commit**

```bash
git add workers/query-worker/src/ppl-core.mjs workers/query-worker/src/search-stream-core.mjs workers/query-worker/src/eval-engine.mjs workers/query-worker/test/ppl-core.test.mjs workers/query-worker/test/search-stream-core.test.mjs
git commit -m "feat(ppl): add eval command with arithmetic, string functions, and conditionals"
```

---

### Task 6: Wire new commands into query-worker pipeline execution

The parsers and executors are built. Now wire them into the actual search execution path in `workers/query-worker/src/index.ts`.

**Files:**
- Modify: `workers/query-worker/src/index.ts` (search execution, stats handling)
- Modify: `workers/query-worker/src/search-stream-core.mjs` (update `isIncrementalStreamPipeline`, add `applyPostPipeline`)

**Step 1: Update `isIncrementalStreamPipeline` to classify new commands**

```javascript
const STREAMING_COMMANDS = new Set(['search', 'where', 'head', 'eval', 'dedup', 'rename', 'table', 'lookup']);
const BLOCKING_COMMANDS = new Set(['timechart', 'top', 'rare', 'stats', 'transaction', 'sort']);

export function isIncrementalStreamPipeline(stages) {
  return (stages || []).every(s => STREAMING_COMMANDS.has(s.command) || s.command === 'fields');
}
```

**Step 2: Add `applyPostPipeline` that runs blocking stages on collected results**

```javascript
export function applyPostPipeline(events, stages) {
  let result = events;
  for (const stage of stages) {
    if (stage.command === 'stats') result = executeStatsPipeline(result, stage);
    else if (stage.command === 'timechart') result = executeTimechartPipeline(result, stage);
    else if (stage.command === 'top') result = executeTopPipeline(result, stage);
    else if (stage.command === 'rare') result = executeRarePipeline(result, stage);
    else if (stage.command === 'dedup') result = executeDedupPipeline(result, stage);
    else if (stage.command === 'eval') result = executeEvalPipeline(result, stage);
    else if (stage.command === 'sort') result = applySortStage(result, stage);
    else if (stage.command === 'fields' || stage.command === 'table') result = applyFieldsStage(result, stage);
  }
  return result;
}

function applySortStage(events, stage) {
  return [...events].sort((a, b) => {
    for (const { field, direction } of stage.keys) {
      const cmp = compareUnknownValues(a[field], b[field]);
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

function applyFieldsStage(events, stage) {
  const fields = stage.fields;
  return events.map(e => {
    const row = {};
    for (const f of fields) { row[f] = e[f]; }
    return row;
  });
}
```

**Step 3: Update the search handler in `index.ts`**

Find where stats results are computed after `executeSearchWithContext` and replace with a call to `applyPostPipeline` for all post-search stages (everything after `search` + `where` + `head`).

The key change: instead of only handling `stats count()`, apply the full pipeline to collected results.

**Step 4: Run all tests**

Run: `node --test workers/query-worker/test/*.test.mjs`
Expected: All PASS

**Step 5: Run dry-run bundle**

Run: `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`
Expected: Bundle succeeds

**Step 6: Commit**

```bash
git add workers/query-worker/src/index.ts workers/query-worker/src/search-stream-core.mjs
git commit -m "feat(ppl): wire new pipeline commands into query-worker search execution"
```

---

### Task 7: Run full unit test suite and verify no regressions

**Step 1:** `node --test workers/query-worker/test/*.test.mjs workers/ingest-worker/test/*.test.mjs workers/synthetic-worker/test/*.test.mjs`

**Step 2:** `npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml`

**Step 3:** Fix any failures. Commit.

---

## Phase 2: Scheduled Searches

Depends on Phase 1 being complete (PPL commands make scheduled searches useful).

---

### Task 8: Create D1 migration for scheduled searches

**Files:**
- Create: `deploy/migrations/006_operational_workflows.sql`
- Modify: `schema.sql` (append new tables)
- Modify: `package.json` (add migration script)

**Step 1:** Create the migration file with `scheduled_searches` and `scheduled_search_results` tables as specified in the design doc section 2.2.

**Step 2:** Append the same CREATE TABLE statements to `schema.sql` for fresh installs.

**Step 3:** Add to `package.json` scripts: `"d1:migrate:workflows": "wrangler d1 execute edgedata-db --remote --file=./deploy/migrations/006_operational_workflows.sql"`

**Step 4:** Commit.

---

### Task 9: Add scheduled search CRUD endpoints to query-worker

**Files:**
- Modify: `workers/query-worker/src/index.ts`

**Step 1:** Add `ScheduledSearchRow` interface matching the D1 schema.

**Step 2:** Add `handleScheduledSearches` function following the pattern of `handleSavedSearches` — CRUD with owner scoping.

**Step 3:** Wire routes in the main fetch handler: `GET /scheduled-searches`, `POST /scheduled-searches`, `PUT /scheduled-searches/:id`, `DELETE /scheduled-searches/:id`, `GET /scheduled-searches/:id/results`, `POST /scheduled-searches/:id/run`.

**Step 4:** Add RBAC permissions `scheduled_search.read`, `scheduled_search.write`, `scheduled_search.delete` to `ROLE_PERMISSION_DEFAULTS`.

**Step 5:** Run dry-run bundle. Commit.

---

### Task 10: Add scheduled search execution to alert-worker

**Files:**
- Modify: `workers/alert-worker/src/index.ts`

**Step 1:** Add scheduled search loading alongside alerts in the cron handler.

**Step 2:** Implement `processScheduledSearch`: compute time window, call query-worker search endpoint, store results in `scheduled_search_results`, execute actions (Slack/webhook).

**Step 3:** Add result retention cleanup: delete rows older than `retain_days`.

**Step 4:** Run dry-run bundle. Commit.

---

### Task 11: Add scheduled searches to the UI

**Files:**
- Modify: `pages/src/App.tsx`

**Step 1:** Add "Scheduled Searches" view (list, create, edit, delete, view run history).

**Step 2:** Add "Schedule This Search" action from Log Explorer (prefills PPL from current search).

**Step 3:** Commit.

---

## Phase 3: Search-Powered Dashboards

Depends on Phase 1 (timechart/stats needed for dashboard panels).

---

### Task 12: Create D1 tables for dashboards and panels

**Files:**
- Modify: `deploy/migrations/006_operational_workflows.sql` (add dashboard tables if not yet applied, or create 007)
- Modify: `schema.sql`

Add `dashboards` and `dashboard_panels` tables as specified in design doc section 4.2.

---

### Task 13: Add dashboard CRUD endpoints

**Files:**
- Modify: `workers/query-worker/src/index.ts`

Add `handleDashboards` function with routes: `GET /dashboards`, `POST /dashboards`, `PUT /dashboards/:id`, `DELETE /dashboards/:id`, `GET /dashboards/:id/panels`, `POST /dashboards/:id/panels`, `PUT /dashboards/:id/panels/:panelId`, `DELETE /dashboards/:id/panels/:panelId`.

Add RBAC permissions `dashboard.write`, `dashboard.delete`.

---

### Task 14: Seed default dashboards

**Files:**
- Modify: `workers/query-worker/src/index.ts` or create `workers/query-worker/src/starter-dashboards.mjs`

Create an idempotent seed function (similar to `starter-alert-pack.mjs`) that inserts the two default dashboards with their panels on first run.

---

### Task 15: Update frontend to render PPL-based dashboards

**Files:**
- Modify: `pages/src/App.tsx`

Replace hardcoded WAE dashboard cards with panel-based rendering. Each panel executes its PPL query via `POST /search` and renders based on `viz_type`.

---

## Phase 4: Lookup Tables

---

### Task 16: Create D1 tables for lookup tables

Add `lookup_tables` and `lookup_rows` tables to the migration file.

---

### Task 17: Add lookup CRUD endpoints

Add `handleLookupTables` function with routes for CRUD + CSV upload.

---

### Task 18: Add `lookup` PPL command

**Files:**
- Modify: `workers/query-worker/src/ppl-core.mjs`
- Modify: `workers/query-worker/src/search-stream-core.mjs`
- Test: both test files

Parser: `lookup <table_name> <event_field> [output <fields>]`
Executor: load lookup table into Map, enrich each event as it flows through.

---

## Phase 5: PPL Tier 2 (after Phase 1-4 are stable)

### Task 19: Add `rex` command (regex field extraction)
### Task 20: Add `transaction` command (event grouping)
### Task 21: Add `rename` command
### Task 22: Add `table` command (alias for `fields`)

Each follows the same TDD pattern: parser test → parser → executor test → executor → wire → commit.

---

## Verification Checkpoints

After each phase, run:

```bash
node --test workers/query-worker/test/*.test.mjs workers/ingest-worker/test/*.test.mjs workers/synthetic-worker/test/*.test.mjs
npx wrangler deploy --dry-run --config workers/query-worker/wrangler.toml
npx wrangler deploy --dry-run --config workers/alert-worker/wrangler.toml
npm -C pages run build
```
