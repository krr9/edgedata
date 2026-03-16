import { useCallback, useEffect, useRef, useState } from 'react';
import { EventTimeline } from './EventTimeline';
import { PivotChips } from './PivotChips';
import { RelatedEventsPanel } from './RelatedEventsPanel';
import { DemoScenarioPicker, type DemoScenarioSelection } from './DemoScenarioPicker';
import type { InvestigationPivots, PivotKey, RelatedEvent } from './types';
import { pivotsFromRelatedEvent, hasPivots } from './types';
import { API_PROXY_BASE } from '../constants';
import { formatDateTimeLocalValue, type InvestigationContext } from '../utils';

interface BootstrapPayload {
  scope: { index: string; service: string; env: string };
  starter_queries: Array<{ id: string; title: string; ppl: string }>;
  pivot_chips: Array<{ key: string; value: string }>;
}

interface SignalCount {
  loading: boolean;
  total: number | null;
  label: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  alert: 'Alert',
  search: 'Log Event',
  dashboard: 'Dashboard'
};

function escapePplValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildScopedPpl(
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

function defaultTimeRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface IncidentWorkspacePageProps {
  apiToken: string;
  sessionIdFromUrl: string | null;
  initialContext?: InvestigationContext | null;
  onRunStarterQuery?: (selection: WorkspaceStarterSelection) => void;
}

export interface WorkspaceStarterSelection {
  title: string;
  ppl: string;
  scope: { index: string; service: string; env: string };
  time: { from: string; to: string };
  pivots: InvestigationPivots;
}

export function IncidentWorkspacePage({
  apiToken,
  sessionIdFromUrl,
  initialContext,
  onRunStarterQuery
}: IncidentWorkspacePageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initScope = initialContext
    ? {
        index: initialContext.index || 'otel-demo',
        service: initialContext.service || 'frontend',
        env: initialContext.env || 'demo'
      }
    : { index: 'otel-demo', service: 'frontend', env: 'demo' };

  const initTime = (initialContext?.time_from && initialContext?.time_to)
    ? { from: initialContext.time_from, to: initialContext.time_to }
    : defaultTimeRange();

  const initPivots: InvestigationPivots = {};
  if (initialContext?.trace_id) initPivots.trace_id = initialContext.trace_id;
  if (initialContext?.request_id) initPivots.request_id = initialContext.request_id;
  if (initialContext?.user_id) initPivots.user_id = initialContext.user_id;
  if (initialContext?.msg_hash) initPivots.msg_hash = initialContext.msg_hash;

  const [scope, setScope] = useState(initScope);
  const [time, setTime] = useState(initTime);
  const [pivots, setPivots] = useState<InvestigationPivots>(initPivots);
  const [starterQueries, setStarterQueries] = useState<BootstrapPayload['starter_queries']>([]);
  const [signalCounts, setSignalCounts] = useState<Record<string, SignalCount>>({});

  const [draftIndex, setDraftIndex] = useState(scope.index);
  const [draftService, setDraftService] = useState(scope.service);
  const [draftEnv, setDraftEnv] = useState(scope.env);
  const [draftFrom, setDraftFrom] = useState(() => formatDateTimeLocalValue(new Date(time.from)));
  const [draftTo, setDraftTo] = useState(() => formatDateTimeLocalValue(new Date(time.to)));
  const [scopeExpanded, setScopeExpanded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sessionRestoredRef = useRef(false);

  const apiFetch = useCallback(
    (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`);
      return fetch(`${API_PROXY_BASE}${path}`, { ...init, headers, credentials: init?.credentials ?? 'include' });
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
          body: JSON.stringify({ source: 'workspace', time: { from: t.from, to: t.to }, scope: s })
        });
        const body = (await response.json()) as BootstrapPayload & { error?: string };
        if (!response.ok || body.error) {
          setError(body.error || 'Failed to load workspace');
          return;
        }
        setScope(body.scope);
        setStarterQueries(body.starter_queries || []);
        const chips: InvestigationPivots = {};
        for (const c of body.pivot_chips || []) {
          if (c.key && c.value) chips[c.key as PivotKey] = c.value;
        }
        setPivots((prev) => ({ ...chips, ...prev }));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch]
  );

  const loadSignalCount = useCallback(
    async (query: { id: string; ppl: string }, t: { from: string; to: string }) => {
      setSignalCounts((prev) => ({ ...prev, [query.id]: { loading: true, total: null, label: null } }));
      try {
        const response = await apiFetch('/search/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ time: { from: t.from, to: t.to }, ppl: query.ppl, limit: 500, cursor: null })
        });
        const body = (await response.json()) as {
          timeline?: Array<{ minute: string; count: number }>;
          stats?: Record<string, unknown>;
          error?: string;
        };
        if (response.ok && body.timeline) {
          const total = body.timeline.reduce((s, p) => s + p.count, 0);
          setSignalCounts((prev) => ({
            ...prev,
            [query.id]: { loading: false, total, label: formatCompact(total) }
          }));
        } else {
          setSignalCounts((prev) => ({ ...prev, [query.id]: { loading: false, total: null, label: null } }));
        }
      } catch {
        setSignalCounts((prev) => ({ ...prev, [query.id]: { loading: false, total: null, label: null } }));
      }
    },
    [apiFetch]
  );

  const loadSession = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/investigations/session/${id}`);
        const body = (await res.json()) as { scope_json?: string; state_json?: string; error?: string };
        if (!res.ok || body.error) {
          setError(body.error || 'Failed to load session');
          return;
        }
        let s = { index: 'otel-demo', service: 'frontend', env: 'demo' };
        if (body.scope_json) {
          try { const parsed = JSON.parse(body.scope_json); s = { index: parsed.index || s.index, service: parsed.service || s.service, env: parsed.env || s.env }; } catch { /* ignore */ }
        }
        setScope(s);
        setDraftIndex(s.index);
        setDraftService(s.service);
        setDraftEnv(s.env);
        let t = defaultTimeRange();
        let p: InvestigationPivots = {};
        if (body.state_json) {
          try {
            const state = JSON.parse(body.state_json);
            if (state.time) t = state.time;
            if (state.pivots) p = state.pivots;
          } catch { /* ignore */ }
        }
        setTime(t);
        setDraftFrom(formatDateTimeLocalValue(new Date(t.from)));
        setDraftTo(formatDateTimeLocalValue(new Date(t.to)));
        setPivots(p);
        void loadBootstrap(s, t);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, loadBootstrap]
  );

  useEffect(() => {
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    if (sessionIdFromUrl) {
      void loadSession(sessionIdFromUrl);
    } else {
      void loadBootstrap(initScope, initTime);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (starterQueries.length === 0) return;
    for (const q of starterQueries) {
      void loadSignalCount(q, time);
    }
  }, [starterQueries, time.from, time.to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setDraftIndex(scope.index);
    setDraftService(scope.service);
    setDraftEnv(scope.env);
  }, [scope.index, scope.service, scope.env]);

  useEffect(() => {
    setDraftFrom(formatDateTimeLocalValue(new Date(time.from)));
    setDraftTo(formatDateTimeLocalValue(new Date(time.to)));
  }, [time.from, time.to]);

  const handleApplyScope = useCallback(() => {
    const nextScope = {
      index: draftIndex.trim() || 'otel-demo',
      service: draftService.trim() || 'frontend',
      env: draftEnv.trim() || 'demo'
    };
    const nextTime = { from: new Date(draftFrom).toISOString(), to: new Date(draftTo).toISOString() };
    setScope(nextScope);
    setTime(nextTime);
    setSignalCounts({});
    void loadBootstrap(nextScope, nextTime);
  }, [draftIndex, draftService, draftEnv, draftFrom, draftTo, loadBootstrap]);

  const handlePivotClick = useCallback((key: PivotKey) => {
    setPivots((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleSelectRelatedEvent = useCallback((ev: RelatedEvent) => {
    const newPivots = pivotsFromRelatedEvent(ev);
    setPivots(newPivots);
    setSignalCounts({});
    void loadBootstrap(scope, time);
  }, [loadBootstrap, scope, time]);

  const handleTimelinePivot = useCallback((newPivots: InvestigationPivots) => {
    setPivots(newPivots);
    setSignalCounts({});
  }, []);

  const handleSelectScenario = useCallback(
    (selection: DemoScenarioSelection) => {
      setScope(selection.scope);
      setTime(selection.time);
      setPivots(selection.pivots);
      setStarterQueries(selection.starterQueries);
      setSignalCounts({});
      setDraftIndex(selection.scope.index);
      setDraftService(selection.scope.service);
      setDraftEnv(selection.scope.env);
      setDraftFrom(formatDateTimeLocalValue(new Date(selection.time.from)));
      setDraftTo(formatDateTimeLocalValue(new Date(selection.time.to)));
    },
    []
  );

  const handleSaveShare = useCallback(async () => {
    setSaving(true);
    setShareLink(null);
    try {
      const res = await apiFetch('/investigations/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: initialContext?.sourceLabel || null,
          scope,
          state: { scope, time, pivots },
          source_type: 'workspace'
        })
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (res.ok && body.id) {
        setShareLink(`${window.location.origin}${window.location.pathname}?session=${body.id}`);
      }
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  }, [apiFetch, scope, time, pivots, initialContext?.sourceLabel]);

  const handleCopy = useCallback(() => {
    if (!shareLink) return;
    void navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shareLink]);

  const sourceTag = initialContext?.source ? SOURCE_LABELS[initialContext.source] || initialContext.source : null;
  const sourceLabel = initialContext?.sourceLabel || null;

  if (loading) {
    return (
      <div className="workspace-view">
        <div className="workspace-loading app-loading">Loading investigation…</div>
      </div>
    );
  }

  return (
    <div className="workspace-view">
      {error && <div className="error-banner">{error}</div>}

      {/* ── Context bar ───────────────────────────────────── */}
      <div className="workspace-context-bar">
        <div className="workspace-context-left">
          {sourceTag && (
            <span className="workspace-source-tag">{sourceTag}</span>
          )}
          {sourceLabel && (
            <span className="workspace-source-label">{sourceLabel}</span>
          )}
          {!sourceTag && !sourceLabel && (
            <span className="workspace-source-label">Investigation</span>
          )}
          <span className="workspace-scope-badge">
            {scope.index} / {scope.service} / {scope.env}
          </span>
        </div>
        <div className="workspace-context-right">
          <button
            type="button"
            className="secondary workspace-scope-edit-btn"
            onClick={() => setScopeExpanded((o) => !o)}
          >
            {scopeExpanded ? 'Close' : 'Edit Scope'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={handleSaveShare}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save & Share'}
          </button>
          {shareLink && (
            <div className="workspace-share-link">
              <input readOnly value={shareLink} className="workspace-share-input" />
              <button className="secondary" onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Scope editor (collapsible) ────────────────────── */}
      {scopeExpanded && (
        <div className="workspace-scope-editor card">
          <div className="workspace-scope-fields">
            <div className="workspace-scope-row">
              <label>
                Index
                <input type="text" value={draftIndex} onChange={(e) => setDraftIndex(e.target.value)} placeholder="otel-demo" />
              </label>
              <label>
                Service
                <input type="text" value={draftService} onChange={(e) => setDraftService(e.target.value)} placeholder="frontend" />
              </label>
              <label>
                Environment
                <input type="text" value={draftEnv} onChange={(e) => setDraftEnv(e.target.value)} placeholder="demo" />
              </label>
            </div>
            <div className="workspace-scope-row">
              <label>
                From
                <input type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
              </label>
              <div className="workspace-scope-actions">
                <button type="button" className="primary" onClick={handleApplyScope}>
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <DemoScenarioPicker apiFetch={apiFetch} onSelectScenario={handleSelectScenario} />

      {/* ── Pivot chips ───────────────────────────────────── */}
      {hasPivots(pivots) && (
        <div className="workspace-pivots-section">
          <PivotChips pivots={pivots} onPivotClick={handlePivotClick} />
          {onRunStarterQuery && (
            <div className="workspace-pivot-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  onRunStarterQuery({
                    title: 'Pivot context',
                    ppl: buildScopedPpl(scope, pivots),
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
                  Trace Context
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Event Timeline ─────────────────────────────────── */}
      {hasPivots(pivots) && (
        <EventTimeline
          apiFetch={apiFetch}
          scope={scope}
          time={time}
          pivots={pivots}
          onPivotEvent={handleTimelinePivot}
        />
      )}

      {/* ── Top Signals with inline counts ────────────────── */}
      <div className="workspace-signals-grid">
        {starterQueries.map((q) => {
          const count = signalCounts[q.id];
          const handleOpen = () => {
            if (!onRunStarterQuery) return;
            onRunStarterQuery({ title: q.title, ppl: q.ppl, scope, time, pivots });
          };
          return (
            <div
              key={q.id}
              className={`workspace-signal-card card${onRunStarterQuery ? ' interactive' : ''}`}
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
              <div className="workspace-signal-header">
                <strong>{q.title}</strong>
                <span className="workspace-signal-count">
                  {count?.loading ? '…' : count?.label ?? '—'}
                </span>
              </div>
              <span className="workspace-signal-desc">{SIGNAL_DESCRIPTIONS[q.id] || 'Open in Search'}</span>
            </div>
          );
        })}
      </div>

      {/* ── Related Events ────────────────────────────────── */}
      {hasPivots(pivots) && (
        <RelatedEventsPanel
          apiFetch={apiFetch}
          scope={scope}
          time={time}
          pivots={pivots}
          onSelectRelatedEvent={handleSelectRelatedEvent}
        />
      )}
    </div>
  );
}

const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  errors: 'Recent error-level events in scope',
  latency: 'Average duration by host',
  volume: 'Event volume over time'
};
