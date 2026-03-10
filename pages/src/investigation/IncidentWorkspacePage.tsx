import { useCallback, useEffect, useState } from 'react';
import { InvestigationTimeline, type TimelinePoint } from './InvestigationTimeline';
import { SessionShareBar, type WorkspaceState } from './SessionShareBar';
import { PivotChips } from './PivotChips';
import { DemoScenarioPicker, type DemoScenarioSelection } from './DemoScenarioPicker';
import type { InvestigationPivots, PivotKey } from './types';

const API_BASE =
  ((import.meta as { env?: Record<string, string> }).env?.VITE_QUERY_API_BASE || '').trim();
const API_BASE_MISSING_ERROR = 'Missing VITE_QUERY_API_BASE. Configure your deployed query-worker URL.';

interface BootstrapPayload {
  scope: { index: string; service: string; env: string };
  starter_queries: Array<{ id: string; title: string; ppl: string }>;
  pivot_chips: Array<{ key: string; value: string }>;
  timeline?: Array<{ minute: string; count: number }>;
}

function escapePplValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildTimelinePpl(
  scope: { index: string; service: string; env: string },
  pivots: InvestigationPivots
): string {
  const conditions: string[] = [];
  if (scope.index && scope.index !== 'default' && scope.index !== '*') {
    conditions.push(`index="${escapePplValue(scope.index)}"`);
  }
  if (scope.service && scope.service !== 'unknown' && scope.service !== '*') {
    conditions.push(`service="${escapePplValue(scope.service)}"`);
  }
  if (scope.env && scope.env !== '*') {
    conditions.push(`env="${escapePplValue(scope.env)}"`);
  }
  if (pivots.trace_id) conditions.push(`trace_id="${escapePplValue(pivots.trace_id)}"`);
  if (pivots.request_id) conditions.push(`request_id="${escapePplValue(pivots.request_id)}"`);
  if (pivots.user_id) conditions.push(`user_id="${escapePplValue(pivots.user_id)}"`);
  if (pivots.msg_hash) conditions.push(`msg_hash="${escapePplValue(pivots.msg_hash)}"`);
  return `search * | where ${conditions.join(' and ')} | sort -ts | head 500`;
}

function buildTraceContextPpl(
  scope: { index: string; service: string; env: string },
  traceId: string
): string {
  const conditions: string[] = [`trace_id="${escapePplValue(traceId)}"`];
  if (scope.index && scope.index !== 'default' && scope.index !== '*') {
    conditions.push(`index="${escapePplValue(scope.index)}"`);
  }
  if (scope.service && scope.service !== 'unknown' && scope.service !== '*') {
    conditions.push(`service="${escapePplValue(scope.service)}"`);
  }
  if (scope.env && scope.env !== '*') {
    conditions.push(`env="${escapePplValue(scope.env)}"`);
  }
  return `search * | where ${conditions.join(' and ')} | transaction trace_id maxspan=5m maxevents=200 | sort -ts | head 200`;
}

interface IncidentWorkspacePageProps {
  apiToken: string;
  sessionIdFromUrl: string | null;
  onRunStarterQuery?: (selection: WorkspaceStarterSelection) => void;
}

export interface WorkspaceStarterSelection {
  title: string;
  ppl: string;
  scope: { index: string; service: string; env: string };
  time: { from: string; to: string };
  pivots: InvestigationPivots;
}

function defaultTimeRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
  return {
    from: from.toISOString(),
    to: to.toISOString()
  };
}

export function IncidentWorkspacePage({
  apiToken,
  sessionIdFromUrl,
  onRunStarterQuery
}: IncidentWorkspacePageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<{ index: string; service: string; env: string }>({
    index: 'otel-demo',
    service: 'frontend',
    env: 'demo'
  });
  const [time, setTime] = useState<{ from: string; to: string }>(defaultTimeRange);
  const [pivots, setPivots] = useState<InvestigationPivots>({});
  const [starterQueries, setStarterQueries] = useState<BootstrapPayload['starter_queries']>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const apiFetch = useCallback(
    (path: string, init?: RequestInit) => {
      if (!API_BASE) {
        return Promise.reject(new Error(API_BASE_MISSING_ERROR));
      }
      const headers = new Headers(init?.headers);
      if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`);
      return fetch(`${API_BASE}${path}`, { ...init, headers });
    },
    [apiToken]
  );

  const loadBootstrap = useCallback(
    async (
      scopeOverride?: { index: string; service: string; env: string },
      timeOverride?: { from: string; to: string }
    ) => {
      const s = scopeOverride || scope;
      const t = timeOverride || time;
      setLoading(true);
      setError(null);
      try {
        const response = await apiFetch('/investigations/bootstrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'workspace',
            time: { from: t.from, to: t.to },
            scope: s
          })
        });
        const body = (await response.json()) as BootstrapPayload & { error?: string };
        if (!response.ok || body.error) {
          setError(body.error || 'Failed to load workspace');
          return;
        }
        setScope(body.scope);
        setStarterQueries(body.starter_queries || []);
        if (Array.isArray(body.timeline) && body.timeline.length > 0) {
          setTimeline(body.timeline);
        }
        const chips: InvestigationPivots = {};
        for (const c of body.pivot_chips || []) {
          if (c.key && c.value) chips[c.key as PivotKey] = c.value;
        }
        setPivots(chips);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch]
  );

  const loadSummary = useCallback(
    async (
      scopeOverride?: { index: string; service: string; env: string },
      timeOverride?: { from: string; to: string },
      pivotsOverride?: InvestigationPivots
    ) => {
      const s = scopeOverride || scope;
      const t = timeOverride || time;
      const p = pivotsOverride || pivots;
      setTimelineLoading(true);
      try {
        const payload = {
          time: { from: t.from, to: t.to },
          ppl: buildTimelinePpl(s, p),
          limit: 500,
          cursor: null
        };
        const response = await apiFetch('/search/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const body = (await response.json()) as {
          timeline?: Array<{ minute: string; count: number }>;
          error?: string;
        };
        if (response.ok && body.timeline) {
          setTimeline(body.timeline);
        } else {
          setTimeline([]);
        }
      } catch {
        setTimeline([]);
      } finally {
        setTimelineLoading(false);
      }
    },
    [apiFetch, pivots, scope, time]
  );


  useEffect(() => {
    if (sessionIdFromUrl) {
      setLoading(false);
      return;
    }
    void loadBootstrap();
  }, [sessionIdFromUrl, loadBootstrap]);

  useEffect(() => {
    if (!sessionIdFromUrl && !loading && !error && timeline.length === 0) {
      void loadSummary();
    }
  }, [sessionIdFromUrl, loading, error, timeline.length, scope.index, scope.service, scope.env]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestore = useCallback(
    (restored: WorkspaceState) => {
      if (restored.scope) setScope(restored.scope);
      if (restored.time) setTime(restored.time);
      if (restored.pivots) setPivots(restored.pivots);
      void loadBootstrap(restored.scope, restored.time);
    },
    [loadBootstrap]
  );

  const handlePivotClick = useCallback((key: PivotKey) => {
    setPivots((prev) => {
      const next = { ...prev };
      delete next[key];
      void loadSummary(scope, time, next);
      return next;
    });
  }, [loadSummary, scope, time]);

  const handleSelectScenario = useCallback(
    (selection: DemoScenarioSelection) => {
      setTimeline([]);
      setScope(selection.scope);
      setTime(selection.time);
      setPivots(selection.pivots);
      setStarterQueries(selection.starterQueries);
      void loadSummary(selection.scope, selection.time);
    },
    [loadSummary]
  );

  const workspaceState: WorkspaceState = {
    scope,
    time,
    pivots
  };

  if (loading && !sessionIdFromUrl) {
    return (
      <div className="workspace-view">
        <div className="workspace-loading app-loading">Loading workspace…</div>
      </div>
    );
  }

  return (
    <div className="workspace-view">
      {error && <div className="error-banner">{error}</div>}

      <DemoScenarioPicker apiFetch={apiFetch} onSelectScenario={handleSelectScenario} />

      <SessionShareBar
        apiFetch={apiFetch}
        scope={scope}
        state={workspaceState}
        sessionIdFromUrl={sessionIdFromUrl}
        onRestore={handleRestore}
      />

      <div className="workspace-content">
        <div className="workspace-top-signals card">
          <h3>Top Signals</h3>
          {starterQueries.length === 0 && !loading && (
            <p className="empty-card">No starter queries. Run a bootstrap or load a session.</p>
          )}
          <ul className="workspace-starter-list">
            {starterQueries.map((q) => {
              const handleOpen = () => {
                if (!onRunStarterQuery) return;
                onRunStarterQuery({
                  title: q.title,
                  ppl: q.ppl,
                  scope,
                  time,
                  pivots
                });
              };
              return (
                <li
                  key={q.id}
                  className={onRunStarterQuery ? 'interactive' : ''}
                  role={onRunStarterQuery ? 'button' : undefined}
                  tabIndex={onRunStarterQuery ? 0 : undefined}
                  onClick={onRunStarterQuery ? handleOpen : undefined}
                  onKeyDown={
                    onRunStarterQuery
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleOpen();
                          }
                        }
                      : undefined
                  }
                >
                  <strong>{q.title}</strong>
                  <code className="workspace-ppl">{q.ppl}</code>
                </li>
              );
            })}
          </ul>
        </div>

        {Object.keys(pivots).length > 0 && (
          <>
            <PivotChips pivots={pivots} onPivotClick={handlePivotClick} />
            {onRunStarterQuery && (
              <div className="workspace-pivot-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    onRunStarterQuery({
                      title: 'Pivot context',
                      ppl: buildTimelinePpl(scope, pivots),
                      scope,
                      time,
                      pivots
                    });
                  }}
                >
                  Open pivots in Search
                </button>
                {pivots.trace_id && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      onRunStarterQuery({
                        title: 'Trace context',
                        ppl: buildTraceContextPpl(scope, pivots.trace_id as string),
                        scope,
                        time,
                        pivots
                      });
                    }}
                  >
                    Open trace context
                  </button>
                )}
              </div>
            )}
          </>
        )}

        <InvestigationTimeline
          timeline={timeline}
          loading={timelineLoading}
          label="Activity Timeline"
        />
      </div>
    </div>
  );
}
