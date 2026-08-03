import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { GameInput, ProgramSubmission } from '@roborally/engine';
import { createUser, login, logout, resolveSession } from './auth.js';
import type { SessionUser } from './auth.js';
import {
  advanceGame, createLobbyGame, loadGame, startPlay,
  VersionConflictError, GameNotFoundError,
} from './games.js';
import { viewFor } from './view.js';
import { broadcast, subscribe } from './sse.js';

/**
 * STATUS: real, covers the base game. HTTP surface.
 *
 * Everything here is a thin shell: authenticate, authorise, hand to
 * `games.ts`, redact through `view.ts`, respond. No rules live in this
 * file and none should.
 *
 * Authority model: the client sends INTENT, never state. It says "program
 * these five cards", not "here is my new position". Every response is
 * built from what the engine produced, redacted per player.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const SESSION_COOKIE = 'rr_session';

interface PlayerRow extends RowDataPacket {
  robot_id: string;
  user_id: number;
}

async function robotIdFor(
  pool: Pool, gameId: number, userId: number,
): Promise<string | null> {
  const [rows] = await pool.query<PlayerRow[]>(
    'SELECT robot_id FROM game_players WHERE game_id = ? AND user_id = ?',
    [gameId, userId],
  );
  return rows[0]?.robot_id ?? null;
}

/** Pushes the new state to every watcher, each redacted for its own
 * viewer. Called after any successful advance. */
async function publish(pool: Pool, gameId: number): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const game = await loadGame(conn, gameId);
    broadcast(gameId, 'state', (robotId) => viewFor(game.state, robotId, game.version));
  } finally {
    conn.release();
  }
}

export function createApp(pool: Pool): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // Apache terminates TLS and proxies over plain HTTP on localhost, so
  // express must be told to trust the forwarded headers or every request
  // looks like it came from 127.0.0.1 over http.
  app.set('trust proxy', 'loopback');

  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    const user = await resolveSession(pool, req.cookies?.[SESSION_COOKIE]);
    if (!user) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    req.user = user;
    next();
  };

  // ============================================================
  // Auth
  // ============================================================

  app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length < 3 || username.length > 64) {
      res.status(400).json({ error: 'username must be 3 to 64 characters' });
      return;
    }
    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'password must be at least 8 characters' });
      return;
    }
    try {
      await createUser(pool, username, password);
    } catch {
      // Almost certainly the unique index. Deliberately vague: confirming
      // which usernames exist is an enumeration aid.
      res.status(409).json({ error: 'could not create that account' });
      return;
    }
    res.status(201).json({ ok: true });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const token = await login(pool, username, password);
    if (!token) {
      // Same message for unknown user and wrong password.
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await logout(pool, token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ username: req.user!.username, userId: req.user!.userId });
  });

  // ============================================================
  // Lobby
  // ============================================================

  app.get('/api/games', requireAuth, async (_req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT g.id, g.status, g.turn_number, g.phase_kind, g.updated_at,
              c.name AS course_name,
              (SELECT COUNT(*) FROM game_players p WHERE p.game_id = g.id) AS players
         FROM games g JOIN courses c ON c.id = g.course_id
        WHERE g.status IN ('lobby','active')
        ORDER BY g.updated_at DESC
        LIMIT 100`,
    );
    res.json({ games: rows });
  });

  app.get('/api/courses', requireAuth, async (_req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name, course_json, created_at FROM courses ORDER BY name`,
    );
    res.json({
      courses: rows.map((r) => {
        const row = r as { id: number; name: string; course_json: string };
        const course = JSON.parse(row.course_json);
        return {
          id: row.id,
          name: row.name,
          boardCount: course.boards?.length ?? 0,
          flagCount: course.flags?.length ?? 0,
          lifeTokens: course.lifeTokens,
          hasDock: Boolean(course.dock),
        };
      }),
    });
  });

  /** Creates a game in lobby status. Robots are built when it starts, from
   * whoever has joined by then. */
  app.post('/api/games', requireAuth, async (req, res) => {
    const { courseId } = req.body ?? {};
    if (typeof courseId !== 'number') {
      res.status(400).json({ error: 'courseId required' });
      return;
    }
    const gameId = await createLobbyGame(pool, courseId, req.user!.userId);
    res.status(201).json({ gameId });
  });

  app.post('/api/games/:id/start', requireAuth, async (req, res) => {
    const gameId = Number(req.params.id);

    const [owner] = await pool.query<RowDataPacket[]>(
      'SELECT created_by FROM games WHERE id = ?', [gameId],
    );
    const createdBy = (owner[0] as { created_by: number | null } | undefined)?.created_by;
    if (createdBy !== req.user!.userId) {
      res.status(403).json({ error: 'only the player who created this game can start it' });
      return;
    }

    try {
      await startPlay(pool, gameId);
    } catch (err) {
      if (err instanceof GameNotFoundError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    await publish(pool, gameId);
    res.json({ ok: true });
  });

  app.get('/api/games/:id/players', requireAuth, async (req, res) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.robot_id, p.seat, p.display_name, p.colour, p.user_id,
              g.created_by, g.status
         FROM game_players p JOIN games g ON g.id = p.game_id
        WHERE p.game_id = ? ORDER BY p.seat`,
      [Number(req.params.id)],
    );
    res.json({ players: rows });
  });

  app.post('/api/games/:id/join', requireAuth, async (req, res) => {
    const gameId = Number(req.params.id);
    const { displayName, colour } = req.body ?? {};
    const [seats] = await pool.query<RowDataPacket[]>(
      'SELECT COALESCE(MAX(seat), 0) + 1 AS seat FROM game_players WHERE game_id = ?',
      [gameId],
    );
    const seat = (seats[0] as { seat: number }).seat;
    if (seat > 8) {
      res.status(409).json({ error: 'game is full' });
      return;
    }
    // The robot id is derived from the seat, not supplied by the client:
    // it is the identity the engine and every authorisation check use, so
    // letting a client name it would let one player act as another.
    const robotId = `robot${seat}`;
    try {
      await pool.execute(
        `INSERT INTO game_players
           (game_id, user_id, robot_id, seat, display_name, colour)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [gameId, req.user!.userId, robotId, seat,
          displayName ?? req.user!.username, colour ?? null],
      );
    } catch {
      res.status(409).json({ error: 'already joined, or that robot is taken' });
      return;
    }
    res.status(201).json({ seat, robotId });
  });

  // ============================================================
  // Game state
  // ============================================================

  app.get('/api/games/:id', requireAuth, async (req, res) => {
    const gameId = Number(req.params.id);
    const robotId = await robotIdFor(pool, gameId, req.user!.userId);
    const conn = await pool.getConnection();
    try {
      const game = await loadGame(conn, gameId);
      res.json(viewFor(game.state, robotId, game.version));
    } catch (err) {
      if (err instanceof GameNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    } finally {
      conn.release();
    }
  });

  /** The SSE stream. One per watching client. */
  app.get('/api/games/:id/stream', requireAuth, async (req, res) => {
    const gameId = Number(req.params.id);
    const robotId = await robotIdFor(pool, gameId, req.user!.userId);

    subscribe(gameId, res, robotId, req.user!.userId);

    // Send current state immediately so a client that connects mid-game
    // does not sit blank until something happens.
    const conn = await pool.getConnection();
    try {
      const game = await loadGame(conn, gameId);
      res.write(`event: state\ndata: ${JSON.stringify(
        viewFor(game.state, robotId, game.version),
      )}\n\n`);
    } catch {
      // A stream for a game that cannot load is simply empty; the client
      // will see nothing and can fall back to GET.
    } finally {
      conn.release();
    }
  });

  // ============================================================
  // Actions
  // ============================================================

  /**
   * A player's program submission. Held in `pending_submissions` rather
   * than advancing immediately, because the engine's Program phase takes
   * every player's submission at once. Once all have arrived, one advance
   * consumes them.
   */
  app.post('/api/games/:id/program', requireAuth, async (req, res) => {
    const gameId = Number(req.params.id);
    const robotId = await robotIdFor(pool, gameId, req.user!.userId);
    if (!robotId) {
      res.status(403).json({ error: 'not a player in this game' });
      return;
    }

    const submission = req.body?.submission as ProgramSubmission | undefined;
    if (!submission || !Array.isArray(submission.registers)) {
      res.status(400).json({ error: 'submission.registers required' });
      return;
    }
    // The client does not get to say whose submission this is.
    submission.robotId = robotId;

    const conn = await pool.getConnection();
    let game;
    try {
      game = await loadGame(conn, gameId);
    } catch (err) {
      conn.release();
      if (err instanceof GameNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
    conn.release();

    if (game.state.phase.kind !== 'awaitingProgram') {
      res.status(409).json({ error: `game is not accepting programs (${game.state.phase.kind})` });
      return;
    }

    await pool.execute(
      `INSERT INTO pending_submissions
         (game_id, robot_id, turn_number, submission_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE submission_json = VALUES(submission_json),
                               submitted_at = CURRENT_TIMESTAMP(3)`,
      [gameId, robotId, game.state.turnNumber, JSON.stringify(submission)],
    );

    const outstanding = game.state.phase.robotIds;
    const [pending] = await pool.query<RowDataPacket[]>(
      `SELECT robot_id, submission_json FROM pending_submissions
        WHERE game_id = ? AND turn_number = ?`,
      [gameId, game.state.turnNumber],
    );

    const submitted = new Set(pending.map((r) => (r as { robot_id: string }).robot_id));
    const everyoneIn = outstanding.every((id) => submitted.has(id));

    if (!everyoneIn) {
      res.json({ accepted: true, waitingFor: outstanding.filter((id) => !submitted.has(id)) });
      return;
    }

    const input: GameInput = {
      kind: 'program',
      submissions: pending.map(
        (r) => JSON.parse((r as { submission_json: string }).submission_json) as ProgramSubmission,
      ),
    };

    try {
      const outcome = await advanceGame(pool, gameId, input, {
        expectedVersion: game.version,
        userId: req.user!.userId,
        clientToken: randomUUID(),
      });
      await pool.execute(
        'DELETE FROM pending_submissions WHERE game_id = ? AND turn_number = ?',
        [gameId, game.state.turnNumber],
      );
      await publish(pool, gameId);
      res.json({ accepted: true, advanced: true, rejected: outcome.rejected });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        // Someone else's request advanced it first. The submission is
        // stored, so this is not an error the player needs to see.
        res.json({ accepted: true, advanced: false });
        return;
      }
      throw err;
    }
  });

  /**
   * Every other input kind: powerDown, registerChoices, endOfTurn, and the
   * no-input advances (deal, runningRegister).
   */
  app.post('/api/games/:id/action', requireAuth, async (req, res) => {
    const gameId = Number(req.params.id);
    const robotId = await robotIdFor(pool, gameId, req.user!.userId);
    if (!robotId) {
      res.status(403).json({ error: 'not a player in this game' });
      return;
    }

    const { kind, choices, expectedVersion, clientToken } = req.body ?? {};

    // A player may only ever speak for their OWN robot. The client sends a
    // bare value; the server attaches the robot id. This is what stops one
    // player powering down another.
    let input: GameInput | undefined;
    switch (kind) {
      case 'advance':
        input = undefined;
        break;
      case 'powerDown':
        input = { kind: 'powerDown', announcements: new Map([[robotId, Boolean(choices?.powerDown)]]) };
        break;
      case 'registerChoices':
        input = {
          kind: 'registerChoices',
          chopShopChoices: choices?.chopShop
            ? new Map([[robotId, choices.chopShop]]) : undefined,
          radioactiveWasteDrawChoices: choices?.radioactiveWasteDraw !== undefined
            ? new Map([[robotId, Boolean(choices.radioactiveWasteDraw)]]) : undefined,
        };
        break;
      case 'endOfTurn':
        input = {
          kind: 'endOfTurn',
          facingChoices: choices?.facing ? new Map([[robotId, choices.facing]]) : undefined,
          repairChoices: choices?.repair ? new Map([[robotId, choices.repair]]) : undefined,
          continuePowerDownChoices: choices?.continuePowerDown !== undefined
            ? new Map([[robotId, Boolean(choices.continuePowerDown)]]) : undefined,
          returnPowerDownChoices: choices?.returnPowerDown !== undefined
            ? new Map([[robotId, Boolean(choices.returnPowerDown)]]) : undefined,
        };
        break;
      default:
        res.status(400).json({ error: `unknown action kind: ${kind}` });
        return;
    }

    try {
      const outcome = await advanceGame(pool, gameId, input, {
        expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
        userId: req.user!.userId,
        clientToken: typeof clientToken === 'string' ? clientToken : undefined,
      });
      await publish(pool, gameId);
      res.json({
        version: outcome.version,
        rejected: outcome.rejected,
        phase: outcome.state.phase,
      });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        res.status(409).json({ error: 'game moved on; re-read and retry' });
        return;
      }
      if (err instanceof GameNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Anything thrown in a handler lands here. Deliberately does not echo
  // the message, which may contain SQL or internals.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('unhandled:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
