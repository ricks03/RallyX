import { describe, it, expect } from 'vitest';
import { resolveAnnouncePowerDown } from '../src/announce-power-down.js';
import { resolveEndOfTurnEffects } from '../src/end-of-turn.js';
import { resolveDeal } from '../src/deal.js';
import { newDeck, Rng } from '../src/cards.js';
import { RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid } from '../src/types.js';

const rng: Rng = () => 0.5;

function robot(overrides: Partial<RobotState> = {}): RobotState {
  return { id: 'r1', x: 0, y: 0, facing: 'N', damage: 0, destroyed: false, ...overrides };
}

/** Bare 3x3 of open floor — enough for End of Turn, which only reads
 * radiation and repair. */
function plainGrid(): ComposedGrid {
  const cells: ComposedCell[][] = [];
  for (let y = 0; y < 3; y++) {
    const row: ComposedCell[] = [];
    for (let x = 0; x < 3; x++) row.push({ level: 0, edges: {} });
    cells.push(row);
  }
  return { width: 3, height: 3, cells };
}

describe('resolveAnnouncePowerDown — case (a), end of programming', () => {
  it('records an announcement for next turn', () => {
    const result = resolveAnnouncePowerDown([robot()], new Map([['r1', true]]));
    expect(result.robots[0].announcedPowerDownNextTurn).toBe(true);
    expect(result.events).toEqual([{ type: 'announcedPowerDown', robotId: 'r1' }]);
  });

  it('does not power the robot down now', () => {
    const result = resolveAnnouncePowerDown([robot()], new Map([['r1', true]]));
    expect(result.robots[0].poweredDown).toBeUndefined();
  });

  it('records an explicit decline without an event', () => {
    const result = resolveAnnouncePowerDown([robot()], new Map([['r1', false]]));
    expect(result.robots[0].announcedPowerDownNextTurn).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('leaves a robot that made no decision untouched', () => {
    const result = resolveAnnouncePowerDown([robot()], new Map());
    expect(result.robots[0].announcedPowerDownNextTurn).toBeUndefined();
  });

  it('lets an explicit decline retract an earlier announcement', () => {
    const result = resolveAnnouncePowerDown(
      [robot({ announcedPowerDownNextTurn: true })], new Map([['r1', false]]),
    );
    expect(result.robots[0].announcedPowerDownNextTurn).toBe(false);
  });

  it('skips a destroyed robot — that decision is case (b)', () => {
    const result = resolveAnnouncePowerDown(
      [robot({ destroyed: true })], new Map([['r1', true]]),
    );
    expect(result.robots[0].announcedPowerDownNextTurn).toBeUndefined();
    expect(result.events).toEqual([]);
  });

  it('skips an already powered-down robot — that decision is case (c)', () => {
    const result = resolveAnnouncePowerDown(
      [robot({ poweredDown: true })], new Map([['r1', true]]),
    );
    expect(result.robots[0].announcedPowerDownNextTurn).toBeUndefined();
    expect(result.events).toEqual([]);
  });

  it('handles a table where only some players announce', () => {
    const result = resolveAnnouncePowerDown(
      [robot({ id: 'a' }), robot({ id: 'b' }), robot({ id: 'c' })],
      new Map([['a', true], ['c', true]]),
    );
    expect(result.robots.map((r) => r.announcedPowerDownNextTurn))
      .toEqual([true, undefined, true]);
  });

  it('does not mutate the robots it was given', () => {
    const before = robot();
    resolveAnnouncePowerDown([before], new Map([['r1', true]]));
    expect(before.announcedPowerDownNextTurn).toBeUndefined();
  });
});

describe('End of Turn — case (b), power down on return from destruction', () => {
  const destroyed = () => robot({
    destroyed: true, damage: 10, archiveMarker: { x: 1, y: 1 },
  });

  it('records the choice as an announcement for next turn', () => {
    const result = resolveEndOfTurnEffects(plainGrid(), [destroyed()], {
      returnPowerDownChoices: new Map([['r1', true]]),
    });
    expect(result.robots[0].announcedPowerDownNextTurn).toBe(true);
    expect(result.events).toContainEqual(
      { type: 'announcedPowerDownOnReturn', robotId: 'r1' },
    );
  });

  it('still returns the robot with 2 damage — the discard happens at Deal', () => {
    const result = resolveEndOfTurnEffects(plainGrid(), [destroyed()], {
      returnPowerDownChoices: new Map([['r1', true]]),
    });
    expect(result.robots[0].destroyed).toBe(false);
    expect(result.robots[0].damage).toBe(2);
    expect(result.robots[0].poweredDown).toBeUndefined();
  });

  it('returns the robot normally when it declines', () => {
    const result = resolveEndOfTurnEffects(plainGrid(), [destroyed()], {
      returnPowerDownChoices: new Map([['r1', false]]),
    });
    expect(result.robots[0].announcedPowerDownNextTurn).toBeUndefined();
  });

  it('returns the robot normally when no choice is supplied', () => {
    const result = resolveEndOfTurnEffects(plainGrid(), [destroyed()]);
    expect(result.robots[0].announcedPowerDownNextTurn).toBeUndefined();
    expect(result.robots[0].damage).toBe(2);
  });

  it('ignores the choice for a robot that was not destroyed', () => {
    const result = resolveEndOfTurnEffects(plainGrid(), [robot({ damage: 3 })], {
      returnPowerDownChoices: new Map([['r1', true]]),
    });
    expect(result.robots[0].announcedPowerDownNextTurn).toBeUndefined();
  });
});

describe('all three routes converge on the next Deal', () => {
  it('(a) an announcement at the end of programming powers the robot down', () => {
    const announced = resolveAnnouncePowerDown([robot({ damage: 4 })], new Map([['r1', true]]));
    const dealt = resolveDeal(announced.robots, newDeck(rng), rng);
    expect(dealt.robots[0].poweredDown).toBe(true);
    expect(dealt.robots[0].damage).toBe(0);
    expect(dealt.robots[0].hand).toEqual([]);
  });

  it('(b) a return-from-destruction choice discards the 2 damage at Deal', () => {
    const returned = resolveEndOfTurnEffects(
      plainGrid(),
      [robot({ destroyed: true, damage: 10, archiveMarker: { x: 1, y: 1 } })],
      { returnPowerDownChoices: new Map([['r1', true]]) },
    );
    expect(returned.robots[0].damage).toBe(2);
    const dealt = resolveDeal(returned.robots, newDeck(rng), rng);
    expect(dealt.robots[0].poweredDown).toBe(true);
    expect(dealt.robots[0].damage).toBe(0);
  });

  it('(c) continuing power down keeps the robot down through the next Deal', () => {
    const continued = resolveEndOfTurnEffects(
      plainGrid(), [robot({ poweredDown: true, damage: 6 })],
      { continuePowerDownChoices: new Map([['r1', true]]) },
    );
    expect(continued.robots[0].announcedPowerDownNextTurn).toBe(true);
    const dealt = resolveDeal(continued.robots, newDeck(rng), rng);
    expect(dealt.robots[0].poweredDown).toBe(true);
    expect(dealt.robots[0].damage).toBe(0);
  });

  it('a robot that stops continuing powers up and is dealt against its damage', () => {
    const continued = resolveEndOfTurnEffects(
      plainGrid(), [robot({ poweredDown: true, damage: 6, registers: [null, null, null, null, null] })],
      { continuePowerDownChoices: new Map([['r1', false]]) },
    );
    expect(continued.robots[0].announcedPowerDownNextTurn).toBe(false);
    const dealt = resolveDeal(continued.robots, newDeck(rng), rng);
    expect(dealt.robots[0].poweredDown).toBe(false);
    expect(dealt.robots[0].damage).toBe(6);
    expect(dealt.robots[0].hand).toHaveLength(3);
    // registers 4 and 5 locked but emptied on the way down, so both filled
    expect(dealt.events.filter((e) => e.type === 'lockedRegisterFilled')).toHaveLength(2);
  });
});
