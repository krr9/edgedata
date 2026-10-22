import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'reader', role: 'viewer', permissions: ['search.read'] }, token: 'ui-test-session', loading: false, logout() {} })
}));
import App from '../App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Search workspace', () => {
  it('replaces initial guidance with results and field coverage after a search', async () => {
    window.history.replaceState({}, '', '/?tab=search');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input).endsWith('/search')
      ? Response.json({
          results: [{ event_id: 'evt-ui', ts: '2026-10-21T12:00:00Z', index: 'default', service: 'api', env: 'prod', host: 'node', level: 'info', message: 'request completed' }],
          stats: { mode: 'structured', scanned_partitions: 1, scanned_objects: 1, candidates: 1, returned: 1 },
          next_cursor: null,
          result_type: 'events'
        })
      : new Response(null, { status: 404 }));
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Start with a search' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Field Coverage' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /stream/i }));
    const searchButtons = screen.getAllByRole('button', { name: 'Search' });
    fireEvent.click(searchButtons[searchButtons.length - 1]);
    expect(await screen.findByText('request completed')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Start with a search' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Field Coverage' })).toBeInTheDocument();
  });
});
