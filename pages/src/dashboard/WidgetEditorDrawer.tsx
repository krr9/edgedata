import { Button, Drawer, Form, Input, InputNumber, Select, Space } from 'antd';
import { useEffect } from 'react';
import type { DashboardWidget, WidgetType } from './types';

const WIDGET_TYPE_OPTIONS: Array<{ label: string; value: WidgetType }> = [
  { label: 'Time Series', value: 'timeseries' },
  { label: 'Bar', value: 'bar' },
  { label: 'Pie / Donut', value: 'pie' },
  { label: 'Table', value: 'table' },
  { label: 'KPI', value: 'kpi' },
  { label: 'Top-N', value: 'topn' },
  { label: 'Markdown', value: 'markdown' }
];

interface WidgetEditorValues {
  title: string;
  widget_type: WidgetType;
  query_text: string;
  time_window_minutes: number;
  refresh_seconds: number;
  markdown: string;
}

export function WidgetEditorDrawer({
  open,
  mode,
  widget,
  saving,
  onClose,
  onSave,
  onDelete
}: {
  open: boolean;
  mode: 'create' | 'edit';
  widget: DashboardWidget | null;
  saving: boolean;
  onClose: () => void;
  onSave: (values: WidgetEditorValues) => Promise<void>;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const [form] = Form.useForm<WidgetEditorValues>();
  const typeValue = Form.useWatch('widget_type', form) || 'table';

  useEffect(() => {
    if (!open) return;
    if (widget) {
      let markdown = '';
      try {
        const parsed = JSON.parse(widget.display_options_json) as Record<string, unknown>;
        markdown = String(parsed.markdown || parsed.content || '');
      } catch {
        markdown = '';
      }
      form.setFieldsValue({
        title: widget.title,
        widget_type: widget.widget_type,
        query_text: widget.query_text,
        time_window_minutes: widget.time_window_minutes,
        refresh_seconds: widget.refresh_seconds,
        markdown
      });
      return;
    }
    form.setFieldsValue({
      title: '',
      widget_type: 'table',
      query_text: 'search * | stats count() by service',
      time_window_minutes: 60,
      refresh_seconds: 0,
      markdown: '## Notes\nAdd context for this dashboard.'
    });
  }, [form, open, widget]);

  return (
    <Drawer
      title={mode === 'create' ? 'Add Widget' : 'Edit Widget'}
      width={480}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={(
        <Space>
          {mode === 'edit' && (
            <Button danger onClick={() => void onDelete()} disabled={saving}>
              Delete
            </Button>
          )}
          <Button type="primary" loading={saving} onClick={() => void form.submit()}>
            Save
          </Button>
        </Space>
      )}
    >
      <Form<WidgetEditorValues>
        layout="vertical"
        form={form}
        onFinish={(values) => onSave(values)}
      >
        <Form.Item label="Widget Title" name="title" rules={[{ required: true, message: 'Title is required' }]}>
          <Input placeholder="Widget title" />
        </Form.Item>
        <Form.Item label="Widget Type" name="widget_type" rules={[{ required: true }]}>
          <Select options={WIDGET_TYPE_OPTIONS} />
        </Form.Item>
        {typeValue !== 'markdown' ? (
          <Form.Item
            label="Query (PPL)"
            name="query_text"
            rules={[{ required: true, message: 'Query is required for data widgets' }]}
          >
            <Input.TextArea rows={4} placeholder='search * | where level="error" | stats count() by service' />
          </Form.Item>
        ) : (
          <Form.Item label="Markdown Content" name="markdown">
            <Input.TextArea rows={8} placeholder="## Runbook notes" />
          </Form.Item>
        )}
        <Form.Item label="Time Window (minutes)" name="time_window_minutes" rules={[{ required: true }]}>
          <InputNumber min={1} max={10080} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Auto Refresh (seconds, 0 disables)" name="refresh_seconds" rules={[{ required: true }]}>
          <InputNumber min={0} max={3600} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
