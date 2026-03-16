import { ALERT_TEMPLATE_PRESETS, ALERT_THRESHOLD_OPERATOR_OPTIONS } from '../constants';
import type {
  AlertDefinition,
  AlertQueryTemplate,
  AlertThresholdOperator
} from '../types';
import { buildAlertWorkspaceHref, parseAlertNotifyConfig, parseAlertParamsConfig } from '../utils';

export interface AlertsPageProps {
  alertsError: string | null;
  alertsInfo: string | null;
  alertsLoading: boolean;
  alerts: AlertDefinition[];
  alertGovernance: { total: number; withDeepLink: number; withRunbook: number; withOwnerTeam: number };
  newAlertName: string;
  setNewAlertName: (value: string) => void;
  newAlertTemplateId: AlertQueryTemplate;
  setNewAlertTemplateId: (value: AlertQueryTemplate) => void;
  selectedAlertTemplate: (typeof ALERT_TEMPLATE_PRESETS)[number];
  isTokenAlertTemplate: boolean;
  newAlertWindowMinutes: string;
  setNewAlertWindowMinutes: (value: string) => void;
  newAlertSchedule: string;
  setNewAlertSchedule: (value: string) => void;
  newAlertCooldown: string;
  setNewAlertCooldown: (value: string) => void;
  newAlertThresholdOperator: AlertThresholdOperator;
  setNewAlertThresholdOperator: (value: AlertThresholdOperator) => void;
  newAlertThresholdValue: string;
  setNewAlertThresholdValue: (value: string) => void;
  newAlertIndex: string;
  setNewAlertIndex: (value: string) => void;
  newAlertService: string;
  setNewAlertService: (value: string) => void;
  newAlertEnv: string;
  setNewAlertEnv: (value: string) => void;
  newAlertToken: string;
  setNewAlertToken: (value: string) => void;
  newAlertSeverity: string;
  setNewAlertSeverity: (value: string) => void;
  newAlertNotifySlack: boolean;
  setNewAlertNotifySlack: (value: boolean) => void;
  newAlertNotifyWebhook: boolean;
  setNewAlertNotifyWebhook: (value: boolean) => void;
  newAlertOwnerTeam: string;
  setNewAlertOwnerTeam: (value: string) => void;
  newAlertRunbookUrl: string;
  setNewAlertRunbookUrl: (value: string) => void;
  newAlertDeepLink: string;
  setNewAlertDeepLink: (value: string) => void;
  starterRunbookBase: string;
  setStarterRunbookBase: (value: string) => void;
  starterOwnerTeam: string;
  setStarterOwnerTeam: (value: string) => void;
  indexName: string;
  alertPayloadPreview: Record<string, unknown>;
  starterPackApplying: boolean;
  createAlert: () => void;
  applyStarterAlertPack: () => void;
  toggleAlertEnabled: (alert: AlertDefinition) => void;
  deleteAlert: (id: string) => void;
}

export function AlertsPage({
  alertsError,
  alertsInfo,
  alertsLoading,
  alerts,
  alertGovernance,
  newAlertName,
  setNewAlertName,
  newAlertTemplateId,
  setNewAlertTemplateId,
  selectedAlertTemplate,
  isTokenAlertTemplate,
  newAlertWindowMinutes,
  setNewAlertWindowMinutes,
  newAlertSchedule,
  setNewAlertSchedule,
  newAlertCooldown,
  setNewAlertCooldown,
  newAlertThresholdOperator,
  setNewAlertThresholdOperator,
  newAlertThresholdValue,
  setNewAlertThresholdValue,
  newAlertIndex,
  setNewAlertIndex,
  newAlertService,
  setNewAlertService,
  newAlertEnv,
  setNewAlertEnv,
  newAlertToken,
  setNewAlertToken,
  newAlertSeverity,
  setNewAlertSeverity,
  newAlertNotifySlack,
  setNewAlertNotifySlack,
  newAlertNotifyWebhook,
  setNewAlertNotifyWebhook,
  newAlertOwnerTeam,
  setNewAlertOwnerTeam,
  newAlertRunbookUrl,
  setNewAlertRunbookUrl,
  newAlertDeepLink,
  setNewAlertDeepLink,
  starterRunbookBase,
  setStarterRunbookBase,
  starterOwnerTeam,
  setStarterOwnerTeam,
  indexName,
  alertPayloadPreview,
  starterPackApplying,
  createAlert,
  applyStarterAlertPack,
  toggleAlertEnabled,
  deleteAlert
}: AlertsPageProps) {
  return (
    <div className="alerts-view">
      {alertsError && <div className="error-banner">{alertsError}</div>}
      {alertsInfo && <p className="empty-card">{alertsInfo}</p>}

      <div className="alerts-layout">
        <div className="card alert-form-card">
          <h3>Create Alert</h3>
          <div className="alert-form-grid">
            <label className="alert-form-field">
              <span>Alert Name</span>
              <input
                type="text"
                value={newAlertName}
                onChange={(event) => setNewAlertName(event.target.value)}
                placeholder="API error spike in prod"
              />
            </label>

            <label className="alert-form-field">
              <span>Template</span>
              <select
                value={newAlertTemplateId}
                onChange={(event) => setNewAlertTemplateId(event.target.value as AlertQueryTemplate)}
              >
                {ALERT_TEMPLATE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            </label>

            <p className="alert-template-hint">{selectedAlertTemplate.description}</p>

            <div className="alert-form-row cols-3">
              <label className="alert-form-field">
                <span>Window (minutes)</span>
                <input
                  type="number"
                  min={1}
                  value={newAlertWindowMinutes}
                  onChange={(event) => setNewAlertWindowMinutes(event.target.value)}
                />
              </label>
              <label className="alert-form-field">
                <span>Schedule (seconds)</span>
                <input
                  type="number"
                  min={1}
                  value={newAlertSchedule}
                  onChange={(event) => setNewAlertSchedule(event.target.value)}
                />
              </label>
              <label className="alert-form-field">
                <span>Cooldown (seconds)</span>
                <input
                  type="number"
                  min={1}
                  value={newAlertCooldown}
                  onChange={(event) => setNewAlertCooldown(event.target.value)}
                />
              </label>
            </div>

            <div className="alert-form-row cols-2">
              <label className="alert-form-field">
                <span>Threshold Rule</span>
                <select
                  value={newAlertThresholdOperator}
                  onChange={(event) => setNewAlertThresholdOperator(event.target.value as AlertThresholdOperator)}
                >
                  {ALERT_THRESHOLD_OPERATOR_OPTIONS.map((operator) => (
                    <option key={operator.value} value={operator.value}>{operator.label}</option>
                  ))}
                </select>
              </label>
              <label className="alert-form-field">
                <span>Threshold Value</span>
                <input
                  type="number"
                  value={newAlertThresholdValue}
                  onChange={(event) => setNewAlertThresholdValue(event.target.value)}
                />
              </label>
            </div>

            <div className="alert-form-row cols-3">
              <label className="alert-form-field">
                <span>Index (optional)</span>
                <input
                  type="text"
                  value={newAlertIndex}
                  onChange={(event) => setNewAlertIndex(event.target.value)}
                  placeholder={indexName.trim().toLowerCase() || 'default'}
                />
              </label>
              <label className="alert-form-field">
                <span>Service (optional)</span>
                <input
                  type="text"
                  value={newAlertService}
                  onChange={(event) => setNewAlertService(event.target.value)}
                  placeholder="checkout-api"
                />
              </label>
              <label className="alert-form-field">
                <span>Environment (optional)</span>
                <input
                  type="text"
                  value={newAlertEnv}
                  onChange={(event) => setNewAlertEnv(event.target.value)}
                  placeholder="prod"
                />
              </label>
            </div>

            {isTokenAlertTemplate && (
              <label className="alert-form-field">
                <span>Token</span>
                <input
                  type="text"
                  value={newAlertToken}
                  onChange={(event) => setNewAlertToken(event.target.value)}
                  placeholder="unauthorized"
                />
              </label>
            )}

            <div className="alert-form-row cols-2">
              <label className="alert-form-field">
                <span>Severity</span>
                <select
                  value={newAlertSeverity}
                  onChange={(event) => setNewAlertSeverity(event.target.value as 'critical' | 'warn' | 'info')}
                >
                  <option value="critical">critical</option>
                  <option value="warn">warn</option>
                  <option value="info">info</option>
                </select>
              </label>
              <div className="alert-form-field">
                <span>Notify Channels</span>
                <div className="alert-channel-group">
                  <label className="alert-check">
                    <input
                      type="checkbox"
                      checked={newAlertNotifySlack}
                      onChange={(event) => setNewAlertNotifySlack(event.target.checked)}
                    />
                    Slack
                  </label>
                  <label className="alert-check">
                    <input
                      type="checkbox"
                      checked={newAlertNotifyWebhook}
                      onChange={(event) => setNewAlertNotifyWebhook(event.target.checked)}
                    />
                    Webhook
                  </label>
                </div>
              </div>
            </div>

            <div className="alert-form-row cols-2">
              <label className="alert-form-field">
                <span>Owner Team (optional)</span>
                <input
                  type="text"
                  value={newAlertOwnerTeam}
                  onChange={(event) => setNewAlertOwnerTeam(event.target.value)}
                  placeholder="edge-ops"
                />
              </label>
              <label className="alert-form-field">
                <span>Runbook URL (optional)</span>
                <input
                  type="url"
                  value={newAlertRunbookUrl}
                  onChange={(event) => setNewAlertRunbookUrl(event.target.value)}
                  placeholder="https://runbooks.example.com/edge/error-rate"
                />
              </label>
            </div>

            <label className="alert-form-field">
              <span>Deep Link URL Override (optional)</span>
              <input
                type="url"
                value={newAlertDeepLink}
                onChange={(event) => setNewAlertDeepLink(event.target.value)}
                placeholder="Auto-generated from template + filters"
              />
            </label>

            <div className="alert-starter-pack">
              <h4>Starter Pack Defaults</h4>
              <div className="alert-form-row cols-2">
                <label className="alert-form-field">
                  <span>Runbook Base URL</span>
                  <input
                    type="text"
                    value={starterRunbookBase}
                    onChange={(event) => setStarterRunbookBase(event.target.value)}
                    placeholder="https://runbooks.example.com/edge"
                  />
                </label>
                <label className="alert-form-field">
                  <span>Owner Team</span>
                  <input
                    type="text"
                    value={starterOwnerTeam}
                    onChange={(event) => setStarterOwnerTeam(event.target.value)}
                    placeholder="edge-ops"
                  />
                </label>
              </div>
            </div>

            <div className="alert-json-preview">
              <strong>Payload Preview</strong>
              <pre>{JSON.stringify(alertPayloadPreview, null, 2)}</pre>
            </div>
          </div>
          <div className="alert-form-actions">
            <button onClick={() => void createAlert()}>Create Alert</button>
            <button className="secondary" disabled={starterPackApplying} onClick={() => void applyStarterAlertPack()}>
              {starterPackApplying ? 'Applying...' : 'Apply Starter Pack'}
            </button>
          </div>
        </div>

        <div className="card alerts-list-card">
          <h3>Alert Definitions</h3>
          <div className="alert-governance-summary">
            <span><strong>Total:</strong> {alertGovernance.total}</span>
            <span><strong>Deep links:</strong> {alertGovernance.withDeepLink}/{alertGovernance.total}</span>
            <span><strong>Runbooks:</strong> {alertGovernance.withRunbook}/{alertGovernance.total}</span>
            <span><strong>Owner team:</strong> {alertGovernance.withOwnerTeam}/{alertGovernance.total}</span>
          </div>
          {alertsLoading && <p className="empty-card">Loading alerts...</p>}
          {!alertsLoading && alerts.length === 0 && <p className="empty-card">No alerts configured.</p>}
          {!alertsLoading && alerts.map((alert) => {
            const notify = parseAlertNotifyConfig(alert.notify_json);
            const params = parseAlertParamsConfig(alert.params_json);
            const workspaceHref = buildAlertWorkspaceHref(alert);
            const missing: string[] = [];
            if (!notify.deep_link) missing.push('deep-link');
            if (!notify.runbook_url) missing.push('runbook');
            if (!notify.owner_team) missing.push('owner-team');

            return (
              <div key={alert.id} className="alert-row">
                <div className="alert-main">
                  <div className="alert-name">{alert.name}</div>
                  <div className="alert-meta">
                    <span>{alert.type}</span>
                    <span>{alert.query_template}</span>
                    <span>every {alert.schedule_seconds}s</span>
                    <span className={alert.enabled ? '' : 'alert-status-disabled'}>{alert.enabled ? 'enabled' : 'disabled'}</span>
                    {notify.severity && <span className={`alert-severity-${notify.severity}`}>{notify.severity}</span>}
                    {params.window_minutes && <span>{params.window_minutes}m window</span>}
                    {params.token && <span>token: {params.token}</span>}
                    {params.service && <span>{params.service}</span>}
                    {params.env && <span>{params.env}</span>}
                    {params.index && <span>{params.index}</span>}
                  </div>
                  <div className="alert-governance">
                    {notify.owner_team && <span className="alert-governance-pill ok">team:{notify.owner_team}</span>}
                    {notify.runbook_url && <span className="alert-governance-pill ok">runbook attached</span>}
                    {notify.deep_link && <span className="alert-governance-pill ok">deep-link attached</span>}
                    {missing.length > 0 && (
                      <span className="alert-governance-pill missing">missing {missing.join(', ')}</span>
                    )}
                  </div>
                </div>
                <div className="alert-actions">
                  {workspaceHref && (
                    <a className="secondary alert-link-btn" href={workspaceHref}>Investigate</a>
                  )}
                  {notify.deep_link && (
                    <a className="secondary alert-link-btn" href={notify.deep_link}>Search</a>
                  )}
                  {notify.runbook_url && (
                    <a className="secondary alert-link-btn" href={notify.runbook_url} target="_blank" rel="noreferrer">Runbook</a>
                  )}
                  <button className="secondary" onClick={() => void toggleAlertEnabled(alert)}>
                    {alert.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="danger" onClick={() => void deleteAlert(alert.id)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
