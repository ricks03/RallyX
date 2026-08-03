import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  advance, composeCourse, createRng, newDeck, randomSeed, startGame,
} from '@roborally/engine';
import type {
  BoardLibrary, Course, GameEvent, GameInput, GameState, RobotState,
} from '@roborally/engine';
import { decodeGameInput, decodeGameState, encodeGameInput, encodeGameState } from './codec.js';

/**
 * STATUS: real, complete for the base game. The layer where the schema and
 * the engine meet.
 *
 * The whole point of this module is that ONE advance is ONE transaction.
 * Reading state, running the engine, and writing back the new state, the
 * new RNG state, and the log row all commit together or not at all. A
 * partial write here is a corrupted game, not a retryable error.
 *
 * Two hazards it exists to handle:
 *
 *   * Concurrency. Two players acting at the same instant would otherwise
 *     each read the same state, each advance it, and the second write
 *     would silently discard the first. Every write is guarded by
 *     `games.version`; the loser gets `VersionConflictError` and retries
 *     against fresh state.
 *
 *   * RNG continuity. The engine takes an Rng per call and a seeded
 *     generator advances as it is consumed, so the generator is rebuilt
 *     from `games.rng_state` (not from `seed`) and its new state written
 *     back inside the same transaction. Rebuilding from the seed would
 *     deal the same hand every turn.
 */

export class VersionConflictError extends Error {}
export class GameNotFoundError extends Error {}

export interface LoadedGame {
  id: number;
  courseId: number;
  status: 'lobby' | 'active' | 'finished' | 'abandoned';
  state: GameState;
  version: number;
  rngState: number;
  phaseDeadline: Date | null;
}

interface GameRow extends RowDataPacket {
  id: number;
  course_id: number;
  status: LoadedGame['status'];
  state_json: string | null;
  seed: number;
  rng_state: number;
  version: number;
  phase_deadline: Date | null;
  course_json: string;
  course_updated_at: Date;
}

interface BoardRow extends RowDataPacket {
  id: string;
  sha256: string;
  board_json: string;
}

interface SeqRow extends RowDataPacket {
  next_seq: number;
}

/**
 * Composed grids are pure functions of a course, so they are cached rather
 * than rebuilt on every request.
 *
 * The cache key is course id PLUS the course's `updated_at`, not the id
 * alone. Confirmed by the project owner: a board found to be broken may be
 * fixed and relinked WHILE A GAME IS IN PLAY, and the floor is expected to
 * change underneath it. Keying on id alone would mean a running Node
 * process kept serving the old grid until it was restarted, which is the
 * kind of bug that looks like the import silently failing.
 */
const gridCache = new Map<string, GameState['grid']>();

export function clearGridCache(): void {
  gridCache.clear();
}

async function loadBoardLibrary(conn: PoolConnection, course: Course): Promise<BoardLibrary> {
  const refs = course.dock ? [...course.boards, course.dock] : course.boards;
  if (refs.length === 0) return {};

  const [rows] = await conn.query<BoardRow[]>(
    `SELECT id, sha256, board_json FROM boards
      WHERE (id, sha256) IN (${refs.map(() => '(?, ?)').join(', ')})`,
    refs.flatMap((r) => [r.id, r.sha256]),
  );

  const library: BoardLibrary = {};
  for (const row of rows) {
    library[row.id] = { data: JSON.parse(row.board_json), sha256: row.sha256 };
  }
  return library;
}

async function gridFor(
  conn: PoolConnection,
  courseId: number,
  course: Course,
  updatedAt: Date | string,
): Promise<GameState['grid']> {
  const key = `${courseId}:${new Date(updatedAt).getTime()}`;
  const cached = gridCache.get(key);
  if (cached) return cached;

  const library = await loadBoardLibrary(conn, course);
  const grid = composeCourse(course, library);

  // Only one version of a given course is ever wanted; drop the old entry
  // rather than accumulating one per relink.
  for (const existing of gridCache.keys()) {
    if (existing.startsWith(`${courseId}:`)) gridCache.delete(existing);
  }
  gridCache.set(key, grid);
  return grid;
}

/** Reads a game and rebuilds its full state. Pass a connection already
 * inside a transaction when this is the read half of an advance. */
export async function loadGame(
  conn: PoolConnection,
  gameId: number,
  forUpdate = false,
): Promise<LoadedGame> {
  const [rows] = await conn.query<GameRow[]>(
    `SELECT g.id, g.course_id, g.status, g.state_json, g.seed, g.rng_state,
            g.version, g.phase_deadline, c.course_json,
            c.updated_at AS course_updated_at
       FROM games g
       JOIN courses c ON c.id = g.course_id
      WHERE g.id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [gameId],
  );

  const row = rows[0];
  if (!row) throw new GameNotFoundError(`no game with id ${gameId}`);
  if (!row.state_json) throw new GameNotFoundError(`game ${gameId} has not been started`);

  const course = JSON.parse(row.course_json) as Course;
  const grid = await gridFor(conn, row.course_id, course, row.course_updated_at);

  return {
    id: row.id,
    courseId: row.course_id,
    status: row.status,
    state: decodeGameState(row.state_json, grid),
    version: row.version,
    rngState: row.rng_state,
    phaseDeadline: row.phase_deadline,
  };
}

export interface AdvanceOptions {
  /** The version the caller last saw. Omit only for server-driven
   * advances that have just read the row in the same transaction. */
  expectedVersion?: number;
  /** Who submitted this. NULL for server-driven advances such as a timer
   * expiry. */
  userId?: number;
  /** Client-generated uuid making a retry a no-op. */
  clientToken?: string;
  /** Sets `games.phase_deadline` after the advance. `null` clears it. */
  phaseDeadline?: Date | null;
}

export interface AdvanceOutcome {
  state: GameState;
  events: GameEvent[];
  rejected: ReturnType<typeof advance>['rejected'];
  version: number;
  seq: number;
}

/**
 * Runs one `advance` and commits everything it touched.
 *
 * `input` is omitted for the phases that need none (`deal`,
 * `runningRegister`), matching the engine's own signature.
 */
export async function advanceGame(
  pool: Pool,
  gameId: number,
  input: GameInput | undefined,
  options: AdvanceOptions = {},
): Promise<AdvanceOutcome> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Idempotency: a repeated token means this action already ran. Return
    // the recorded result rather than applying it twice.
    if (options.clientToken) {
      const replay = await findByToken(conn, gameId, options.clientToken);
      if (replay) {
        await conn.rollback();
        return replay;
      }
    }

    const game = await loadGame(conn, gameId, true);

    if (options.expectedVersion !== undefined && options.expectedVersion !== game.version) {
      await conn.rollback();
      throw new VersionConflictError(
        `game ${gameId} is at version ${game.version}, caller expected ${options.expectedVersion}`,
      );
    }

    const rng = createRng(game.rngState);
    const result = advance(game.state, input, rng);

    const [[seqRow]] = await conn.query<SeqRow[]>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM game_actions WHERE game_id = ?',
      [gameId],
    );
    const seq = seqRow.next_seq;

    await conn.execute(
      `INSERT INTO game_actions
         (game_id, seq, user_id, action_kind, action_json, events_json,
          client_token, phase_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gameId, seq, options.userId ?? null,
        input?.kind ?? 'advance',
        input ? encodeGameInput(input) : '{}',
        JSON.stringify(result.events),
        options.clientToken ?? null,
        game.state.phase.kind,
      ],
    );

    const nextVersion = game.version + 1;
    const finished = result.state.phase.kind === 'gameOver';

    // The version in the WHERE clause is belt and braces: SELECT FOR UPDATE
    // already serialises writers. It also makes the guard survive anyone
    // later calling this outside a transaction.
    const [update] = await conn.execute(
      `UPDATE games
          SET state_json = ?, rng_state = ?, version = ?,
              turn_number = ?, phase_kind = ?, phase_deadline = ?,
              status = ?, finished_at = ?
        WHERE id = ? AND version = ?`,
      [
        encodeGameState(result.state),
        rng.state,
        nextVersion,
        result.state.turnNumber,
        result.state.phase.kind,
        options.phaseDeadline ?? null,
        finished ? 'finished' : 'active',
        finished ? new Date() : null,
        gameId,
        game.version,
      ],
    );

    if ((update as { affectedRows: number }).affectedRows !== 1) {
      await conn.rollback();
      throw new VersionConflictError(`game ${gameId} changed underneath this advance`);
    }

    await conn.commit();

    return {
      state: result.state,
      events: result.events,
      rejected: result.rejected,
      version: nextVersion,
      seq,
    };
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

interface ReplayRow extends RowDataPacket {
  seq: number;
  events_json: string | null;
}

async function findByToken(
  conn: PoolConnection,
  gameId: number,
  token: string,
): Promise<AdvanceOutcome | null> {
  const [rows] = await conn.query<ReplayRow[]>(
    'SELECT seq, events_json FROM game_actions WHERE game_id = ? AND client_token = ?',
    [gameId, token],
  );
  const row = rows[0];
  if (!row) return null;

  const game = await loadGame(conn, gameId);
  return {
    state: game.state,
    events: row.events_json ? (JSON.parse(row.events_json) as GameEvent[]) : [],
    rejected: [],
    version: game.version,
    seq: row.seq,
  };
}

// ============================================================
// Creating a game
// ============================================================

/**
 * Creates a game in `lobby` status with NO state. Players join, and
 * `startPlay` below builds the robots and writes the opening state.
 *
 * Two steps rather than one because the engine needs its full robot roster
 * up front, while a lobby by definition does not know it yet.
 */
export async function createLobbyGame(
  pool: Pool, courseId: number, createdBy?: number,
): Promise<number> {
  const seed = randomSeed();
  const [insert] = await pool.execute(
    `INSERT INTO games (course_id, status, seed, rng_state, created_by)
     VALUES (?, 'lobby', ?, ?, ?)`,
    [courseId, seed, seed, createdBy ?? null],
  );
  return (insert as { insertId: number }).insertId;
}

/**
 * Where robots stand at the start of the game.
 *
 * Docking bay start positions are numbered cells; seat N takes start N.
 * RULES_SPEC §1: `dock: null` is legal, and with no dock every player
 * begins on flag 1's cell — they share it, which Virtual Mode already
 * handles, including its whole-turn grace period on turn 1.
 *
 * Facing is NOT chosen here. Every player picks their own on turn 1,
 * inside their program submission, so these all start pointing north and
 * the first submission overrides it.
 */
export function startingPositions(
  grid: GameState['grid'], count: number,
): { x: number; y: number }[] {
  const starts: { number: number; x: number; y: number }[] = [];
  let flagOne: { x: number; y: number } | null = null;

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.cells[y][x];
      if (cell.start !== undefined) starts.push({ number: cell.start, x, y });
      if (cell.flag?.number === 1) flagOne = { x, y };
    }
  }

  starts.sort((a, b) => a.number - b.number);

  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const dockPosition = starts[i];
    if (dockPosition) {
      positions.push({ x: dockPosition.x, y: dockPosition.y });
    } else if (flagOne) {
      positions.push({ x: flagOne.x, y: flagOne.y });
    } else {
      throw new GameNotFoundError(
        'course has neither enough docking bay start positions nor a flag 1',
      );
    }
  }
  return positions;
}

/**
 * Turns a lobby into a live game: builds the robot roster from whoever
 * joined, writes the opening state, and flips the status.
 */
export async function startPlay(pool: Pool, gameId: number): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<(RowDataPacket & {
      course_id: number; course_json: string; status: string; seed: number;
      course_updated_at: Date;
    })[]>(
      `SELECT g.course_id, g.status, g.seed, c.course_json,
              c.updated_at AS course_updated_at
         FROM games g JOIN courses c ON c.id = g.course_id
        WHERE g.id = ? FOR UPDATE`,
      [gameId],
    );
    const row = rows[0];
    if (!row) throw new GameNotFoundError(`no game with id ${gameId}`);
    if (row.status !== 'lobby') throw new GameNotFoundError(`game ${gameId} has already started`);

    const [players] = await conn.query<(RowDataPacket & { robot_id: string; seat: number })[]>(
      'SELECT robot_id, seat FROM game_players WHERE game_id = ? ORDER BY seat',
      [gameId],
    );
    if (players.length === 0) throw new GameNotFoundError('cannot start a game with no players');

    const course = JSON.parse(row.course_json) as Course;
    const grid = await gridFor(conn, row.course_id, course, row.course_updated_at);
    const positions = startingPositions(grid, players.length);

    const robots: RobotState[] = players.map((p, i) => ({
      id: p.robot_id,
      x: positions[i].x,
      y: positions[i].y,
      facing: 'N',
      damage: 0,
      destroyed: false,
      archiveMarker: { x: positions[i].x, y: positions[i].y },
    }));

    const rng = createRng(row.seed);
    const deck = newDeck(rng);
    const state = startGame(grid, robots, deck, { lifeTokens: course.lifeTokens });

    await conn.execute(
      `UPDATE games
          SET status = 'active', state_json = ?, rng_state = ?,
              turn_number = ?, phase_kind = ?
        WHERE id = ?`,
      [encodeGameState(state), rng.state, state.turnNumber, state.phase.kind, gameId],
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

export interface CreateGameOptions {
  courseId: number;
  robots: RobotState[];
  createdBy?: number;
  /** Omit for a random seed. Supply one to reproduce a known game. */
  seed?: number;
}

/** Inserts a game row and writes its opening state. Life tokens come from
 * the course, which is where `Course.lifeTokens` already lives. */
export async function createGame(pool: Pool, options: CreateGameOptions): Promise<number> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<(RowDataPacket & {
      course_json: string; updated_at: Date;
    })[]>(
      'SELECT course_json, updated_at FROM courses WHERE id = ?',
      [options.courseId],
    );
    const courseRow = rows[0];
    if (!courseRow) throw new GameNotFoundError(`no course with id ${options.courseId}`);

    const course = JSON.parse(courseRow.course_json) as Course;
    const grid = await gridFor(conn, options.courseId, course, courseRow.updated_at);

    const seed = options.seed ?? randomSeed();
    const rng = createRng(seed);
    const deck = newDeck(rng);

    const state = startGame(grid, options.robots, deck, { lifeTokens: course.lifeTokens });

    const [insert] = await conn.execute(
      `INSERT INTO games
         (course_id, status, state_json, seed, rng_state, turn_number,
          phase_kind, version, created_by)
       VALUES (?, 'active', ?, ?, ?, ?, ?, 0, ?)`,
      [
        options.courseId,
        encodeGameState(state),
        seed,
        rng.state,
        state.turnNumber,
        state.phase.kind,
        options.createdBy ?? null,
      ],
    );

    await conn.commit();
    return (insert as { insertId: number }).insertId;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
