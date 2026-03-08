import ReactECharts from 'echarts-for-react';
import { Table } from 'antd';
import ReactMarkdown from 'react-markdown';
import type { DashboardRow, DashboardWidget, WidgetType } from './types';

function parseObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore bad payloads
  }
  return {};
}

function detectColumns(data: DashboardRow[]): { categoryKey: string | null; valueKey: string | null } {
  if (data.length === 0) return { categoryKey: null, valueKey: null };
  const row = data[0];
  const keys = Object.keys(row);
  const categoryKey = keys.find((key) => typeof row[key] === 'string') || keys[0] || null;
  const valueKey = keys.find((key) => typeof row[key] === 'number' && key !== categoryKey) || keys[1] || null;
  return { categoryKey, valueKey };
}

function renderChart(widgetType: WidgetType, data: DashboardRow[], title: string): JSX.Element {
  const { categoryKey, valueKey } = detectColumns(data);
  if (!categoryKey || !valueKey) {
    return <div className="widget-empty">No plottable data.</div>;
  }
  const rows = data.slice(0, 20);
  const categories = rows.map((row) => String(row[categoryKey] ?? ''));
  const values = rows.map((row) => Number(row[valueKey]) || 0);
  const common = {
    grid: { left: 10, right: 12, top: 20, bottom: 18, containLabel: true },
    tooltip: {
      trigger: widgetType === 'pie' ? 'item' : 'axis',
      backgroundColor: '#ffffff',
      borderColor: '#dbe4ef',
      borderWidth: 1,
      textStyle: { color: '#334861', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 20px rgba(12,38,72,0.08); border-radius: 8px;'
    },
    animationDuration: 240
  };
  const option =
    widgetType === 'pie'
      ? {
          title: { text: title, left: 'left', top: 0, textStyle: { fontSize: 12, fontWeight: 600 } },
          tooltip: { trigger: 'item' },
          series: [
            {
              type: 'pie',
              radius: ['36%', '70%'],
              data: categories.map((name, idx) => ({ name, value: values[idx] })),
              label: { formatter: '{b}: {d}%' }
            }
          ]
        }
      : {
          ...common,
          xAxis: widgetType === 'timeseries'
            ? {
                type: 'category',
                data: categories,
                axisLine: { lineStyle: { color: '#dbe5f2' } },
                axisTick: { show: false },
                axisLabel: { color: '#6b7d93', fontSize: 11 }
              }
            : {
                type: 'value',
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: '#6b7d93', fontSize: 11 },
                splitLine: { lineStyle: { color: '#edf2f8' } }
              },
          yAxis: widgetType === 'timeseries'
            ? {
                type: 'value',
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: '#6b7d93', fontSize: 11 },
                splitLine: { lineStyle: { color: '#edf2f8' } }
              }
            : {
                type: 'category',
                data: categories,
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: '#5f738a', fontSize: 11 }
              },
          series: [
            {
              type: widgetType === 'timeseries' ? 'line' : 'bar',
              data: values,
              smooth: widgetType === 'timeseries',
              showSymbol: widgetType === 'timeseries',
              itemStyle: widgetType === 'timeseries'
                ? { color: '#5b8ff9' }
                : { color: '#5b8ff9', borderRadius: [0, 6, 6, 0] },
              lineStyle: widgetType === 'timeseries' ? { color: '#5b8ff9', width: 2 } : undefined,
              areaStyle: widgetType === 'timeseries' ? { color: 'rgba(91,143,249,0.12)' } : undefined,
              barMaxWidth: widgetType === 'timeseries' ? undefined : 14
            }
          ]
        };
  return <ReactECharts option={option} style={{ height: 230, width: '100%' }} notMerge />;
}

function renderKpi(data: DashboardRow[]): JSX.Element {
  const first = data[0];
  if (!first) return <div className="widget-empty">No data.</div>;
  const numericKey = Object.keys(first).find((key) => typeof first[key] === 'number');
  const value = numericKey ? Number(first[numericKey]) : 0;
  return (
    <div className="widget-kpi">
      <div className="widget-kpi-value">{value.toLocaleString()}</div>
      <div className="widget-kpi-label">{(numericKey || 'value').replace(/_/g, ' ')}</div>
    </div>
  );
}

function renderTable(data: DashboardRow[]): JSX.Element {
  if (data.length === 0) return <div className="widget-empty">No rows.</div>;
  const columns = Object.keys(data[0]).map((key) => ({
    title: key.replace(/_/g, ' '),
    dataIndex: key,
    key
  }));
  const rows = data.slice(0, 50).map((row, index) => ({ ...row, __rowid: `${index}` }));
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="__rowid"
      columns={columns}
      dataSource={rows}
      scroll={{ y: 260 }}
    />
  );
}

export function WidgetRenderer({
  widget,
  data,
  loading,
  error
}: {
  widget: DashboardWidget;
  data: DashboardRow[];
  loading: boolean;
  error: string | null;
}): JSX.Element {
  if (loading) return <div className="widget-loading">Loading widget…</div>;
  if (error) return <div className="widget-error">{error}</div>;

  const displayOptions = parseObject(widget.display_options_json);
  const markdown = String(displayOptions.markdown || displayOptions.content || '');
  const widgetType = widget.widget_type;
  const title = widget.title;

  if (widgetType === 'markdown') {
    return (
      <div className="widget-markdown">
        {markdown ? <ReactMarkdown>{markdown}</ReactMarkdown> : <div className="widget-empty">Add markdown content.</div>}
      </div>
    );
  }

  if (widgetType === 'kpi') return renderKpi(data);
  if (widgetType === 'table') return renderTable(data);
  if (widgetType === 'topn') return renderChart('bar', data, title);
  return renderChart(widgetType, data, title);
}
