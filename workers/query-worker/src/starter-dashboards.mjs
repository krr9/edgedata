export const STARTER_DASHBOARDS_VERSION = 'v1';

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
  name: 'Service Health',
  description: 'Detailed service health and error analysis',
  panels: [
    {
      title: 'Status Distribution',
      ppl: 'search * | where status>0 | stats count() by status',
      viz_type: 'pie',
      time_window_minutes: 60,
      position: 0
    },
    {
      title: 'Top Hosts by Errors',
      ppl: 'search * | where level="error" | top 10 host',
      viz_type: 'table',
      time_window_minutes: 60,
      position: 1
    },
    {
      title: 'Slowest Services',
      ppl: 'search * | where duration_ms>0 | stats avg(duration_ms) by service | sort -avg_duration_ms',
      viz_type: 'bar',
      time_window_minutes: 60,
      position: 2
    }
  ]
};

export function getStarterDashboards() {
  return [OPERATIONS_OVERVIEW, SERVICE_HEALTH];
}

export async function seedStarterDashboards(db) {
  const existing = await db.prepare(
    "SELECT COUNT(*) as cnt FROM dashboards WHERE is_default = 1"
  ).first();
  if (existing && existing.cnt > 0) return { seeded: false };

  const dashboards = getStarterDashboards();
  const now = new Date().toISOString();

  for (const dash of dashboards) {
    const dashId = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO dashboards (id, name, description, layout_json, is_default, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, 'system', ?, ?)`
    ).bind(dashId, dash.name, dash.description || '', now, now).run();

    for (const panel of dash.panels) {
      const panelId = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO dashboard_panels (id, dashboard_id, title, ppl, viz_type, time_window_minutes, refresh_seconds, options_json, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, '{}', ?, ?, ?)`
      ).bind(panelId, dashId, panel.title, panel.ppl, panel.viz_type, panel.time_window_minutes, panel.position, now, now).run();
    }
  }

  return { seeded: true, count: dashboards.length };
}
