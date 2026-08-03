import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import type { PlayerRow } from '../api.js';
import { useSession } from '../App.js';

/**
 * The waiting room for one game: who has joined, which docking bay they
 * take, and the control to begin. Seats are the real ordering the engine
 * uses, so they are shown as the bay numbers they are.
 */
export function GameLobby() {
  const { gameId } = useParams();
  const id = Number(gameId);
  const navigate = useNavigate();
  const { me } = useSession();

  const [players, setPlayers] = useState<PlayerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.players(id);
      setPlayers(result.players);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const status = players?.[0]?.status;
  const createdBy = players?.[0]?.created_by ?? null;
  const isHost = me !== null && createdBy === me.userId;
  const joined = players?.some((p) => p.user_id === me?.userId) ?? false;

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.joinGame(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join.');
    } finally {
      setBusy(false);
    }
  };

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.startGame(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the game.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="content stack" style={{ gap: '2rem' }}>
      <div className="spread">
        <div>
          <p className="eyebrow">Game {id}</p>
          <h2>Docking bay</h2>
        </div>
        <button className="secondary" onClick={() => navigate('/')}>Back to lobby</button>
      </div>

      {error && <p className="notice">{error}</p>}

      {players === null && <p className="eyebrow">Loading</p>}

      {players?.length === 0 && (
        <div className="empty"><p className="muted">Nobody has taken a bay yet.</p></div>
      )}

      <div className="stack" style={{ gap: '0.5rem' }}>
        {players?.map((player) => (
          <div key={player.robot_id} className="game-row" style={{ cursor: 'default' }}>
            <span className="bay">{player.seat}</span>
            <span>
              <span className="display" style={{ fontSize: '1.35rem', display: 'block' }}>
                {player.display_name}
              </span>
              <span className="mono muted" style={{ fontSize: '0.8125rem' }}>
                {player.robot_id}
              </span>
            </span>
            {player.user_id === me?.userId && <span className="tag lobby">You</span>}
          </div>
        ))}
      </div>

      <div className="row">
        {!joined && status === 'lobby' && (
          <button onClick={() => void join()} disabled={busy}>Take a bay</button>
        )}
        {isHost && status === 'lobby' && (
          <button onClick={() => void begin()} disabled={busy || (players?.length ?? 0) === 0}>
            Start the game
          </button>
        )}
        {status === 'active' && (
          <p className="notice ok">
            This game is running. The board screen is not built yet.
          </p>
        )}
      </div>
    </main>
  );
}
