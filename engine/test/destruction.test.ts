import { describe, it, expect } from 'vitest';
import { applyDamage, isDestroyed } from '../src/reducer.js';
import { resolveRobotMove, RobotState } from '../src/movement.js';
import { resolveLaserFirePass1 } from '../src/laser-fire.js';
import { resolveEndOfTurnEffects } from '../src/end-of-turn.js';
import { ComposedCell, ComposedGrid } from '../src/types.js';

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

describe('applyDamage', () => {
  it('adds the damage', () => {
    const r = { damage: 3, destroyed: false };
    applyDamage(r, 2);
    expect(r.damage).toBe(5);
  });

  it('leaves a robot alive below 10', () => {
    const r = { damage: 8, destroyed: false };
    expect(applyDamage(r, 1)).toBe(false);
    expect(r.destroyed).toBe(false);
  });

  it('destroys at exactly 10 and reports the kill', () => {
    const r = { damage: 9, destroyed: false };
    expect(applyDamage(r, 1)).toBe(true);
    expect(r.destroyed).toBe(true);
  });

  it('destroys when a single hit overshoots 10', () => {
    const r = { damage: 8, destroyed: false };
    expect(applyDamage(r, 6)).toBe(true);
    expect(r.damage).toBe(14);
  });

  it('does not report a kill for a robot already destroyed', () => {
    const r = { damage: 12, destroyed: true };
    expect(applyDamage(r, 1)).toBe(false);
  });

  it('agrees with isDestroyed', () => {
    expect(isDestroyed(9)).toBe(false);
    expect(isDestroyed(10)).toBe(true);
  });
});

describe('destruction stops movement at once', () => {
  it('kills a robot crossing a spiked wall at 9 damage, before it moves', () => {
    const g = grid((cells) => {
      cells[2][2].edges.N = [{ kind: 'wall', spikes: true }];
    });
    // A spiked wall blocks as well as damaging, so the robot never moves;
    // what matters is that it is destroyed and stays put.
    const result = resolveRobotMove(g, [robot({ damage: 9 })], 'r1', 'N', 1);
    expect(result.robots[0].destroyed).toBe(true);
    expect(result.robots[0].y).toBe(2);
    expect(result.events.some((e) => e.type === 'destroyedByDamage')).toBe(true);
  });

  it('kills a robot on a fall that takes it to 10, leaving it where it fell', () => {
    const g = grid((cells) => {
      cells[2][2].edges.N = [{ kind: 'cliff', drop: 'out', levels: 1 }];
      cells[1][2].level = -1;
    });
    const result = resolveRobotMove(g, [robot({ damage: 8 })], 'r1', 'N', 3);
    const r = result.robots[0];
    expect(r.destroyed).toBe(true);
    expect(r.damage).toBe(10);
    // Destroyed on landing, so it does not carry on with the remaining
    // two squares of the Move 3.
    expect(r.y).toBe(2);
  });

  it('leaves a robot moving normally when the fall does not reach 10', () => {
    const g = grid((cells) => {
      cells[2][2].edges.N = [{ kind: 'cliff', drop: 'out', levels: 1 }];
      cells[1][2].level = -1;
    });
    const result = resolveRobotMove(g, [robot({ damage: 4 })], 'r1', 'N', 1);
    expect(result.robots[0].destroyed).toBe(false);
    expect(result.robots[0].damage).toBe(6);
    expect(result.robots[0].y).toBe(1);
  });
});

describe('destruction from laser fire', () => {
  it('kills a robot whose accumulated damage reaches 10', () => {
    const g = grid((cells) => {
      cells[2][0].edges.E = [{ kind: 'laser', count: 1 }];
    });
    const result = resolveLaserFirePass1(g, [robot({ x: 2, y: 2, damage: 9 })], 1);
    const r = result.robots[0];
    expect(r.destroyed).toBe(true);
    expect(result.events.some((e) => e.type === 'destroyedByDamage')).toBe(true);
  });

  it('judges a robot against the whole pass, not one source at a time', () => {
    // Two beams into the same cell: 8 + 1 + 1 = 10, though neither alone
    // would kill.
    const g = grid((cells) => {
      cells[2][0].edges.E = [{ kind: 'laser', count: 1 }];
      cells[4][2].edges.N = [{ kind: 'laser', count: 1 }];
    });
    const result = resolveLaserFirePass1(g, [robot({ x: 2, y: 2, damage: 8 })], 1);
    expect(result.robots[0].damage).toBe(10);
    expect(result.robots[0].destroyed).toBe(true);
  });

  it('leaves a robot alive below 10', () => {
    const g = grid((cells) => {
      cells[2][0].edges.E = [{ kind: 'laser', count: 1 }];
    });
    const result = resolveLaserFirePass1(g, [robot({ x: 2, y: 2, damage: 5 })], 1);
    expect(result.robots[0].destroyed).toBe(false);
    expect(result.events.some((e) => e.type === 'destroyedByDamage')).toBe(false);
  });
});

describe('destruction from radiation at End of Turn', () => {
  it('kills a robot at 9 damage standing on radiation', () => {
    const g = grid((cells) => { cells[2][2].radiation = true; });
    const result = resolveEndOfTurnEffects(g, [robot({ damage: 9, archiveMarker: { x: 0, y: 0 } })]);
    expect(result.events.some((e) => e.type === 'destroyedByDamage')).toBe(true);
  });

  it('returns that robot to play in the same End of Turn, since radiation runs first', () => {
    const g = grid((cells) => { cells[2][2].radiation = true; });
    const result = resolveEndOfTurnEffects(g, [robot({ damage: 9, archiveMarker: { x: 0, y: 0 } })]);
    const r = result.robots[0];
    expect(r.destroyed).toBe(false);
    expect(r.damage).toBe(2);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('spends a life token when radiation is what killed it', () => {
    const g = grid((cells) => { cells[2][2].radiation = true; });
    const result = resolveEndOfTurnEffects(
      g, [robot({ damage: 9, lives: 3, archiveMarker: { x: 0, y: 0 } })],
    );
    expect(result.robots[0].lives).toBe(2);
  });

  it('leaves a robot below 10 alone', () => {
    const g = grid((cells) => { cells[2][2].radiation = true; });
    const result = resolveEndOfTurnEffects(g, [robot({ damage: 4 })]);
    expect(result.robots[0].damage).toBe(5);
    expect(result.robots[0].destroyed).toBe(false);
  });
});
