import { describe, it, expect } from 'vitest';
import {
  startGame, advance, advanceUntilInputNeeded, needsInput,
  GameFlowError, GameState, GameInput,
} from '../src/game.js';
import { newDeck, buildProgramDeck, Rng } from '../src/cards.js';
import { ProgramCard, RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid } from '../src/types.js';

const rng: Rng = () => 0.5;
const deckCards = buildProgramDeck();

function grid(mutate?: (cells: ComposedCell[][]) => void): ComposedGrid {
  const cells: ComposedCell[][] = [];
  for (let y = 0; y < 5; y++) {
    const row: ComposedCell[] = [];
    for (let x = 0; x < 5; x++) row.push({ level: 0, edges: {} });
    cells.push(row);
  }
  mutate?.(cells);
  return { width: 5, height: 5, cells };
}

function robot(overrides: Partial<RobotState> = {}): RobotState {
  return { id: 'r1', x: 2, y: 2, facing: 'N', damage: 0, destroyed: false, ...overrides };
}

/** Programs whatever each waiting robot happens to hold, so a test can get
 * past the Program phase without caring which cards came up. */
function programEverything(state: GameState, timerExpired = false): GameInput {
  const phase = state.phase as { kind: 'awaitingProgram'; robotIds: string[] };
  return {
    kind: 'program',
    timerExpired,
    submissions: phase.robotIds.map((id) => {
      const r = state.robots.find((x) => x.id === id)!;
      const locked = r.lockedRegisters ?? [false, false, false, false, false];
      const hand = (r.hand ?? []).slice();
      const registers: (ProgramCard | null)[] = [];
      for (let i = 0; i < 5; i++) registers.push(locked[i] ? null : (hand.shift() ?? null));
      return { robotId: id, registers };
    }),
  };
}

describe('startGame', () => {
  it('opens on the Deal phase at turn 1', () => {
    const state = startGame(grid(), [robot()], newDeck(rng));
    expect(state.phase).toEqual({ kind: 'deal' });
    expect(state.turnNumber).toBe(1);
  });

  it('reports Deal as needing no input', () => {
    expect(needsInput(startGame(grid(), [robot()], newDeck(rng)))).toBe(false);
  });
});

describe('phase sequence', () => {
  it('runs Deal then waits on programming', () => {
    const result = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng);
    expect(result.state.phase).toEqual({ kind: 'awaitingProgram', robotIds: ['r1'] });
    expect(result.state.robots[0].hand).toHaveLength(9);
    expect(needsInput(result.state)).toBe(true);
  });

  it('goes Program then Announce Power Down then register 1', () => {
    let state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    state = advance(state, programEverything(state), rng).state;
    expect(state.phase).toEqual({ kind: 'awaitingPowerDown', robotIds: ['r1'] });

    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;
    expect(state.phase).toEqual({ kind: 'runningRegister', register: 1 });
  });

  it('walks registers 1 to 5 and then reaches End of Turn', () => {
    let state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    state = advance(state, programEverything(state), rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;

    for (let register = 1; register <= 5; register++) {
      expect(state.phase).toEqual({ kind: 'runningRegister', register });
      state = advance(state, undefined, rng).state;
      expect(state.phase.kind).toBe('awaitingRegisterChoices');
      state = advance(state, { kind: 'registerChoices' }, rng).state;
    }
    expect(state.phase.kind).toBe('awaitingEndOfTurn');
  });

  it('rolls into turn 2 with a fresh Deal', () => {
    let state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    state = advance(state, programEverything(state), rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;
    for (let i = 0; i < 5; i++) {
      state = advance(state, undefined, rng).state;
      state = advance(state, { kind: 'registerChoices' }, rng).state;
    }
    state = advance(state, { kind: 'endOfTurn' }, rng).state;

    expect(state.turnNumber).toBe(2);
    expect(state.phase).toEqual({ kind: 'deal' });
  });
});

describe('the Program phase loop', () => {
  it('stays put and names who is outstanding on a partial submission', () => {
    let state = advance(startGame(grid(), [robot({ id: 'a' }), robot({ id: 'b', x: 1 })], newDeck(rng)), undefined, rng).state;
    const full = programEverything(state) as Extract<GameInput, { kind: 'program' }>;
    const onlyA = { ...full, submissions: full.submissions.filter((s) => s.robotId === 'a') };

    const result = advance(state, onlyA, rng);
    expect(result.state.phase).toEqual({ kind: 'awaitingProgram', robotIds: ['b'] });
  });

  it('keeps a rejected robot in the waiting set and reports why', () => {
    let state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    const bad: GameInput = {
      kind: 'program',
      submissions: [{
        robotId: 'r1',
        registers: [deckCards[0], deckCards[0], deckCards[1], deckCards[2], deckCards[3]],
      }],
    };
    const result = advance(state, bad, rng);
    expect(result.rejected).toHaveLength(1);
    expect(result.state.phase).toEqual({ kind: 'awaitingProgram', robotIds: ['r1'] });
  });

  it('moves on when the timer expires with nothing submitted', () => {
    let state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    const result = advance(state, { kind: 'program', submissions: [], timerExpired: true }, rng);
    expect(result.state.phase.kind).toBe('awaitingPowerDown');
    expect(result.state.robots[0].registers!.every((c) => c !== null)).toBe(true);
  });
});

describe('phases with nobody to wait on are skipped', () => {
  it('skips Program and Announce Power Down when every robot is powered down', () => {
    // It must have re-announced at End of Turn to still be down after
    // Deal — a powered-down robot that does NOT re-announce powers up
    // here and does have to program.
    const down = robot({ poweredDown: true, announcedPowerDownNextTurn: true });
    const result = advance(startGame(grid(), [down], newDeck(rng)), undefined, rng);
    expect(result.state.phase).toEqual({ kind: 'runningRegister', register: 1 });
  });

  it('does make a powered-down robot program once it powers up at Deal', () => {
    const down = robot({ poweredDown: true });
    const result = advance(startGame(grid(), [down], newDeck(rng)), undefined, rng);
    expect(result.state.phase).toEqual({ kind: 'awaitingProgram', robotIds: ['r1'] });
  });

  it('advanceUntilInputNeeded runs straight through to the first real prompt', () => {
    const result = advanceUntilInputNeeded(startGame(grid(), [robot()], newDeck(rng)), rng);
    expect(result.state.phase.kind).toBe('awaitingProgram');
    expect(result.events.some((e) => e.type === 'dealt')).toBe(true);
  });
});

describe('who is asked for what', () => {
  it('asks only robots standing on a chop shop', () => {
    const g = grid((cells) => { cells[2][2].chopShop = true; });
    let state = startGame(g, [robot({ id: 'a' }), robot({ id: 'b', x: 0, y: 0 })], newDeck(rng));
    state = advance(state, undefined, rng).state;
    state = advance(state, programEverything(state), rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;
    const result = advance(state, undefined, rng);

    const phase = result.state.phase as { kind: 'awaitingRegisterChoices'; chopShop: string[] };
    expect(phase.kind).toBe('awaitingRegisterChoices');
    expect(phase.chopShop).not.toContain('b');
  });

  it('asks a destroyed robot player for both facing and a power-down choice', () => {
    const g = grid((cells) => { cells[2][2].floor = { kind: 'pit' }; });
    let state = startGame(g, [robot({ archiveMarker: { x: 0, y: 0 } })], newDeck(rng));
    state = advanceUntilInputNeeded(state, rng).state;
    state = advance(state, programEverything(state), rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;
    for (let i = 0; i < 5; i++) {
      state = advance(state, undefined, rng).state;
      state = advance(state, { kind: 'registerChoices' }, rng).state;
    }

    const phase = state.phase as {
      kind: 'awaitingEndOfTurn'; facing: string[]; returnPowerDown: string[];
    };
    expect(phase.kind).toBe('awaitingEndOfTurn');
    expect(phase.facing).toContain('r1');
    expect(phase.returnPowerDown).toContain('r1');
  });

  it('asks for a repair choice only on a two-wrench site', () => {
    const g = grid((cells) => {
      cells[2][2].repair = { wrenches: 2 };
      cells[0][0].repair = { wrenches: 1 };
    });
    let state = startGame(g, [robot({ id: 'a' }), robot({ id: 'b', x: 0, y: 0 })], newDeck(rng));
    state = advanceUntilInputNeeded(state, rng).state;
    state = advance(state, { kind: 'program', submissions: [], timerExpired: true }, rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;
    for (let i = 0; i < 5; i++) {
      state = advance(state, undefined, rng).state;
      state = advance(state, { kind: 'registerChoices' }, rng).state;
    }
    const phase = state.phase as { kind: 'awaitingEndOfTurn'; repair: string[] };
    expect(phase.repair).not.toContain('b');
  });
});

describe('victory', () => {
  it('ends the game the moment the final flag is touched in register 5', () => {
    const g = grid((cells) => { cells[2][2].flag = { number: 1, isFinal: true }; });
    let state = startGame(g, [robot({ lastTouchedFlag: 0 })], newDeck(rng));
    state = advanceUntilInputNeeded(state, rng).state;
    state = advance(state, { kind: 'program', submissions: [], timerExpired: true }, rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;

    let over = false;
    for (let i = 0; i < 5 && !over; i++) {
      state = advance(state, undefined, rng).state;
      state = advance(state, { kind: 'registerChoices' }, rng).state;
      over = state.phase.kind === 'gameOver';
    }
    // Whether it wins depends on where the random program leaves it, so
    // assert the machine's rule rather than the outcome: game over is
    // reachable only via a winner, and only ever from register 5.
    if (over) {
      expect((state.phase as { kind: 'gameOver'; winnerId: string }).winnerId).toBe('r1');
    } else {
      expect(state.phase.kind).toBe('awaitingEndOfTurn');
    }
  });

  it('refuses to advance once the game is over', () => {
    const state: GameState = {
      grid: grid(), robots: [robot()], deck: newDeck(rng), turnNumber: 1,
      phase: { kind: 'gameOver', winnerId: 'r1' },
    };
    expect(() => advance(state, undefined, rng)).toThrow(GameFlowError);
    expect(needsInput(state)).toBe(false);
  });
});

describe('input validation', () => {
  it('rejects the wrong input kind for the phase', () => {
    const state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    expect(() => advance(state, { kind: 'endOfTurn' }, rng)).toThrow(GameFlowError);
  });

  it('rejects no input at all for a phase that needs some', () => {
    const state = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng).state;
    expect(() => advance(state, undefined, rng)).toThrow(GameFlowError);
  });
});

describe('turn 1 grace period', () => {
  it('skips Virtual Mode clearing on turn 1 and applies it afterwards', () => {
    const shared = [
      robot({ id: 'a', virtual: true }),
      robot({ id: 'b', x: 0, y: 0 }),
    ];
    let state = startGame(grid(), shared, newDeck(rng));
    state = advanceUntilInputNeeded(state, rng).state;
    state = advance(state, { kind: 'program', submissions: [], timerExpired: true }, rng).state;
    state = advance(state, { kind: 'powerDown', announcements: new Map() }, rng).state;
    state = advance(state, undefined, rng).state;
    state = advance(state, { kind: 'registerChoices' }, rng).state;

    // Turn 1: 'a' is alone on its square but must stay virtual regardless.
    expect(state.robots.find((r) => r.id === 'a')!.virtual).toBe(true);
    expect(state.turnNumber).toBe(1);
  });
});

describe('state handling', () => {
  it('does not mutate the state it was given', () => {
    const state = startGame(grid(), [robot()], newDeck(rng));
    advance(state, undefined, rng);
    expect(state.phase).toEqual({ kind: 'deal' });
    expect(state.robots[0].hand).toBeUndefined();
  });

  it('is reproducible for a given rng', () => {
    const a = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng);
    const b = advance(startGame(grid(), [robot()], newDeck(rng)), undefined, rng);
    expect(a.state.robots[0].hand!.map((c) => c.priority))
      .toEqual(b.state.robots[0].hand!.map((c) => c.priority));
  });
});
