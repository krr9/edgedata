/** Investigation pivot keys supported for deep-link prefill and chip display. */
export type PivotKey = 'trace_id' | 'request_id' | 'user_id' | 'msg_hash';

/** Prefilled investigation pivots from URL or session. */
export interface InvestigationPivots {
  trace_id?: string;
  request_id?: string;
  user_id?: string;
  msg_hash?: string;
}

/** Parse investigation params from URL search string. */
export function parseInvestigationParams(search: string): InvestigationPivots {
  const params = new URLSearchParams(search);
  const pivots: InvestigationPivots = {};
  const keys: PivotKey[] = ['trace_id', 'request_id', 'user_id', 'msg_hash'];
  for (const key of keys) {
    const val = params.get(key)?.trim();
    if (val) pivots[key as keyof InvestigationPivots] = val;
  }
  return pivots;
}

/** Check if pivots object has any values. */
export function hasPivots(pivots: InvestigationPivots): boolean {
  return !!(pivots.trace_id || pivots.request_id || pivots.user_id || pivots.msg_hash);
}

/** Event shape from related-events API. */
export interface RelatedEvent {
  id?: string;
  event_id?: string;
  ts?: string;
  trace_id?: string;
  request_id?: string;
  user_id?: string;
  msg_hash?: string;
  service?: string;
  level?: string;
  message?: string;
}

/** Extract InvestigationPivots from a related event for pivot selection. */
export function pivotsFromRelatedEvent(
  ev: { trace_id?: string; request_id?: string; user_id?: string; msg_hash?: string }
): InvestigationPivots {
  const pivots: InvestigationPivots = {};
  const keys: PivotKey[] = ['trace_id', 'request_id', 'user_id', 'msg_hash'];
  for (const key of keys) {
    const val = ev[key];
    if (val != null && String(val).trim()) pivots[key] = String(val).trim();
  }
  return pivots;
}
