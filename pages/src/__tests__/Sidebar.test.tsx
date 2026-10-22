import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sidebar } from '../components/Sidebar';
import type { ViewMode } from '../types';

afterEach(cleanup);

function Navigation() {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<ViewMode>('search');
  return <Sidebar
    navExpanded={expanded}
    setNavExpanded={setExpanded}
    navItems={[{ key: 'search', label: 'Log Explorer' }, { key: 'saved', label: 'Saved Searches' }]}
    view={view}
    setAddressableView={setView}
    getTooltipHandlers={() => ({ onMouseEnter() {}, onFocus() {}, onMouseLeave() {}, onBlur() {} })}
  />;
}

describe('Application navigation', () => {
  it('keeps collapsed destinations named and identifies the current page after navigation', () => {
    render(<Navigation />);
    const navigation = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(navigation).getByRole('button', { name: 'Log Explorer' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Saved Searches' }));
    expect(within(navigation).getByRole('button', { name: 'Saved Searches' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('button', { name: 'Log Explorer' })).not.toHaveAttribute('aria-current');
  });

  it('exposes expansion state and preserves the selected destination when toggled', () => {
    render(<Navigation />);
    const expand = screen.getByRole('button', { name: 'Expand navigation' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Log Explorer' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(screen.getByRole('button', { name: 'Log Explorer' })).toHaveAttribute('aria-current', 'page');
  });
});
