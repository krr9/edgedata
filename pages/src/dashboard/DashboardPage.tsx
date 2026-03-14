import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WidgetGrid } from './WidgetGrid';
import type { DashboardSummary, DashboardWidget, DashboardRow, WidgetType } from './types';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const WidgetEditorDrawer = lazy(async () => {
  const mod = await import('./WidgetEditorDrawer');
  return { default: mod.WidgetEditorDrawer };
});

const TIME_PRESETS = [
  { label: '15m', value: 15 },
  { label: '1h', value: 60 },
  { label: '4h', value: 240 },
  { label: '24h', value: 1440 },
  { label: '7d', value: 10080 }
] as const;

const FRONTEND_WIDGET_CACHE_TTL_MS = 60_000;
const MAX_DASHBOARD_WIDGET_CACHE_SIZE = 200;
const dashboardWidgetResultCache = new Map<string, { expiresAt: number; rows: DashboardRow[] }>();

function resolveDashboardDefaultMinutes(widgets: DashboardWidget[], fallback: number): number {
  const counts = new Map<number, number>();
  for (const widget of widgets) {
    const minutes = Number(widget.time_window_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    counts.set(minutes, (counts.get(minutes) || 0) + 1);
  }
  let selected = fallback;
  let selectedCount = -1;
  for (const [minutes, count] of counts.entries()) {
    if (count > selectedCount) {
      selected = minutes;
      selectedCount = count;
    }
  }
  return selected;
}

function evictOldest<V>(map: Map<string, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const toDelete = map.size - maxSize;
  const iter = map.keys();
  for (let i = 0; i < toDelete; i++) {
    const next = iter.next();
    if (!next.done) map.delete(next.value);
  }
}

function buildFrontendWidgetCacheKey(dashboardId: string, widget: DashboardWidget, minutes: number): string {
  return `${dashboardId}|${widget.id}|${minutes}|${widget.query_text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function clearDashboardWidgetCache(dashboardId: string): void {
  for (const key of dashboardWidgetResultCache.keys()) {
    if (key.startsWith(`${dashboardId}|`)) {
      dashboardWidgetResultCache.delete(key);
    }
  }
}

function parseWidget(raw: Record<string, unknown>): DashboardWidget {
  return {
    id: String(raw.id || ''),
    dashboard_id: String(raw.dashboard_id || ''),
    title: String(raw.title || 'Untitled widget'),
    widget_type: String(raw.widget_type || raw.viz_type || 'table') as WidgetType,
    query_text: String(raw.query_text || raw.ppl || ''),
    query_mode: String(raw.query_mode || 'ppl'),
    viz_config_json: String(raw.viz_config_json || '{}'),
    layout_json: String(raw.layout_json || '{}'),
    bindings_json: String(raw.bindings_json || '{}'),
    display_options_json: String(raw.display_options_json || '{}'),
    time_window_minutes: Number(raw.time_window_minutes) || 60,
    refresh_seconds: Number(raw.refresh_seconds) || 0,
    position: Number(raw.position) || 0,
    created_at: String(raw.created_at || new Date().toISOString()),
    updated_at: raw.updated_at ? String(raw.updated_at) : null
  };
}

export function DashboardPage({
  apiFetch
}: {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
}): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [selectedDashboardId, setSelectedDashboardId] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [widgetData, setWidgetData] = useState<Record<string, DashboardRow[]>>({});
  const [widgetLoading, setWidgetLoading] = useState<Record<string, boolean>>({});
  const [widgetErrors, setWidgetErrors] = useState<Record<string, string | null>>({});
  const [dashboardMinutes, setDashboardMinutes] = useState<number>(60);
  const [editMode, setEditMode] = useState(false);
  const [dirtyLayout, setDirtyLayout] = useState<Record<string, string>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create');
  const [activeWidgetId, setActiveWidgetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flashMessage, setFlashMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const snapshotRef = useRef<Map<string, DashboardWidget[]>>(new Map());

  const showFlash = useCallback((kind: 'success' | 'error', text: string) => {
    setFlashMessage({ kind, text });
  }, []);

  const selectedWidget = useMemo(
    () => widgets.find((widget) => widget.id === activeWidgetId) || null,
    [activeWidgetId, widgets]
  );

  const loadDashboards = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/dashboards');
      const body = await response.json() as DashboardSummary[];
      if (!response.ok) throw new Error('Failed to load dashboards');
      setDashboards(body || []);
      if ((body || []).length > 0) {
        setSelectedDashboardId((current) => current || body[0].id);
      }
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  const loadWidgets = useCallback(async (dashboardId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/dashboards/${dashboardId}/panels`);
      const body = await response.json() as Record<string, unknown>[];
      if (!response.ok) throw new Error('Failed to load widgets');
      const next = (body || []).map(parseWidget);
      setWidgets(next);
      setDashboardMinutes((current) => resolveDashboardDefaultMinutes(next, current));
      snapshotRef.current.set(dashboardId, next);
      setDirtyLayout({});
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  const refreshAll = useCallback(async (minutesOverride?: number) => {
    const effectiveMinutes = minutesOverride ?? dashboardMinutes;
    const now = new Date();
    const from = new Date(now.getTime() - effectiveMinutes * 60 * 1000).toISOString();
    const to = now.toISOString();
    const dashboardId = selectedDashboardId || '_';
    const pending: DashboardWidget[] = [];

    for (const widget of widgets) {
      if (widget.widget_type === 'markdown') {
        setWidgetData((prev) => ({ ...prev, [widget.id]: [] }));
        setWidgetErrors((prev) => ({ ...prev, [widget.id]: null }));
        setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
        continue;
      }
      if (!widget.query_text.trim()) {
        setWidgetErrors((prev) => ({ ...prev, [widget.id]: 'Widget query is empty.' }));
        setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
        continue;
      }
      const cacheKey = buildFrontendWidgetCacheKey(dashboardId, widget, effectiveMinutes);
      const cached = dashboardWidgetResultCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        setWidgetData((prev) => ({ ...prev, [widget.id]: cached.rows }));
        setWidgetErrors((prev) => ({ ...prev, [widget.id]: null }));
        setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
        continue;
      }
      pending.push(widget);
    }

    if (pending.length === 0) return;

    setWidgetLoading((prev) => {
      const next = { ...prev };
      for (const widget of pending) next[widget.id] = true;
      return next;
    });
    setWidgetErrors((prev) => {
      const next = { ...prev };
      for (const widget of pending) next[widget.id] = null;
      return next;
    });

    try {
      const response = await apiFetch('/dashboards/widgets/query-batch', {
        method: 'POST',
        body: JSON.stringify({
          time: { from, to },
          widgets: pending.map((widget) => ({
            widget_id: widget.id,
            ppl: widget.query_text,
            limit: 500
          }))
        })
      });
      const body = await response.json() as {
        widgets?: Record<string, { response?: { results?: DashboardRow[]; error?: string }; error?: string }>;
        error?: string;
      };
      if (!response.ok || body.error) {
        throw new Error(body.error || 'Widget batch query failed');
      }
      const resultMap = body.widgets || {};
      for (const widget of pending) {
        const result = resultMap[widget.id];
        if (!result) {
          setWidgetErrors((prev) => ({ ...prev, [widget.id]: 'Widget result missing.' }));
          continue;
        }
        if (result.error || result.response?.error) {
          setWidgetErrors((prev) => ({ ...prev, [widget.id]: String(result.error || result.response?.error || 'Widget query failed') }));
          continue;
        }
        const rows = result.response?.results || [];
        setWidgetData((prev) => ({ ...prev, [widget.id]: rows }));
        const cacheKey = buildFrontendWidgetCacheKey(dashboardId, widget, effectiveMinutes);
        evictOldest(dashboardWidgetResultCache, MAX_DASHBOARD_WIDGET_CACHE_SIZE);
        dashboardWidgetResultCache.set(cacheKey, {
          expiresAt: Date.now() + FRONTEND_WIDGET_CACHE_TTL_MS,
          rows
        });
      }
    } catch (requestError) {
      const message = String(requestError);
      setWidgetErrors((prev) => {
        const next = { ...prev };
        for (const widget of pending) next[widget.id] = message;
        return next;
      });
    } finally {
      setWidgetLoading((prev) => {
        const next = { ...prev };
        for (const widget of pending) next[widget.id] = false;
        return next;
      });
    }
  }, [apiFetch, dashboardMinutes, selectedDashboardId, widgets]);

  const refreshSingleWidget = useCallback(async (widget: DashboardWidget) => {
    if (widget.widget_type === 'markdown') {
      setWidgetData((prev) => ({ ...prev, [widget.id]: [] }));
      setWidgetErrors((prev) => ({ ...prev, [widget.id]: null }));
      setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
      return;
    }
    if (!widget.query_text.trim()) {
      setWidgetErrors((prev) => ({ ...prev, [widget.id]: 'Widget query is empty.' }));
      setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
      return;
    }
    const effectiveMinutes = dashboardMinutes;
    const now = new Date();
    const from = new Date(now.getTime() - effectiveMinutes * 60 * 1000).toISOString();
    const to = now.toISOString();
    const dashboardId = selectedDashboardId || '_';
    const cacheKey = buildFrontendWidgetCacheKey(dashboardId, widget, effectiveMinutes);
    const cached = dashboardWidgetResultCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setWidgetData((prev) => ({ ...prev, [widget.id]: cached.rows }));
      setWidgetErrors((prev) => ({ ...prev, [widget.id]: null }));
      setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
      return;
    }

    setWidgetLoading((prev) => ({ ...prev, [widget.id]: true }));
    setWidgetErrors((prev) => ({ ...prev, [widget.id]: null }));

    try {
      const response = await apiFetch('/dashboards/widgets/query-batch', {
        method: 'POST',
        body: JSON.stringify({
          time: { from, to },
          widgets: [{ widget_id: widget.id, ppl: widget.query_text, limit: 500 }]
        })
      });
      const body = await response.json() as {
        widgets?: Record<string, { response?: { results?: DashboardRow[]; error?: string }; error?: string }>;
        error?: string;
      };
      if (!response.ok || body.error) {
        throw new Error(body.error || 'Widget batch query failed');
      }
      const result = (body.widgets || {})[widget.id];
      if (!result) {
        setWidgetErrors((prev) => ({ ...prev, [widget.id]: 'Widget result missing.' }));
        return;
      }
      if (result.error || result.response?.error) {
        setWidgetErrors((prev) => ({ ...prev, [widget.id]: String(result.error || result.response?.error || 'Widget query failed') }));
        return;
      }
      const rows = result.response?.results || [];
      setWidgetData((prev) => ({ ...prev, [widget.id]: rows }));
      evictOldest(dashboardWidgetResultCache, MAX_DASHBOARD_WIDGET_CACHE_SIZE);
      dashboardWidgetResultCache.set(cacheKey, {
        expiresAt: Date.now() + FRONTEND_WIDGET_CACHE_TTL_MS,
        rows
      });
    } catch (requestError) {
      setWidgetErrors((prev) => ({ ...prev, [widget.id]: String(requestError) }));
    } finally {
      setWidgetLoading((prev) => ({ ...prev, [widget.id]: false }));
    }
  }, [apiFetch, dashboardMinutes, selectedDashboardId]);

  const saveLayout = useCallback(async () => {
    if (!selectedDashboardId) return;
    const entries = Object.entries(dirtyLayout);
    if (entries.length === 0) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/dashboards/${selectedDashboardId}/layout`, {
        method: 'PUT',
        body: JSON.stringify({
          items: entries.map(([id, layout_json]) => ({ id, layout_json }))
        })
      });
      if (!response.ok) throw new Error('Failed to save layout');
      showFlash('success', 'Layout saved');
      clearDashboardWidgetCache(selectedDashboardId);
      await loadWidgets(selectedDashboardId);
      await refreshAll();
    } catch (requestError) {
      showFlash('error', String(requestError));
    } finally {
      setSaving(false);
    }
  }, [apiFetch, dirtyLayout, loadWidgets, refreshAll, selectedDashboardId, showFlash]);

  const openCreateDrawer = () => {
    setDrawerMode('create');
    setActiveWidgetId(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (widgetId: string) => {
    setDrawerMode('edit');
    setActiveWidgetId(widgetId);
    setDrawerOpen(true);
  };

  const createOrUpdateWidget = useCallback(async (values: {
    title: string;
    widget_type: WidgetType;
    query_text: string;
    time_window_minutes: number;
    refresh_seconds: number;
    markdown: string;
  }) => {
    if (!selectedDashboardId) return;
    setSaving(true);
    try {
      const isEdit = drawerMode === 'edit' && selectedWidget;
      const displayOptions = values.widget_type === 'markdown'
        ? { markdown: values.markdown || '' }
        : {};
      const payload = {
        title: values.title,
        widget_type: values.widget_type,
        query_text: values.query_text,
        query_mode: 'ppl',
        time_window_minutes: values.time_window_minutes,
        refresh_seconds: values.refresh_seconds,
        display_options_json: JSON.stringify(displayOptions)
      };
      const endpoint = isEdit
        ? `/dashboards/${selectedDashboardId}/panels/${selectedWidget.id}`
        : `/dashboards/${selectedDashboardId}/panels`;
      const response = await apiFetch(endpoint, {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String((body as { error?: string }).error || 'Widget save failed'));
      setDrawerOpen(false);
      clearDashboardWidgetCache(selectedDashboardId);
      await loadWidgets(selectedDashboardId);
      await refreshAll();
    } catch (requestError) {
      showFlash('error', String(requestError));
    } finally {
      setSaving(false);
    }
  }, [apiFetch, drawerMode, loadWidgets, refreshAll, selectedDashboardId, selectedWidget, showFlash]);

  const deleteActiveWidget = useCallback(async () => {
    if (!selectedDashboardId || !selectedWidget) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/dashboards/${selectedDashboardId}/panels/${selectedWidget.id}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete widget');
      setDrawerOpen(false);
      clearDashboardWidgetCache(selectedDashboardId);
      await loadWidgets(selectedDashboardId);
      await refreshAll();
    } catch (requestError) {
      showFlash('error', String(requestError));
    } finally {
      setSaving(false);
    }
  }, [apiFetch, loadWidgets, refreshAll, selectedDashboardId, selectedWidget, showFlash]);

  const duplicateWidget = useCallback(async (widgetId: string) => {
    if (!selectedDashboardId) return;
    const source = widgets.find((widget) => widget.id === widgetId);
    if (!source) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/dashboards/${selectedDashboardId}/panels`, {
        method: 'POST',
        body: JSON.stringify({
          title: `${source.title} (copy)`,
          widget_type: source.widget_type,
          query_text: source.query_text,
          query_mode: source.query_mode,
          time_window_minutes: source.time_window_minutes,
          refresh_seconds: source.refresh_seconds,
          viz_config_json: source.viz_config_json,
          bindings_json: source.bindings_json,
          display_options_json: source.display_options_json
        })
      });
      if (!response.ok) throw new Error('Failed to duplicate widget');
      clearDashboardWidgetCache(selectedDashboardId);
      await loadWidgets(selectedDashboardId);
      await refreshAll();
    } catch (requestError) {
      showFlash('error', String(requestError));
    } finally {
      setSaving(false);
    }
  }, [apiFetch, loadWidgets, refreshAll, selectedDashboardId, showFlash, widgets]);

  const deleteWidgetFromGrid = useCallback(async (widgetId: string) => {
    if (!selectedDashboardId) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/dashboards/${selectedDashboardId}/panels/${widgetId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete widget');
      clearDashboardWidgetCache(selectedDashboardId);
      await loadWidgets(selectedDashboardId);
      await refreshAll();
    } catch (requestError) {
      showFlash('error', String(requestError));
    } finally {
      setSaving(false);
    }
  }, [apiFetch, loadWidgets, refreshAll, selectedDashboardId, showFlash]);

  useEffect(() => {
    void loadDashboards();
  }, [loadDashboards]);

  useEffect(() => {
    if (!selectedDashboardId) return;
    void loadWidgets(selectedDashboardId);
  }, [loadWidgets, selectedDashboardId]);

  useEffect(() => {
    if (widgets.length === 0) return;
    void refreshAll();
  }, [widgets, dashboardMinutes, refreshAll]);

  useEffect(() => {
    if (!flashMessage || typeof window === 'undefined') return;
    const timer = window.setTimeout(() => setFlashMessage(null), 2800);
    return () => window.clearTimeout(timer);
  }, [flashMessage]);

  return (
    <div className="dashboard-builder">
      {error && <div className="error-banner">{error}</div>}
      {flashMessage && (
        <div className={flashMessage.kind === 'success' ? 'success-banner' : 'error-banner'}>
          {flashMessage.text}
        </div>
      )}
      <div className="dashboard-builder-toolbar card">
        <div className="dashboard-toolbar-controls">
          <select
            className="dashboard-toolbar-select"
            value={selectedDashboardId || ''}
            onChange={(event) => setSelectedDashboardId(event.target.value)}
            aria-label="Select dashboard"
          >
            {dashboards.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>{dashboard.name}</option>
            ))}
          </select>
          <div className="dashboard-toolbar-presets">
            {TIME_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={`secondary ${dashboardMinutes === preset.value ? 'active' : ''}`}
                onClick={() => setDashboardMinutes(preset.value)}
                aria-label={`Time range ${preset.label}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" onClick={() => void refreshAll()} aria-label="Refresh all widgets">
            Refresh All
          </button>
          <label className="dashboard-edit-toggle" aria-label="Toggle edit mode">
            <input type="checkbox" checked={editMode} onChange={(event) => setEditMode(event.target.checked)} />
            <span>Edit</span>
          </label>
          {editMode && (
            <>
              <button type="button" className="secondary" onClick={openCreateDrawer} aria-label="Add new widget">Add Widget</button>
              <button type="button" className="secondary" disabled={saving} onClick={() => void saveLayout()} aria-label="Save dashboard layout">
                {saving ? 'Saving...' : 'Save Layout'}
              </button>
            </>
          )}
        </div>
      </div>
      {loading && widgets.length === 0 && <div className="empty-state"><p>Loading dashboard…</p></div>}
      {!loading && widgets.length === 0 && (
        <div className="empty-state">
          <p>No widgets configured yet.</p>
          {editMode && <button type="button" className="secondary" onClick={openCreateDrawer}>Add First Widget</button>}
        </div>
      )}
      {widgets.length > 0 && (
        <WidgetGrid
          editable={editMode}
          widgets={widgets}
          widgetData={widgetData}
          widgetLoading={widgetLoading}
          widgetErrors={widgetErrors}
          onRefreshWidget={(widgetId) => {
            const widget = widgets.find((item) => item.id === widgetId);
            if (widget) void refreshSingleWidget(widget);
          }}
          onEditWidget={openEditDrawer}
          onDuplicateWidget={(widgetId) => void duplicateWidget(widgetId)}
          onDeleteWidget={(widgetId) => void deleteWidgetFromGrid(widgetId)}
          onLayoutChange={(next) => {
            const nextMap = next.reduce<Record<string, string>>((acc, item) => {
              acc[item.id] = item.layout_json;
              return acc;
            }, {});
            setDirtyLayout(nextMap);
            setWidgets((prev) => prev.map((widget) => (
              nextMap[widget.id] ? { ...widget, layout_json: nextMap[widget.id] } : widget
            )));
          }}
        />
      )}
      {drawerOpen && (
        <Suspense fallback={null}>
          <WidgetEditorDrawer
            open={drawerOpen}
            mode={drawerMode}
            widget={selectedWidget}
            saving={saving}
            onClose={() => setDrawerOpen(false)}
            onSave={createOrUpdateWidget}
            onDelete={deleteActiveWidget}
          />
        </Suspense>
      )}
    </div>
  );
}
