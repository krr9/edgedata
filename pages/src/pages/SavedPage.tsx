import type { SavedSearch } from '../types';

export interface SavedPageProps {
  savedError: string | null;
  savedLoading: boolean;
  savedSearches: SavedSearch[];
  applySavedSearch: (saved: SavedSearch) => void;
  deleteSavedSearch: (id: string) => void;
}

export function SavedPage({
  savedError,
  savedLoading,
  savedSearches,
  applySavedSearch,
  deleteSavedSearch
}: SavedPageProps) {
  return (
    <div className="saved-view">
      {savedError && <div className="error-banner">{savedError}</div>}
      {savedLoading && <div className="empty-state"><p>Loading saved searches...</p></div>}

      {!savedLoading && (
        <div className="saved-list card">
          <h3>Saved Searches</h3>
          {savedSearches.length === 0 && <p className="empty-card">No saved searches yet.</p>}

          {savedSearches.map((saved) => (
            <div key={saved.id} className="saved-row">
              <div>
                <div className="saved-name">{saved.name}</div>
                <div className="saved-query">{saved.query}</div>
              </div>
              <div className="saved-actions">
                <button className="secondary" onClick={() => applySavedSearch(saved)}>Apply</button>
                <button className="danger" onClick={() => void deleteSavedSearch(saved.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
