import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { API_BASE, API_BASE_MISSING_ERROR, API_PROXY_BASE } from './constants';
import { EdgeDataLogo } from './components/EdgeDataLogo';

const INVITE_TOKEN_PARAM = 'invite_token';

function readInviteTokenFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);
  return hashParams.get(INVITE_TOKEN_PARAM)?.trim() || url.searchParams.get(INVITE_TOKEN_PARAM)?.trim() || '';
}

function clearInviteTokenFromLocation(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const hadHashToken = hashParams.has(INVITE_TOKEN_PARAM);
  const hadSearchToken = url.searchParams.has(INVITE_TOKEN_PARAM);
  if (!hadHashToken && !hadSearchToken) return;

  hashParams.delete(INVITE_TOKEN_PARAM);
  url.searchParams.delete(INVITE_TOKEN_PARAM);
  url.hash = hashParams.toString() ? `#${hashParams.toString()}` : '';
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function AuthScreen() {
  const { login, loading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [invitePasswordConfirm, setInvitePasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);

  useEffect(() => {
    const tokenFromUrl = readInviteTokenFromLocation();
    if (!tokenFromUrl) return;
    setInviteToken(tokenFromUrl);
    setError('');
    clearInviteTokenFromLocation();
  }, []);

  const isInviteFlow = !!inviteToken.trim();

  const startAccessBootstrap = () => {
    setError('');
    setInfo('');
    if (!API_BASE) {
      setError(API_BASE_MISSING_ERROR);
      return;
    }

    setSsoLoading(true);
    const returnToUrl = new URL(window.location.href);
    returnToUrl.searchParams.set('access', '1');
    const returnTo = returnToUrl.toString();
    window.location.assign(`${API_BASE}/auth/access/start?return_to=${encodeURIComponent(returnTo)}`);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);

    const result = await login(email, password);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    }
  };

  const handleSsoStart = () => {
    startAccessBootstrap();
  };

  const handleInviteAccept = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!inviteToken.trim()) {
      setError('Open the full invite link from your email to continue.');
      return;
    }
    if (invitePassword.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    if (invitePassword !== invitePasswordConfirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const payload = new URLSearchParams();
      payload.set('token', inviteToken.trim());
      payload.set('password', invitePassword);
      const response = await fetch(`${API_PROXY_BASE}/auth/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString(),
        credentials: 'include'
      });
      const body = await response.json() as { error?: string; email?: string };
      if (!response.ok || body.error) {
        setError(body.error || 'Failed to accept invite');
        return;
      }
      setEmail(body.email || '');
      setInviteToken('');
      setInvitePassword('');
      setInvitePasswordConfirm('');
      setInfo(`Invite accepted for ${body.email || 'user'}. Sign in to continue.`);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="auth-screen">
        <div className="auth-loading">Loading...</div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <EdgeDataLogo size={40} />
        </div>
        <h1 className="auth-heading">{isInviteFlow ? 'Join your workspace' : 'Welcome back'}</h1>
        <p className="auth-subtitle">{isInviteFlow ? 'Set up your account to get started.' : 'Sign in to your EdgeData workspace.'}</p>

        {info && <div className="auth-info">{info}</div>}
        {error && <div className="auth-error">{error}</div>}

        {!isInviteFlow ? (
          <form onSubmit={handleSubmit}>
            <button type="button" className="auth-secondary" disabled={ssoLoading || loading} onClick={handleSsoStart}>
              {ssoLoading ? 'Redirecting to Access...' : 'Continue with Cloudflare Access'}
            </button>
            <div className="auth-divider"><span>or</span></div>

            <div className="auth-field">
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="auth-field">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <button type="submit" className="auth-submit" disabled={loading || ssoLoading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleInviteAccept}>
            <div className="auth-invite-summary">
              Invite link detected. Set your password to finish joining EdgeData.
            </div>
            <div className="auth-field">
              <label htmlFor="auth-invite-password">New password</label>
              <input
                id="auth-invite-password"
                type="password"
                autoComplete="new-password"
                value={invitePassword}
                onChange={(e) => setInvitePassword(e.target.value)}
                required
                minLength={10}
                autoFocus
              />
            </div>
            <div className="auth-field">
              <label htmlFor="auth-invite-password-confirm">Confirm password</label>
              <input
                id="auth-invite-password-confirm"
                type="password"
                autoComplete="new-password"
                value={invitePasswordConfirm}
                onChange={(e) => setInvitePasswordConfirm(e.target.value)}
                required
                minLength={10}
              />
            </div>
            <button type="submit" className="auth-submit" disabled={loading}>
              {loading ? 'Accepting...' : 'Accept Invite'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
