import { describe, it, expect } from 'vitest';
import { resolveDeal } from '../src/deal.js';
import { newDeck, buildProgramDeck, PROGRAM_DECK_SIZE, Rng } from '../src/cards.js';
import { ProgramCard, RobotState } from '../src/movement.js';

const rng: Rng = () => 0.5;

function robot(overrides: Partial<RobotState> = {}): RobotState {
  return {
    id: 'r1', x: 0, y: 0, facing: 'N', damage: 0, destroyed: false, ...overrides,
  };
}

const card = (i: number): ProgramCard => buildProgramDeck()[i];
const emptyRegisters = (): (ProgramCard | null)[] => [null, null, null, null, null];

describe('resolveDeal — hand size', () => {
  it('deals 9 to an undamaged robot', () => {
    const result = resolveDeal([robot()], newDeck(rng), rng);
    expect(result.robots[0].hand).toHaveLength(9);
  });

  it('deals 9 minus damage across the whole table', () => {
    for (let damage = 0; damage <= 9; damage++) {
      const result = resolveDeal([robot({ damage })], newDeck(rng), rng);
      expect(result.robots[0].hand).toHaveLength(9 - damage);
    }
  });

  it('deals nothing at 9 damage', () => {
    const result = resolveDeal([robot({ damage: 9 })], newDeck(rng), rng);
    expect(result.robots[0].hand).toEqual([]);
  });

  it('emits one dealt event per robot carrying the hand size', () => {
    const result = resolveDeal(
      [robot({ id: 'a' }), robot({ id: 'b', damage: 3 })], newDeck(rng), rng,
    );
    const dealt = result.events.filter((e) => e.type === 'dealt');
    expect(dealt).toEqual([
      { type: 'dealt', robotId: 'a', count: 9 },
      { type: 'dealt', robotId: 'b', count: 6 },
    ]);
  });

  it('gives no two robots the same card', () => {
    const robots = Array.from({ length: 8 }, (_, i) => robot({ id: `r${i}` }));
    const result = resolveDeal(robots, newDeck(rng), rng);
    const all = result.robots.flatMap((r) => r.hand!.map((c) => c.priority));
    expect(all).toHaveLength(72);
    expect(new Set(all).size).toBe(72);
  });

  it('takes the dealt cards out of the deck', () => {
    const result = resolveDeal([robot()], newDeck(rng), rng);
    expect(result.deck.draw).toHaveLength(PROGRAM_DECK_SIZE - 9);
  });
});

describe('resolveDeal — locked registers', () => {
  it('recomputes locks from current damage', () => {
    const result = resolveDeal([robot({ damage: 6 })], newDeck(rng), rng);
    expect(result.robots[0].lockedRegisters).toEqual([false, false, false, true, true]);
  });

  it('clears stale locks when damage has been repaired', () => {
    const result = resolveDeal(
      [robot({ damage: 2, lockedRegisters: [false, false, false, true, true] })],
      newDeck(rng), rng,
    );
    expect(result.robots[0].lockedRegisters).toEqual([false, false, false, false, false]);
  });

  it('leaves a locked register that still holds a card alone', () => {
    const held = card(0);
    const registers = emptyRegisters();
    registers[4] = held;
    const result = resolveDeal([robot({ damage: 5, registers })], newDeck(rng), rng);
    expect(result.robots[0].registers![4]).toEqual(held);
    expect(result.events.some((e) => e.type === 'lockedRegisterFilled')).toBe(false);
  });

  it('fills an EMPTY locked register from the deck', () => {
    const result = resolveDeal(
      [robot({ damage: 5, registers: emptyRegisters() })], newDeck(rng), rng,
    );
    expect(result.robots[0].registers![4]).not.toBeNull();
    expect(result.events).toContainEqual(
      { type: 'lockedRegisterFilled', robotId: 'r1', count: 5 },
    );
  });

  it('fills every empty locked register, reporting each by register number', () => {
    const result = resolveDeal(
      [robot({ damage: 7, registers: emptyRegisters() })], newDeck(rng), rng,
    );
    const filled = result.events
      .filter((e) => e.type === 'lockedRegisterFilled')
      .map((e) => e.count);
    expect(filled).toEqual([3, 4, 5]);
    expect(result.robots[0].registers!.slice(2).every((c) => c !== null)).toBe(true);
    expect(result.robots[0].registers!.slice(0, 2)).toEqual([null, null]);
  });

  it('never fills an unlocked register', () => {
    const result = resolveDeal(
      [robot({ damage: 0, registers: emptyRegisters() })], newDeck(rng), rng,
    );
    expect(result.robots[0].registers).toEqual(emptyRegisters());
  });

  it('draws the fills on top of the hand, not out of it', () => {
    // damage 7 -> 2 cards dealt, 3 locked registers filled = 5 off the deck
    const result = resolveDeal(
      [robot({ damage: 7, registers: emptyRegisters() })], newDeck(rng), rng,
    );
    expect(result.robots[0].hand).toHaveLength(2);
    expect(result.deck.draw).toHaveLength(PROGRAM_DECK_SIZE - 5);
  });

  it('gives a robot exactly enough cards for its unlocked registers', () => {
    for (let damage = 5; damage <= 9; damage++) {
      const result = resolveDeal(
        [robot({ damage, registers: emptyRegisters() })], newDeck(rng), rng,
      );
      const unlocked = result.robots[0].lockedRegisters!.filter((l) => !l).length;
      expect(result.robots[0].hand).toHaveLength(unlocked);
    }
  });
});

describe('resolveDeal — powering down', () => {
  const announcing = () => robot({
    damage: 6,
    announcedPowerDownNextTurn: true,
    hand: [card(0), card(1)],
    registers: [card(2), null, null, card(3), card(4)],
  });

  it('powers the robot down and clears the announcement', () => {
    const result = resolveDeal([announcing()], newDeck(rng), rng);
    expect(result.robots[0].poweredDown).toBe(true);
    expect(result.robots[0].announcedPowerDownNextTurn).toBe(false);
    expect(result.events).toContainEqual({ type: 'poweredDown', robotId: 'r1' });
  });

  it('discards all damage', () => {
    const result = resolveDeal([announcing()], newDeck(rng), rng);
    expect(result.robots[0].damage).toBe(0);
    expect(result.robots[0].lockedRegisters).toEqual([false, false, false, false, false]);
  });

  it('discards all cards, hand and registers alike, locked ones included', () => {
    const result = resolveDeal([announcing()], newDeck(rng), rng);
    expect(result.robots[0].hand).toEqual([]);
    expect(result.robots[0].registers).toEqual(emptyRegisters());
    expect(result.deck.discard).toHaveLength(5); // 2 in hand + 3 in registers
  });

  it('deals it nothing', () => {
    const result = resolveDeal([announcing()], newDeck(rng), rng);
    expect(result.robots[0].hand).toEqual([]);
    expect(result.events.some((e) => e.type === 'dealt')).toBe(false);
    expect(result.deck.draw).toHaveLength(PROGRAM_DECK_SIZE);
  });

  it('does not fill its locked registers on the way down', () => {
    const result = resolveDeal([announcing()], newDeck(rng), rng);
    expect(result.events.some((e) => e.type === 'lockedRegisterFilled')).toBe(false);
  });
});

describe('resolveDeal — powering up', () => {
  it('clears poweredDown and deals normally', () => {
    const result = resolveDeal(
      [robot({ poweredDown: true, damage: 0, registers: emptyRegisters() })],
      newDeck(rng), rng,
    );
    expect(result.robots[0].poweredDown).toBe(false);
    expect(result.robots[0].hand).toHaveLength(9);
    expect(result.events).toContainEqual({ type: 'poweredUp', robotId: 'r1' });
  });

  it('fills the locks left by damage taken while powered down', () => {
    // The confirmed case: emptied every register on the way down, then took
    // 6 damage while down, so registers 4 and 5 are locked but empty.
    const result = resolveDeal(
      [robot({ poweredDown: true, damage: 6, registers: emptyRegisters() })],
      newDeck(rng), rng,
    );
    expect(result.robots[0].registers![3]).not.toBeNull();
    expect(result.robots[0].registers![4]).not.toBeNull();
    expect(result.robots[0].registers!.slice(0, 3)).toEqual([null, null, null]);
    expect(result.robots[0].hand).toHaveLength(3);
  });

  it('stays down when it re-announced power down at End of Turn', () => {
    const result = resolveDeal(
      [robot({ poweredDown: true, announcedPowerDownNextTurn: true, damage: 4 })],
      newDeck(rng), rng,
    );
    expect(result.robots[0].poweredDown).toBe(true);
    expect(result.robots[0].damage).toBe(0);
    expect(result.robots[0].hand).toEqual([]);
  });
});

describe('resolveDeal — general', () => {
  it('does not mutate the robots it was given', () => {
    const before = robot({ damage: 3 });
    resolveDeal([before], newDeck(rng), rng);
    expect(before.hand).toBeUndefined();
    expect(before.lockedRegisters).toBeUndefined();
  });

  it('does not mutate the deck it was given', () => {
    const deck = newDeck(rng);
    resolveDeal([robot()], deck, rng);
    expect(deck.draw).toHaveLength(PROGRAM_DECK_SIZE);
  });

  it('skips a destroyed robot entirely', () => {
    const result = resolveDeal([robot({ destroyed: true })], newDeck(rng), rng);
    expect(result.robots[0].hand).toBeUndefined();
    expect(result.events).toEqual([]);
  });

  it('conserves all 84 cards across a full 8-player deal', () => {
    const robots = Array.from({ length: 8 }, (_, i) => robot({ id: `r${i}`, damage: i }));
    const result = resolveDeal(robots, newDeck(rng), rng);
    const inHands = result.robots.reduce((n, r) => n + (r.hand?.length ?? 0), 0);
    const inRegisters = result.robots.reduce(
      (n, r) => n + (r.registers ?? []).filter((c) => c !== null).length, 0,
    );
    const total = inHands + inRegisters + result.deck.draw.length + result.deck.discard.length;
    expect(total).toBe(PROGRAM_DECK_SIZE);
  });
});
