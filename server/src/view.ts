import type { GameState, ProgramCard, RobotState } from '@roborally/engine';

/**
 * STATUS: real, complete for the base game.
 *
 * `GameState` is the SERVER's view. It must never reach a browser intact,
 * because it contains three things a player is not entitled to see:
 *
 *   1. `robots[].hand` — every other player's dealt cards.
 *   2. `robots[].registers` — what everyone programmed, before reveal.
 *   3. `deck.draw` — the shuffled draw pile IN ORDER. This is the worst of
 *      the three: a client holding it can compute every hand that will be
 *      dealt for the rest of the game. Only counts ever leave the server.
 *
 * Everything here is subtractive. Nothing is computed or invented; a field
 * is either passed through or replaced by a count. If a future field on
 * `RobotState` is secret, it must be added to `redactRobot` — the default
 * is to pass through, which is the wrong default for secrecy but the right
 * one for not silently dropping public state. Worth a second look whenever
 * `RobotState` grows.
 */

/** A robot as one particular player sees it. */
export interface RobotView extends Omit<RobotState, 'hand' | 'registers'> {
  /** Own robot only. Absent for everyone else. */
  hand?: ProgramCard[];
  /** How many cards this robot holds. Always present — hand SIZE is public
   * (it follows from damage) even though its contents are not. */
  handCount: number;
  /** Registers this viewer may see: all five for their own robot, and for
   * others only those already revealed this turn. Hidden entries are
   * `null`. */
  registers: (ProgramCard | null)[];
  /** Which of the five entries above are genuinely revealed, as opposed to
   * being `null` because the viewer may not see them yet. Without this a
   * client cannot tell "empty register" from "not your business". */
  registersRevealed: boolean[];
}

export interface GameView {
  turnNumber: number;
  phase: GameState['phase'];
  robots: RobotView[];
  deck: { drawCount: number; discardCount: number };
  /** The viewer's own robot id, echoed so a client needn't track it. */
  youAre: string | null;
  version: number;
}

/**
 * How many registers have been revealed this turn.
 *
 * Reveal is step A of each register, so during register N every register
 * up to and including N is face up. Before the registers start (Deal,
 * Program, Announce Power Down) nothing from this turn is revealed.
 */
function revealedThrough(phase: GameState['phase']): number {
  switch (phase.kind) {
    case 'runningRegister':
      return phase.register;
    case 'awaitingRegisterChoices':
      return phase.register;
    case 'awaitingEndOfTurn':
      return 5;
    case 'gameOver':
      return 5;
    default:
      return 0; // deal, awaitingProgram, awaitingPowerDown
  }
}

function redactRobot(robot: RobotState, isOwn: boolean, revealed: number): RobotView {
  const { hand, registers, ...rest } = robot;
  const allRegisters = registers ?? [null, null, null, null, null];

  if (isOwn) {
    return {
      ...rest,
      hand: hand ?? [],
      handCount: hand?.length ?? 0,
      registers: allRegisters.slice(0, 5),
      registersRevealed: [true, true, true, true, true],
    };
  }

  const visible: (ProgramCard | null)[] = [];
  const revealedFlags: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const isRevealed = i < revealed;
    visible.push(isRevealed ? (allRegisters[i] ?? null) : null);
    revealedFlags.push(isRevealed);
  }

  return {
    ...rest,
    handCount: hand?.length ?? 0,
    registers: visible,
    registersRevealed: revealedFlags,
  };
}

/**
 * Builds the view for one player. `viewerRobotId` is null for a spectator,
 * who sees exactly what a player sees of someone else's robot: no hands,
 * no unrevealed registers.
 */
export function viewFor(
  state: GameState,
  viewerRobotId: string | null,
  version: number,
): GameView {
  const revealed = revealedThrough(state.phase);
  return {
    turnNumber: state.turnNumber,
    phase: state.phase,
    robots: state.robots.map((r) => redactRobot(r, r.id === viewerRobotId, revealed)),
    deck: {
      drawCount: state.deck.draw.length,
      discardCount: state.deck.discard.length,
    },
    youAre: viewerRobotId,
    version,
  };
}
