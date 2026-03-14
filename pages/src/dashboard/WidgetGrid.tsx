import { WidthProvider, Responsive, type Layout, type Layouts } from 'react-grid-layout';
import type { DashboardWidget } from './types';
import { WidgetRenderer } from './WidgetRenderer';

const ResponsiveGridLayout = WidthProvider(Responsive);

function parseLayout(layoutJson: string): Layout {
  try {
    const parsed = JSON.parse(layoutJson) as Partial<Layout>;
    return {
      i: '',
      x: Number(parsed.x) || 0,
      y: Number(parsed.y) || 0,
      w: Math.max(1, Number(parsed.w) || 6),
      h: Math.max(1, Number(parsed.h) || 8),
      minW: parsed.minW ? Number(parsed.minW) : 2,
      minH: parsed.minH ? Number(parsed.minH) : 3
    };
  } catch {
    return { i: '', x: 0, y: 0, w: 6, h: 8, minW: 2, minH: 3 };
  }
}

export function WidgetGrid({
  editable,
  widgets,
  widgetData,
  widgetLoading,
  widgetErrors,
  onRefreshWidget,
  onEditWidget,
  onDuplicateWidget,
  onDeleteWidget,
  onLayoutChange
}: {
  editable: boolean;
  widgets: DashboardWidget[];
  widgetData: Record<string, Array<Record<string, string | number | null | undefined>>>;
  widgetLoading: Record<string, boolean>;
  widgetErrors: Record<string, string | null>;
  onRefreshWidget: (widgetId: string) => void;
  onEditWidget: (widgetId: string) => void;
  onDuplicateWidget: (widgetId: string) => void;
  onDeleteWidget: (widgetId: string) => void;
  onLayoutChange: (next: Array<{ id: string; layout_json: string }>) => void;
}): JSX.Element {
  const baseLayout = widgets.map((widget, index) => {
    const parsed = parseLayout(widget.layout_json);
    return {
      ...parsed,
      i: widget.id,
      y: Number.isFinite(parsed.y) ? parsed.y : index * 8
    };
  });
  const layouts: Layouts = { lg: baseLayout };

  return (
    <ResponsiveGridLayout
      className="widget-grid"
      rowHeight={28}
      layouts={layouts}
      breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
      cols={{ lg: 12, md: 12, sm: 8, xs: 4, xxs: 2 }}
      isDraggable={editable}
      isResizable={editable}
      margin={[12, 12]}
      onLayoutChange={(layout) => {
        const next = layout.map((item) => ({
          id: item.i,
          layout_json: JSON.stringify({
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            minW: item.minW ?? 2,
            minH: item.minH ?? 3
          })
        }));
        onLayoutChange(next);
      }}
    >
      {widgets.map((widget) => (
        <div key={widget.id} className="widget-card">
          <div className="widget-card-header">
            <h3>{widget.title}</h3>
            <div className="widget-card-actions">
              <button className="secondary" onClick={() => onRefreshWidget(widget.id)} aria-label="Refresh">Refresh</button>
              {editable && (
                <>
                  <button className="secondary" onClick={() => onEditWidget(widget.id)} aria-label="Edit">Edit</button>
                  <button className="secondary" onClick={() => onDuplicateWidget(widget.id)} aria-label="Duplicate">Duplicate</button>
                  <button className="danger" onClick={() => onDeleteWidget(widget.id)} aria-label="Delete">Delete</button>
                </>
              )}
            </div>
          </div>
          <WidgetRenderer
            widget={widget}
            data={widgetData[widget.id] || []}
            loading={Boolean(widgetLoading[widget.id])}
            error={widgetErrors[widget.id] || null}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
