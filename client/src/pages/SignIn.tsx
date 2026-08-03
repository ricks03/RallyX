import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import { useSession } from '../App.js';

type Mode = 'signIn' | 'register';

export function SignIn() {
  const { me, loading, refresh } = useSession();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="content"><p className="eyebrow">Loading</p></div>;
  if (me) return <Navigate to="/" replace />;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') {
        await api.register(username, password);
      }
      await api.login(username, password);
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = username.length >= 3 && password.length >= 8 && !busy;

  return (
    <div className="gate">
      <div className="gate-panel plate">
        <div className="hazard hazard-rule" role="presentation" />
        <div className="gate-body">
          <div>
            <p className="eyebrow">Factory floor access</p>
            <h1 className="gate-title">Robo<br />Rally</h1>
          </div>

          <div className="stack" style={{ gap: '0.85rem' }}>
            <div>
              <label htmlFor="username">Name</label>
              <input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }}
              />
            </div>
            <div>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }}
              />
              {mode === 'register' && (
                <p className="mono muted" style={{ fontSize: '0.8125rem', marginTop: '0.4rem' }}>
                  Eight characters or more.
                </p>
              )}
            </div>
          </div>

          {error && <p className="notice">{error}</p>}

          <button onClick={() => void submit()} disabled={!canSubmit}>
            {mode === 'register' ? 'Create account' : 'Sign in'}
          </button>

          <button
            className="secondary"
            onClick={() => { setMode(mode === 'signIn' ? 'register' : 'signIn'); setError(null); }}
          >
            {mode === 'signIn' ? 'Create an account' : 'I already have an account'}
          </button>
        </div>
      </div>
    </div>
  );
}
