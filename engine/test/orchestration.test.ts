import { describe, it, expect } from 'vitest';
import {
  resolveProgramCard, resolveRegister, clearVirtualIfSeparated,
} from '../src/orchestration.js';
import { RobotState, ProgramCard } from '../src/movement.js';
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

function card(type: ProgramCard['type'], priority = 1): ProgramCard {
  return { type, priority };
}

describe('resolveProgramCard — basic movement and rotation', () => {
  it('Move1 moves the robot 1 square in its facing direction', () => {
    const grid = makeGrid(5);
    const { robots } = resolveProgramCard(grid, [robot('r1', 0, 0, { facing: 'E' })], 'r1', card('Move1'));
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });

  it('BackUp moves 1 square OPPOSITE the facing direction, facing unchanged', () => {
    const grid = makeGrid(5);
    const { robots } = resolveProgramCard(grid, [robot('r1', 2, 0, { facing: 'E' })], 'r1', card('BackUp'));
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(1);
    expect(r1.facing).toBe('E');
  });

  it('RotateRight/Left/UTurn change facing with no movement', () => {
    const grid = makeGrid(5);
    const right = resolveProgramCard(grid, [robot('r1', 2, 2, { facing: 'N' })], 'r1', card('RotateRight'));
    expect(right.robots.find((r) => r.id === 'r1')!.facing).toBe('E');
    expect(right.robots.find((r) => r.id === 'r1')!.x).toBe(2);

    const left = resolveProgramCard(grid, [robot('r1', 2, 2, { facing: 'N' })], 'r1', card('RotateLeft'));
    expect(left.robots.find((r) => r.id === 'r1')!.facing).toBe('W');

    const uturn = resolveProgramCard(grid, [robot('r1', 2, 2, { facing: 'N' })], 'r1', card('UTurn'));
    expect(uturn.robots.find((r) => r.id === 'r1')!.facing).toBe('S');
  });
});

describe('resolveProgramCard — terrain integration', () => {
  it('oil at the start reduces Move2 to Move1', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].terrain = ['oil'];
    const { robots } = resolveProgramCard(grid, [robot('r1', 0, 0)], 'r1', card('Move2'));
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });

  it('slime fully fizzles a Rotate card — no rotation happens at all', () => {
    const grid = makeGrid(5);
    grid.cells[2][2].terrain = ['slime'];
    const { robots } = resolveProgramCard(
      grid, [robot('r1', 2, 2, { facing: 'N' })], 'r1', card('RotateRight'),
    );
    expect(robots.find((r) => r.id === 'r1')!.facing).toBe('N'); // unchanged, card discarded
  });

  it('a rotate on gravel slides 1 square in the ORIGINAL facing direction', () => {
    const grid = makeGrid(5);
    grid.cells[2][2].terrain = ['gravel'];
    const { robots } = resolveProgramCard(
      grid, [robot('r1', 2, 2, { facing: 'E' })], 'r1', card('RotateRight'),
    );
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.facing).toBe('S'); // rotated
    expect(r1.x).toBe(3); // AND slid east (original facing), per tiles.yml's own example
  });

  it('ending a Move on oil triggers the continued end-of-move slide', () => {
    const grid = makeGrid(6);
    grid.cells[0][2].terrain = ['oil']; // robot lands here after Move2
    const { robots } = resolveProgramCard(grid, [robot('r1', 0, 0)], 'r1', card('Move2'));
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(3); // 2 (move) + 1 (oil momentum)
  });

  it('a Move3 that enters sand mid-move stops at the first sand square', () => {
    const grid = makeGrid(6);
    grid.cells[0][1].terrain = ['sand'];
    const { robots } = resolveProgramCard(grid, [robot('r1', 0, 0)], 'r1', card('Move3'));
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1); // stopped, not 3
  });
});

describe('clearVirtualIfSeparated', () => {
  it('clears virtual and stays in place (not the archive marker) once no longer sharing', () => {
    const robots = [robot('r1', 5, 5, { virtual: true, archiveMarker: { x: 0, y: 0 }, facing: 'S' })];
    const { robots: after, events } = clearVirtualIfSeparated(robots);
    const r1 = after.find((r) => r.id === 'r1')!;
    expect(r1.virtual).toBe(false);
    expect(r1.x).toBe(5); // stayed exactly where it was — NOT snapped to archiveMarker (0,0)
    expect(r1.y).toBe(5);
    expect(r1.facing).toBe('S'); // kept its current facing
    expect(events.some((e) => e.type === 'becameReal')).toBe(true);
  });

  it('stays virtual if still sharing a square with another robot', () => {
    const robots = [robot('a', 3, 3, { virtual: true }), robot('b', 3, 3)];
    const { robots: after } = clearVirtualIfSeparated(robots);
    expect(after.find((r) => r.id === 'a')!.virtual).toBe(true);
  });
});

describe('resolveRegister — priority order', () => {
  it('the higher-priority card resolves first, pushing the lower-priority robot out of the way', () => {
    const grid = makeGrid(6);
    const mover = robot('mover', 0, 0, {
      registers: [null, null, card('Move1', 10)],
    });
    const inTheWay = robot('inTheWay', 1, 0, {
      registers: [null, null, card('Move1', 1)], // lower priority, moves the SAME register but later
    });
    const { robots } = resolveRegister(grid, [mover, inTheWay], 3, true);
    // mover (priority 10) goes first, pushes inTheWay from (1,0) to (2,0);
    // inTheWay then executes its own Move1 (priority 1) from its NEW position.
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'inTheWay')!.x).toBe(3);
  });

  it('a robot with no card for this register does nothing that register', () => {
    const grid = makeGrid(6);
    const r = robot('r1', 0, 0, { registers: [card('Move1', 5), null, null, null, null] });
    const { robots } = resolveRegister(grid, [r], 2, true); // register 2 is null
    expect(robots.find((x) => x.id === 'r1')!.x).toBe(0);
  });
});

describe('resolveRegister — full pipeline integration', () => {
  it('a robot moving onto a flag touches it via step E, in the same register call', () => {
    const grid = makeGrid(6);
    grid.cells[0][1].flag = { number: 1, isFinal: false };
    const r = robot('r1', 0, 0, { registers: [card('Move1', 1), null, null, null, null] });
    const { robots } = resolveRegister(grid, [r], 1, true);
    expect(robots.find((x) => x.id === 'r1')!.lastTouchedFlag).toBe(1);
  });

  it('victory propagates as winnerId through the full register pipeline', () => {
    const grid = makeGrid(6);
    grid.cells[0][1].flag = { number: 1, isFinal: true };
    const r = robot('r1', 0, 0, {
      lastTouchedFlag: 0,
      registers: [null, null, null, null, card('Move1', 1)],
    });
    const { winnerId } = resolveRegister(grid, [r], 5, true);
    expect(winnerId).toBe('r1');
  });

  it('board elements move (a conveyor) applies after step B, within the same register call', () => {
    const grid = makeGrid(6);
    grid.cells[0][1].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    const r = robot('r1', 0, 0, { registers: [card('Move1', 1), null, null, null, null] });
    const { robots } = resolveRegister(grid, [r], 1, true);
    // Move1 to (1,0), then the belt there carries it to (2,0).
    expect(robots.find((x) => x.id === 'r1')!.x).toBe(2);
  });
});

describe('resolveRegister — Virtual Mode clearing wired in correctly', () => {
  it('skips clearing entirely when skipVirtualClearing is true (turn 1)', () => {
    const grid = makeGrid(6);
    const r = robot('r1', 3, 3, { virtual: true, registers: [null, null, null, null, null] });
    const { robots } = resolveRegister(grid, [r], 1, true);
    expect(robots.find((x) => x.id === 'r1')!.virtual).toBe(true);
  });

  it('clears a separated virtual robot when skipVirtualClearing is false', () => {
    const grid = makeGrid(6);
    const r = robot('r1', 3, 3, { virtual: true, registers: [null, null, null, null, null] });
    const { robots } = resolveRegister(grid, [r], 2, false);
    expect(robots.find((x) => x.id === 'r1')!.virtual).toBe(false);
  });
});
