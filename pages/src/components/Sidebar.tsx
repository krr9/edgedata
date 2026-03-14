import { ChevronLeft, ChevronRight, Database } from 'lucide-react';
import { renderNavIcon } from '../utils';
import type { ViewMode } from '../types';

export interface NavItem {
  key: ViewMode;
  label: string;
}

export interface SidebarProps {
  navExpanded: boolean;
  setNavExpanded: (value: boolean | ((prev: boolean) => boolean)) => void;
  navItems: NavItem[];
  view: ViewMode;
  setAddressableView: (view: ViewMode) => void;
  getTooltipHandlers: (label: string) => {
    onMouseEnter: (event: { currentTarget: EventTarget | null }) => void;
    onFocus: (event: { currentTarget: EventTarget | null }) => void;
    onMouseLeave: () => void;
    onBlur: () => void;
  };
}

export function Sidebar({
  navExpanded,
  setNavExpanded,
  navItems,
  view,
  setAddressableView,
  getTooltipHandlers
}: SidebarProps) {
  return (
    <aside className={`side-nav ${navExpanded ? 'expanded' : 'collapsed'}`} aria-label="Application navigation">
      <div className="side-nav-top">
        <a className="nav-brand nav-brand-link" href="/" aria-label="Go to home page">
          <span className="nav-brand-mark" aria-hidden="true">
            <Database size={14} strokeWidth={2.1} />
          </span>
          {navExpanded && <span className="nav-brand-text">EdgeData</span>}
          {navExpanded && <span className="nav-brand-badge">Cloud</span>}
        </a>
        <button
          type="button"
          className="side-nav-toggle"
          onClick={() => setNavExpanded((value) => !value)}
          aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
          data-tooltip={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
          {...getTooltipHandlers(navExpanded ? 'Collapse navigation' : 'Expand navigation')}
        >
          {navExpanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      <div className="side-nav-tabs" role="tablist" aria-label="Primary">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`side-nav-tab ${view === item.key ? 'active' : ''}`}
            onClick={() => setAddressableView(item.key)}
            data-tooltip={item.label}
            {...getTooltipHandlers(item.label)}
          >
            <span className="side-nav-tab-icon" aria-hidden="true">{renderNavIcon(item.key)}</span>
            {navExpanded && <span className="side-nav-tab-label">{item.label}</span>}
          </button>
        ))}
      </div>
    </aside>
  );
}
