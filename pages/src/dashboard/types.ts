export type WidgetType = 'timeseries' | 'bar' | 'pie' | 'table' | 'kpi' | 'topn' | 'markdown';

export interface DashboardRow {
  [key: string]: string | number | null | undefined;
}

export interface DashboardSummary {
  id: string;
  name: string;
  description?: string | null;
  is_default: number;
}

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface DashboardWidget {
  id: string;
  dashboard_id: string;
  title: string;
  widget_type: WidgetType;
  query_text: string;
  query_mode: string;
  viz_config_json: string;
  layout_json: string;
  bindings_json: string;
  display_options_json: string;
  time_window_minutes: number;
  refresh_seconds: number;
  position: number;
  created_at: string;
  updated_at?: string | null;
}
