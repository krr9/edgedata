import React, { createContext, useCallback, useEffect, useState, useContext, type ReactNode } from 'react';
import { API_BASE, API_BASE_MISSING_ERROR, API_PROXY_BASE } from './constants';

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

const STORAGE_KEY = 'edgedata_auth';
const ACCESS_RETURN_PARAM = 'access';

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

function shouldResumeAccessSession(): boolean {
  if (typeof window === 'undefined') return false;
  return new URL(window.location.href).searchParams.get(ACCESS_RETURN_PARAM) === '1';
}

function clearAccessResumeFlag(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ACCESS_RETURN_PARAM)) return;
  url.searchParams.delete(ACCESS_RETURN_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', next);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const stored = loadStoredAuth();
    return { ...stored, loading: true };
  });

  const fetchCurrentUser = useCallback(async (token: string | null): Promise<boolean> => {
    if (!token && !API_BASE) {
      localStorage.removeItem(STORAGE_KEY);
      setState({ user: null, token: null, expiresAt: null, loading: false });
      return false;
    }
    try {
      const headers = new Headers();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const response = await fetch(`${token ? API_PROXY_BASE : API_BASE}/auth/me`, {
        headers,
        credentials: 'include'
      });
      if (response.ok) {
        const body = await response.json() as { user: AuthUser; token?: string; expires_at?: string };
        const sessionToken = body.token || token || null;
        const expiresAt = body.expires_at || null;
        if (sessionToken) {
          storeAuth(body.user, sessionToken, expiresAt || '');
        }
        setState({ user: body.user, token: sessionToken, expiresAt, loading: false });
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
    if (!state.token && !shouldResumeAccessSession()) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }
    void fetchCurrentUser(state.token);
  }, [state.loading, state.token, state.user, fetchCurrentUser]);

  useEffect(() => {
    if (state.loading) return;
    clearAccessResumeFlag();
  }, [state.loading]);

  const login = useCallback(async (email: string, password: string): Promise<{ error?: string }> => {
    try {
      const payload = new URLSearchParams();
      payload.set('email', email);
      payload.set('password', password);
      const response = await fetch(`${API_PROXY_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString(),
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
