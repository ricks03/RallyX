import { Direction } from './types.js';
import { ProgramCard, RobotState } from './movement.js';
import { ProgramDeck, Rng, discardCards, shuffle } from './cards.js';

/**
 * STATUS: real, complete for the base game. Turn step 2 of 5 —
 * RULES_SPEC.md §2's `Program Registers`.
 *
 * Timer expiry, confirmed directly by the project owner: the tabletop rule
 * has the player to the right shuffle the unused cards and deal them into
 * the empty registers, but since a computer is running the game it draws
 * randomly from that player's own hand itself. A partially-programmed
 * player keeps every register they filled and only the empty ones are
 * filled at random; a player who programmed nothing gets all five filled
 * from their whole hand.
 *
 * A locked register is not part of the submission at all — it already
 * holds the card it will execute again this turn (placed either by last
 * turn's programming or, if it was empty, by the Deal step's random fill).
 * Submitting anything for a locked register is rejected rather than
 * silently ignored, since a client doing that is confused about the game
 * state and should be told.
 *
 * Deliberately NOT included:
 *   - Turn- and phase-programmed Option cards, which the rulebook says are
 *     also programmed at this point
 *   - Announce Power Down, which is its own step AFTER this one (confirmed
 *     by the project owner: it is the last thing before programming is
 *     locked in)
 */

export interface ProgramSubmission {
  robotId: string;
  /** Cards for registers 1-5. `null` means "not programmed": required for
   * a locked register, and allowed elsewhere only while the timer is still
   * running. */
  registers: (ProgramCard | null)[];
  /** Turn-1 only. RULES_SPEC §2: a player's chosen facing travels inside
   * this same submission the first time their robot is placed. Ignored
   * when absent. */
  facing?: Direction;
}

export type ProgramEventType =
  | 'programmed' | 'autoFilled' | 'leftoversDiscarded' | 'facingSet';

export interface ProgramEvent {
  type: ProgramEventType;
  robotId: string;
  /** Register number 1-5 on `autoFilled`; card count on
   * `leftoversDiscarded`. Absent otherwise. */
  count?: number;
}

export interface RejectedSubmission {
  robotId: string;
  problems: string[];
}

/** Pure check, exported so a server can validate a submission the moment it
 * arrives rather than waiting for the whole table. Returns an empty array
 * when the submission is acceptable. */
export function validateSubmission(
  robot: RobotState,
  submission: ProgramSubmission,
): string[] {
  const problems: string[] = [];

  if (submission.registers.length !== 5) {
    problems.push(`expected 5 register slots, got ${submission.registers.length}`);
    return problems; // nothing else is meaningful against a malformed array
  }

  const locked = robot.lockedRegisters ?? [false, false, false, false, false];
  const hand = robot.hand ?? [];
  const handPriorities = new Set(hand.map((c) => c.priority));
  const used = new Set<number>();

  submission.registers.forEach((card, i) => {
    if (locked[i]) {
      if (card !== null) problems.push(`register ${i + 1} is locked and cannot be programmed`);
      return;
    }
    if (card === null) return;
    if (!handPriorities.has(card.priority)) {
      problems.push(`card with priority ${card.priority} is not in this robot's hand`);
    }
    if (used.has(card.priority)) {
      problems.push(`card with priority ${card.priority} was programmed into two registers`);
    }
    used.add(card.priority);
  });

  return problems;
}

/**
 * Applies every player's submission. Call once at the close of the Program
 * step with `timerExpired` set to whether the On the Clock timer ran out.
 *
 * A robot whose registers all end up filled has its leftover hand
 * discarded and its hand cleared — its programming is final. A robot left
 * with an empty register (only possible while the timer is still running)
 * keeps its hand so the player can submit again, and is named in
 * `incomplete`.
 *
 * A submission that fails validation leaves that robot completely
 * untouched — registers and hand both — and is named in `rejected` so the
 * server can ask again. It is not treated as a submission of nothing,
 * which would quietly cost the player their turn over what is most likely
 * a client bug.
 */
export function resolveProgram(
  robots: RobotState[],
  deck: ProgramDeck,
  submissions: readonly ProgramSubmission[],
  rng: Rng,
  options: { timerExpired?: boolean } = {},
): {
  robots: RobotState[];
  deck: ProgramDeck;
  events: ProgramEvent[];
  rejected: RejectedSubmission[];
  incomplete: string[];
} {
  const timerExpired = options.timerExpired ?? false;
  const byRobot = new Map(submissions.map((s) => [s.robotId, s]));
  const working = robots.map((r) => ({ ...r }));
  const events: ProgramEvent[] = [];
  const rejected: RejectedSubmission[] = [];
  const incomplete: string[] = [];
  let currentDeck = deck;

  for (const r of working) {
    if (r.destroyed || r.poweredDown) continue;

    const submission = byRobot.get(r.id);
    if (submission) {
      const problems = validateSubmission(r, submission);
      if (problems.length > 0) {
        rejected.push({ robotId: r.id, problems });
        continue;
      }
    }

    const locked = r.lockedRegisters ?? [false, false, false, false, false];
    const registers: (ProgramCard | null)[] = (r.registers ?? [null, null, null, null, null]).slice();
    while (registers.length < 5) registers.push(null);

    let hand = (r.hand ?? []).slice();

    if (submission) {
      if (submission.facing) {
        r.facing = submission.facing;
        events.push({ type: 'facingSet', robotId: r.id });
      }
      submission.registers.forEach((card, i) => {
        if (locked[i] || card === null) return;
        registers[i] = card;
        hand = hand.filter((c) => c.priority !== card.priority);
      });
      events.push({ type: 'programmed', robotId: r.id });
    }

    // Timer expiry: the computer fills what the player didn't, drawing at
    // random from that player's own remaining hand.
    if (timerExpired) {
      const empty = registers
        .map((c, i) => (c === null && !locked[i] ? i : -1))
        .filter((i) => i >= 0);
      if (empty.length > 0) {
        const pool = shuffle(hand, rng);
        for (const i of empty) {
          const card = pool.shift();
          if (!card) break; // hand exhausted — reported via `incomplete` below
          registers[i] = card;
          hand = hand.filter((c) => c.priority !== card.priority);
          events.push({ type: 'autoFilled', robotId: r.id, count: i + 1 });
        }
      }
    }

    r.registers = registers;

    const allFilled = registers.every((c) => c !== null);
    if (allFilled) {
      if (hand.length > 0) {
        currentDeck = discardCards(currentDeck, hand);
        events.push({ type: 'leftoversDiscarded', robotId: r.id, count: hand.length });
      }
      r.hand = [];
    } else {
      r.hand = hand; // keep it — the player can still submit
      incomplete.push(r.id);
    }
  }

  return { robots: working, deck: currentDeck, events, rejected, incomplete };
}
