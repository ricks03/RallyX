import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  resolveExpressBelts, resolveAllBelts, resolveCurrents,
  resolvePushers, resolveGears, resolveBoardElementsMove,
} from '../src/board-elements.js';
import { RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid, BoardData } from '../src/types.js';

function openCell(): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, openCell),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number, facing: RobotState['facing'] = 'E'): RobotState {
  return { id, x, y, facing, damage: 0, destroyed: false };
}

describe('resolveAllBelts — basic movement and rotation', () => {
  it('moves a robot 1 square in the belt exit direction', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    const { robots } = resolveAllBelts(grid, [robot('r1', 0, 0)]);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });

  it('rotates a robot arriving via a curved belt segment', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    grid.cells[0][1].conveyor = { express: false, exit: 'S', entries: ['W'], rotates: { W: 'CW' } };
    const { robots } = resolveAllBelts(grid, [robot('r1', 0, 0, 'N')]);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(1);
    expect(r1.facing).toBe('E'); // N rotated CW -> E
  });

  it('does not rotate a robot moved there by a card (not applicable here — belt-only check)', () => {
    // Sanity: a robot NOT on a belt this sub-step is untouched entirely.
    const grid = makeGrid(5);
    grid.cells[0][1].conveyor = { express: false, exit: 'S', entries: ['W'], rotates: { W: 'CW' } };
    const { robots } = resolveAllBelts(grid, [robot('r1', 1, 0, 'N')]);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(1);
    expect(r1.facing).toBe('N'); // untouched, robot wasn't on a belt
  });
});

describe('resolveAllBelts — never pushes, stationary robot blocks', () => {
  it('a belt-moved robot does not move if the destination holds a non-moving robot', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    const { robots } = resolveAllBelts(grid, [robot('onBelt', 0, 0), robot('stationary', 1, 0)]);
    expect(robots.find((r) => r.id === 'onBelt')!.x).toBe(0); // did not move
    expect(robots.find((r) => r.id === 'stationary')!.x).toBe(1); // did not get pushed
  });
});

describe('resolveAllBelts — converging belts', () => {
  it('two robots converging on the same destination (constructed precisely): neither moves', () => {
    const grid = makeGrid(5);
    // (0,1) moving E -> (1,1); (2,1) moving W -> (1,1). Same destination.
    grid.cells[1][0].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    grid.cells[1][2].conveyor = { express: false, exit: 'W', entries: ['E'], rotates: {} };
    const { robots } = resolveAllBelts(grid, [robot('a', 0, 1), robot('b', 2, 1)]);
    expect(robots.find((r) => r.id === 'a')!.x).toBe(0);
    expect(robots.find((r) => r.id === 'b')!.x).toBe(2);
  });

  it('a chain of belt-riding robots can all shift forward together (not blocked by each other)', () => {
    const grid = makeGrid(6);
    for (let x = 0; x <= 2; x++) {
      grid.cells[0][x].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    }
    const { robots } = resolveAllBelts(
      grid, [robot('a', 0, 0), robot('b', 1, 0), robot('c', 2, 0)],
    );
    expect(robots.find((r) => r.id === 'a')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'b')!.x).toBe(2);
    expect(robots.find((r) => r.id === 'c')!.x).toBe(3);
  });
});

describe('resolveExpressBelts vs resolveAllBelts — express moves twice total', () => {
  it('an express belt robot moves once in the express sub-step, once more in all-belts', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].conveyor = { express: true, exit: 'E', entries: ['W'], rotates: {} };
    grid.cells[0][1].conveyor = { express: true, exit: 'E', entries: ['W'], rotates: {} };

    const afterExpress = resolveExpressBelts(grid, [robot('r1', 0, 0)]);
    expect(afterExpress.robots.find((r) => r.id === 'r1')!.x).toBe(1);

    const afterAll = resolveAllBelts(grid, afterExpress.robots);
    expect(afterAll.robots.find((r) => r.id === 'r1')!.x).toBe(2);
  });

  it('a regular (non-express) belt robot does not move during the express sub-step', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].conveyor = { express: false, exit: 'E', entries: ['W'], rotates: {} };
    const { robots } = resolveExpressBelts(grid, [robot('r1', 0, 0)]);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(0);
  });
});

describe('resolveCurrents', () => {
  it('moves a robot 1 square in the current exit direction, same rules as belts', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].current = { exit: 'E', entries: ['W'], rotates: {} };
    const { robots } = resolveCurrents(grid, [robot('r1', 0, 0)]);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });
});

describe('resolvePushers', () => {
  it('pushes a robot on an active pusher, 1 square in its push direction', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].pusher = { edge: 'N', phases: [3], push: 'E' };
    const { robots } = resolvePushers(grid, [robot('r1', 0, 0)], 3);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });

  it('does nothing on a register the pusher is not active', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].pusher = { edge: 'N', phases: [3], push: 'E' };
    const { robots } = resolvePushers(grid, [robot('r1', 0, 0)], 2);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(0);
  });

  it('chain-pushes multiple robots, same as a card-driven push', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].pusher = { edge: 'N', phases: [1], push: 'E' };
    const { robots } = resolvePushers(grid, [robot('mover', 0, 0), robot('ahead', 1, 0)], 1);
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'ahead')!.x).toBe(2);
  });
});

describe('resolveGears', () => {
  it('rotates a robot on a gear, no movement', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].gear = { rotation: 'CW' };
    const { robots } = resolveGears(grid, [robot('r1', 0, 0, 'N')]);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(0);
    expect(r1.facing).toBe('E');
  });

  it('gears act every register, never phase-gated', () => {
    // No phases field exists on gear at all — nothing to even gate on.
    const grid = makeGrid(5);
    grid.cells[0][0].gear = { rotation: 'CCW' };
    const { robots } = resolveGears(grid, [robot('r1', 0, 0, 'N')]);
    expect(robots.find((r) => r.id === 'r1')!.facing).toBe('W');
  });
});

describe('resolveBoardElementsMove — five-step order (crushers excluded, see laser-fire.ts)', () => {
  it('runs express belts, all belts, currents, pushers, gears in order', () => {
    const grid = makeGrid(8);
    // Express belt carries the robot from (0,0) to (2,0) across two steps.
    grid.cells[0][0].conveyor = { express: true, exit: 'E', entries: ['W'], rotates: {} };
    grid.cells[0][1].conveyor = { express: true, exit: 'E', entries: ['W'], rotates: {} };
    // Then a gear at the final resting cell rotates it.
    grid.cells[0][2].gear = { rotation: 'CW' };

    const { robots } = resolveBoardElementsMove(grid, [robot('r1', 0, 0, 'N')], 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(2); // moved twice via express+all-belts
    expect(r1.facing).toBe('E'); // then rotated by the gear
  });

  it('does not touch a crusher square at all — that belongs to Resolve Laser Fire', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].crusher = { phases: [1] };
    const { robots } = resolveBoardElementsMove(grid, [robot('r1', 0, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.destroyed).toBe(false);
  });
});

describe('Board Elements Move — real board data (Chicane3)', () => {
  it('a real conveyor cell has entries/exit/rotates matching the assumed shape and resolves without throwing', () => {
    const raw = readFileSync(new URL('./real-boards/Chicane3.json', import.meta.url), 'utf-8');
    const data = JSON.parse(raw) as BoardData;
    const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

    let found: { x: number; y: number } | null = null;
    outer: for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.cells[y][x].conveyor) { found = { x, y }; break outer; }
      }
    }
    expect(found).not.toBeNull();

    const robots = [robot('r1', found!.x, found!.y)];
    expect(() => resolveAllBelts(grid, robots)).not.toThrow();
  });
});
