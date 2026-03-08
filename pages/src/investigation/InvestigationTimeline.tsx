export interface TimelinePoint {
  minute: string;
  count: number;
}

interface InvestigationTimelineProps {
  timeline: TimelinePoint[];
  loading?: boolean;
  label?: string;
}

function maxCount(points: TimelinePoint[]): number {
  if (points.length === 0) return 1;
  return Math.max(1, ...points.map((p) => p.count));
}

export function InvestigationTimeline({
  timeline,
  loading = false,
  label = 'Activity Timeline'
}: InvestigationTimelineProps) {
  const max = maxCount(timeline);

  return (
    <div className="investigation-timeline timeline-card card">
      <div className="timeline-head">
        <h4>{label}</h4>
        <span>
          {loading
            ? 'Loading…'
            : timeline.length === 0
              ? 'No timeline data yet.'
              : `${timeline.reduce((s, p) => s + p.count, 0).toLocaleString()} events`}
        </span>
      </div>
      <div className="timeline-bars">
        {loading && <p className="facet-empty">Loading…</p>}
        {!loading && timeline.length === 0 && <p className="facet-empty">No timeline data yet.</p>}
        {!loading &&
          timeline.length > 0 &&
          timeline.map((point) => (
            <div
              key={point.minute}
              className="timeline-col"
              title={`${point.minute} - ${point.count}`}
            >
              <div
                className="timeline-bar"
                style={{
                  height: `${Math.max(8, (point.count / max) * 58)}px`
                }}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
