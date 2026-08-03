import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError } from './api.js';
import type { Me } from './api.js';
import { SignIn } from './pages/SignIn.js';
import { Lobby } from './pages/Lobby.js';
import { GameLobby } from './pages/GameLobby.js';

interface Session {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session>({
  me: null, loading: true,
  refresh: async () => undefined,
  signOut: async () => undefined,
});

export const useSession = () => useContext(SessionContext);

function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (err) {
      // A 401 here is the ordinary "not signed in" case, not a failure.
      if (!(err instanceof ApiError) || err.status !== 401) console.error(err);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setMe(null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <SessionContext.Provider value={{ me, loading, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

function Masthead() {
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  if (!me) return null;

  return (
    <>
      <header className="masthead">
        <span className="wordmark">RoboRally</span>
        <div className="row">
          <span className="mono muted">{me.username}</span>
          <button
            className="secondary"
            onClick={async () => { await signOut(); navigate('/sign-in'); }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="hazard hazard-thin" role="presentation" />
    </>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  if (loading) {
    return <div className="content"><p className="eyebrow">Loading</p></div>;
  }
  return me ? <>{children}</> : <Navigate to="/sign-in" replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <div className="shell">
          <Masthead />
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route
              path="/"
              element={<RequireSession><Lobby /></RequireSession>}
            />
            <Route
              path="/games/:gameId"
              element={<RequireSession><GameLobby /></RequireSession>}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </SessionProvider>
    </BrowserRouter>
  );
}
