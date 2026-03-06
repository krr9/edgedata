import { evaluateExpression } from './eval-engine.mjs';

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compareUnknownValues(left, right) {
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

function rowMatchesCondition(row, condition) {
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

export function isIncrementalStreamPipeline(stages) {
  return (stages || []).every((stage) => (
    stage.command === 'search' ||
    stage.command === 'where' ||
    stage.command === 'head'
  ));
}

export function resolvePipelineLimit(stages, fallback, max = 5000) {
  const base = Number.isFinite(Number(fallback)) && Number(fallback) > 0
    ? Math.trunc(Number(fallback))
    : 200;
  let limit = base;

  for (const stage of stages || []) {
    if (stage.command === 'head') {
      limit = Math.min(limit, Math.max(1, Math.trunc(Number(stage.count || 1))));
    }
  }

  return Math.max(1, Math.min(limit, max));
}

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

export function executeEvalPipeline(events, stage) {
  return events.map(event => ({
    ...event,
    [stage.field]: evaluateExpression(stage.expression, event)
  }));
}

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

export function rowMatchesWhereStages(row, stages) {
  for (const stage of stages || []) {
    if (stage.command !== 'where') continue;
    for (const condition of stage.conditions || []) {
      if (!rowMatchesCondition(row, condition)) return false;
    }
  }
  return true;
}
