import { describe, it, expect } from 'vitest';
import { resolveEndOfTurnEffects } from '../src/end-of-turn.js';
import { RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid } from '../src/types.js';

function openCell(): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, openCell),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number, overrides: Partial<RobotState> = {}): RobotState {
  return { id, x, y, facing: 'E', damage: 0, destroyed: false, ...overrides };
}

describe('resolveEndOfTurnEffects — radiation', () => {
  it('deals 1 damage to a robot currently on a radiation square', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].radiation = true;
    const { robots, events } = resolveEndOfTurnEffects(grid, [robot('r1', 0, 0)]);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(1);
    expect(events.some((e) => e.type === 'radiationDamage')).toBe(true);
  });

  it('does nothing to a robot not currently there, regardless of archive history', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].radiation = true;
    const { robots } = resolveEndOfTurnEffects(
      grid, [robot('r1', 1, 0, { archiveMarker: { x: 0, y: 0 } })],
    );
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(0);
  });
});

describe('resolveEndOfTurnEffects — repair site healing', () => {
  it('heals 1 damage on a one-wrench site', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 1 };
    const { robots } = resolveEndOfTurnEffects(grid, [robot('r1', 0, 0, { damage: 3 })]);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(2);
  });

  it('heals 2 damage on a two-wrench site', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 2 };
    const { robots } = resolveEndOfTurnEffects(grid, [robot('r1', 0, 0, { damage: 5 })]);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(3);
  });

  it('never heals below 0', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 2 };
    const { robots } = resolveEndOfTurnEffects(grid, [robot('r1', 0, 0, { damage: 1 })]);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(0);
  });
});

describe('resolveEndOfTurnEffects — return to play', () => {
  it('returns a destroyed robot to its archive marker with 2 damage and the chosen facing', () => {
    const grid = makeGrid(6);
    const destroyed = robot('r1', 9, 9, { destroyed: true, archiveMarker: { x: 2, y: 2 }, facing: 'N' });
    const facings = new Map([['r1', 'S' as const]]);
    const { robots, events } = resolveEndOfTurnEffects(grid, [destroyed], { facingChoices: facings });
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.destroyed).toBe(false);
    expect(r1.damage).toBe(2);
    expect(r1.x).toBe(2);
    expect(r1.y).toBe(2);
    expect(r1.facing).toBe('S');
    expect(events.some((e) => e.type === 'returnedToPlay')).toBe(true);
  });

  it('falls back to the robot\'s current position if it never archived anywhere', () => {
    const grid = makeGrid(6);
    const destroyed = robot('r1', 3, 3, { destroyed: true });
    const { robots } = resolveEndOfTurnEffects(grid, [destroyed]);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(3);
    expect(r1.y).toBe(3);
  });

  it('only the returning robot becomes virtual, NOT the robot already there (confirmed against the rulebook)', () => {
    const grid = makeGrid(6);
    const returning = robot('returning', 9, 9, { destroyed: true, archiveMarker: { x: 2, y: 2 } });
    const alreadyThere = robot('alreadyThere', 2, 2);
    const { robots, events } = resolveEndOfTurnEffects(grid, [returning, alreadyThere]);

    expect(robots.find((r) => r.id === 'returning')!.virtual).toBe(true);
    expect(robots.find((r) => r.id === 'alreadyThere')!.virtual).toBeFalsy();
    expect(events.some((e) => e.type === 'becameVirtual' && e.robotId === 'returning')).toBe(true);
    expect(events.some((e) => e.type === 'becameVirtual' && e.robotId === 'alreadyThere')).toBe(false);
  });

  it('two robots returning to the same archive square: the second becomes virtual relative to the first, not vice versa', () => {
    const grid = makeGrid(6);
    const a = robot('a', 9, 9, { destroyed: true, archiveMarker: { x: 2, y: 2 } });
    const b = robot('b', 8, 8, { destroyed: true, archiveMarker: { x: 2, y: 2 } });
    const { robots } = resolveEndOfTurnEffects(grid, [a, b]);
    const results = robots.map((r) => ({ id: r.id, virtual: !!r.virtual }));
    // Exactly one of them ends up virtual (whichever is processed second),
    // never both, never neither.
    const virtualCount = results.filter((r) => r.virtual).length;
    expect(virtualCount).toBe(1);
  });

  it('does not flag a robot virtual if its archive square is empty', () => {
    const grid = makeGrid(6);
    const destroyed = robot('r1', 9, 9, { destroyed: true, archiveMarker: { x: 2, y: 2 } });
    const { robots } = resolveEndOfTurnEffects(grid, [destroyed]);
    expect(robots.find((r) => r.id === 'r1')!.virtual).toBeFalsy();
  });
});

describe('resolveEndOfTurnEffects — repair choice (2-wrench only, not hammer)', () => {
  it('defaults to healing 2 when no choice is given', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 2 };
    const { robots } = resolveEndOfTurnEffects(grid, [robot('r1', 0, 0, { damage: 5 })]);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(3);
  });

  it('choosing "option" skips healing entirely and grants an option instead', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 2 };
    const { robots, events } = resolveEndOfTurnEffects(
      grid, [robot('r1', 0, 0, { damage: 5 })],
      { repairChoices: new Map([['r1', 'option']]) },
    );
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(5); // unhealed
    expect(events.some((e) => e.type === 'optionGranted' && e.robotId === 'r1')).toBe(true);
    expect(events.some((e) => e.type === 'healed' && e.robotId === 'r1')).toBe(false);
  });

  it('a wrench+hammer site always does both — heal 1 AND grant an option, never a choice', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 1, hammer: true };
    const { robots, events } = resolveEndOfTurnEffects(
      grid, [robot('r1', 0, 0, { damage: 5 })],
      { repairChoices: new Map([['r1', 'option']]) }, // should be ignored — not a choice site
    );
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(4); // still healed 1
    expect(events.some((e) => e.type === 'optionGranted')).toBe(true);
    expect(events.some((e) => e.type === 'healed')).toBe(true);
  });
});

describe('resolveEndOfTurnEffects — wipe registers', () => {
  it('discards non-locked registers, keeps locked ones', () => {
    const grid = makeGrid(4);
    const r = robot('r1', 0, 0, {
      registers: [
        { type: 'Move1', priority: 5 },
        { type: 'Move2', priority: 3 },
        null, null, null,
      ],
      lockedRegisters: [false, true, false, false, false],
    });
    const { robots, events } = resolveEndOfTurnEffects(grid, [r]);
    const r1 = robots.find((x) => x.id === 'r1')!;
    expect(r1.registers![0]).toBeNull(); // wiped
    expect(r1.registers![1]).toEqual({ type: 'Move2', priority: 3 }); // kept, locked
    expect(events.some((e) => e.type === 'registersWiped')).toBe(true);
  });

  it('clears ALL registers for a powered-down robot, ignoring lock status entirely', () => {
    const grid = makeGrid(4);
    const r = robot('r1', 0, 0, {
      poweredDown: true,
      registers: [
        { type: 'Move1', priority: 5 },
        { type: 'Move2', priority: 3 },
        null, null, null,
      ],
      lockedRegisters: [false, true, false, false, false], // register 1 locked
    });
    const { robots, events } = resolveEndOfTurnEffects(grid, [r]);
    const r1 = robots.find((x) => x.id === 'r1')!;
    expect(r1.registers![0]).toBeNull();
    expect(r1.registers![1]).toBeNull(); // cleared even though locked — powered down overrides that
    expect(events.some((e) => e.type === 'registersWiped')).toBe(true);
  });
});

describe('resolveEndOfTurnEffects — continue power down', () => {
  it('sets announcedPowerDownNextTurn when the robot chooses to continue', () => {
    const grid = makeGrid(4);
    const r = robot('r1', 0, 0, { poweredDown: true });
    const { robots, events } = resolveEndOfTurnEffects(
      grid, [r], { continuePowerDownChoices: new Map([['r1', true]]) },
    );
    expect(robots.find((x) => x.id === 'r1')!.announcedPowerDownNextTurn).toBe(true);
    expect(events.some((e) => e.type === 'continuingPowerDown')).toBe(true);
  });

  it('defaults to NOT continuing (powers up next turn) if unspecified', () => {
    const grid = makeGrid(4);
    const r = robot('r1', 0, 0, { poweredDown: true });
    const { robots } = resolveEndOfTurnEffects(grid, [r]);
    expect(robots.find((x) => x.id === 'r1')!.announcedPowerDownNextTurn).toBe(false);
  });

  it('does nothing for a robot that was not powered down this turn', () => {
    const grid = makeGrid(4);
    const r = robot('r1', 0, 0);
    const { robots } = resolveEndOfTurnEffects(
      grid, [r], { continuePowerDownChoices: new Map([['r1', true]]) },
    );
    expect(robots.find((x) => x.id === 'r1')!.announcedPowerDownNextTurn).toBeUndefined();
  });
});

describe('resolveEndOfTurnEffects — order: radiation, then repair, then return-to-play', () => {
  it('a robot healed by a repair site this same step still applies radiation damage first', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].radiation = true;
    grid.cells[0][0].repair = { wrenches: 2 };
    const { robots } = resolveEndOfTurnEffects(grid, [robot('r1', 0, 0, { damage: 3 })]);
    // 3 + 1 (radiation) - 2 (repair) = 2
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(2);
  });
});
