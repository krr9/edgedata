function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 500;
  return Math.max(1, Math.min(2000, Math.trunc(n)));
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
