import React, { createContext, useCallback, useEffect, useState, useContext, type ReactNode } from 'react';

export interface AuthUser {
  id: string;
  email?: string;
  role: 'viewer' | 'analyst' | 'admin' | 'superadmin';
  role_ids?: string[];
  permissions?: string[];
  scope?: {
    services: string[];
    envs: string[];
    hosts: string[];
  };
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  expiresAt: string | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<{ error?: string }>;
  refresh: () => Promise<{ authenticated: boolean; error?: string }>;
  logout: () => void;
  hasRole: (roles: AuthUser['role'][]) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

const API_BASE = ((import.meta as { env?: Record<string, string> }).env?.VITE_QUERY_API_BASE || '').trim();
const API_BASE_MISSING_ERROR = 'Missing VITE_QUERY_API_BASE. Configure your deployed query-worker URL.';

const STORAGE_KEY = 'edgedata_auth';

function loadStoredAuth(): AuthState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { user: null, token: null, expiresAt: null, loading: false };
    const parsed = JSON.parse(stored) as { user: AuthUser; token: string; expiresAt: string };
    if (parsed.expiresAt && new Date(parsed.expiresAt) < new Date()) {
      localStorage.removeItem(STORAGE_KEY);
      return { user: null, token: null, expiresAt: null, loading: false };
    }
    return { user: parsed.user, token: parsed.token, expiresAt: parsed.expiresAt, loading: false };
  } catch {
    return { user: null, token: null, expiresAt: null, loading: false };
  }
}

function storeAuth(user: AuthUser, token: string, expiresAt: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token, expiresAt }));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const stored = loadStoredAuth();
    return { ...stored, loading: true };
  });

  const fetchCurrentUser = useCallback(async (token: string | null): Promise<boolean> => {
    if (!API_BASE) {
      localStorage.removeItem(STORAGE_KEY);
      setState({ user: null, token: null, expiresAt: null, loading: false });
      return false;
    }
    try {
      const headers = new Headers();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const response = await fetch(`${API_BASE}/auth/me`, {
        headers,
        credentials: 'include'
      });
      if (response.ok) {
        const body = await response.json() as { user: AuthUser };
        setState({ user: body.user, token: token || null, expiresAt: null, loading: false });
        return true;
      }
    } catch {
      // ignore
    }
    if (token) {
      localStorage.removeItem(STORAGE_KEY);
    }
    setState({ user: null, token: null, expiresAt: null, loading: false });
    return false;
  }, []);

  useEffect(() => {
    if (!state.loading) return;
    if (state.user) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }
    void fetchCurrentUser(state.token);
  }, [state.loading, state.token, state.user, fetchCurrentUser]);

  const login = useCallback(async (email: string, password: string): Promise<{ error?: string }> => {
    if (!API_BASE) {
      return { error: API_BASE_MISSING_ERROR };
    }
    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include'
      });

      const body = await response.json() as { token?: string; expires_at?: string; user?: AuthUser; error?: string };

      if (!response.ok || body.error) {
        return { error: body.error || 'Login failed' };
      }

      if (!body.token || !body.user) {
        return { error: 'Invalid response' };
      }

      storeAuth(body.user, body.token, body.expires_at || '');
      setState({ user: body.user, token: body.token, expiresAt: body.expires_at || null, loading: false });
      return {};
    } catch {
      return { error: 'Network error' };
    }
  }, []);

  const refresh = useCallback(async (): Promise<{ authenticated: boolean; error?: string }> => {
    setState((prev) => ({ ...prev, loading: true }));
    const ok = await fetchCurrentUser(state.token);
    if (ok) return { authenticated: true };
    return { authenticated: false, error: 'Not authenticated' };
  }, [fetchCurrentUser, state.token]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState({ user: null, token: null, expiresAt: null, loading: false });
  }, []);

  const hasRole = useCallback((roles: AuthUser['role'][]): boolean => {
    if (!state.user) return false;
    return roles.includes(state.user.role);
  }, [state.user]);

  return (
    <AuthContext.Provider value={{ ...state, login, refresh, logout, hasRole }}>
      {children}
    </AuthContext.Provider>
  );
}
