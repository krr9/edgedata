function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 500;
  return Math.max(1, Math.min(2000, Math.trunc(n)));
}

export function buildScheduledSearchPreview(results, limit = 100) {
  const safeResults = Array.isArray(results) ? results : [];
  const safeLimit = clampLimit(limit);
  return safeResults.slice(0, safeLimit);
}

export function buildScheduledSearchRunSummary({
  name,
  status,
  resultCount,
  errorMessage,
  warning,
  results
}) {
  const safeName = String(name || '').trim();
  const safeStatus = status === 'error' ? 'error' : 'success';
  const safeCount = Number.isFinite(Number(resultCount)) ? Math.max(0, Math.trunc(Number(resultCount))) : 0;
  const safeResults = Array.isArray(results) ? results : [];
  const sample = safeResults.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || null;
  const previewFields = sample ? Object.keys(sample).slice(0, 8) : [];
  let headline = safeCount === 0 ? 'No results' : `${safeCount} result${safeCount === 1 ? '' : 's'} captured`;
  if (safeStatus === 'error') {
    headline = safeName ? `${safeName} run failed` : 'Scheduled search run failed';
  } else if (safeName && safeCount > 0) {
    headline = `${safeName}: ${headline}`;
  }

  return {
    headline,
    status: safeStatus,
    result_count: safeCount,
    warning: warning ? String(warning) : null,
    error_message: errorMessage ? String(errorMessage) : null,
    preview_fields: previewFields,
    has_results: safeCount > 0
  };
}

export function resolveQueryWorkerSearchUrl(rawUrl) {
  const base = String(rawUrl || '').trim();
  if (!base) {
    throw new Error('QUERY_WORKER_URL is not configured');
  }
  const normalized = base.replace(/\/+$/, '');
  if (normalized.endsWith('/search')) return normalized;
  return `${normalized}/search`;
}

export function buildScheduledSearchQueryRequest({ ppl, maxResults, from, to }) {
  return {
    ppl: String(ppl || '').trim(),
    time: {
      from: String(from || ''),
      to: String(to || '')
    },
    limit: clampLimit(maxResults)
  };
}
