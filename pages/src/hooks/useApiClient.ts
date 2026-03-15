import { useCallback } from 'react';
import { API_PROXY_BASE } from '../constants';
import type {
  AdminInviteRow,
  AdminUserRow,
  AlertDefinition,
  GroupRoleMappingRow,
  RoleRow,
  SearchRequestPayload,
  SyntheticIngestControl
} from '../types';

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface UseApiClientReturn {
  apiFetch: ApiFetch;
  fetchSearchSuggestions: (body: { query: string; cursorPos: number; maxItems: number; context?: { topTerms?: string[] } }) => Promise<Response>;
  fetchSearchSummary: (payload: SearchRequestPayload) => Promise<Response>;
  fetchSearchStream: (payload: SearchRequestPayload) => Promise<Response>;
  fetchSearch: (payload: SearchRequestPayload) => Promise<Response>;
  fetchDashboards: () => Promise<Response>;
  fetchDashboardPanels: (dashId: string) => Promise<Response>;
  fetchSavedSearches: () => Promise<Response>;
  createSavedSearch: (body: { name: string; query: string }) => Promise<Response>;
  deleteSavedSearch: (id: string) => Promise<Response>;
  fetchScheduledSearches: () => Promise<Response>;
  createScheduledSearch: (body: { name: string; ppl: string; schedule_cron: string; time_window_minutes: number }) => Promise<Response>;
  deleteScheduledSearch: (id: string) => Promise<Response>;
  toggleScheduledSearch: (id: string, enabled: boolean) => Promise<Response>;
  fetchScheduledResults: (id: string) => Promise<Response>;
  fetchScheduledRunDetail: (searchId: string, runId: string) => Promise<Response>;
  fetchScheduledRunResults: (searchId: string, runId: string) => Promise<Response>;
  runScheduledSearch: (id: string) => Promise<Response>;
  fetchAlerts: () => Promise<Response>;
  createAlert: (body: Record<string, unknown>) => Promise<Response>;
  applyStarterAlertPack: (body: { index: string; deep_link_base: string; runbook_base_url?: string; owner_team?: string }) => Promise<Response>;
  toggleAlertEnabled: (alert: AlertDefinition) => Promise<Response>;
  deleteAlert: (id: string) => Promise<Response>;
  fetchAdminData: () => Promise<{
    users: AdminUserRow[];
    roles: RoleRow[];
    mappings: GroupRoleMappingRow[];
    invites: AdminInviteRow[];
    audit: unknown[];
    synthetic: SyntheticIngestControl;
    alerts: AlertDefinition[];
  }>;
  setSyntheticIngestEnabled: (enabled: boolean) => Promise<Response>;
  runSyntheticIngestNow: () => Promise<Response>;
  createInvite: (body: { email: string; auth_mode: string; role_ids: string[] }) => Promise<Response>;
  resendInvite: (invite: AdminInviteRow) => Promise<Response>;
  revokeInvite: (invite: AdminInviteRow) => Promise<Response>;
  updateUserEnabled: (userRow: AdminUserRow, enabled: number) => Promise<Response>;
  updateUserRoles: (userRow: AdminUserRow, roleIds: string[]) => Promise<Response>;
  createRole: (body: { id: string; name: string; permissions_json: string[]; scope_json: object }) => Promise<Response>;
  createMapping: (body: { access_group: string; role_id: string }) => Promise<Response>;
}

export function useApiClient(apiToken: string | null): UseApiClientReturn {
  const apiFetch = useCallback<ApiFetch>((path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers || {});
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (apiToken) {
      headers.set('Authorization', `Bearer ${apiToken}`);
    }
    return fetch(`${API_PROXY_BASE}${path}`, { ...init, headers, credentials: init.credentials ?? 'include' });
  }, [apiToken]);

  const fetchSearchSuggestions = useCallback(
    (body: { query: string; cursorPos: number; maxItems: number; context?: { topTerms?: string[] } }) =>
      apiFetch('/search/suggestions', { method: 'POST', body: JSON.stringify(body) }),
    [apiFetch]
  );

  const fetchSearchSummary = useCallback(
    (payload: SearchRequestPayload) =>
      apiFetch('/search/summary', { method: 'POST', body: JSON.stringify(payload) }),
    [apiFetch]
  );

  const fetchSearchStream = useCallback(
    (payload: SearchRequestPayload) =>
      apiFetch('/search/stream', { method: 'POST', body: JSON.stringify(payload) }),
    [apiFetch]
  );

  const fetchSearch = useCallback(
    (payload: SearchRequestPayload) =>
      apiFetch('/search', { method: 'POST', body: JSON.stringify(payload) }),
    [apiFetch]
  );

  const fetchDashboards = useCallback(() => apiFetch('/dashboards'), [apiFetch]);
  const fetchDashboardPanels = useCallback((dashId: string) => apiFetch(`/dashboards/${dashId}/panels`), [apiFetch]);

  const fetchSavedSearches = useCallback(() => apiFetch('/saved-searches'), [apiFetch]);
  const createSavedSearch = useCallback(
    (body: { name: string; query: string }) =>
      apiFetch('/saved-searches', { method: 'POST', body: JSON.stringify(body) }),
    [apiFetch]
  );
  const deleteSavedSearch = useCallback((id: string) => apiFetch(`/saved-searches/${id}`, { method: 'DELETE' }), [apiFetch]);

  const fetchScheduledSearches = useCallback(() => apiFetch('/scheduled-searches'), [apiFetch]);
  const createScheduledSearch = useCallback(
    (body: { name: string; ppl: string; schedule_cron: string; time_window_minutes: number }) =>
      apiFetch('/scheduled-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
    [apiFetch]
  );
  const deleteScheduledSearch = useCallback(
    (id: string) => apiFetch(`/scheduled-searches/${id}`, { method: 'DELETE' }),
    [apiFetch]
  );
  const toggleScheduledSearch = useCallback(
    (id: string, enabled: boolean) =>
      apiFetch(`/scheduled-searches/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled ? 1 : 0 })
      }),
    [apiFetch]
  );
  const fetchScheduledResults = useCallback(
    (id: string) => apiFetch(`/scheduled-searches/${id}/results`),
    [apiFetch]
  );
  const fetchScheduledRunDetail = useCallback(
    (searchId: string, runId: string) =>
      apiFetch(`/scheduled-searches/${searchId}/runs/${runId}`),
    [apiFetch]
  );
  const fetchScheduledRunResults = useCallback(
    (searchId: string, runId: string) =>
      apiFetch(`/scheduled-searches/${searchId}/runs/${runId}/results`),
    [apiFetch]
  );
  const runScheduledSearch = useCallback(
    (id: string) =>
      apiFetch(`/scheduled-searches/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
    [apiFetch]
  );

  const fetchAlerts = useCallback(() => apiFetch('/alerts'), [apiFetch]);
  const createAlert = useCallback(
    (body: Record<string, unknown>) =>
      apiFetch('/alerts', { method: 'POST', body: JSON.stringify(body) }),
    [apiFetch]
  );
  const applyStarterAlertPack = useCallback(
    (body: { index: string; deep_link_base: string; runbook_base_url?: string; owner_team?: string }) =>
      apiFetch('/alerts/starter-pack/apply', { method: 'POST', body: JSON.stringify(body) }),
    [apiFetch]
  );
  const toggleAlertEnabled = useCallback(
    (alert: AlertDefinition) =>
      apiFetch(`/alerts/${alert.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: alert.enabled ? 0 : 1 })
      }),
    [apiFetch]
  );
  const deleteAlert = useCallback((id: string) => apiFetch(`/alerts/${id}`, { method: 'DELETE' }), [apiFetch]);

  const fetchAdminData = useCallback(async () => {
    const [usersRes, rolesRes, mappingsRes, invitesRes, auditRes, syntheticRes, alertsRes] = await Promise.all([
      apiFetch('/users'),
      apiFetch('/roles'),
      apiFetch('/rbac/mappings'),
      apiFetch('/auth/invites?status=pending&limit=200'),
      apiFetch('/audit?limit=100'),
      apiFetch('/admin/synthetic-ingest'),
      apiFetch('/alerts')
    ]);

    const usersBody = (await usersRes.json()) as AdminUserRow[] | { error?: string };
    const rolesBody = (await rolesRes.json()) as RoleRow[] | { error?: string };
    const mappingsBody = (await mappingsRes.json()) as GroupRoleMappingRow[] | { error?: string };
    const invitesBody = (await invitesRes.json()) as AdminInviteRow[] | { error?: string };
    const auditBody = (await auditRes.json()) as unknown[] | { error?: string };
    const syntheticBody = (await syntheticRes.json()) as SyntheticIngestControl | { error?: string };
    const alertsBody = (await alertsRes.json()) as AlertDefinition[] | { error?: string };

    if (!usersRes.ok || ('error' in usersBody && usersBody.error)) {
      throw new Error(('error' in usersBody && usersBody.error) ? usersBody.error : 'Failed to load users');
    }
    if (!rolesRes.ok || ('error' in rolesBody && rolesBody.error)) {
      throw new Error(('error' in rolesBody && rolesBody.error) ? rolesBody.error : 'Failed to load roles');
    }
    if (!mappingsRes.ok || ('error' in mappingsBody && mappingsBody.error)) {
      throw new Error(('error' in mappingsBody && mappingsBody.error) ? mappingsBody.error : 'Failed to load mappings');
    }
    if (!invitesRes.ok || ('error' in invitesBody && invitesBody.error)) {
      throw new Error(('error' in invitesBody && invitesBody.error) ? invitesBody.error : 'Failed to load invites');
    }
    if (!auditRes.ok) {
      throw new Error('Failed to load audit');
    }
    const syntheticErr = syntheticBody as { error?: string };
    if (!syntheticRes.ok || syntheticErr.error) {
      throw new Error(syntheticErr.error || 'Failed to load synthetic ingest control');
    }
    const alertsErr = alertsBody as { error?: string };
    if (!alertsRes.ok || alertsErr.error) {
      throw new Error(alertsErr.error || 'Failed to load alerts');
    }

    return {
      users: usersBody as AdminUserRow[],
      roles: rolesBody as RoleRow[],
      mappings: mappingsBody as GroupRoleMappingRow[],
      invites: invitesBody as AdminInviteRow[],
      audit: auditBody as unknown[],
      synthetic: syntheticBody as SyntheticIngestControl,
      alerts: alertsBody as AlertDefinition[]
    };
  }, [apiFetch]);

  const setSyntheticIngestEnabled = useCallback(
    (enabled: boolean) =>
      apiFetch('/admin/synthetic-ingest', {
        method: 'POST',
        body: JSON.stringify({ enabled, trigger_run: enabled })
      }),
    [apiFetch]
  );

  const runSyntheticIngestNow = useCallback(
    () => apiFetch('/admin/synthetic-ingest/run', { method: 'POST' }),
    [apiFetch]
  );

  const createInvite = useCallback(
    (body: { email: string; auth_mode: string; role_ids: string[] }) =>
      apiFetch('/auth/invite', { method: 'POST', body: JSON.stringify(body) }),
    [apiFetch]
  );

  const resendInvite = useCallback(
    (invite: AdminInviteRow) =>
      apiFetch('/auth/invite/resend', {
        method: 'POST',
        body: JSON.stringify({ id: invite.id })
      }),
    [apiFetch]
  );

  const revokeInvite = useCallback(
    (invite: AdminInviteRow) =>
      apiFetch('/auth/invite/revoke', {
        method: 'POST',
        body: JSON.stringify({ id: invite.id })
      }),
    [apiFetch]
  );

  const updateUserEnabled = useCallback(
    (userRow: AdminUserRow, enabled: number) =>
      apiFetch(`/users/${userRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled })
      }),
    [apiFetch]
  );

  const updateUserRoles = useCallback(
    (userRow: AdminUserRow, roleIds: string[]) =>
      apiFetch(`/users/${userRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role_ids: roleIds })
      }),
    [apiFetch]
  );

  const createRole = useCallback(
    (body: { id: string; name: string; permissions_json: string[]; scope_json: object }) =>
      apiFetch('/roles', {
        method: 'POST',
        body: JSON.stringify({
          id: body.id,
          name: body.name,
          permissions_json: body.permissions_json,
          scope_json: body.scope_json
        })
      }),
    [apiFetch]
  );

  const createMapping = useCallback(
    (body: { access_group: string; role_id: string }) =>
      apiFetch('/rbac/mappings', {
        method: 'POST',
        body: JSON.stringify(body)
      }),
    [apiFetch]
  );

  return {
    apiFetch,
    fetchSearchSuggestions,
    fetchSearchSummary,
    fetchSearchStream,
    fetchSearch,
    fetchDashboards,
    fetchDashboardPanels,
    fetchSavedSearches,
    createSavedSearch,
    deleteSavedSearch,
    fetchScheduledSearches,
    createScheduledSearch,
    deleteScheduledSearch,
    toggleScheduledSearch,
    fetchScheduledResults,
    fetchScheduledRunDetail,
    fetchScheduledRunResults,
    runScheduledSearch,
    fetchAlerts,
    createAlert,
    applyStarterAlertPack,
    toggleAlertEnabled,
    deleteAlert,
    fetchAdminData,
    setSyntheticIngestEnabled,
    runSyntheticIngestNow,
    createInvite,
    resendInvite,
    revokeInvite,
    updateUserEnabled,
    updateUserRoles,
    createRole,
    createMapping
  };
}
