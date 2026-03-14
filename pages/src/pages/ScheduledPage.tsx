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
  return (
    <div className="saved-view">
      {scheduledError && <div className="error-banner">{scheduledError}</div>}

      <div className="saved-list card">
        <div className="scheduled-header">
          <h3>Scheduled Searches</h3>
          <button onClick={() => setShowScheduleForm(f => !f)}>{showScheduleForm ? 'Cancel' : '+ New'}</button>
        </div>

        {showScheduleForm && (
          <div className="card scheduled-form-card">
            <input type="text" value={scheduleFormName} onChange={e => setScheduleFormName(e.target.value)} placeholder="Search name" />
            <input type="text" value={scheduleFormPpl} onChange={e => setScheduleFormPpl(e.target.value)} placeholder="PPL query (e.g. search * | where level=&quot;error&quot; | stats count() by service)" />
            <div className="scheduled-form-row">
              <input type="text" value={scheduleFormCron} onChange={e => setScheduleFormCron(e.target.value)} placeholder="Cron (0 * * * *)" className="scheduled-form-cron" />
              <input type="number" value={scheduleFormWindow} onChange={e => setScheduleFormWindow(Number(e.target.value) || 60)} placeholder="Window (min)" className="scheduled-form-window" />
            </div>
            <button onClick={() => void createScheduledSearch()}>Create Scheduled Search</button>
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
                <button className="danger" onClick={() => void deleteScheduledSearch(ss.id)}>Delete</button>
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
    </div>
  );
}
