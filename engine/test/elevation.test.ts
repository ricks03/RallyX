import { describe, it, expect } from 'vitest';
import { composeCourse, computeElevation, BoardLibrary } from '../src/composer.js';
import { boardWithCliff, flatBoard } from './fixtures.js';
import { BoardDataError, ComposedGrid, Course } from '../src/types.js';

function libraryOf(boards: Record<string, ReturnType<typeof flatBoard>>): BoardLibrary {
  const lib: BoardLibrary = {};
  for (const [id, data] of Object.entries(boards)) {
    lib[id] = { data, sha256: `fake-${id}` };
  }
  return lib;
}

describe('computeElevation — ridge (net-zero, both-directions-blocking)', () => {
  it('a ridge edge contributes no level change', () => {
    const grid: ComposedGrid = {
      width: 2,
      height: 1,
      cells: [
        [
          { level: 0, edges: { E: [{ kind: 'cliff', drop: 'out', ridge: true }] }, floor: { kind: 'open' } },
          { level: 0, edges: {}, floor: { kind: 'open' } },
        ],
      ],
    };
    computeElevation(grid);
    expect(grid.cells[0][0].level).toBe(0);
    expect(grid.cells[0][1].level).toBe(0);
  });
});

describe('computeElevation — multi-level cliffs', () => {
  it('a cliff with levels: 2 produces a 2-level drop, confirmed against real Straightaway6 numbers', () => {
    // Mirrors the real (4,1)->(4,2)->(4,3) relationship: (0,0) reference at
    // 0, a plain 1-level cliff takes (0,1) to -1, then a levels:2 cliff
    // takes (0,2) to -1 + 2 = 1 — matching the real confirmed values.
    const grid: ComposedGrid = {
      width: 1,
      height: 3,
      cells: [
        [{ level: 0, edges: { S: [{ kind: 'cliff', drop: 'out' }] }, floor: { kind: 'open' } }],
        [{ level: 0, edges: { S: [{ kind: 'cliff', drop: 'in', levels: 2 }] }, floor: { kind: 'open' } }],
        [{ level: 0, edges: {}, floor: { kind: 'open' } }],
      ],
    };
    computeElevation(grid);
    expect(grid.cells[0][0].level).toBe(0);
    expect(grid.cells[1][0].level).toBe(-1);
    expect(grid.cells[2][0].level).toBe(1);
  });

  it('an absent levels field still defaults to a plain 1-level drop', () => {
    const grid: ComposedGrid = {
      width: 1,
      height: 2,
      cells: [
        [{ level: 0, edges: { S: [{ kind: 'cliff', drop: 'in' }] }, floor: { kind: 'open' } }],
        [{ level: 0, edges: {}, floor: { kind: 'open' } }],
      ],
    };
    computeElevation(grid);
    expect(grid.cells[1][0].level).toBe(1);
  });
});

describe('computeElevation', () => {
  it('assigns level 0 to a fully flat board', () => {
    const board = flatBoard('Flat');
    const course: Course = {
      boards: [{ id: 'Flat', sha256: 'fake-Flat', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, libraryOf({ Flat: board }));
    computeElevation(grid);
    expect(grid.cells.every((row) => row.every((c) => c.level === 0))).toBe(true);
  });

  it('propagates a cliff drop across the edge', () => {
    const board = boardWithCliff();
    const course: Course = {
      boards: [{ id: 'Cliff', sha256: 'fake-Cliff', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, libraryOf({ Cliff: board }));
    computeElevation(grid);

    // (0,0) is the BFS reference at level 0. (5,5) is a raised plateau
    // (drop: out on all four sides), so it comes out 1 higher than the flat
    // sea surrounding it — including (5,6), its southern neighbor.
    expect(grid.cells[0][0].level).toBe(0);
    expect(grid.cells[5][5].level).toBe(1);
    expect(grid.cells[6][5].level).toBe(0);
  });

  it('throws on an elevation contradiction (a cliff loop that does not sum to zero)', () => {
    // A direct 2x2 grid, bypassing composeCourse, so the contradiction is
    // unambiguous: going around the loop (0,0)->(1,0)->(1,1) and
    // (0,0)->(0,1)->(1,1) disagrees about (1,1)'s level.
    const grid: ComposedGrid = {
      width: 2,
      height: 2,
      cells: [
        [
          { level: 0, edges: { E: [{ kind: 'cliff', drop: 'out' }], S: [{ kind: 'cliff', drop: 'in' }] }, floor: { kind: 'open' } },
          { level: 0, edges: { S: [{ kind: 'cliff', drop: 'out' }] }, floor: { kind: 'open' } },
        ],
        [
          { level: 0, edges: { E: [{ kind: 'cliff', drop: 'out' }] }, floor: { kind: 'open' } },
          { level: 0, edges: {}, floor: { kind: 'open' } },
        ],
      ],
    };

    expect(() => computeElevation(grid)).toThrow(BoardDataError);
  });
});
