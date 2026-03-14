import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../constants', () => ({
  API_BASE: 'https://query-worker.example.com',
  API_BASE_MISSING_ERROR: 'Missing VITE_QUERY_API_BASE. Configure your deployed query-worker URL.',
  API_PROXY_BASE: '/api'
}));

import { AuthProvider, useAuth } from '../AuthContext';

function AuthProbe() {
  const { loading, user, token } = useAuth();
  return (
    <div>
      <div data-testid="loading">{loading ? 'loading' : 'ready'}</div>
      <div data-testid="email">{user?.email || ''}</div>
      <div data-testid="token">{token || ''}</div>
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      }
    });
    localStorage.clear();
    window.history.replaceState({}, '', '/?access=1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('persists a session token returned by auth/me after Access bootstrap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: {
              id: 'user-123',
              email: 'analyst@example.com',
              role: 'analyst',
              role_ids: ['analyst'],
              permissions: ['search.read'],
              scope: { services: ['api'], envs: ['prod'], hosts: ['*'] }
            },
            token: 'session-token-123',
            expires_at: '2026-03-14T20:00:00.000Z'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
    );

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('ready');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://query-worker.example.com/auth/me',
      expect.objectContaining({
        credentials: 'include'
      })
    );
    expect(screen.getByTestId('email')).toHaveTextContent('analyst@example.com');
    expect(screen.getByTestId('token')).toHaveTextContent('session-token-123');
    expect(JSON.parse(localStorage.getItem('edgedata_auth') || '{}')).toMatchObject({
      token: 'session-token-123',
      expiresAt: '2026-03-14T20:00:00.000Z'
    });
  });
});
