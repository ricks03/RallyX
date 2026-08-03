import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveRobotMove, RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid, BoardData } from '../src/types.js';

function openCell(): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

/** A small NxN grid of open floor, for hand-constructing specific
 * mechanics (push chains, pits) precisely. */
function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, openCell),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number): RobotState {
  return { id, x, y, facing: 'E', damage: 0, destroyed: false };
}

describe('resolveRobotMove — basic movement', () => {
  it('moves freely across open floor', () => {
    const grid = makeGrid(5);
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 3);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(3);
    expect(r1.y).toBe(0);
  });

  it('stops early and does not consume remaining squares once blocked', () => {
    const grid = makeGrid(5);
    grid.cells[0][2].edges.E = [{ kind: 'wall' }];
    const { robots, events } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 4);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(2); // stopped at the wall, not pushed through
    expect(events.some((e) => e.type === 'blocked')).toBe(true);
  });
});

describe('resolveRobotMove — one-way walls (synthetic)', () => {
  it('blocks crossing from the red side', () => {
    const grid = makeGrid(3);
    grid.cells[1][1].edges.E = [{ kind: 'wall', oneWay: 'red' }];
    const { robots, events } = resolveRobotMove(grid, [robot('r1', 1, 1)], 'r1', 'E', 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(1); // did not move
    expect(events.some((e) => e.type === 'blocked')).toBe(true);
  });

  it('allows crossing from the green side', () => {
    const grid = makeGrid(3);
    grid.cells[1][1].edges.E = [{ kind: 'wall', oneWay: 'green' }];
    const { robots } = resolveRobotMove(grid, [robot('r1', 1, 1)], 'r1', 'E', 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(2); // moved through
  });
});

describe('resolveRobotMove — one-way walls (real Containment6 gate)', () => {
  it('finds a real red-side edge and confirms it blocks crossing', () => {
    const raw = readFileSync(
      new URL('./real-boards/Containment6.json', import.meta.url), 'utf-8',
    );
    const data = JSON.parse(raw) as BoardData;
    const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

    let found: { x: number; y: number; dir: 'N' | 'E' | 'S' | 'W' } | null = null;
    outer: for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        for (const dir of ['N', 'E', 'S', 'W'] as const) {
          const feats = grid.cells[y][x].edges[dir] ?? [];
          if (feats.some((f) => f.kind === 'wall' && f.oneWay === 'red')) {
            found = { x, y, dir };
            break outer;
          }
        }
      }
    }
    expect(found).not.toBeNull();

    const { robots } = resolveRobotMove(
      grid, [robot('r1', found!.x, found!.y)], 'r1', found!.dir, 1,
    );
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(found!.x);
    expect(r1.y).toBe(found!.y); // blocked — did not cross the red side
  });
});

describe('resolveRobotMove — push chains', () => {
  it('pushes a single robot ahead of the mover', () => {
    const grid = makeGrid(5);
    const { robots } = resolveRobotMove(
      grid, [robot('mover', 0, 0), robot('pushed', 1, 0)], 'mover', 'E', 1,
    );
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'pushed')!.x).toBe(2);
  });

  it('pushes a chain of two robots together', () => {
    const grid = makeGrid(6);
    const { robots } = resolveRobotMove(
      grid,
      [robot('mover', 0, 0), robot('a', 1, 0), robot('b', 2, 0)],
      'mover', 'E', 1,
    );
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'a')!.x).toBe(2);
    expect(robots.find((r) => r.id === 'b')!.x).toBe(3);
  });

  it('a wall at the end of the chain blocks the whole chain, nothing moves', () => {
    const grid = makeGrid(6);
    grid.cells[0][2].edges.E = [{ kind: 'wall' }]; // blocks b's own attempt to advance
    const { robots, events } = resolveRobotMove(
      grid,
      [robot('mover', 0, 0), robot('a', 1, 0), robot('b', 2, 0)],
      'mover', 'E', 1,
    );
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(0);
    expect(robots.find((r) => r.id === 'a')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'b')!.x).toBe(2);
    expect(events.some((e) => e.type === 'blocked' && e.robotId === 'mover')).toBe(true);
  });

  it('a pushed robot can be destroyed by falling into a pit, clearing the way', () => {
    const grid = makeGrid(5);
    grid.cells[0][2].floor = { kind: 'pit' };
    const { robots } = resolveRobotMove(
      grid, [robot('mover', 0, 0), robot('pushed', 1, 0)], 'mover', 'E', 1,
    );
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'pushed')!.destroyed).toBe(true);
  });
});

describe('resolveRobotMove — pits and off-board', () => {
  it('destroys a robot that moves onto a pit, and ends its movement there', () => {
    const grid = makeGrid(5);
    grid.cells[0][1].floor = { kind: 'pit' };
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 3);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.destroyed).toBe(true);
    expect(r1.x).toBe(0); // never actually recorded as moving onto the pit square
  });

  it('destroys a robot that moves off the edge of the board', () => {
    const grid = makeGrid(3);
    const { robots } = resolveRobotMove(grid, [robot('r1', 2, 0)], 'r1', 'E', 1);
    expect(robots.find((r) => r.id === 'r1')!.destroyed).toBe(true);
  });
});

describe('resolveRobotMove — portals (real Chicane3 data)', () => {
  it('relocates a robot to the paired portal cell', () => {
    const raw = readFileSync(
      new URL('./real-boards/Chicane3.json', import.meta.url), 'utf-8',
    );
    const data = JSON.parse(raw) as BoardData;
    const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

    let source: { x: number; y: number } | null = null;
    let colour = '';
    outer: for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.cells[y][x].portal) {
          source = { x, y };
          colour = grid.cells[y][x].portal!.colour;
          break outer;
        }
      }
    }
    expect(source).not.toBeNull();

    // Place the robot one square away (in whichever direction is in
    // bounds) so its first step lands it on the portal.
    const approachDir = source!.x > 0 ? 'E' : 'S';
    const startX = approachDir === 'E' ? source!.x - 1 : source!.x;
    const startY = approachDir === 'E' ? source!.y : source!.y - 1;

    const { robots } = resolveRobotMove(grid, [robot('r1', startX, startY)], 'r1', approachDir, 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    // It should have landed somewhere with that same portal colour, but NOT
    // on the source cell itself (i.e. it actually teleported).
    expect(grid.cells[r1.y][r1.x].portal?.colour).toBe(colour);
    expect(r1.x === source!.x && r1.y === source!.y).toBe(false);
  });
});

describe('resolveRobotMove — spiked walls', () => {
  it('deals damage on collision even though the move is blocked', () => {
    const grid = makeGrid(3);
    grid.cells[1][1].edges.E = [{ kind: 'wall', spikes: true }];
    const { robots, events } = resolveRobotMove(grid, [robot('r1', 1, 1)], 'r1', 'E', 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(1); // blocked, no net movement
    expect(r1.damage).toBe(1); // but still took spike damage
    expect(events.some((e) => e.type === 'spikeDamage')).toBe(true);
  });
});
