-- 014: Scheduled search run artifacts and richer execution metadata

ALTER TABLE scheduled_search_results ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'schedule';
ALTER TABLE scheduled_search_results ADD COLUMN requested_by TEXT;
ALTER TABLE scheduled_search_results ADD COLUMN query_request_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_search_results ADD COLUMN preview_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE scheduled_search_results ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_search_results ADD COLUMN materialized_result_id TEXT;
ALTER TABLE scheduled_search_results ADD COLUMN comparison_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_search_results ADD COLUMN started_at TEXT;
ALTER TABLE scheduled_search_results ADD COLUMN completed_at TEXT;
ALTER TABLE scheduled_search_results ADD COLUMN baseline_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sched_results_status_run
  ON scheduled_search_results(scheduled_search_id, status, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_sched_results_materialized
  ON scheduled_search_results(materialized_result_id);
