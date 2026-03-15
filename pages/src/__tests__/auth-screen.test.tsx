import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../constants', () => ({
  API_BASE: 'https://query-worker.example.com',
  API_BASE_MISSING_ERROR: 'Missing VITE_QUERY_API_BASE. Configure your deployed query-worker URL.',
  API_PROXY_BASE: '/api'
}));

import { AuthContext, type AuthUser } from '../AuthContext';
import { AuthScreen } from '../AuthScreen';

function renderAuthScreen() {
  const authValue = {
    user: null,
    token: null,
    expiresAt: null,
    loading: false,
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    hasRole: vi.fn(() => false)
  } as {
    user: AuthUser | null;
    token: string | null;
    expiresAt: string | null;
    loading: boolean;
    login: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    hasRole: ReturnType<typeof vi.fn>;
  };

  return render(
    <AuthContext.Provider value={authValue}>
      <AuthScreen />
    </AuthContext.Provider>
  );
}

describe('AuthScreen invite links', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/#invite_token=test-invite-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('accepts an invite from the URL without asking for a manual token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          email: 'invitee@example.com'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    renderAuthScreen();

    expect(screen.getByText('Invite link detected. Set your password to finish joining EdgeData.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Invite token')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('');

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'StrongPass!123' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'StrongPass!123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = new URLSearchParams(String(init.body || ''));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/invite/accept',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include'
      })
    );
    expect(payload.get('token')).toBe('test-invite-token');
    expect(payload.get('password')).toBe('StrongPass!123');
    expect(await screen.findByText('Invite accepted for invitee@example.com. Sign in to continue.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('invitee@example.com');
  });
});
