import type { InvestigationPivots, PivotKey } from './types';

const PIVOT_LABELS: Record<PivotKey, string> = {
  trace_id: 'Trace',
  request_id: 'Request',
  user_id: 'User',
  msg_hash: 'MsgHash',
};

function truncate(value: string, maxLen = 20): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

interface PivotChipsProps {
  pivots: InvestigationPivots;
  onPivotClick: (key: PivotKey, value: string) => void;
}

export function PivotChips({ pivots, onPivotClick }: PivotChipsProps) {
  const entries = (['trace_id', 'request_id', 'user_id', 'msg_hash'] as PivotKey[])
    .filter((k) => pivots[k])
    .map((k) => ({ key: k, value: pivots[k]! }));

  if (entries.length === 0) return null;

  return (
    <div className="pivot-chips">
      {entries.map(({ key, value }) => (
        <button
          key={key}
          type="button"
          className="pivot-chip"
          onClick={() => onPivotClick(key, value)}
          title={`${PIVOT_LABELS[key]}: ${value}`}
        >
          <span className="pivot-chip-label">{PIVOT_LABELS[key]}</span>
          <span className="pivot-chip-value">{truncate(value)}</span>
        </button>
      ))}
    </div>
  );
}
