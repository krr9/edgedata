import { useState } from 'react';
import type {
  ScheduledSearchItem,
  ScheduledSearchResult,
  ScheduledSearchRunDetail,
  ScheduledSearchRunResultsPayload
} from '../types';
import { formatDateTime } from '../utils';

export interface ScheduledPageProps {
  scheduledError: string | null;
  scheduledLoading: boolean;
  scheduledSearches: ScheduledSearchItem[];
  scheduledResults: Record<string, ScheduledSearchResult[]>;
  scheduledRunDetails: Record<string, ScheduledSearchRunDetail>;
  scheduledRunResults: Record<string, ScheduledSearchRunResultsPayload>;
  scheduledActiveRunBySearch: Record<string, string>;
  scheduledRunLoading: Record<string, boolean>;
  scheduledRunTriggering: Record<string, boolean>;
  showScheduleForm: boolean;
  setShowScheduleForm: (value: boolean | ((prev: boolean) => boolean)) => void;
  scheduleFormName: string;
  setScheduleFormName: (value: string) => void;
  scheduleFormPpl: string;
  setScheduleFormPpl: (value: string) => void;
  scheduleFormCron: string;
  setScheduleFormCron: (value: string) => void;
  scheduleFormWindow: number;
  setScheduleFormWindow: (value: number) => void;
  createScheduledSearch: () => void;
  deleteScheduledSearch: (id: string) => void;
  toggleScheduledSearch: (id: string, enabled: boolean) => void;
  loadScheduledResults: (id: string) => void;
  loadScheduledRunDetail: (searchId: string, runId: string) => void;
  loadScheduledRunResults: (searchId: string, runId: string) => void;
  runScheduledSearch: (id: string) => void;
  setScheduledResults: React.Dispatch<React.SetStateAction<Record<string, ScheduledSearchResult[]>>>;
  setScheduledActiveRunBySearch: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

export function ScheduledPage({
  scheduledError,
  scheduledLoading,
  scheduledSearches,
  scheduledResults,
  scheduledRunDetails,
  scheduledRunResults,
  scheduledActiveRunBySearch,
  scheduledRunLoading,
  scheduledRunTriggering,
  showScheduleForm,
  setShowScheduleForm,
  scheduleFormName,
  setScheduleFormName,
  scheduleFormPpl,
  setScheduleFormPpl,
  scheduleFormCron,
  setScheduleFormCron,
  scheduleFormWindow,
  setScheduleFormWindow,
  createScheduledSearch,
  deleteScheduledSearch,
  toggleScheduledSearch,
  loadScheduledResults,
  loadScheduledRunDetail,
  loadScheduledRunResults,
  runScheduledSearch,
  setScheduledResults,
  setScheduledActiveRunBySearch
}: ScheduledPageProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const pendingDelete = confirmDeleteId ? scheduledSearches.find(s => s.id === confirmDeleteId) : null;

  return (
    <div className="saved-view">
      {scheduledError && <div className="error-banner">{scheduledError}</div>}

      <div className="saved-list card">
        <div className="scheduled-header">
          <h3>Scheduled Searches</h3>
          <button onClick={() => setShowScheduleForm(f => !f)}>{showScheduleForm ? 'Cancel' : '+ New'}</button>
        </div>

        {showScheduleForm && (
          <div className="scheduled-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowScheduleForm(false); }}>
            <div className="scheduled-modal">
              <div className="scheduled-modal-header">
                <h3>New Scheduled Search</h3>
                <button className="scheduled-modal-close" onClick={() => setShowScheduleForm(false)}>&times;</button>
              </div>
              <div className="scheduled-modal-body">
                <label className="scheduled-field-label">Name</label>
                <input type="text" value={scheduleFormName} onChange={e => setScheduleFormName(e.target.value)} placeholder="e.g. Error Rate Check" />
                <label className="scheduled-field-label">PPL Query</label>
                <input type="text" value={scheduleFormPpl} onChange={e => setScheduleFormPpl(e.target.value)} placeholder='search * | where level="error" | stats count() by service' />
                <div className="scheduled-form-row">
                  <div className="scheduled-field-group">
                    <label className="scheduled-field-label">Cron Schedule</label>
                    <input type="text" value={scheduleFormCron} onChange={e => setScheduleFormCron(e.target.value)} placeholder="*/30 * * * *" />
                  </div>
                  <div className="scheduled-field-group">
                    <label className="scheduled-field-label">Window (minutes)</label>
                    <input type="number" value={scheduleFormWindow} onChange={e => setScheduleFormWindow(Number(e.target.value) || 60)} placeholder="60" />
                  </div>
                </div>
              </div>
              <div className="scheduled-modal-footer">
                <button className="secondary" onClick={() => setShowScheduleForm(false)}>Cancel</button>
                <button onClick={() => void createScheduledSearch()}>Create</button>
              </div>
            </div>
          </div>
        )}

        {scheduledLoading && <p className="empty-card">Loading...</p>}

        {!scheduledLoading && scheduledSearches.length === 0 && <p className="empty-card">No scheduled searches yet.</p>}

        {scheduledSearches.map((ss) => (
          <div key={ss.id} className="saved-row scheduled-row">
            <div className="scheduled-row-top">
              <div className="scheduled-row-main">
                <div className="saved-name">
                  {ss.name}
                  <span className={`status-badge ${ss.enabled ? 'active' : 'disabled'}`}>
                    {ss.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="scheduled-meta-inline">
                    {ss.schedule_cron} · {ss.time_window_minutes}m window
                  </span>
                </div>
                <div className="saved-query">{ss.ppl}</div>
              </div>
              <div className="saved-actions">
                <button
                  className="secondary"
                  disabled={scheduledRunTriggering[ss.id]}
                  onClick={() => void runScheduledSearch(ss.id)}
                >
                  {scheduledRunTriggering[ss.id] ? 'Running...' : 'Run Now'}
                </button>
                <button className="secondary" onClick={() => { void toggleScheduledSearch(ss.id, !ss.enabled); }}>
                  {ss.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    if (scheduledResults[ss.id]) {
                      setScheduledResults((prev) => {
                        const next = { ...prev };
                        delete next[ss.id];
                        return next;
                      });
                      setScheduledActiveRunBySearch((prev) => {
                        const next = { ...prev };
                        delete next[ss.id];
                        return next;
                      });
                      return;
                    }
                    void loadScheduledResults(ss.id);
                  }}
                >
                  {scheduledResults[ss.id] ? 'Hide Runs' : 'Results'}
                </button>
                <button className="danger" onClick={() => setConfirmDeleteId(ss.id)}>Delete</button>
              </div>
            </div>

            {scheduledResults[ss.id] && (
              <div className="scheduled-runs">
                <div className="scheduled-runs-header">
                  <strong>Recent runs</strong>
                  <span>{scheduledResults[ss.id].slice(0, 5).length} shown</span>
                </div>
                {scheduledResults[ss.id].length === 0 && <span className="scheduled-runs-empty">No runs yet</span>}
                <div className="scheduled-run-list">
                  {scheduledResults[ss.id].slice(0, 5).map((r) => (
                    <div key={r.id} className="scheduled-run-card">
                      <div className="scheduled-run-row">
                        <span className="scheduled-run-time">{formatDateTime(r.run_at)}</span>
                        <span className={`scheduled-run-status status-${r.status === 'success' ? 'success' : 'error'}`}>
                          {r.status}
                        </span>
                        <span className="scheduled-run-count">{r.result_count} results</span>
                        <span className="scheduled-run-summary-text">
                          {r.summary?.headline || (r.error_message || 'Run completed')}
                        </span>
                      </div>
                      <div className="scheduled-run-subrow">
                        <span>{formatDateTime(r.time_from)} to {formatDateTime(r.time_to)}</span>
                        <span>{r.trigger_type || 'schedule'}</span>
                        {r.requested_by && <span>{r.requested_by}</span>}
                      </div>
                      {r.error_message && <span className="scheduled-run-error">{r.error_message}</span>}
                      <div className="scheduled-run-actions">
                        <button
                          className="secondary"
                          disabled={scheduledRunLoading[r.id]}
                          onClick={() => {
                            void Promise.all([
                              loadScheduledRunDetail(ss.id, r.id),
                              loadScheduledRunResults(ss.id, r.id)
                            ]);
                          }}
                        >
                          {scheduledRunLoading[r.id] ? 'Loading...' : 'View Run'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {scheduledActiveRunBySearch[ss.id] && scheduledRunDetails[scheduledActiveRunBySearch[ss.id]] && (
                  <div className="scheduled-run-detail">
                    {(() => {
                      const activeRunId = scheduledActiveRunBySearch[ss.id];
                      const detail = scheduledRunDetails[activeRunId];
                      const runPayload = scheduledRunResults[activeRunId];
                      const rows = runPayload?.results || detail.preview || [];
                      const columnKeys = rows.length > 0 ? Object.keys(rows[0]).slice(0, 6) : [];
                      return (
                        <>
                          <div className="scheduled-run-detail-header">
                            <div>
                              <strong>{detail.summary?.headline || 'Run detail'}</strong>
                              <div className="scheduled-run-subrow">
                                <span>{formatDateTime(detail.run_at)}</span>
                                <span>{detail.status}</span>
                                <span>{detail.result_count} results</span>
                              </div>
                            </div>
                            {detail.artifact && (
                              <span className="scheduled-run-artifact-meta">
                                Artifact expires {formatDateTime(detail.artifact.expires_at)}
                              </span>
                            )}
                          </div>
                          <div className="scheduled-run-subrow">
                            <span>Window: {formatDateTime(detail.time_from)} to {formatDateTime(detail.time_to)}</span>
                            {runPayload?.partial && <span>Preview only</span>}
                            {detail.query_request?.time && <span>On-demand result view ready</span>}
                          </div>
                          {detail.error_message && <div className="scheduled-run-error">{detail.error_message}</div>}
                          {rows.length === 0 ? (
                            <p className="scheduled-runs-empty">No rows captured for this run.</p>
                          ) : (
                            <div className="scheduled-run-preview">
                              <table>
                                <thead>
                                  <tr>
                                    {columnKeys.map((key) => (
                                      <th key={key}>{key}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.slice(0, 10).map((row, rowIndex) => (
                                    <tr key={`${activeRunId}-${rowIndex}`}>
                                      {columnKeys.map((key) => (
                                        <td key={`${activeRunId}-${rowIndex}-${key}`}>{String(row[key] ?? '')}</td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {pendingDelete && (
        <div className="scheduled-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}>
          <div className="scheduled-modal scheduled-modal-narrow">
            <div className="scheduled-modal-header">
              <h3>Delete Scheduled Search</h3>
              <button className="scheduled-modal-close" onClick={() => setConfirmDeleteId(null)}>&times;</button>
            </div>
            <div className="scheduled-modal-body">
              <p className="confirm-delete-text">
                Are you sure you want to delete <strong>{pendingDelete.name}</strong>? This will also remove all run history. This action cannot be undone.
              </p>
            </div>
            <div className="scheduled-modal-footer">
              <button className="secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="danger" onClick={() => { void deleteScheduledSearch(pendingDelete.id); setConfirmDeleteId(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
