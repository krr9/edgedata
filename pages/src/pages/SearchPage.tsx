import { Search } from 'lucide-react';
import type { RefObject } from 'react';
import { PivotChips } from '../investigation/PivotChips';
import { RelatedEventsPanel } from '../investigation/RelatedEventsPanel';
import { hasPivots, type InvestigationPivots, type PivotKey, type RelatedEvent } from '../investigation/types';
import { TIME_RANGE_PRESETS } from '../constants';
import type {
  DashboardRow,
  FacetItem,
  GuardrailExplanation,
  LogEvent,
  QuerySuggestionItem,
  SearchStats,
  SearchSummaryResponse
} from '../types';
import {
  attrsPreviewPairs,
  extractHighlightTerms,
  formatDateTime,
  highlightText,
  maxFacetCount,
  modeLabel
} from '../utils';

export interface FieldPresenceRow {
  key: keyof SearchSummaryResponse['field_presence'];
  label: string;
  count: number;
  percent: number;
  missing: number;
}

export interface FieldPresenceGroup {
  key: string;
  title: string;
  rows: FieldPresenceRow[];
  average: number;
}

export interface SearchPageProps {
  workspaceLaunchInfo: string | null;
  timeFrom: string;
  setTimeFrom: (value: string) => void;
  timeTo: string;
  setTimeTo: (value: string) => void;
  activeTimePreset: string | null;
  applyTimePreset: (fromOffsetMinutes: number, toOffsetMinutes: number, label: string) => void;
  showAdvancedFilters: boolean;
  setShowAdvancedFilters: (value: boolean) => void;
  activeAdvancedFilterCount: number;
  indexName: string;
  setIndexName: (value: string) => void;
  service: string;
  setService: (value: string) => void;
  environment: string;
  setEnvironment: (value: string) => void;
  host: string;
  setHost: (value: string) => void;
  level: string;
  setLevel: (value: string) => void;
  statusCode: string;
  setStatusCode: (value: string) => void;
  queryInputMode: 'search' | 'ask_ai';
  setQueryInputMode: (value: 'search' | 'ask_ai') => void;
  query: string;
  setQuery: (value: string) => void;
  queryFocused: boolean;
  setQueryFocused: (value: boolean) => void;
  querySuggestions: QuerySuggestionItem[];
  querySuggestionsOpen: boolean;
  querySuggestionsLoading: boolean;
  querySuggestionIndex: number;
  setQuerySuggestionIndex: (value: number | ((prev: number) => number)) => void;
  closeQuerySuggestions: () => void;
  applyQuerySuggestion: (item: QuerySuggestionItem) => void;
  runSearch: (options?: { append?: boolean; cursor?: { before_ts: string; before_event_id: string } | null }) => void;
  cancelOngoingSearch: () => void;
  loading: boolean;
  streamSearch: boolean;
  setStreamSearch: (value: boolean) => void;
  streaming: boolean;
  showSearchActions: boolean;
  setShowSearchActions: (value: boolean) => void;
  setShowSaveSearchInline: (value: boolean) => void;
  scheduleCurrentSearch: () => void;
  hasActiveAdvancedFilters: boolean;
  setActiveTimePreset: (value: string | null) => void;
  setQuerySuggestionsOpen?: (value: boolean) => void;
  setQueryFocused?: (value: boolean) => void;
  setCursor?: (value: { before_ts: string; before_event_id: string } | null) => void;
  queryTypeaheadRef: RefObject<HTMLDivElement | null>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchActionsRef: RefObject<HTMLDivElement | null>;
  assistantPlan: { intentLabel: string; confidence: string; generatedPpl: string; reasoning: string[]; passthrough: boolean };
  showSaveSearchInline: boolean;
  saveName: string;
  setSaveName: (value: string) => void;
  saveCurrentSearch: () => void;
  investigationPivots: InvestigationPivots;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  error: string | null;
  guardrailDetail: GuardrailExplanation | null;
  stats: SearchStats | null;
  summary?: SearchSummaryResponse | null;
  summaryLoading: boolean;
  results: LogEvent[];
  tableRows: DashboardRow[];
  resultType: 'events' | 'table';
  cursor: { before_ts: string; before_event_id: string } | null;
  hasCompletedSearch: boolean;
  levelTotals: { error: number; warn: number; info: number; debug: number };
  timeline: Array<{ minute: string; count: number }>;
  timelineStepMs: number;
  timelineMax: number;
  timelineAxisMarks: Array<{ key: string; label: string; align: string }>;
  facets: {
    indexes: FacetItem[];
    services: FacetItem[];
    levels: FacetItem[];
    statuses: FacetItem[];
    hosts: FacetItem[];
  };
  topTerms: FacetItem[];
  fieldPresenceSampleSize: number;
  fieldCoverageAverage: number;
  fieldCoverageQuality: string;
  fieldPresenceGroups: FieldPresenceGroup[];
  fieldCoverageFilter: { field: keyof SearchSummaryResponse['field_presence']; mode: 'present' | 'missing' } | null;
  summaryUnavailable: boolean;
  applyFacetFilter: (key: 'indexName' | 'service' | 'level' | 'host' | 'statusCode', value: string) => void;
  runPivot: (term: string) => void;
  runFieldCoverageQuery: (field: keyof SearchSummaryResponse['field_presence'], mode: 'present' | 'missing') => void;
  clearFieldCoverageFilter: () => void;
  handlePivotClick: (key: PivotKey, value: string) => void;
  handleSelectRelatedEvent: (event: RelatedEvent) => void;
  activeIndex: number;
  setActiveIndex: (value: number | ((prev: number) => number)) => void;
  setSelectedEvent: (event: LogEvent | null) => void;
  explorerLayoutRef: RefObject<HTMLDivElement | null>;
  explorerPanelHeight: number | null;
}

export function SearchPage(props: SearchPageProps) {
  const {
    workspaceLaunchInfo,
    timeFrom,
    setTimeFrom,
    timeTo,
    setTimeTo,
    activeTimePreset,
    applyTimePreset,
    showAdvancedFilters,
    setShowAdvancedFilters,
    activeAdvancedFilterCount,
    indexName,
    setIndexName,
    service,
    setService,
    environment,
    setEnvironment,
    host,
    setHost,
    level,
    setLevel,
    statusCode,
    setStatusCode,
    queryInputMode,
    setQueryInputMode,
    query,
    setQuery,
    querySuggestionsOpen,
    querySuggestions,
    querySuggestionsLoading,
    querySuggestionIndex,
    setQuerySuggestionIndex,
    closeQuerySuggestions,
    applyQuerySuggestion,
    runSearch,
    cancelOngoingSearch,
    loading,
    streamSearch,
    setStreamSearch,
    streaming,
    showSearchActions,
    setShowSearchActions,
    setShowSaveSearchInline,
    scheduleCurrentSearch,
    hasActiveAdvancedFilters,
    queryTypeaheadRef,
    searchInputRef,
    searchActionsRef,
    assistantPlan,
    showSaveSearchInline,
    saveName,
    setSaveName,
    saveCurrentSearch,
    investigationPivots,
    handlePivotClick,
    apiFetch,
    error,
    guardrailDetail,
    stats,
    summary,
    summaryLoading,
    results,
    tableRows,
    resultType,
    cursor,
    hasCompletedSearch,
    levelTotals,
    timeline,
    timelineStepMs,
    timelineMax,
    timelineAxisMarks,
    facets,
    topTerms,
    fieldPresenceSampleSize,
    fieldCoverageAverage,
    fieldCoverageQuality,
    fieldPresenceGroups,
    fieldCoverageFilter,
    summaryUnavailable,
    applyFacetFilter,
    runPivot,
    runFieldCoverageQuery,
    clearFieldCoverageFilter,
    handleSelectRelatedEvent,
    activeIndex,
    setActiveIndex,
    setSelectedEvent,
    explorerLayoutRef,
    explorerPanelHeight
  } = props;

  const highlightTerms = extractHighlightTerms(query);

  return (
    <div className="search-view">
      {workspaceLaunchInfo && <div className="success-banner">{workspaceLaunchInfo}</div>}
      <div className="search-bar sticky">
        <div className="search-filters search-filters-primary">
          <div className="filter-group">
            <label>Time Range</label>
            <div className="time-inputs">
              <input
                aria-label="Time range start"
                type="datetime-local"
                value={timeFrom}
                onChange={(event) => {
                  setTimeFrom(event.target.value);
                  props.setActiveTimePreset(null);
                }}
              />
              <span>to</span>
              <input
                aria-label="Time range end"
                type="datetime-local"
                value={timeTo}
                onChange={(event) => {
                  setTimeTo(event.target.value);
                  props.setActiveTimePreset(null);
                }}
              />
            </div>
            <div className="time-presets">
              {TIME_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={activeTimePreset === preset.label ? 'active' : ''}
                  onClick={() => applyTimePreset(preset.fromOffsetMinutes, preset.toOffsetMinutes, preset.label)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="search-top-actions">
            <button
              type="button"
              className="secondary"
              aria-expanded={showAdvancedFilters}
              onClick={() => setShowAdvancedFilters((value) => !value)}
            >
              {showAdvancedFilters ? 'Hide Filters' : `Advanced Filters${activeAdvancedFilterCount > 0 ? ` (${activeAdvancedFilterCount})` : ''}`}
            </button>
          </div>
        </div>

        {showAdvancedFilters && (
          <div className="search-filters search-filters-advanced">
            <div className="filter-group">
              <label>Index</label>
              <input type="text" value={indexName} onChange={(event) => setIndexName(event.target.value)} placeholder="all indexes" />
            </div>
            <div className="filter-group">
              <label>Service</label>
              <input type="text" value={service} onChange={(event) => setService(event.target.value)} placeholder="paymentservice" />
            </div>
            <div className="filter-group">
              <label>Env</label>
              <input type="text" value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder="demo" />
            </div>
            <div className="filter-group">
              <label>Host</label>
              <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="otel-demo-node-1" />
            </div>
            <div className="filter-group">
              <label>Level</label>
              <input type="text" value={level} onChange={(event) => setLevel(event.target.value)} placeholder="error" />
            </div>
            <div className="filter-group">
              <label>Status</label>
              <input type="number" value={statusCode} onChange={(event) => setStatusCode(event.target.value)} placeholder="500" />
            </div>
          </div>
        )}

        <div className="query-mode-toggle" role="group" aria-label="Search input mode">
          <button
            type="button"
            className={queryInputMode === 'search' ? 'active' : ''}
            aria-pressed={queryInputMode === 'search'}
            onClick={() => {
              setQueryInputMode('search');
              if (props.setQuerySuggestionsOpen) props.setQuerySuggestionsOpen(querySuggestions.length > 0);
            }}
          >
            Search
          </button>
          <button
            type="button"
            className={queryInputMode === 'ask_ai' ? 'active' : ''}
            aria-pressed={queryInputMode === 'ask_ai'}
            onClick={() => {
              setQueryInputMode('ask_ai');
              closeQuerySuggestions();
            }}
          >
            Ask AI
          </button>
        </div>

        <div className="search-input">
          <div className="query-input-wrapper" ref={queryTypeaheadRef}>
            <input
              ref={searchInputRef}
              aria-label={queryInputMode === 'ask_ai' ? 'Describe your question' : 'Search query'}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => {
                if (props.setQueryFocused) props.setQueryFocused(true);
                if (queryInputMode === 'search' && props.setQuerySuggestionsOpen) {
                  props.setQuerySuggestionsOpen(querySuggestions.length > 0);
                }
              }}
              onBlur={() => { if (props.setQueryFocused) props.setQueryFocused(false); }}
              placeholder={queryInputMode === 'ask_ai'
                ? 'Why is checkout latency high in otel-demo?'
                : 'search * | where index="otel-demo" | sort -ts | head 200'}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
                  event.preventDefault();
                  if (queryInputMode === 'search' && props.setQuerySuggestionsOpen) {
                    props.setQuerySuggestionsOpen(querySuggestions.length > 0);
                    setQuerySuggestionIndex(querySuggestions.length > 0 ? 0 : -1);
                  }
                  return;
                }
                if (queryInputMode === 'search' && querySuggestionsOpen && querySuggestions.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setQuerySuggestionIndex((index) => (index + 1) % querySuggestions.length);
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setQuerySuggestionIndex((index) => (index <= 0 ? querySuggestions.length - 1 : index - 1));
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeQuerySuggestions();
                    return;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    if (querySuggestionIndex >= 0 && querySuggestionIndex < querySuggestions.length) {
                      event.preventDefault();
                      applyQuerySuggestion(querySuggestions[querySuggestionIndex]);
                      return;
                    }
                  }
                }
                if (event.key === 'Enter') {
                  if (props.setCursor) props.setCursor(null);
                  setActiveIndex(-1);
                  closeQuerySuggestions();
                  void runSearch({ append: false, cursor: null });
                }
              }}
            />
            {queryInputMode === 'search' && querySuggestionsOpen && (
              <div className="query-typeahead-dropdown" role="listbox" aria-label="Search suggestions">
                {querySuggestionsLoading && (
                  <div className="query-typeahead-status">Loading suggestions...</div>
                )}
                {!querySuggestionsLoading && querySuggestions.length === 0 && (
                  <div className="query-typeahead-status">No suggestions yet.</div>
                )}
                {querySuggestions.map((item, index) => (
                  <button
                    key={`${item.kind}-${item.label}-${index}`}
                    type="button"
                    className={`query-typeahead-item ${index === querySuggestionIndex ? 'active' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyQuerySuggestion(item);
                    }}
                    onMouseEnter={() => setQuerySuggestionIndex(index)}
                  >
                    <span className="query-typeahead-row">
                      <strong>{item.label}</strong>
                      <span className="query-typeahead-kind">{item.kind}</span>
                    </span>
                    {item.detail && <span className="query-typeahead-detail">{item.detail}</span>}
                    {item.example && <span className="query-typeahead-example">{item.example}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => {
              if (props.setCursor) props.setCursor(null);
              setActiveIndex(-1);
              closeQuerySuggestions();
              void runSearch({ append: false, cursor: null });
            }}
            disabled={loading}
          >
            {loading ? (queryInputMode === 'ask_ai' ? 'Thinking...' : 'Searching...') : (queryInputMode === 'ask_ai' ? 'Ask AI' : 'Search')}
          </button>
          {loading && (
            <button type="button" className="secondary" onClick={cancelOngoingSearch}>
              Cancel
            </button>
          )}
          <label className="stream-toggle">
            <input
              type="checkbox"
              checked={streamSearch}
              onChange={(event) => setStreamSearch(event.target.checked)}
            />
            Stream
          </label>
          <div className="search-actions-anchor" ref={searchActionsRef}>
            <button
              type="button"
              className="secondary"
              aria-label="More search actions"
              onClick={() => setShowSearchActions((value) => !value)}
            >
              ...
            </button>
            {showSearchActions && (
              <div className="search-actions-menu">
                <button
                  className="secondary search-action-item"
                  type="button"
                  onClick={() => {
                    setShowSaveSearchInline(true);
                    setShowSearchActions(false);
                  }}
                >
                  <span className="action-icon" aria-hidden="true">S</span>
                  Save current search
                </button>
                {query.trim() && (
                  <button
                    className="secondary search-action-item"
                    type="button"
                    onClick={() => {
                      scheduleCurrentSearch();
                      setShowSearchActions(false);
                    }}
                  >
                    <span className="action-icon" aria-hidden="true">T</span>
                    Schedule current search
                  </button>
                )}
                {hasActiveAdvancedFilters && (
                  <button
                    className="secondary search-action-item"
                    type="button"
                    onClick={() => {
                      setIndexName('');
                      setService('');
                      setEnvironment('');
                      setHost('');
                      setLevel('');
                      setStatusCode('');
                      setShowAdvancedFilters(false);
                      setShowSearchActions(false);
                    }}
                  >
                    <span className="action-icon" aria-hidden="true">C</span>
                    Clear advanced filters
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {queryInputMode === 'ask_ai' && (
          <div className="ask-ai-plan">
            <div className="ask-ai-plan-header">
              <strong>{assistantPlan.intentLabel}</strong>
              <span className={`ask-ai-confidence ${assistantPlan.confidence}`}>{assistantPlan.confidence} confidence</span>
            </div>
            <p className="ask-ai-plan-summary">
              {assistantPlan.passthrough
                ? 'Ask AI detected direct PPL and will run it unchanged.'
                : 'Ask AI will compile this prompt into PPL and execute it in the current explorer.'}
            </p>
            <pre className="ask-ai-plan-query">{assistantPlan.generatedPpl}</pre>
            <div className="ask-ai-plan-reasons">
              {assistantPlan.reasoning.map((reason, index) => (
                <span key={`ask-ai-reason-${index}`}>{reason}</span>
              ))}
            </div>
          </div>
        )}

        {showSaveSearchInline && (
          <div className="save-search-row">
            <input
              type="text"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder="Saved search name"
            />
            <button className="secondary" type="button" onClick={() => void saveCurrentSearch()}>Save Search</button>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setShowSaveSearchInline(false);
                setSaveName('');
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {hasPivots(investigationPivots) && (
          <PivotChips pivots={investigationPivots} onPivotClick={handlePivotClick} />
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {guardrailDetail && (
        <div className="guardrail-banner" role="status" aria-live="polite">
          <div className="guardrail-title">{guardrailDetail.title}</div>
          <div className="guardrail-reason">{guardrailDetail.reason}</div>
          <div className="guardrail-suggestion"><strong>Try:</strong> {guardrailDetail.suggestion}</div>
        </div>
      )}

      {stats && (
        <div className="search-stats">
          {streaming && <span className="streaming-pill">Streaming results...</span>}
          {!streaming && summaryLoading && <span className="streaming-pill">Updating summary...</span>}
          <span><strong>Mode:</strong> {modeLabel(stats.mode)}</span>
          <span><strong>Lang:</strong> PPL</span>
          <span><strong>Returned:</strong> {stats.returned}</span>
          <span><strong>Partitions:</strong> {stats.scanned_partitions}</span>
          <span><strong>Objects:</strong> {stats.scanned_objects}</span>
          <span><strong>Indexes:</strong> {facets.indexes.length}</span>
          <span><strong>Services:</strong> {facets.services.length}</span>
          <span><strong>Hosts:</strong> {facets.hosts.length}</span>
          {stats.candidates > 0 && <span><strong>Candidates:</strong> {stats.candidates}</span>}
          {resultType === 'events' && <span><strong>Keys:</strong> j/k move, Enter open, Esc close</span>}
        </div>
      )}

      {!hasCompletedSearch && !loading && !error && !hasPivots(investigationPivots) ? (
        <section className="search-welcome card">
          <span className="search-welcome-icon" aria-hidden="true"><Search size={24} /></span>
          <h2>Start with a search</h2>
          <p>Choose a time range and run a query to explore your events. Use the query assistant to turn a question into a search you can review.</p>
          <span className="search-welcome-hint">Tip: press <kbd>Ctrl / ⌘ K</kbd> to jump to the query input.</span>
        </section>
      ) : (<>
      <div className="level-strip">
        <div className="pill error">Error {levelTotals.error}</div>
        <div className="pill warn">Warn {levelTotals.warn}</div>
        <div className="pill info">Info {levelTotals.info}</div>
        <div className="pill debug">Debug {levelTotals.debug}</div>
      </div>

      <div className="timeline-card card">
        <div className="timeline-head">
          <h4>Activity Timeline</h4>
          <span>
            {streaming
              ? 'Streaming...'
                : summary
                ? (summary?.truncated ? 'Sampled timeline' : 'Timeline')
                : results.length > 0
                  ? 'Timeline'
                  : summaryLoading
                    ? 'Updating summary...'
                    : 'Run a search to load summary'}
          </span>
        </div>
        <div className="timeline-bars">
          {timeline.length === 0 ? (
            <p className="facet-empty">No timeline data yet.</p>
          ) : (
            timeline.map((point) => (
              <div
                key={point.minute}
                className="timeline-col"
                title={`${formatDateTime(point.minute)} to ${formatDateTime(new Date(new Date(point.minute).getTime() + timelineStepMs).toISOString())} - ${point.count} events`}
              >
                <div className="timeline-bar" style={{ height: `${Math.max(8, (point.count / timelineMax) * 58)}px` }} />
              </div>
            ))
          )}
        </div>
        {timelineAxisMarks.length > 0 && (
          <div className="timeline-axis">
            {timelineAxisMarks.map((mark) => (
              <span key={mark.key} className={`timeline-axis-label ${mark.align}`}>{mark.label}</span>
            ))}
          </div>
        )}
      </div>

      {loading && results.length === 0 && !error ? (
        <div className="search-loading-state card" role="status" aria-live="polite">
          <div className="search-loading-header">
            <div className="search-loading-dot" aria-hidden="true" />
            <div>
              <h4>Searching logs...</h4>
              <p>
                {streamSearch
                  ? 'Streaming first matches as soon as they arrive.'
                  : 'Scanning partitions and preparing your results.'}
              </p>
            </div>
          </div>
          <div className="search-loading-meta">
            <span>
              <strong>Query:</strong>{' '}
              {query.trim()
                ? (query.trim().length > 90 ? `${query.trim().slice(0, 90)}...` : query.trim())
                : 'search *'}
            </span>
            <span>
              <strong>Window:</strong>{' '}
              {Number.isNaN(Date.parse(timeFrom)) || Number.isNaN(Date.parse(timeTo))
                ? 'Custom range'
                : `${formatDateTime(new Date(timeFrom).toISOString())} to ${formatDateTime(new Date(timeTo).toISOString())}`}
            </span>
            <span><strong>Tip:</strong> Use Cancel to stop long-running scans.</span>
          </div>
          <div className="search-loading-grid" aria-hidden="true">
            <div className="search-loading-col search-loading-col-facets">
              <div className="search-loading-col-title">Facets</div>
              <div className="search-loading-skeleton" />
              <div className="search-loading-skeleton short" />
              <div className="search-loading-skeleton" />
              <div className="search-loading-skeleton short" />
            </div>
            <div className="search-loading-col">
              <div className="search-loading-col-title">Results</div>
              <div className="search-loading-skeleton tall" />
              <div className="search-loading-skeleton" />
              <div className="search-loading-skeleton" />
              <div className="search-loading-skeleton short" />
            </div>
          </div>
        </div>
      ) : (
        <div
          className="explorer-layout"
          ref={explorerLayoutRef}
          style={explorerPanelHeight ? { height: `${explorerPanelHeight}px` } : undefined}
        >
          <aside className="facet-panel">
            <div className="facet-card">
              <h4>Indexes</h4>
              {facets.indexes.length === 0 && <p className="facet-empty">No data</p>}
              {facets.indexes.map((facet) => (
                <button key={`idx-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('indexName', facet.value)}>
                  <span>{facet.value}</span>
                  <div className="facet-right">
                    <strong>{facet.count}</strong>
                    <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.indexes)) * 100}%` }} /></div>
                  </div>
                </button>
              ))}
            </div>
            <div className="facet-card">
              <h4>Services</h4>
              {facets.services.length === 0 && <p className="facet-empty">No data</p>}
              {facets.services.map((facet) => (
                <button key={`svc-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('service', facet.value)}>
                  <span>{facet.value}</span>
                  <div className="facet-right">
                    <strong>{facet.count}</strong>
                    <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.services)) * 100}%` }} /></div>
                  </div>
                </button>
              ))}
            </div>
            <div className="facet-card">
              <h4>Levels</h4>
              {facets.levels.length === 0 && <p className="facet-empty">No data</p>}
              {facets.levels.map((facet) => (
                <button key={`lvl-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('level', facet.value)}>
                  <span>{facet.value}</span>
                  <div className="facet-right">
                    <strong>{facet.count}</strong>
                    <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.levels)) * 100}%` }} /></div>
                  </div>
                </button>
              ))}
            </div>
            <div className="facet-card">
              <h4>Status</h4>
              {facets.statuses.length === 0 && <p className="facet-empty">No data</p>}
              {facets.statuses.map((facet) => (
                <button key={`status-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('statusCode', facet.value)}>
                  <span>{facet.value}</span>
                  <div className="facet-right">
                    <strong>{facet.count}</strong>
                    <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.statuses)) * 100}%` }} /></div>
                  </div>
                </button>
              ))}
            </div>
            <div className="facet-card">
              <h4>Hosts</h4>
              {facets.hosts.length === 0 && <p className="facet-empty">No data</p>}
              {facets.hosts.map((facet) => (
                <button key={`host-${facet.value}`} className="facet-item" onClick={() => applyFacetFilter('host', facet.value)}>
                  <span>{facet.value}</span>
                  <div className="facet-right">
                    <strong>{facet.count}</strong>
                    <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(facets.hosts)) * 100}%` }} /></div>
                  </div>
                </button>
              ))}
            </div>
            <div className="facet-card">
              <h4>Top Terms</h4>
              {topTerms.length === 0 && <p className="facet-empty">No data</p>}
              {topTerms.map((facet) => (
                <button key={`term-${facet.value}`} className="facet-item" onClick={() => runPivot(facet.value)}>
                  <span>{facet.value}</span>
                  <div className="facet-right">
                    <strong>{facet.count}</strong>
                    <div className="facet-track"><div className="facet-bar" style={{ width: `${(facet.count / maxFacetCount(topTerms)) * 100}%` }} /></div>
                  </div>
                </button>
              ))}
            </div>
            {hasPivots(investigationPivots) && (
              <RelatedEventsPanel
                apiFetch={apiFetch}
                scope={{
                  index: indexName.trim() || 'default',
                  service: service.trim() || 'unknown',
                  env: environment.trim() || 'prod'
                }}
                time={{
                  from: new Date(timeFrom).toISOString(),
                  to: new Date(timeTo).toISOString()
                }}
                pivots={investigationPivots}
                onSelectRelatedEvent={handleSelectRelatedEvent}
              />
            )}
            <div className="facet-card">
              <h4>Field Coverage</h4>
              <p className="field-coverage-subtitle">
                {fieldPresenceSampleSize > 0
                  ? `Coverage across ${fieldPresenceSampleSize} event${fieldPresenceSampleSize === 1 ? '' : 's'}`
                  : 'Run a search to calculate field coverage'}
              </p>
              <div className="field-coverage-kpis">
                <div className="field-coverage-kpi">
                  <span className="field-coverage-kpi-label">Overall</span>
                  <strong>{fieldCoverageAverage}%</strong>
                </div>
                <div className="field-coverage-kpi">
                  <span className="field-coverage-kpi-label">Quality</span>
                  <strong>{fieldCoverageQuality}</strong>
                </div>
              </div>
              {summaryUnavailable && (
                <p className="field-coverage-warning">
                  Summary endpoint unavailable (404). Showing coverage from loaded results only.
                </p>
              )}
              {fieldCoverageFilter && (
                <div className="field-coverage-filter-chip">
                  <span>
                    Applied filter: {fieldCoverageFilter.field} {fieldCoverageFilter.mode === 'present' ? 'present' : 'missing'}
                  </span>
                  <button type="button" onClick={clearFieldCoverageFilter}>Clear</button>
                </div>
              )}
              <div className="field-presence-list">
                {fieldPresenceGroups.map((group) => (
                  <details key={group.key} className="field-coverage-group" open>
                    <summary className="field-coverage-group-summary">
                      <span>{group.title}</span>
                      <strong>{group.average}%</strong>
                    </summary>
                    {group.rows.map((row) => (
                      <div key={row.key} className={`field-presence-row coverage-${row.percent >= 80 ? 'strong' : row.percent >= 50 ? 'mixed' : 'sparse'}`}>
                        <div className="field-coverage-topline">
                          <button
                            type="button"
                            className="field-coverage-action field-label-action"
                            onClick={() => runFieldCoverageQuery(row.key, 'present')}
                            title={`Filter to events where ${row.key} is present`}
                          >
                            {row.label}
                          </button>
                          <strong>{row.percent}%</strong>
                        </div>
                        <div className="field-coverage-track">
                          <div className="field-coverage-bar" style={{ width: `${row.percent}%` }} />
                        </div>
                        <div className="field-coverage-footnote">
                          <span>{row.count} present</span>
                          {fieldPresenceSampleSize > 0 && (
                            <button
                              type="button"
                              className="field-coverage-action field-missing-action"
                              onClick={() => runFieldCoverageQuery(row.key, 'missing')}
                              title={`Filter to events where ${row.key} is missing`}
                            >
                              {row.missing} missing
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </details>
                ))}
                {fieldPresenceGroups.length === 0 && (
                  <div className="field-presence-row">
                    <div className="field-coverage-topline">
                      <span>No field coverage data yet</span>
                      <strong>0%</strong>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="events-panel">
            {resultType === 'events' && hasCompletedSearch && results.length === 0 && !loading && !error && (
              <div className="empty-state card">
                <p>No results found. Adjust time range, filters, or PPL query.</p>
              </div>
            )}
            {resultType === 'table' ? (
              <div className="card tabular-results">
                {tableRows.length === 0 ? (
                  <p className="empty-card">No tabular rows returned.</p>
                ) : (
                  <table className="tabular-results-table">
                    <thead>
                      <tr>
                        {Object.keys(tableRows[0]).map((key) => (
                          <th key={key}>{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((row, index) => (
                        <tr key={`row-${index}`}>
                          {Object.keys(tableRows[0]).map((key) => (
                            <td key={`${index}-${key}`}>
                              {String(row[key] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <div className="event-feed">
                {results.map((event, index) => {
                  const preview = event.message.length > 340 ? `${event.message.slice(0, 340)}...` : event.message;
                  const attrPairs = attrsPreviewPairs(event.attrs_json);
                  return (
                    <article
                      key={event.event_id}
                      data-event-index={index}
                      className={`event-card level-${event.level} ${index === activeIndex ? 'active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        setActiveIndex(index);
                        setSelectedEvent(event);
                      }}
                    >
                      <header className="event-head">
                        <div className="event-time">{formatDateTime(event.ts)}</div>
                        <div className="event-service">{event.service}</div>
                        <span className={`badge ${event.level}`}>{event.level}</span>
                      </header>
                      <div className="event-message">{highlightText(preview, highlightTerms)}</div>
                      <footer className="event-meta">
                        <span className="meta-chip">idx:{event.index || 'default'}</span>
                        <span className="meta-chip">env:{event.env}</span>
                        <span className="meta-chip">host:{event.host}</span>
                        {event.status !== undefined && <span className="meta-chip">status:{event.status}</span>}
                        {event.duration_ms !== undefined && <span className="meta-chip">dur:{event.duration_ms}ms</span>}
                        {event.trace_id && <span className="meta-chip">trace:{event.trace_id.slice(0, 16)}</span>}
                        {event.span_id && <span className="meta-chip">span:{event.span_id.slice(0, 16)}</span>}
                        {event.request_id && <span className="meta-chip">req:{event.request_id.slice(0, 16)}</span>}
                        {attrPairs.map((pair) => (
                          <span key={`${event.event_id}-${pair.key}`} className="meta-chip attr-chip">
                            {pair.key}:{pair.value}
                          </span>
                        ))}
                      </footer>
                    </article>
                  );
                })}
              </div>
            )}
            {resultType === 'events' && cursor && results.length > 0 && (
              <button className="load-more" disabled={loading} onClick={() => void runSearch({ append: true, cursor })}>
                {loading ? 'Loading...' : 'Load More'}
              </button>
            )}
          </section>
        </div>
      )}
      </>)}
    </div>
  );
}
