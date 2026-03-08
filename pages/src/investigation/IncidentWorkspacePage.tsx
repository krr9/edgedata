import { useCallback, useEffect, useState } from 'react';
import { InvestigationTimeline, type TimelinePoint } from './InvestigationTimeline';
import { SessionShareBar, type WorkspaceState } from './SessionShareBar';
import { PivotChips } from './PivotChips';
import { DemoScenarioPicker, type DemoScenarioSelection } from './DemoScenarioPicker';
import type { InvestigationPivots, PivotKey } from './types';

const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_QUERY_API_BASE ||
  'https://query-worker.example.workers.dev';

interface BootstrapPayload {
  scope: { index: string; service: string; env: string };
  starter_queries: Array<{ id: string; title: string; ppl: string }>;
  pivot_chips: Array<{ key: string; value: string }>;
  timeline?: Array<{ minute: string; count: number }>;
}

interface IncidentWorkspacePageProps {
  apiToken: string;
  sessionIdFromUrl: string | null;
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
  sessionIdFromUrl
}: IncidentWorkspacePageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<{ index: string; service: string; env: string }>({
    index: 'default',
    service: 'unknown',
    env: 'prod'
  });
  const [time, setTime] = useState<{ from: string; to: string }>(defaultTimeRange);
  const [pivots, setPivots] = useState<InvestigationPivots>({});
  const [starterQueries, setStarterQueries] = useState<BootstrapPayload['starter_queries']>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const apiFetch = useCallback(
    (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`);
      return fetch(`${API_BASE}${path}`, { ...init, headers });
    },
    [apiToken]
  );

  const loadBootstrap = useCallback(
    async (scopeOverride?: { index: string; service: string; env: string }) => {
      const s = scopeOverride || scope;
      const t = time;
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
    [apiFetch, scope, time]
  );

  const loadSummary = useCallback(
    async (
      scopeOverride?: { index: string; service: string; env: string },
      timeOverride?: { from: string; to: string }
    ) => {
      const s = scopeOverride || scope;
      const t = timeOverride || time;
      setTimelineLoading(true);
      try {
        const payload = {
          time: { from: t.from, to: t.to },
          ppl: `search * | where index="${s.index}" and service="${s.service}" and env="${s.env}" | sort -ts | head 500`,
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
    [apiFetch, scope, time]
  );


  useEffect(() => {
    if (sessionIdFromUrl) {
      setLoading(false);
      return;
    }
    void loadBootstrap();
  }, [sessionIdFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

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
      void loadBootstrap(restored.scope);
    },
    [loadBootstrap]
  );

  const handlePivotClick = useCallback((key: PivotKey) => {
    setPivots((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

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
            {starterQueries.map((q) => (
              <li key={q.id}>
                <strong>{q.title}</strong>
                <code className="workspace-ppl">{q.ppl}</code>
              </li>
            ))}
          </ul>
        </div>

        {Object.keys(pivots).length > 0 && (
          <PivotChips pivots={pivots} onPivotClick={handlePivotClick} />
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
