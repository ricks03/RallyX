import { describe, it, expect } from 'vitest';
import { composeCourse, BoardLibrary } from '../src/composer.js';
import { flatBoard } from './fixtures.js';
import { Course } from '../src/types.js';

describe('composeCourse — flags (RULES_SPEC \u00a71, \u00a77)', () => {
  const library: BoardLibrary = {
    A: { data: flatBoard('A'), sha256: 'fake-A' },
  };

  it('marks the highest-numbered flag as final and skips synthetic repair on it', () => {
    const course: Course = {
      boards: [{ id: 'A', sha256: 'fake-A', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [
        { number: 1, board: 'A', x: 2, y: 3 },
        { number: 2, board: 'A', x: 5, y: 5 },
      ],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);

    const flag1 = grid.cells[3][2];
    const flag2 = grid.cells[5][5];

    expect(flag1.flag).toEqual({ number: 1, isFinal: false });
    expect(flag1.repair).toEqual({ wrenches: 1 }); // synthetic repair

    expect(flag2.flag).toEqual({ number: 2, isFinal: true });
    expect(flag2.repair).toBeUndefined(); // final flag gets no synthetic repair
  });

  it('does not overwrite an existing printed repair site with the synthetic one', () => {
    const board = flatBoard('A');
    board.cells[3][2].repair = { wrenches: 2 };
    const libWithRepair: BoardLibrary = { A: { data: board, sha256: 'fake-A' } };

    const course: Course = {
      boards: [{ id: 'A', sha256: 'fake-A', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [{ number: 1, board: 'A', x: 2, y: 3 }],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, libWithRepair);
    expect(grid.cells[3][2].repair).toEqual({ wrenches: 2 });
  });

  it('throws on a board content-hash mismatch', () => {
    const course: Course = {
      boards: [{ id: 'A', sha256: 'wrong-hash', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    expect(() => composeCourse(course, library)).toThrow(/hash mismatch/);
  });
});
