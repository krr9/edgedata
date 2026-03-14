export const STARTER_DASHBOARDS_VERSION = 'v1';
const STARTER_DASHBOARD_POLICY = {
  execution_mode: 'cached',
  cache_ttl_seconds: 300,
  materialize_enabled: 1,
  materialize_interval_seconds: 300,
  max_staleness_seconds: 900,
  priority: 10
};

const DEFAULT_SERVICE_HEALTH_SCOPE = {
  index: 'otel-demo',
  env: 'demo'
};

const LEGACY_SERVICE_HEALTH_NAME = 'Service Health';
const SCOPED_SERVICE_HEALTH_NAME = `Service Health (${DEFAULT_SERVICE_HEALTH_SCOPE.index})`;

const SCOPED_SERVICE_HEALTH_PANELS = [
  {
    title: 'Status Distribution',
    ppl: `search * | where index="${DEFAULT_SERVICE_HEALTH_SCOPE.index}" and env="${DEFAULT_SERVICE_HEALTH_SCOPE.env}" and status>=100 | stats count() by status | sort -count`,
    viz_type: 'pie',
    time_window_minutes: 60,
    position: 0
  },
  {
    title: 'Top Hosts by Errors',
    ppl: `search * | where index="${DEFAULT_SERVICE_HEALTH_SCOPE.index}" and env="${DEFAULT_SERVICE_HEALTH_SCOPE.env}" and level="error" | top 10 host`,
    viz_type: 'table',
    time_window_minutes: 60,
    position: 1
  },
  {
    title: 'Slowest Services',
    ppl: `search * | where index="${DEFAULT_SERVICE_HEALTH_SCOPE.index}" and env="${DEFAULT_SERVICE_HEALTH_SCOPE.env}" and duration_ms>0 | stats avg(duration_ms) as avg_latency_ms max(duration_ms) as max_latency_ms by service | sort -avg_latency_ms | head 12`,
    viz_type: 'bar',
    time_window_minutes: 60,
    position: 2
  }
];

const OPERATIONS_OVERVIEW = {
  name: 'Operations Overview',
  description: 'High-level operational health across all services',
  panels: [
    {
      title: 'Error Rate by Service',
      ppl: 'search * | timechart span=5m count() by level',
      viz_type: 'timechart',
      time_window_minutes: 60,
      position: 0
    },
    {
      title: 'Avg Latency by Service',
      ppl: 'search * | where duration_ms>0 | stats avg(duration_ms) by service',
      viz_type: 'bar',
      time_window_minutes: 60,
      position: 1
    },
    {
      title: 'Top Error Messages',
      ppl: 'search * | where level="error" | top 10 msg_hash',
      viz_type: 'table',
      time_window_minutes: 60,
      position: 2
    },
    {
      title: 'Throughput',
      ppl: 'search * | timechart span=5m count()',
      viz_type: 'timechart',
      time_window_minutes: 60,
      position: 3
    }
  ]
};

const SERVICE_HEALTH = {
  name: SCOPED_SERVICE_HEALTH_NAME,
  description: `Detailed service health and error analysis scoped to index="${DEFAULT_SERVICE_HEALTH_SCOPE.index}" env="${DEFAULT_SERVICE_HEALTH_SCOPE.env}"`,
  panels: SCOPED_SERVICE_HEALTH_PANELS
};

export function getStarterDashboards() {
  return [OPERATIONS_OVERVIEW, SERVICE_HEALTH];
}

async function upgradeScopedServiceHealthDashboard(db, now) {
  const dashboard = await db.prepare(
    `SELECT id
     FROM dashboards
     WHERE is_default = 1
       AND created_by = 'system'
       AND name = ?
     ORDER BY updated_at DESC
     LIMIT 1`
  ).bind(LEGACY_SERVICE_HEALTH_NAME).first();

  if (!dashboard || !dashboard.id) return false;

  await db.prepare(
    `UPDATE dashboards
     SET name = ?, description = ?, default_execution_mode = ?, updated_at = ?
     WHERE id = ?`
  ).bind(SERVICE_HEALTH.name, SERVICE_HEALTH.description || '', STARTER_DASHBOARD_POLICY.execution_mode, now, dashboard.id).run();

  for (const panel of SCOPED_SERVICE_HEALTH_PANELS) {
    await db.prepare(
      `UPDATE dashboard_panels
       SET ppl = ?, viz_type = ?, time_window_minutes = ?, position = ?,
           execution_mode = ?, cache_ttl_seconds = ?, materialize_enabled = ?,
           materialize_interval_seconds = ?, max_staleness_seconds = ?, priority = ?, updated_at = ?
       WHERE dashboard_id = ? AND title = ?`
    ).bind(
      panel.ppl,
      panel.viz_type,
      panel.time_window_minutes,
      panel.position,
      STARTER_DASHBOARD_POLICY.execution_mode,
      STARTER_DASHBOARD_POLICY.cache_ttl_seconds,
      STARTER_DASHBOARD_POLICY.materialize_enabled,
      STARTER_DASHBOARD_POLICY.materialize_interval_seconds,
      STARTER_DASHBOARD_POLICY.max_staleness_seconds,
      STARTER_DASHBOARD_POLICY.priority,
      now,
      dashboard.id,
      panel.title
    ).run();
  }

  return true;
}

async function applyStarterDashboardPolicy(db, dashId, panels, now) {
  await db.prepare(
    `UPDATE dashboards
     SET default_execution_mode = ?, updated_at = ?
     WHERE id = ?`
  ).bind(STARTER_DASHBOARD_POLICY.execution_mode, now, dashId).run();

  for (const panel of panels) {
    await db.prepare(
      `UPDATE dashboard_panels
       SET execution_mode = ?, cache_ttl_seconds = ?, materialize_enabled = ?,
           materialize_interval_seconds = ?, max_staleness_seconds = ?, priority = ?, updated_at = ?
       WHERE dashboard_id = ? AND title = ?`
    ).bind(
      STARTER_DASHBOARD_POLICY.execution_mode,
      STARTER_DASHBOARD_POLICY.cache_ttl_seconds,
      STARTER_DASHBOARD_POLICY.materialize_enabled,
      STARTER_DASHBOARD_POLICY.materialize_interval_seconds,
      STARTER_DASHBOARD_POLICY.max_staleness_seconds,
      STARTER_DASHBOARD_POLICY.priority,
      now,
      dashId,
      panel.title
    ).run();
  }
}

async function upgradeStarterDashboardPolicies(db, now) {
  for (const dash of getStarterDashboards()) {
    const existing = await db.prepare(
      `SELECT id
       FROM dashboards
       WHERE is_default = 1
         AND created_by = 'system'
         AND name = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    ).bind(dash.name).first();

    if (!existing?.id) continue;
    await applyStarterDashboardPolicy(db, existing.id, dash.panels, now);
  }
}

export async function seedStarterDashboards(db) {
  const now = new Date().toISOString();
  const upgradedServiceHealth = await upgradeScopedServiceHealthDashboard(db, now);
  await upgradeStarterDashboardPolicies(db, now);
  const existing = await db.prepare(
    "SELECT COUNT(*) as cnt FROM dashboards WHERE is_default = 1"
  ).first();
  if (existing && existing.cnt > 0) return { seeded: false, upgraded_service_health: upgradedServiceHealth };

  const dashboards = getStarterDashboards();

  for (const dash of dashboards) {
    const dashId = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO dashboards (id, name, description, layout_json, is_default, performance_profile, default_execution_mode, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, 'economy', ?, 'system', ?, ?)`
    ).bind(dashId, dash.name, dash.description || '', STARTER_DASHBOARD_POLICY.execution_mode, now, now).run();

    for (const panel of dash.panels) {
      const panelId = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO dashboard_panels (
          id, dashboard_id, title, ppl, viz_type, time_window_minutes, refresh_seconds,
          execution_mode, cache_ttl_seconds, materialize_enabled, materialize_interval_seconds,
          max_staleness_seconds, priority, options_json, position, created_at, updated_at
        )
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`
      ).bind(
        panelId,
        dashId,
        panel.title,
        panel.ppl,
        panel.viz_type,
        panel.time_window_minutes,
        STARTER_DASHBOARD_POLICY.execution_mode,
        STARTER_DASHBOARD_POLICY.cache_ttl_seconds,
        STARTER_DASHBOARD_POLICY.materialize_enabled,
        STARTER_DASHBOARD_POLICY.materialize_interval_seconds,
        STARTER_DASHBOARD_POLICY.max_staleness_seconds,
        STARTER_DASHBOARD_POLICY.priority,
        panel.position,
        now,
        now
      ).run();
    }
  }

  return { seeded: true, count: dashboards.length };
}
