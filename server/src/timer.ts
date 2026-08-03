import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { GameInput, ProgramSubmission } from '@roborally/engine';
import { advanceGame, VersionConflictError } from './games.js';
import { broadcast } from './sse.js';
import { loadGame } from './games.js';
import { viewFor } from './view.js';

/**
 * STATUS: real, complete for the base game.
 *
 * The On the Clock timer. The server is otherwise entirely request-driven,
 * so without this a programming phase whose timer expired would sit
 * forever if nobody happened to send a request.
 *
 * Deliberately a poll rather than a per-game `setTimeout`: timers held in
 * process memory are lost on restart, and a game mid-phase would then hang
 * indefinitely. A one-second sweep over an indexed column costs nothing
 * and survives a restart with no recovery logic.
 */

interface DueRow extends RowDataPacket {
  id: number;
  version: number;
  turn_number: number;
  phase_kind: string;
}

interface PendingRow extends RowDataPacket {
  submission_json: string;
}

/** Starts the clock on a game. `seconds` is whatever the table agreed;
 * the rules do not fix it. */
export async function startTimer(
  pool: Pool, gameId: number, seconds: number,
): Promise<void> {
  await pool.execute(
    'UPDATE games SET phase_deadline = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?',
    [seconds, gameId],
  );
}

export async function clearTimer(pool: Pool, gameId: number): Promise<void> {
  await pool.execute('UPDATE games SET phase_deadline = NULL WHERE id = ?', [gameId]);
}

/**
 * Advances every game whose deadline has passed. Safe to call
 * concurrently and safe to call constantly: `advanceGame`'s version check
 * means a game already advanced by a player's request is skipped rather
 * than double-advanced.
 */
export async function runTimerSweep(pool: Pool): Promise<number> {
  const [due] = await pool.query<DueRow[]>(
    `SELECT id, version, turn_number, phase_kind
       FROM games
      WHERE status = 'active'
        AND phase_deadline IS NOT NULL
        AND phase_deadline <= NOW()
      LIMIT 50`,
  );

  let advanced = 0;

  for (const game of due) {
    try {
      // Only the Program phase has a meaningful timeout in the base game.
      // Any other phase with an expired deadline just has its deadline
      // cleared, rather than being force-advanced past a decision.
      if (game.phase_kind !== 'awaitingProgram') {
        await clearTimer(pool, game.id);
        continue;
      }

      const [pending] = await pool.query<PendingRow[]>(
        `SELECT submission_json FROM pending_submissions
          WHERE game_id = ? AND turn_number = ?`,
        [game.id, game.turn_number],
      );

      const input: GameInput = {
        kind: 'program',
        timerExpired: true,
        submissions: pending.map(
          (r) => JSON.parse(r.submission_json) as ProgramSubmission,
        ),
      };

      await advanceGame(pool, game.id, input, {
        expectedVersion: game.version,
        phaseDeadline: null,
      });

      await pool.execute(
        'DELETE FROM pending_submissions WHERE game_id = ? AND turn_number = ?',
        [game.id, game.turn_number],
      );

      const conn = await pool.getConnection();
      try {
        const fresh = await loadGame(conn, game.id);
        broadcast(game.id, 'state', (robotId) => viewFor(fresh.state, robotId, fresh.version));
      } finally {
        conn.release();
      }

      advanced += 1;
    } catch (err) {
      if (err instanceof VersionConflictError) continue; // a player got there first
      console.error(`timer sweep failed for game ${game.id}:`, err);
    }
  }

  return advanced;
}
