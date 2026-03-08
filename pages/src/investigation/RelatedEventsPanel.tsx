import { useCallback, useEffect, useState } from 'react';
import type { InvestigationPivots, RelatedEvent } from './types';

interface RelatedEventItem {
  event: RelatedEvent;
  match_reason: 'exact_pivot_match' | 'token_overlap';
}

interface RelatedEventsPanelProps {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  scope: { index: string; service: string; env: string };
  time: { from: string; to: string };
  pivots: InvestigationPivots;
  onSelectRelatedEvent: (event: RelatedEvent) => void;
}

function truncate(value: string, maxLen = 24): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

export function RelatedEventsPanel({
  apiFetch,
  scope,
  time,
  pivots,
  onSelectRelatedEvent
}: RelatedEventsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relatedEvents, setRelatedEvents] = useState<RelatedEventItem[]>([]);

  const fetchRelatedEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/investigations/related-events', {
        method: 'POST',
        body: JSON.stringify({
          scope: {
            index: scope.index || 'default',
            service: scope.service,
            env: scope.env || 'prod'
          },
          time: { from: time.from, to: time.to },
          pivots: pivots,
          pivot_tokens: []
        })
      });
      const body = (await response.json()) as { related_events?: RelatedEventItem[]; error?: string };
      if (!response.ok || body.error) {
        setRelatedEvents([]);
        setError(body.error || 'Failed to load related events');
        return;
      }
      setRelatedEvents(body.related_events || []);
    } catch (e) {
      setRelatedEvents([]);
      setError(e instanceof Error ? e.message : 'Request failed');
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
    void fetchRelatedEvents();
  }, [fetchRelatedEvents]);

  return (
    <div className="related-events-panel facet-card">
      <h4>Related Events</h4>
      {loading && <p className="facet-empty">Loading…</p>}
      {error && !loading && <p className="facet-empty error-text">{error}</p>}
      {!loading && !error && relatedEvents.length === 0 && (
        <p className="facet-empty">No related events found.</p>
      )}
      {!loading && !error && relatedEvents.length > 0 && (
        <div className="related-events-list">
          {relatedEvents.map((item, idx) => {
            const ev = item.event;
            const label =
              ev.trace_id ? truncate(ev.trace_id) :
              ev.request_id ? truncate(ev.request_id) :
              ev.msg_hash ? truncate(ev.msg_hash) :
              ev.message ? truncate(ev.message) :
              `Event ${idx + 1}`;
            return (
              <button
                key={ev.event_id || ev.id || idx}
                type="button"
                className="related-event-row"
                onClick={() => onSelectRelatedEvent(ev)}
                title={ev.message || label}
              >
                <span className="related-event-label">{label}</span>
                {item.match_reason === 'exact_pivot_match' && (
                  <span className="related-event-badge">exact</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
