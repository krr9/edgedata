import { useCallback, useEffect, useState } from 'react';
import { PivotChips } from './PivotChips';
import { DemoScenarioPicker, type DemoScenarioSelection } from './DemoScenarioPicker';
import type { InvestigationPivots, PivotKey } from './types';
import { API_PROXY_BASE } from '../constants';
import { formatDateTimeLocalValue } from '../utils';

interface BootstrapPayload {
  scope: { index: string; service: string; env: string };
  starter_queries: Array<{ id: string; title: string; ppl: string }>;
  pivot_chips: Array<{ key: string; value: string }>;
}

interface SavedWorkspace {
  id: string;
  name: string | null;
  owner_user_id: string | null;
  source_type: string | null;
  scope_json: string;
  created_at: string;
}

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
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseScopeJson(json: string): { index: string; service: string; env: string } | null {
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object') {
      return {
        index: String(obj.index || ''),
        service: String(obj.service || ''),
        env: String(obj.env || '')
      };
    }
  } catch { /* ignore */ }
  return null;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

type ViewMode = 'list' | 'editor';

export function IncidentWorkspacePage({
  apiToken,
  sessionIdFromUrl,
  onRunStarterQuery
}: IncidentWorkspacePageProps) {
  const [mode, setMode] = useState<ViewMode>(sessionIdFromUrl ? 'editor' : 'list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [savedList, setSavedList] = useState<SavedWorkspace[]>([]);
  const [listLoading, setListLoading] = useState(false);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [scope, setScope] = useState({ index: 'otel-demo', service: 'frontend', env: 'demo' });
  const [time, setTime] = useState<{ from: string; to: string }>(defaultTimeRange);
  const [pivots, setPivots] = useState<InvestigationPivots>({});
  const [starterQueries, setStarterQueries] = useState<BootstrapPayload['starter_queries']>([]);

  const [draftName, setDraftName] = useState('');
  const [draftIndex, setDraftIndex] = useState(scope.index);
  const [draftService, setDraftService] = useState(scope.service);
  const [draftEnv, setDraftEnv] = useState(scope.env);
  const [draftFrom, setDraftFrom] = useState(() => formatDateTimeLocalValue(new Date(time.from)));
  const [draftTo, setDraftTo] = useState(() => formatDateTimeLocalValue(new Date(time.to)));

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apiFetch = useCallback(
    (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`);
      return fetch(`${API_PROXY_BASE}${path}`, { ...init, headers, credentials: init?.credentials ?? 'include' });
    },
    [apiToken]
  );

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await apiFetch('/investigations/sessions');
      const body = (await res.json()) as { sessions?: SavedWorkspace[]; error?: string };
      if (res.ok && body.sessions) {
        setSavedList(body.sessions);
      }
    } catch { /* ignore */ } finally {
      setListLoading(false);
    }
  }, [apiFetch]);

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
        setPivots(chips);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
      } finally {
        setLoading(false);
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
        const body = (await res.json()) as {
          id?: string;
          name?: string | null;
          scope_json?: string;
          state_json?: string;
          error?: string;
        };
        if (!res.ok || body.error) {
          setError(body.error || 'Failed to load workspace');
          return;
        }
        setActiveSessionId(id);
        setWorkspaceName(body.name || '');
        setDraftName(body.name || '');

        const loadedScope = body.scope_json ? parseScopeJson(body.scope_json) : null;
        const s = loadedScope || { index: 'otel-demo', service: 'frontend', env: 'demo' };
        setScope(s);
        setDraftIndex(s.index);
        setDraftService(s.service);
        setDraftEnv(s.env);

        let loadedTime: { from: string; to: string } | null = null;
        let loadedPivots: InvestigationPivots = {};
        if (body.state_json) {
          try {
            const state = JSON.parse(body.state_json);
            if (state.time) loadedTime = state.time;
            if (state.pivots) loadedPivots = state.pivots;
          } catch { /* ignore */ }
        }
        const t = loadedTime || defaultTimeRange();
        setTime(t);
        setDraftFrom(formatDateTimeLocalValue(new Date(t.from)));
        setDraftTo(formatDateTimeLocalValue(new Date(t.to)));
        setPivots(loadedPivots);
        setMode('editor');
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
    if (sessionIdFromUrl) {
      void loadSession(sessionIdFromUrl);
    } else {
      void loadList().then(() => {
        void loadBootstrap();
      });
    }
  }, [sessionIdFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNew = useCallback(() => {
    setActiveSessionId(null);
    setWorkspaceName('');
    setDraftName('');
    const s = { index: 'otel-demo', service: 'frontend', env: 'demo' };
    const t = defaultTimeRange();
    setScope(s);
    setTime(t);
    setDraftIndex(s.index);
    setDraftService(s.service);
    setDraftEnv(s.env);
    setDraftFrom(formatDateTimeLocalValue(new Date(t.from)));
    setDraftTo(formatDateTimeLocalValue(new Date(t.to)));
    setPivots({});
    setStarterQueries([]);
    setError(null);
    setSaveError(null);
    setMode('editor');
    void loadBootstrap(s, t);
  }, [loadBootstrap]);

  const handleApplyScope = useCallback(() => {
    const nextScope = {
      index: draftIndex.trim() || 'otel-demo',
      service: draftService.trim() || 'frontend',
      env: draftEnv.trim() || 'demo'
    };
    const nextTime = {
      from: new Date(draftFrom).toISOString(),
      to: new Date(draftTo).toISOString()
    };
    setScope(nextScope);
    setTime(nextTime);
    setWorkspaceName(draftName);
    void loadBootstrap(nextScope, nextTime);
  }, [draftIndex, draftService, draftEnv, draftFrom, draftTo, draftName, loadBootstrap]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const payload = {
      name: draftName.trim() || null,
      scope: scope,
      state: { scope, time, pivots },
      source_type: 'workspace'
    };
    try {
      if (activeSessionId) {
        const res = await apiFetch(`/investigations/session/${activeSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) {
          setSaveError(body.error || 'Failed to update');
          return;
        }
        setWorkspaceName(draftName.trim());
      } else {
        const res = await apiFetch('/investigations/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const body = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || body.error) {
          setSaveError(body.error || 'Failed to save');
          return;
        }
        if (body.id) {
          setActiveSessionId(body.id);
          setWorkspaceName(draftName.trim());
        }
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, activeSessionId, draftName, scope, time, pivots]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await apiFetch(`/investigations/session/${id}`, { method: 'DELETE' });
      setSavedList((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setMode('list');
      }
    } catch { /* ignore */ }
  }, [apiFetch, activeSessionId]);

  const handleBack = useCallback(() => {
    setMode('list');
    setError(null);
    setSaveError(null);
    void loadList();
  }, [loadList]);

  const handlePivotClick = useCallback((key: PivotKey) => {
    setPivots((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleSelectScenario = useCallback(
    (selection: DemoScenarioSelection) => {
      setScope(selection.scope);
      setTime(selection.time);
      setPivots(selection.pivots);
      setStarterQueries(selection.starterQueries);
      setDraftIndex(selection.scope.index);
      setDraftService(selection.scope.service);
      setDraftEnv(selection.scope.env);
      setDraftFrom(formatDateTimeLocalValue(new Date(selection.time.from)));
      setDraftTo(formatDateTimeLocalValue(new Date(selection.time.to)));
    },
    []
  );

  // ── List view ──────────────────────────────────────────
  if (mode === 'list') {
    return (
      <div className="workspace-view">
        <div className="workspace-list-header">
          <h2>Workspaces</h2>
          <button type="button" className="primary" onClick={handleNew}>
            New Workspace
          </button>
        </div>
        {listLoading && <div className="workspace-loading app-loading">Loading…</div>}
        {!listLoading && (
          <ul className="workspace-saved-list">
            <li className="workspace-saved-item workspace-default-item card">
              <div className="workspace-saved-info">
                <strong>Default Workspace</strong>
                <span className="workspace-saved-scope">otel-demo / frontend / demo</span>
              </div>
              <div className="workspace-saved-actions">
                <button type="button" className="secondary" onClick={handleNew}>
                  Open
                </button>
              </div>
            </li>
            {savedList.map((ws) => {
              const wsScope = parseScopeJson(ws.scope_json);
              return (
                <li key={ws.id} className="workspace-saved-item card">
                  <div className="workspace-saved-info">
                    <strong>{ws.name || 'Untitled workspace'}</strong>
                    {wsScope && (
                      <span className="workspace-saved-scope">
                        {wsScope.index} / {wsScope.service} / {wsScope.env}
                      </span>
                    )}
                    <span className="workspace-saved-time">{formatRelativeTime(ws.created_at)}</span>
                  </div>
                  <div className="workspace-saved-actions">
                    <button type="button" className="secondary" onClick={() => void loadSession(ws.id)}>
                      Open
                    </button>
                    <button
                      type="button"
                      className="workspace-delete-btn"
                      onClick={() => void handleDelete(ws.id)}
                      title="Delete workspace"
                    >
                      &times;
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  // ── Editor view ────────────────────────────────────────
  return (
    <div className="workspace-view">
      {error && <div className="error-banner">{error}</div>}

      <div className="workspace-editor-header">
        <button type="button" className="secondary workspace-back-btn" onClick={handleBack}>
          &larr; All Workspaces
        </button>
        <div className="workspace-editor-title">
          <input
            type="text"
            className="workspace-name-input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Untitled workspace"
          />
          {activeSessionId && <span className="workspace-saved-badge">Saved</span>}
        </div>
        <div className="workspace-editor-actions">
          <button
            type="button"
            className="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : activeSessionId ? 'Save' : 'Create'}
          </button>
          {saveError && <span className="workspace-save-error">{saveError}</span>}
        </div>
      </div>

      <DemoScenarioPicker apiFetch={apiFetch} onSelectScenario={handleSelectScenario} />

      <div className="workspace-scope-editor card">
        <h3>Scope</h3>
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
              <button type="button" className="secondary" onClick={handleApplyScope} disabled={loading}>
                {loading ? 'Loading…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="workspace-content">
        <div className="workspace-top-signals card">
          <h3>Top Signals</h3>
          {starterQueries.length === 0 && !loading && (
            <p className="empty-card">Apply a scope to generate starter queries.</p>
          )}
          <ul className="workspace-starter-list">
            {starterQueries.map((q) => {
              const handleOpen = () => {
                if (!onRunStarterQuery) return;
                onRunStarterQuery({ title: q.title, ppl: q.ppl, scope, time, pivots });
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
                    Open trace context
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
