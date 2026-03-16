import { useEffect, useState } from 'react';
import type { AdminInviteRow, AdminUserRow, GroupRoleMappingRow, OnboardingChecklistItem, RoleRow, SyntheticIngestControl } from '../types';
import { formatDateTime, parseStringArray } from '../utils';

const BILLING_NOTICE_DISMISSED_KEY = 'edgedata:billing-notice-dismissed';
const ADMIN_TAB_STORAGE_KEY = 'edgedata:admin-active-tab';
const LEGACY_HIDDEN_ROLE_IDS = new Set(['zeek_viewer']);

type AdminTabId = 'overview' | 'access' | 'invites' | 'operations';

function AdminSummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="admin-summary-card">
      <span className="admin-summary-label">{label}</span>
      <strong className="admin-summary-value">{value}</strong>
      <span className="admin-summary-detail">{detail}</span>
    </div>
  );
}

export interface AdminPageProps {
  adminToast: string | null;
  adminError: string | null;
  adminLoading: boolean;
  adminUsers: AdminUserRow[];
  adminRoles: RoleRow[];
  adminMappings: GroupRoleMappingRow[];
  adminInvites: AdminInviteRow[];
  auditRows: Array<{ id: string; actor_principal?: string | null; actor_email?: string | null; action: string; target_type?: string | null; target_id?: string | null; created_at: string }>;
  syntheticIngestControl: SyntheticIngestControl | null;
  syntheticControlLoading: boolean;
  onboardingChecklist: OnboardingChecklistItem[];
  onboardingDoneCount: number;
  inviteEmail: string;
  setInviteEmail: (value: string) => void;
  inviteAuthMode: string;
  setInviteAuthMode: (value: string) => void;
  inviteRoleIds: string[];
  setInviteRoleIds: (value: string[]) => void;
  inviteLinkPreview: string | null;
  newRoleId: string;
  setNewRoleId: (value: string) => void;
  newRoleName: string;
  setNewRoleName: (value: string) => void;
  newRolePermissions: string;
  setNewRolePermissions: (value: string) => void;
  newRoleScope: string;
  setNewRoleScope: (value: string) => void;
  newMappingGroup: string;
  setNewMappingGroup: (value: string) => void;
  newMappingRoleId: string;
  setNewMappingRoleId: (value: string) => void;
  setSyntheticIngestEnabled: (enabled: boolean) => void;
  runSyntheticIngestNow: () => void;
  createInvite: () => void;
  resendInvite: (invite: AdminInviteRow) => void;
  revokeInvite: (invite: AdminInviteRow) => void;
  updateUserEnabled: (userRow: AdminUserRow, enabled: number) => void;
  updateUserRoles: (userRow: AdminUserRow, roleIdsCsv: string) => void;
  createRole: () => void;
  createMapping: () => void;
}

export function AdminPage({
  adminToast,
  adminError,
  adminLoading,
  adminUsers,
  adminRoles,
  adminMappings,
  adminInvites,
  auditRows,
  syntheticIngestControl,
  syntheticControlLoading,
  onboardingChecklist,
  onboardingDoneCount,
  inviteEmail,
  setInviteEmail,
  inviteAuthMode,
  setInviteAuthMode,
  inviteRoleIds,
  setInviteRoleIds,
  inviteLinkPreview,
  newRoleId,
  setNewRoleId,
  newRoleName,
  setNewRoleName,
  newRolePermissions,
  setNewRolePermissions,
  newRoleScope,
  setNewRoleScope,
  newMappingGroup,
  setNewMappingGroup,
  newMappingRoleId,
  setNewMappingRoleId,
  setSyntheticIngestEnabled,
  runSyntheticIngestNow,
  createInvite,
  resendInvite,
  revokeInvite,
  updateUserEnabled,
  updateUserRoles,
  createRole,
  createMapping
}: AdminPageProps) {
  const [showBillingNotice, setShowBillingNotice] = useState(false);
  const [copiedInviteLink, setCopiedInviteLink] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTabId>('overview');
  const availableRoles = adminRoles.filter((role) => role.enabled !== 0 && !LEGACY_HIDDEN_ROLE_IDS.has(role.id));
  const roleNameById = new Map(availableRoles.map((role) => [role.id, role.name]));
  const [inviteRoleCandidate, setInviteRoleCandidate] = useState('');
  const activeUsersCount = adminUsers.filter((row) => row.enabled).length;
  const pendingChecklistCount = Math.max(onboardingChecklist.length - onboardingDoneCount, 0);
  const customRoleCount = availableRoles.filter((role) => !role.system_role).length;
  const latestAuditRow = auditRows[0];
  const inviteQueueSummary = adminInvites.length === 0 ? 'Queue clear' : `${adminInvites.length} pending`;
  const operationsSummary = syntheticIngestControl?.enabled ? 'Synthetic live' : 'Synthetic paused';

  const tabOptions: Array<{ id: AdminTabId; label: string; description: string; badge: string }> = [
    {
      id: 'overview',
      label: 'Overview',
      description: 'Status, setup, and shortcuts',
      badge: pendingChecklistCount > 0 ? `${pendingChecklistCount} pending` : 'Ready'
    },
    {
      id: 'access',
      label: 'Access',
      description: 'Users, roles, and mappings',
      badge: `${activeUsersCount}/${adminUsers.length || 0} active`
    },
    {
      id: 'invites',
      label: 'Invites',
      description: 'Create and manage invites',
      badge: inviteQueueSummary
    },
    {
      id: 'operations',
      label: 'Operations',
      description: 'Runtime controls and audit',
      badge: operationsSummary
    }
  ];

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setShowBillingNotice(window.localStorage.getItem(BILLING_NOTICE_DISMISSED_KEY) !== '1');
    const storedTab = window.localStorage.getItem(ADMIN_TAB_STORAGE_KEY);
    if (storedTab === 'overview' || storedTab === 'access' || storedTab === 'invites' || storedTab === 'operations') {
      setActiveTab(storedTab);
    }
  }, []);

  useEffect(() => {
    setCopiedInviteLink(false);
  }, [inviteLinkPreview]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ADMIN_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    const nextCandidate = availableRoles.find((role) => !inviteRoleIds.includes(role.id))?.id || '';
    setInviteRoleCandidate(nextCandidate);
  }, [availableRoles, inviteRoleIds]);

  const acknowledgeBillingNotice = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(BILLING_NOTICE_DISMISSED_KEY, '1');
    }
    setShowBillingNotice(false);
  };

  const copyInviteLink = async () => {
    if (!inviteLinkPreview || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(inviteLinkPreview);
    setCopiedInviteLink(true);
  };

  const addInviteRole = () => {
    if (!inviteRoleCandidate || inviteRoleIds.includes(inviteRoleCandidate)) return;
    setInviteRoleIds([...inviteRoleIds, inviteRoleCandidate]);
  };

  const removeInviteRole = (roleId: string) => {
    setInviteRoleIds(inviteRoleIds.filter((item) => item !== roleId));
  };

  const onboardingCard = (
    <div className="admin-card admin-span-2">
      <div className="admin-section-title">
        <span className="section-icon onboarding">O</span>
        Onboarding Checklist
      </div>
      <div className="admin-card-copy">
        <p>Track the setup items that turn a fresh deployment into an operational workspace.</p>
      </div>
      <div className="onboarding-summary">
        <strong>{onboardingDoneCount}/{onboardingChecklist.length}</strong> steps complete
      </div>
      <div className="onboarding-checklist">
        {onboardingChecklist.map((item) => (
          <div key={item.key} className={`onboarding-check ${item.done ? 'done' : 'todo'}`}>
            <span className={`status-badge ${item.done ? 'active' : 'disabled'}`}>
              {item.done ? 'Done' : 'Pending'}
            </span>
            <div className="onboarding-check-copy">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const syntheticControlCard = (
    <div className="admin-card">
      <div className="admin-section-title">
        <span className="section-icon synthetic">S</span>
        Synthetic Ingest Control
      </div>
      <div className="admin-card-copy">
        <p>Control demo event generation for live-tail demos, onboarding, and smoke checks.</p>
      </div>
      <div className="admin-form-row">
        <div className="admin-form-group">
          <label>Current runtime state</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className={`status-badge ${syntheticIngestControl?.enabled ? 'active' : 'disabled'}`}>
              {syntheticIngestControl?.enabled ? 'enabled' : 'disabled'}
            </span>
            {syntheticIngestControl?.updated_at && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                updated {formatDateTime(syntheticIngestControl.updated_at)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="admin-action-row">
        <button
          className="admin-submit"
          onClick={() => void setSyntheticIngestEnabled(true)}
          disabled={syntheticControlLoading || !!syntheticIngestControl?.enabled}
        >
          {syntheticControlLoading ? 'Updating...' : 'Start Synthetic Ingest'}
        </button>
        <button
          className="secondary"
          onClick={() => void runSyntheticIngestNow()}
          disabled={syntheticControlLoading}
        >
          Run Once Now
        </button>
        <button
          className="danger"
          onClick={() => void setSyntheticIngestEnabled(false)}
          disabled={syntheticControlLoading || !syntheticIngestControl?.enabled}
        >
          Stop
        </button>
      </div>
      <p style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
        Start also triggers an immediate synthetic run so Live Tail shows fresh events quickly.
      </p>
    </div>
  );

  const inviteUserCard = (
    <div className="admin-card admin-span-2">
      <div className="admin-section-title">
        <span className="section-icon invite">+</span>
        Invite User
      </div>
      <div className="admin-card-copy">
        <p>Create the invite first, then share the generated acceptance link through your normal communication channel.</p>
      </div>
      <div className="admin-form-row">
        <div className="admin-form-group">
          <label>Email address</label>
          <input
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="user@company.com"
          />
        </div>
      </div>
      <div className="admin-form-row cols-2">
        <div className="admin-form-group">
          <label>Auth mode</label>
          <select value={inviteAuthMode} onChange={(event) => setInviteAuthMode(event.target.value as 'access_sso' | 'local_password')}>
            <option value="access_sso">Access SSO</option>
            <option value="local_password">Local Password</option>
          </select>
        </div>
        <div className="admin-form-group">
          <label>Roles</label>
          <div className="role-pill-picker" role="group" aria-label="Invite roles">
            <div className="role-pill-list">
              {inviteRoleIds.map((roleId) => (
                <button
                  key={roleId}
                  type="button"
                  className="role-pill"
                  onClick={() => removeInviteRole(roleId)}
                  aria-label={`Remove ${roleNameById.get(roleId) || roleId}`}
                >
                  <span>{roleNameById.get(roleId) || roleId}</span>
                  <span className="role-pill-dismiss" aria-hidden="true">x</span>
                </button>
              ))}
              {inviteRoleIds.length === 0 && (
                <div className="role-selector-empty">Select at least one role.</div>
              )}
            </div>
            <div className="role-pill-controls">
              <select
                value={inviteRoleCandidate}
                onChange={(event) => setInviteRoleCandidate(event.target.value)}
                disabled={availableRoles.every((role) => inviteRoleIds.includes(role.id))}
              >
                {availableRoles.filter((role) => !inviteRoleIds.includes(role.id)).length === 0 ? (
                  <option value="">All available roles selected</option>
                ) : (
                  <>
                    <option value="">Add a role...</option>
                    {availableRoles
                      .filter((role) => !inviteRoleIds.includes(role.id))
                      .map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name} ({role.id})
                        </option>
                      ))}
                  </>
                )}
              </select>
              <button type="button" className="secondary" onClick={addInviteRole} disabled={!inviteRoleCandidate}>
                Add
              </button>
            </div>
          </div>
        </div>
      </div>
      <p className="invite-delivery-note">
        Invite delivery is manual right now. Create the invite, then copy the generated link into email or chat.
      </p>
      <button className="admin-submit" onClick={() => void createInvite()}>Create Invite</button>
      {inviteLinkPreview && (
        <div className="invite-token-box">
          <strong>Share this invite link</strong>
          <span className="invite-token-help">
            Send the full link to the user so they can accept without copying a token. EdgeData does not send the email for you in this deployment.
          </span>
          <code>{inviteLinkPreview}</code>
          <div className="invite-token-actions">
            <button type="button" className="secondary" onClick={() => void copyInviteLink()}>
              {copiedInviteLink ? 'Copied' : 'Copy Link'}
            </button>
            <a className="invite-link-open" href={inviteLinkPreview} target="_blank" rel="noreferrer">
              Open
            </a>
          </div>
        </div>
      )}
    </div>
  );

  const inviteQueueCard = (
    <div className="admin-card admin-span-2">
      <div className="admin-section-title">
        <span className="section-icon invite">I</span>
        Invite Queue
      </div>
      <div className="admin-card-copy">
        <p>Review outstanding invites, resend links, and revoke invites that should no longer be usable.</p>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Auth Mode</th>
              <th>Roles</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {adminInvites.map((invite) => (
              <tr key={invite.id}>
                <td><strong>{invite.email}</strong></td>
                <td>{invite.auth_mode === 'access_sso' ? 'Access SSO' : 'Local Password'}</td>
                <td>{invite.role_ids.map((roleId) => <span key={roleId} className="permission-tag">{roleNameById.get(roleId) || roleId}</span>)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(invite.expires_at)}</td>
                <td>
                  <div className="invite-actions">
                    <button className="secondary" onClick={() => void resendInvite(invite)}>Resend</button>
                    <button className="danger" onClick={() => void revokeInvite(invite)}>Revoke</button>
                  </div>
                </td>
              </tr>
            ))}
            {adminInvites.length === 0 && (
              <tr className="empty-row">
                <td colSpan={5}>No pending invites</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const createRoleCard = (
    <div className="admin-card">
      <div className="admin-section-title">
        <span className="section-icon role">R</span>
        Create Role
      </div>
      <div className="admin-card-copy">
        <p>Define reusable permission bundles and data scopes for recurring access patterns.</p>
      </div>
      <div className="admin-form-row cols-2">
        <div className="admin-form-group">
          <label>Role ID</label>
          <input
            type="text"
            value={newRoleId}
            onChange={(event) => setNewRoleId(event.target.value)}
            placeholder="e.g. incident_commander"
          />
        </div>
        <div className="admin-form-group">
          <label>Display name</label>
          <input
            type="text"
            value={newRoleName}
            onChange={(event) => setNewRoleName(event.target.value)}
            placeholder="Incident Commander"
          />
        </div>
      </div>
      <div className="admin-form-row">
        <div className="admin-form-group">
          <label>Permissions</label>
          <input
            type="text"
            value={newRolePermissions}
            onChange={(event) => setNewRolePermissions(event.target.value)}
            placeholder="search.read, dashboard.read"
          />
        </div>
      </div>
      <div className="admin-form-row">
        <div className="admin-form-group">
          <label>Data scope (JSON)</label>
          <textarea
            value={newRoleScope}
            onChange={(event) => setNewRoleScope(event.target.value)}
            placeholder='{"indexes":["*"],"services":["*"],"envs":["*"],"hosts":["*"]}'
          />
        </div>
      </div>
      <button className="admin-submit" onClick={() => void createRole()}>Create Role</button>
    </div>
  );

  const mappingCard = (
    <div className="admin-card">
      <div className="admin-section-title">
        <span className="section-icon mapping">G</span>
        Access Group Mapping
      </div>
      <div className="admin-card-copy">
        <p>Map identity-provider groups to EdgeData roles so team membership translates into access automatically.</p>
      </div>
      <div className="admin-form-row cols-2">
        <div className="admin-form-group">
          <label>IdP / Access group</label>
          <input
            type="text"
            value={newMappingGroup}
            onChange={(event) => setNewMappingGroup(event.target.value)}
            placeholder="engineering-team"
          />
        </div>
        <div className="admin-form-group">
          <label>Role ID</label>
          <input
            type="text"
            value={newMappingRoleId}
            onChange={(event) => setNewMappingRoleId(event.target.value)}
            placeholder="analyst"
          />
        </div>
      </div>
      <button className="admin-submit" onClick={() => void createMapping()}>Add Mapping</button>

      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Access Group</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {adminMappings.map((mapping) => (
              <tr key={mapping.id}>
                <td>{mapping.access_group}</td>
                <td><span className="permission-tag">{mapping.role_id}</span></td>
              </tr>
            ))}
            {adminMappings.length === 0 && (
              <tr className="empty-row">
                <td colSpan={2}>No mappings yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const usersCard = (
    <div className="admin-card admin-span-2">
      <div className="admin-section-title">
        <span className="section-icon users">U</span>
        Users
      </div>
      <div className="admin-card-copy">
        <p>Review active accounts, update role assignments, and disable access when needed.</p>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {adminUsers.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.email}</strong></td>
                <td>
                  <form
                    className="admin-inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget as HTMLFormElement;
                      const input = form.elements.namedItem(`roles-${row.id}`) as HTMLInputElement | null;
                      if (!input) return;
                      void updateUserRoles(row, input.value);
                    }}
                  >
                    <input
                      name={`roles-${row.id}`}
                      defaultValue={row.role_ids.join(',')}
                      placeholder="viewer,analyst"
                    />
                    <button className="secondary" type="submit">Set</button>
                  </form>
                </td>
                <td>
                  <span className={`status-badge ${row.enabled ? 'active' : 'disabled'}`}>
                    {row.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td>{row.last_login_at ? formatDateTime(row.last_login_at) : <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>never</span>}</td>
                <td>
                  {row.enabled ? (
                    <button className="danger" onClick={() => void updateUserEnabled(row, 0)}>Disable</button>
                  ) : (
                    <button className="secondary" onClick={() => void updateUserEnabled(row, 1)}>Enable</button>
                  )}
                </td>
              </tr>
            ))}
            {adminUsers.length === 0 && (
              <tr className="empty-row">
                <td colSpan={5}>No users</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const rolesCard = (
    <div className="admin-card admin-span-2">
      <div className="admin-section-title">
        <span className="section-icon roles">R</span>
        Roles
      </div>
      <div className="admin-card-copy">
        <p>Reference every role definition in one place, including permissions and scope boundaries.</p>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Permissions</th>
              <th>Scope</th>
            </tr>
          </thead>
          <tbody>
            {adminRoles.map((role) => (
              <tr key={role.id}>
                <td>
                  <strong>{role.id}</strong>
                  {role.system_role && <span className="system-badge">system</span>}
                </td>
                <td>{parseStringArray(role.permissions_json).map((permission) => <span key={permission} className="permission-tag">{permission}</span>)}</td>
                <td><span className="scope-cell" title={role.scope_json}>{role.scope_json}</span></td>
              </tr>
            ))}
            {adminRoles.length === 0 && (
              <tr className="empty-row">
                <td colSpan={3}>No roles</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const auditCard = (
    <div className="admin-card admin-span-2">
      <div className="admin-section-title">
        <span className="section-icon audit">A</span>
        Audit Log
      </div>
      <div className="admin-card-copy">
        <p>Review administrative changes with actor, action, and target details for faster troubleshooting.</p>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {auditRows.map((row) => (
              <tr key={row.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.created_at)}</td>
                <td>{row.actor_email || row.actor_principal || <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>system</span>}</td>
                <td><span className="audit-action">{row.action}</span></td>
                <td><span className="audit-target">{row.target_type || '-'}:{row.target_id || '-'}</span></td>
              </tr>
            ))}
            {auditRows.length === 0 && (
              <tr className="empty-row">
                <td colSpan={4}>No audit records</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="admin-view">
      <div className="admin-header">
        <div className="admin-header-copy">
          <span className="admin-kicker">Workspace controls</span>
          <h2>Administration</h2>
          <p className="admin-subtitle">
            Organize access, onboarding, and operational controls without hunting through one long page.
          </p>
        </div>
        <div className="admin-header-stats">
          <span className="admin-header-pill">{adminUsers.length} user{adminUsers.length !== 1 ? 's' : ''}</span>
          <span className="admin-header-pill">{availableRoles.length} role{availableRoles.length !== 1 ? 's' : ''}</span>
          <span className="admin-header-pill">{adminInvites.length} invite{adminInvites.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {adminToast && <div className="success-banner">{adminToast}</div>}
      {adminError && <div className="error-banner">{adminError}</div>}
      {adminLoading && <div className="empty-state"><p>Loading admin data...</p></div>}
      {showBillingNotice && (
        <div className="billing-notice" role="note" aria-label="Cloudflare billing acknowledgement">
          <div className="billing-notice-copy">
            <strong>Cloudflare billing acknowledgement</strong>
            <p>
              EdgeData runs in your Cloudflare account. Using Workers, R2, D1, WAE, Durable Objects, Access,
              Pages, synthetic ingest, alerts, and dashboard materialization may incur Cloudflare charges. Review
              your Cloudflare plan and pricing before enabling production workloads.
            </p>
          </div>
          <button type="button" className="secondary billing-notice-dismiss" onClick={acknowledgeBillingNotice}>
            I understand
          </button>
        </div>
      )}

      {!adminLoading && (
        <>
          <div className="admin-tabs-shell">
            <div className="admin-tabs" role="tablist" aria-label="Administration sections">
              {tabOptions.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`admin-tab-${tab.id}`}
                  aria-controls={`admin-panel-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  className={`admin-tab-button ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="admin-tab-topline">
                    <span className="admin-tab-label">{tab.label}</span>
                    <span className="admin-tab-badge">{tab.badge}</span>
                  </span>
                  <span className="admin-tab-caption">{tab.description}</span>
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'overview' && (
            <section
              className="admin-panel"
              role="tabpanel"
              id="admin-panel-overview"
              aria-labelledby="admin-tab-overview"
            >
              <div className="admin-panel-intro">
                <span className="admin-kicker">Workspace snapshot</span>
                <h3>Overview</h3>
                <p>See what needs attention first, then jump directly into the right workflow.</p>
              </div>

              <div className="admin-summary-grid">
                <AdminSummaryCard
                  label="Active users"
                  value={String(activeUsersCount)}
                  detail={activeUsersCount === adminUsers.length ? 'All current accounts enabled' : `${adminUsers.length - activeUsersCount} disabled`}
                />
                <AdminSummaryCard
                  label="Pending invites"
                  value={String(adminInvites.length)}
                  detail={adminInvites.length === 0 ? 'No one waiting for access' : 'Outstanding access requests'}
                />
                <AdminSummaryCard
                  label="Custom roles"
                  value={String(customRoleCount)}
                  detail={`${availableRoles.length} total active roles`}
                />
                <AdminSummaryCard
                  label="Setup progress"
                  value={`${onboardingDoneCount}/${onboardingChecklist.length}`}
                  detail={pendingChecklistCount === 0 ? 'Checklist complete' : `${pendingChecklistCount} steps remaining`}
                />
              </div>

              <div className="admin-grid">
                {onboardingCard}

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon invite">Q</span>
                    Quick Actions
                  </div>
                  <div className="admin-card-copy">
                    <p>Jump into the most common admin jobs without scanning the whole page.</p>
                  </div>
                  <div className="admin-action-list">
                    <button type="button" className="admin-submit" onClick={() => setActiveTab('invites')}>
                      Invite a user
                    </button>
                    <button type="button" className="secondary" onClick={() => setActiveTab('access')}>
                      Manage users and roles
                    </button>
                    <button type="button" className="secondary" onClick={() => setActiveTab('operations')}>
                      Open operations
                    </button>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-section-title">
                    <span className="section-icon synthetic">P</span>
                    Platform Status
                  </div>
                  <div className="admin-card-copy">
                    <p>Keep the key operational signals visible without leaving the admin overview.</p>
                  </div>
                  <dl className="admin-status-list">
                    <div>
                      <dt>Synthetic ingest</dt>
                      <dd>
                        <span className={`status-badge ${syntheticIngestControl?.enabled ? 'active' : 'disabled'}`}>
                          {syntheticIngestControl?.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Latest audit entry</dt>
                      <dd>{latestAuditRow ? formatDateTime(latestAuditRow.created_at) : 'No recent activity'}</dd>
                    </div>
                    <div>
                      <dt>Access mappings</dt>
                      <dd>{adminMappings.length} configured</dd>
                    </div>
                    <div>
                      <dt>Invite queue</dt>
                      <dd>{inviteQueueSummary}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'access' && (
            <section
              className="admin-panel"
              role="tabpanel"
              id="admin-panel-access"
              aria-labelledby="admin-tab-access"
            >
              <div className="admin-panel-intro">
                <span className="admin-kicker">Identity and permissions</span>
                <h3>Access</h3>
                <p>Manage who can sign in, what they can do, and how IdP groups map into roles.</p>
              </div>
              <div className="admin-grid">
                {usersCard}
                {createRoleCard}
                {mappingCard}
                {rolesCard}
              </div>
            </section>
          )}

          {activeTab === 'invites' && (
            <section
              className="admin-panel"
              role="tabpanel"
              id="admin-panel-invites"
              aria-labelledby="admin-tab-invites"
            >
              <div className="admin-panel-intro">
                <span className="admin-kicker">Onboard teammates</span>
                <h3>Invites</h3>
                <p>Create access links and keep track of which invitations are still outstanding.</p>
              </div>
              <div className="admin-grid">
                {inviteUserCard}
                {inviteQueueCard}
              </div>
            </section>
          )}

          {activeTab === 'operations' && (
            <section
              className="admin-panel"
              role="tabpanel"
              id="admin-panel-operations"
              aria-labelledby="admin-tab-operations"
            >
              <div className="admin-panel-intro">
                <span className="admin-kicker">Runtime and governance</span>
                <h3>Operations</h3>
                <p>Control background activity and audit who changed what inside the workspace.</p>
              </div>
              <div className="admin-grid">
                {syntheticControlCard}
                {auditCard}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
