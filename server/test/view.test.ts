import { describe, it, expect } from 'vitest';
import { viewFor } from '../src/view.js';
import { buildProgramDeck, createRng, newDeck } from '@roborally/engine';
import type { ComposedCell, ComposedGrid, GameState, RobotState } from '@roborally/engine';

const deck = buildProgramDeck();
const card = (i: number) => deck[i];

function grid(): ComposedGrid {
  const cells: ComposedCell[][] = [];
  for (let y = 0; y < 3; y++) {
    const row: ComposedCell[] = [];
    for (let x = 0; x < 3; x++) row.push({ level: 0, edges: {} });
    cells.push(row);
  }
  return { width: 3, height: 3, cells };
}

function robot(id: string, overrides: Partial<RobotState> = {}): RobotState {
  return {
    id, x: 1, y: 1, facing: 'N', damage: 0, destroyed: false,
    hand: [card(0), card(1), card(2)],
    registers: [card(10), card(11), card(12), card(13), card(14)],
    ...overrides,
  };
}

function state(phase: GameState['phase'], robots?: RobotState[]): GameState {
  return {
    grid: grid(),
    robots: robots ?? [robot('me'), robot('them')],
    deck: newDeck(createRng(1)),
    turnNumber: 1,
    phase,
  };
}

describe('hands', () => {
  it('shows the viewer their own hand', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), 'me', 1);
    const me = view.robots.find((r) => r.id === 'me')!;
    expect(me.hand).toHaveLength(3);
    expect(me.hand![0]).toEqual(card(0));
  });

  it('does NOT include another player hand', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), 'me', 1);
    const them = view.robots.find((r) => r.id === 'them')!;
    expect(them.hand).toBeUndefined();
  });

  it('still reports another player hand SIZE, which is public', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), 'me', 1);
    expect(view.robots.find((r) => r.id === 'them')!.handCount).toBe(3);
  });

  it('leaks no card from another hand anywhere in the payload', () => {
    const secret = card(83); // last card in the deck; not in me hand or registers
    const s = state(
      { kind: 'awaitingProgram', robotIds: ['me'] },
      [robot('me'), robot('them', { hand: [secret], registers: [null, null, null, null, null] })],
    );
    const json = JSON.stringify(viewFor(s, 'me', 1));
    expect(json).not.toContain(`"priority":${secret.priority}`);
  });
});

describe('the draw pile', () => {
  it('sends counts only, never the ordered pile', () => {
    const s = state({ kind: 'awaitingProgram', robotIds: ['me'] });
    const view = viewFor(s, 'me', 1);
    expect(view.deck.drawCount).toBe(s.deck.draw.length);
    expect((view.deck as unknown as { draw?: unknown }).draw).toBeUndefined();
  });

  it('does not leak the next card that will be dealt', () => {
    const s = state({ kind: 'awaitingProgram', robotIds: ['me'] });
    const next = s.deck.draw[0];
    const json = JSON.stringify(viewFor(s, 'me', 1));
    // The top card must not appear as a deck entry. It could legitimately
    // appear if it were in the viewer's own hand, so build a state where
    // it definitely is not.
    const clean = state(
      { kind: 'awaitingProgram', robotIds: ['me'] },
      [robot('me', { hand: [], registers: [null, null, null, null, null] })],
    );
    const cleanJson = JSON.stringify(viewFor(clean, 'me', 1));
    expect(cleanJson).not.toContain(`"priority":${clean.deck.draw[0].priority}`);
    expect(json.length).toBeGreaterThan(0);
    expect(next).toBeDefined();
  });
});

describe('registers and reveal timing', () => {
  it('hides every register from others during programming', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), 'me', 1);
    const them = view.robots.find((r) => r.id === 'them')!;
    expect(them.registers).toEqual([null, null, null, null, null]);
    expect(them.registersRevealed).toEqual([false, false, false, false, false]);
  });

  it('hides them during Announce Power Down too', () => {
    const view = viewFor(state({ kind: 'awaitingPowerDown', robotIds: ['me'] }), 'me', 1);
    expect(view.robots.find((r) => r.id === 'them')!.registersRevealed)
      .toEqual([false, false, false, false, false]);
  });

  it('reveals register 1 only, during register 1', () => {
    const view = viewFor(state({ kind: 'runningRegister', register: 1 }), 'me', 1);
    const them = view.robots.find((r) => r.id === 'them')!;
    expect(them.registers[0]).toEqual(card(10));
    expect(them.registers[1]).toBeNull();
    expect(them.registersRevealed).toEqual([true, false, false, false, false]);
  });

  it('reveals progressively through the registers', () => {
    for (let register = 1; register <= 5; register++) {
      const view = viewFor(state({ kind: 'runningRegister', register }), 'me', 1);
      const them = view.robots.find((r) => r.id === 'them')!;
      expect(them.registersRevealed.filter(Boolean)).toHaveLength(register);
    }
  });

  it('reveals all five by End of Turn', () => {
    const view = viewFor(
      state({
        kind: 'awaitingEndOfTurn',
        facing: [], repair: [], continuePowerDown: [], returnPowerDown: [],
      }),
      'me', 1,
    );
    expect(view.robots.find((r) => r.id === 'them')!.registersRevealed)
      .toEqual([true, true, true, true, true]);
  });

  it('always shows the viewer all of their own registers', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), 'me', 1);
    const me = view.robots.find((r) => r.id === 'me')!;
    expect(me.registers).toEqual([card(10), card(11), card(12), card(13), card(14)]);
    expect(me.registersRevealed).toEqual([true, true, true, true, true]);
  });

  it('distinguishes an empty register from a hidden one', () => {
    const s = state(
      { kind: 'runningRegister', register: 1 },
      [robot('me'), robot('them', { registers: [null, card(11), null, null, null] })],
    );
    const them = viewFor(s, 'me', 1).robots.find((r) => r.id === 'them')!;
    expect(them.registers[0]).toBeNull();
    expect(them.registersRevealed[0]).toBe(true); // revealed AND empty
    expect(them.registers[1]).toBeNull();
    expect(them.registersRevealed[1]).toBe(false); // hidden, not empty
  });
});

describe('public state', () => {
  it('passes through position, facing, damage and flags', () => {
    const s = state(
      { kind: 'runningRegister', register: 1 },
      [robot('me'), robot('them', { x: 2, y: 0, facing: 'S', damage: 4, lastTouchedFlag: 2 })],
    );
    const them = viewFor(s, 'me', 1).robots.find((r) => r.id === 'them')!;
    expect(them.x).toBe(2);
    expect(them.y).toBe(0);
    expect(them.facing).toBe('S');
    expect(them.damage).toBe(4);
    expect(them.lastTouchedFlag).toBe(2);
  });

  it('passes through lives and destruction', () => {
    const s = state(
      { kind: 'runningRegister', register: 1 },
      [robot('me'), robot('them', { destroyed: true, lives: 2 })],
    );
    const them = viewFor(s, 'me', 1).robots.find((r) => r.id === 'them')!;
    expect(them.destroyed).toBe(true);
    expect(them.lives).toBe(2);
  });

  it('echoes the viewer own robot id and the version', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), 'me', 17);
    expect(view.youAre).toBe('me');
    expect(view.version).toBe(17);
  });
});

describe('spectators', () => {
  it('see nobody hand', () => {
    const view = viewFor(state({ kind: 'awaitingProgram', robotIds: ['me'] }), null, 1);
    for (const r of view.robots) expect(r.hand).toBeUndefined();
  });

  it('see no unrevealed register', () => {
    const view = viewFor(state({ kind: 'runningRegister', register: 2 }), null, 1);
    for (const r of view.robots) {
      expect(r.registersRevealed).toEqual([true, true, false, false, false]);
    }
  });

  it('still see public state', () => {
    const view = viewFor(state({ kind: 'runningRegister', register: 1 }), null, 1);
    expect(view.robots).toHaveLength(2);
    expect(view.robots[0].damage).toBe(0);
  });
});
