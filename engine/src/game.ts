import { ComposedGrid } from './types.js';
import { RobotState } from './movement.js';
import { ProgramDeck, Rng } from './cards.js';
import { DealEvent, resolveDeal } from './deal.js';
import { ProgramEvent, ProgramSubmission, RejectedSubmission, resolveProgram } from './program.js';
import { AnnouncePowerDownEvent, resolveAnnouncePowerDown } from './announce-power-down.js';
import { RegisterEvent, resolveRegisterCheckpoints, resolveRegisterMovement } from './orchestration.js';
import { EndOfTurnEvent, resolveEndOfTurnEffects } from './end-of-turn.js';

/**
 * STATUS: real, complete for the base game. The turn-level machine that
 * ties RULES_SPEC.md §2's five steps together.
 *
 * Shape chosen deliberately over a single synchronous `resolveTurn`: a
 * real turn cannot collect every decision up front, because whether a
 * player owes a chop-shop or radioactive-waste choice depends on where
 * robots end up midway through a register. So this is a state machine.
 * Each `advance` call runs as far as it can and stops at a phase that
 * needs input, naming exactly who owes what. The server feeds decisions
 * back in and calls `advance` again.
 *
 * Randomness is passed in per call rather than held on the state or in a
 * module-level variable: a server runs concurrent games, and a shared
 * generator would entangle them. Keeping it out of `GameState` also
 * leaves that state plainly serializable.
 *
 * Nothing here re-implements a rule. Every phase delegates to the module
 * that already owns it — `deal.ts`, `program.ts`,
 * `announce-power-down.ts`, `orchestration.ts`, `end-of-turn.ts`. This
 * file's whole job is sequencing and working out who is being waited on.
 *
 * Deliberately NOT included:
 *   - Life tokens and permanent elimination. `Course.lifeTokens` exists
 *     and RULES_SPEC describes the rule, but `RobotState` has no life
 *     count, so there is nothing to decrement. A destroyed robot always
 *     returns via End of Turn Effects here.
 *   - The SET_FACING blocking behaviour RULES_SPEC describes for
 *     respawns, where the whole table's Deal waits on it. This machine
 *     collects facing as part of the End of Turn phase instead, which
 *     resolves it strictly before the next Deal opens and so satisfies
 *     the ordering requirement without a separate blocking phase.
 *   - Everything Options-dependent, per the standing scope decision.
 */

export class GameFlowError extends Error {}

export type GamePhase =
  /** Ready to run with no input. */
  | { kind: 'deal' }
  | { kind: 'awaitingProgram'; robotIds: string[] }
  | { kind: 'awaitingPowerDown'; robotIds: string[] }
  /** Ready to run with no input. */
  | { kind: 'runningRegister'; register: number }
  | {
      kind: 'awaitingRegisterChoices';
      register: number;
      chopShop: string[];
      radioactiveWaste: string[];
    }
  | {
      kind: 'awaitingEndOfTurn';
      facing: string[];
      repair: string[];
      continuePowerDown: string[];
      returnPowerDown: string[];
    }
  | { kind: 'gameOver'; winnerId: string };

export interface GameState {
  grid: ComposedGrid;
  robots: RobotState[];
  deck: ProgramDeck;
  /** 1-based. Turn 1 gets Virtual Mode's whole-turn grace period. */
  turnNumber: number;
  phase: GamePhase;
}

export type GameInput =
  | { kind: 'program'; submissions: ProgramSubmission[]; timerExpired?: boolean }
  | { kind: 'powerDown'; announcements: ReadonlyMap<string, boolean> }
  | {
      kind: 'registerChoices';
      chopShopChoices?: Map<string, 'scrapAndRedraw' | 'replenish' | 'freeDraw'>;
      radioactiveWasteDrawChoices?: Map<string, boolean>;
    }
  | {
      kind: 'endOfTurn';
      facingChoices?: Map<string, RobotState['facing']>;
      repairChoices?: Map<string, 'heal' | 'option'>;
      continuePowerDownChoices?: Map<string, boolean>;
      returnPowerDownChoices?: Map<string, boolean>;
    };

export type GameEvent =
  | DealEvent | ProgramEvent | AnnouncePowerDownEvent | RegisterEvent | EndOfTurnEvent;

export interface AdvanceResult {
  state: GameState;
  events: GameEvent[];
  /** Submissions that failed validation. The phase stays on
   * `awaitingProgram` and those robots are still in its `robotIds`. */
  rejected: RejectedSubmission[];
}

/** Robots that can act: in play, not destroyed, not powered down. */
function activeIds(robots: RobotState[]): string[] {
  return robots
    .filter((r) => !r.destroyed && !r.eliminated && !r.poweredDown)
    .map((r) => r.id);
}

/**
 * `lifeTokens` is set per game at creation, not fixed by the rules. It is
 * applied only to robots that don't already carry a `lives` count, so a
 * caller can hand in a mid-game roster untouched. Omitting it leaves
 * `lives` absent, which means unlimited.
 */
export function startGame(
  grid: ComposedGrid,
  robots: RobotState[],
  deck: ProgramDeck,
  options: { lifeTokens?: number } = {},
): GameState {
  const withLives = options.lifeTokens === undefined
    ? robots
    : robots.map((r) => (r.lives === undefined ? { ...r, lives: options.lifeTokens } : r));
  return { grid, robots: withLives, deck, turnNumber: 1, phase: { kind: 'deal' } };
}

/** True when `advance` will make progress without being handed any input. */
export function needsInput(state: GameState): boolean {
  return state.phase.kind !== 'deal'
    && state.phase.kind !== 'runningRegister'
    && state.phase.kind !== 'gameOver';
}

function expect(phase: GamePhase, input: GameInput | undefined, kind: GameInput['kind']): void {
  if (!input) {
    throw new GameFlowError(`phase ${phase.kind} needs input of kind ${kind}, none given`);
  }
  if (input.kind !== kind) {
    throw new GameFlowError(
      `phase ${phase.kind} needs input of kind ${kind}, got ${input.kind}`,
    );
  }
}

/**
 * Runs the current phase and moves to the next one that needs attention.
 * Phases needing no input (`deal`, `runningRegister`) are advanced by
 * calling with no `input`; the rest need the matching `GameInput`.
 *
 * A phase whose waiting-set is empty is skipped rather than stalling —
 * with every robot powered down there is nobody to program, and the turn
 * should carry on to the registers, not wait forever.
 */
export function advance(
  state: GameState,
  input?: GameInput,
  rng: Rng = Math.random,
): AdvanceResult {
  const { phase } = state;

  switch (phase.kind) {
    case 'gameOver':
      throw new GameFlowError('the game is over');

    case 'deal': {
      const result = resolveDeal(state.robots, state.deck, rng);
      const next: GameState = {
        ...state, robots: result.robots, deck: result.deck,
        phase: programPhase(result.robots),
      };
      return { state: next, events: result.events, rejected: [] };
    }

    case 'awaitingProgram': {
      expect(phase, input, 'program');
      const i = input as Extract<GameInput, { kind: 'program' }>;
      const result = resolveProgram(
        state.robots, state.deck, i.submissions, rng,
        { timerExpired: i.timerExpired },
      );

      const outstanding = [...new Set([...result.incomplete, ...result.rejected.map((x) => x.robotId)])];
      const next: GameState = {
        ...state, robots: result.robots, deck: result.deck,
        phase: outstanding.length > 0
          ? { kind: 'awaitingProgram', robotIds: outstanding }
          : powerDownPhase(result.robots),
      };
      return { state: next, events: result.events, rejected: result.rejected };
    }

    case 'awaitingPowerDown': {
      expect(phase, input, 'powerDown');
      const i = input as Extract<GameInput, { kind: 'powerDown' }>;
      const result = resolveAnnouncePowerDown(state.robots, i.announcements);
      const next: GameState = {
        ...state, robots: result.robots, phase: { kind: 'runningRegister', register: 1 },
      };
      return { state: next, events: result.events, rejected: [] };
    }

    case 'runningRegister': {
      const result = resolveRegisterMovement(state.grid, state.robots, phase.register);
      const next: GameState = {
        ...state, robots: result.robots,
        phase: registerChoicesPhase(state.grid, result.robots, phase.register),
      };
      return { state: next, events: result.events, rejected: [] };
    }

    case 'awaitingRegisterChoices': {
      expect(phase, input, 'registerChoices');
      const i = input as Extract<GameInput, { kind: 'registerChoices' }>;
      const result = resolveRegisterCheckpoints(
        state.grid, state.robots, phase.register,
        state.turnNumber === 1, // Virtual Mode's whole-turn grace period
        {
          chopShopChoices: i.chopShopChoices,
          radioactiveWasteDrawChoices: i.radioactiveWasteDrawChoices,
        },
      );

      let nextPhase: GamePhase;
      if (result.winnerId) {
        nextPhase = { kind: 'gameOver', winnerId: result.winnerId };
      } else if (phase.register < 5) {
        nextPhase = { kind: 'runningRegister', register: phase.register + 1 };
      } else {
        nextPhase = endOfTurnPhase(state.grid, result.robots);
      }

      return {
        state: { ...state, robots: result.robots, phase: nextPhase },
        events: result.events,
        rejected: [],
      };
    }

    case 'awaitingEndOfTurn': {
      expect(phase, input, 'endOfTurn');
      const i = input as Extract<GameInput, { kind: 'endOfTurn' }>;
      const result = resolveEndOfTurnEffects(state.grid, state.robots, {
        facingChoices: i.facingChoices,
        repairChoices: i.repairChoices,
        continuePowerDownChoices: i.continuePowerDownChoices,
        returnPowerDownChoices: i.returnPowerDownChoices,
      });
      const next: GameState = {
        ...state, robots: result.robots,
        turnNumber: state.turnNumber + 1,
        phase: { kind: 'deal' },
      };
      return { state: next, events: result.events, rejected: [] };
    }
  }
}

/** Runs every phase that needs no input, so a caller can loop until the
 * machine actually wants something. */
export function advanceUntilInputNeeded(
  state: GameState,
  rng: Rng = Math.random,
): { state: GameState; events: GameEvent[] } {
  let current = state;
  const events: GameEvent[] = [];
  while (!needsInput(current) && current.phase.kind !== 'gameOver') {
    const result = advance(current, undefined, rng);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

// ============================================================
// Phase construction — each skips itself when nobody is waited on
// ============================================================

function programPhase(robots: RobotState[]): GamePhase {
  const ids = activeIds(robots);
  if (ids.length === 0) return powerDownPhase(robots);
  return { kind: 'awaitingProgram', robotIds: ids };
}

function powerDownPhase(robots: RobotState[]): GamePhase {
  const ids = activeIds(robots);
  if (ids.length === 0) return { kind: 'runningRegister', register: 1 };
  return { kind: 'awaitingPowerDown', robotIds: ids };
}

function registerChoicesPhase(
  grid: ComposedGrid,
  robots: RobotState[],
  register: number,
): GamePhase {
  const chopShop: string[] = [];
  const radioactiveWaste: string[] = [];
  for (const r of robots) {
    if (r.destroyed) continue;
    const cell = grid.cells[r.y][r.x];
    if (cell.chopShop) chopShop.push(r.id);
    if (cell.radioactiveWaste) radioactiveWaste.push(r.id);
  }
  return { kind: 'awaitingRegisterChoices', register, chopShop, radioactiveWaste };
}

function endOfTurnPhase(grid: ComposedGrid, robots: RobotState[]): GamePhase {
  const facing: string[] = [];
  const repair: string[] = [];
  const continuePowerDown: string[] = [];
  const returnPowerDown: string[] = [];

  for (const r of robots) {
    if (r.destroyed) {
      // Both decisions a returning robot's player makes — but only if it
      // is actually coming back. A robot already out, or one spending its
      // last life token on this destruction, has nothing to decide.
      if (r.eliminated) continue;
      if (r.lives !== undefined && r.lives <= 1) continue;
      facing.push(r.id);
      returnPowerDown.push(r.id);
      continue;
    }
    if (r.poweredDown) continuePowerDown.push(r.id);
    const cell = grid.cells[r.y][r.x];
    if (cell.repair?.wrenches === 2) repair.push(r.id);
  }

  return { kind: 'awaitingEndOfTurn', facing, repair, continuePowerDown, returnPowerDown };
}
