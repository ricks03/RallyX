import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import type { CourseSummary, GameSummary } from '../api.js';

export function Lobby() {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [chosenCourse, setChosenCourse] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [gameList, courseList] = await Promise.all([api.games(), api.courses()]);
      setGames(gameList.games);
      setCourses(courseList.courses);
      setChosenCourse((current) => current ?? courseList.courses[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The lobby list is the one place polling is right: nothing is happening
  // yet, so an SSE connection per idle browser would cost a worker each
  // for no benefit. The game screen uses the stream instead.
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const create = async () => {
    if (chosenCourse === null) return;
    setBusy(true);
    setError(null);
    try {
      const { gameId } = await api.createGame(chosenCourse);
      await api.joinGame(gameId);
      navigate(`/games/${gameId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a game.');
    } finally {
      setBusy(false);
    }
  };

  const course = courses.find((c) => c.id === chosenCourse);

  return (
    <main className="content stack" style={{ gap: '2.5rem' }}>
      <section className="stack">
        <p className="eyebrow">New game</p>
        <div className="plate" style={{ padding: '1.25rem' }}>
          {courses.length === 0 ? (
            <p className="muted">
              No courses have been built yet. A course has to exist before a game can run on it.
            </p>
          ) : (
            <div className="stack">
              <div>
                <label htmlFor="course">Course</label>
                <select
                  id="course"
                  className="mono"
                  value={chosenCourse ?? ''}
                  onChange={(e) => setChosenCourse(Number(e.target.value))}
                  style={{
                    width: '100%', padding: '0.55rem 0.7rem',
                    font: 'inherit', background: 'var(--floor-lit)',
                    border: 'var(--edge)', borderBottom: '2px solid var(--ink-soft)',
                  }}
                >
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {course && (
                <p className="mono muted">
                  <span className="num">{course.boardCount}</span> boards
                  {' / '}
                  <span className="num">{course.flagCount}</span> flags
                  {' / '}
                  <span className="num">{course.lifeTokens}</span> lives
                  {' / '}
                  {course.hasDock ? 'docking bay' : 'no dock, all start on flag 1'}
                </p>
              )}

              <div>
                <button onClick={() => void create()} disabled={busy || chosenCourse === null}>
                  Open a new game
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="stack">
        <div className="spread">
          <p className="eyebrow">Games running</p>
          {games && <span className="mono muted num">{games.length}</span>}
        </div>

        {error && <p className="notice">{error}</p>}

        {games === null && <p className="eyebrow">Loading</p>}

        {games?.length === 0 && (
          <div className="empty">
            <p className="muted">Nothing is running. Open a game and the floor fills up.</p>
          </div>
        )}

        <div className="stack" style={{ gap: '0.5rem' }}>
          {games?.map((game) => (
            <button
              key={game.id}
              className="game-row"
              onClick={() => navigate(`/games/${game.id}`)}
            >
              <span className="bay">{game.id}</span>
              <span>
                <span className="display" style={{ fontSize: '1.35rem', display: 'block' }}>
                  {game.course_name}
                </span>
                <span className="mono muted" style={{ fontSize: '0.8125rem' }}>
                  <span className="num">{game.players}</span> of 8
                  {game.status === 'active' && (
                    <> {' / '} turn <span className="num">{game.turn_number}</span></>
                  )}
                </span>
              </span>
              <span className={`tag ${game.status}`}>
                {game.status === 'lobby' ? 'Waiting' : 'Running'}
              </span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
