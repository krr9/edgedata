import { useCallback, useEffect, useState } from 'react';
import type { InvestigationPivots } from './types';

export interface WorkspaceState {
  scope: { index: string; service: string; env: string };
  time?: { from: string; to: string };
  pivots?: InvestigationPivots;
  [key: string]: unknown;
}

interface SessionShareBarProps {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  scope: { index: string; service: string; env: string };
  state: WorkspaceState;
  sessionIdFromUrl: string | null;
  onRestore: (state: WorkspaceState) => void;
}

export function SessionShareBar({
  apiFetch,
  scope,
  state,
  sessionIdFromUrl,
  onRestore
}: SessionShareBarProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSession = useCallback(
    async (id: string) => {
      setLoadingSession(true);
      setLoadError(null);
      try {
        const response = await apiFetch(`/investigations/session/${id}`);
        const body = (await response.json()) as {
          scope_json?: string;
          state_json?: string;
          error?: string;
        };
        if (!response.ok || body.error) {
          setLoadError(body.error || 'Failed to load session');
          return;
        }
        const loadedScope = body.scope_json
          ? (JSON.parse(body.scope_json) as { index?: string; service?: string; env?: string })
          : {};
        const loadedState = body.state_json
          ? (JSON.parse(body.state_json) as WorkspaceState)
          : {};
        onRestore({
          scope: {
            index: loadedScope.index || 'default',
            service: loadedScope.service || 'unknown',
            env: loadedScope.env || 'prod'
          },
          ...loadedState
        });
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Request failed');
      } finally {
        setLoadingSession(false);
      }
    },
    [apiFetch, onRestore]
  );

  useEffect(() => {
    if (sessionIdFromUrl && !loadingSession && !loadError) {
      void loadSession(sessionIdFromUrl);
    }
  }, [sessionIdFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setShareLink(null);
    try {
      const response = await apiFetch('/investigations/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          state,
          source_type: 'workspace'
        })
      });
      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || body.error) {
        setSaveError(body.error || 'Failed to save session');
        return;
      }
      const id = body.id;
      if (id) {
        const link = `${window.location.origin}${window.location.pathname}?session=${id}`;
        setShareLink(link);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, scope, state]);

  const handleCopy = useCallback(() => {
    if (!shareLink) return;
    void navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shareLink]);

  return (
    <div className="session-share-bar">
      {loadError && <div className="session-share-error error-banner">{loadError}</div>}
      {loadingSession && <span className="session-share-loading">Loading session…</span>}
      <div className="session-share-actions">
        <button
          className="secondary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save & Share'}
        </button>
        {saveError && <span className="session-share-error-text">{saveError}</span>}
        {shareLink && (
          <div className="session-share-link">
            <input readOnly value={shareLink} className="session-share-input" />
            <button className="secondary" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
