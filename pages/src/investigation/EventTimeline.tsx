import { useCallback, useEffect, useState } from 'react';
import type { InvestigationPivots } from './types';

interface TimelineEvent {
  event_id?: string;
  ts?: string;
  service?: string;
  level?: string;
  message?: string;
  trace_id?: string;
  request_id?: string;
  user_id?: string;
  msg_hash?: string;
  duration_ms?: number;
  host?: string;
  span_id?: string;
  eventcount?: number;
  duration?: number;
  _events?: TimelineEvent[];
}

interface EventTimelineProps {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  scope: { index: string; service: string; env: string };
  time: { from: string; to: string };
  pivots: InvestigationPivots;
  onPivotEvent: (pivots: InvestigationPivots) => void;
}

function escapePpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildTimelinePpl(
  scope: { index: string; service: string; env: string },
  pivots: InvestigationPivots
): { ppl: string; isTransaction: boolean } {
  const conditions: string[] = [];
  if (scope.index && scope.index !== 'default' && scope.index !== '*') {
    conditions.push(`index="${escapePpl(scope.index)}"`);
  }

  if (pivots.trace_id) {
    conditions.push(`trace_id="${escapePpl(pivots.trace_id)}"`);
    const where = conditions.length > 0 ? ` | where ${conditions.join(' and ')}` : '';
    return {
      ppl: `search *${where} | transaction trace_id maxspan=5m maxevents=200 | sort -ts | head 200`,
      isTransaction: true
    };
  }

  if (scope.service && scope.service !== 'unknown' && scope.service !== '*') {
    conditions.push(`service="${escapePpl(scope.service)}"`);
  }
  if (scope.env && scope.env !== '*') {
    conditions.push(`env="${escapePpl(scope.env)}"`);
  }

  if (pivots.request_id) conditions.push(`request_id="${escapePpl(pivots.request_id)}"`);
  else if (pivots.msg_hash) conditions.push(`msg_hash="${escapePpl(pivots.msg_hash)}"`);
  else if (pivots.user_id) conditions.push(`user_id="${escapePpl(pivots.user_id)}"`);

  const where = conditions.length > 0 ? ` | where ${conditions.join(' and ')}` : '';
  return {
    ppl: `search *${where} | sort -ts | head 100`,
    isTransaction: false
  };
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

const LEVEL_CLASS: Record<string, string> = {
  error: 'level-error',
  fatal: 'level-error',
  warn: 'level-warn',
  warning: 'level-warn',
  info: 'level-info',
  debug: 'level-debug'
};

export function EventTimeline({
  apiFetch,
  scope,
  time,
  pivots,
  onPivotEvent
}: EventTimelineProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [transactionMeta, setTransactionMeta] = useState<{ eventcount: number; duration: number } | null>(null);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    setTransactionMeta(null);
    try {
      const { ppl, isTransaction } = buildTimelinePpl(scope, pivots);
      const response = await apiFetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: { from: time.from, to: time.to }, ppl, limit: 200, cursor: null })
      });
      const body = (await response.json()) as {
        results?: TimelineEvent[];
        result_type?: string;
        error?: string;
      };
      if (!response.ok || body.error) {
        setError(body.error || 'Failed to load timeline');
        setEvents([]);
        return;
      }
      const results = body.results || [];

      if (isTransaction && results.length > 0) {
        const txn = results[0];
        setTransactionMeta({
          eventcount: txn.eventcount ?? results.length,
          duration: txn.duration ?? 0
        });
        const inner = txn._events || results;
        const sorted = [...inner].sort((a, b) => {
          const ta = a.ts ? new Date(a.ts).getTime() : 0;
          const tb = b.ts ? new Date(b.ts).getTime() : 0;
          return ta - tb;
        });
        setEvents(sorted);
      } else {
        setEvents(results);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [
    apiFetch,
    scope.index,
    scope.service,
    scope.env,
    time.from,
    time.to,
    pivots.trace_id,
    pivots.request_id,
    pivots.user_id,
    pivots.msg_hash
  ]);

  useEffect(() => {
    void fetchTimeline();
  }, [fetchTimeline]);

  const handleClickEvent = useCallback(
    (ev: TimelineEvent) => {
      const next: InvestigationPivots = {};
      if (ev.trace_id) next.trace_id = ev.trace_id;
      if (ev.request_id) next.request_id = ev.request_id;
      if (ev.user_id) next.user_id = ev.user_id;
      if (ev.msg_hash) next.msg_hash = ev.msg_hash;
      onPivotEvent(next);
    },
    [onPivotEvent]
  );

  const pivotLabel = pivots.trace_id
    ? `Trace ${pivots.trace_id.slice(0, 12)}…`
    : pivots.request_id
      ? `Request ${pivots.request_id.slice(0, 12)}…`
      : pivots.msg_hash
        ? `Message pattern ${pivots.msg_hash.slice(0, 8)}…`
        : pivots.user_id
          ? `User ${pivots.user_id.slice(0, 12)}…`
          : 'Events';

  return (
    <div className="event-timeline card">
      <div className="event-timeline-header">
        <h3>Event Timeline</h3>
        <span className="event-timeline-pivot-label">{pivotLabel}</span>
        {transactionMeta && (
          <span className="event-timeline-meta">
            {transactionMeta.eventcount} events &middot; {formatDuration(transactionMeta.duration)}
          </span>
        )}
        {!loading && events.length > 0 && !transactionMeta && (
          <span className="event-timeline-meta">{events.length} events</span>
        )}
      </div>

      {loading && <div className="event-timeline-loading">Loading timeline…</div>}
      {error && !loading && <div className="event-timeline-error">{error}</div>}
      {!loading && !error && events.length === 0 && (
        <div className="event-timeline-empty">No events found for this context.</div>
      )}

      {!loading && events.length > 0 && (
        <div className="event-timeline-list">
          {events.map((ev, idx) => {
            const levelClass = LEVEL_CLASS[String(ev.level || '').toLowerCase()] || 'level-default';
            const isHighlighted =
              (pivots.trace_id && ev.level === 'error') ||
              (pivots.msg_hash && ev.msg_hash === pivots.msg_hash) ||
              (pivots.request_id && ev.request_id === pivots.request_id);
            return (
              <button
                key={ev.event_id || idx}
                type="button"
                className={`event-timeline-row${isHighlighted ? ' highlighted' : ''}`}
                onClick={() => handleClickEvent(ev)}
                title={ev.message || undefined}
              >
                <span className="event-timeline-ts">
                  {ev.ts ? formatTimestamp(ev.ts) : '—'}
                </span>
                <span className={`event-timeline-level ${levelClass}`}>
                  {String(ev.level || 'info').toUpperCase()}
                </span>
                {ev.service && (
                  <span className="event-timeline-service">{ev.service}</span>
                )}
                <span className="event-timeline-message">
                  {ev.message ? truncate(ev.message) : '(no message)'}
                </span>
                {ev.duration_ms != null && ev.duration_ms > 0 && (
                  <span className="event-timeline-duration">{formatDuration(ev.duration_ms)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
