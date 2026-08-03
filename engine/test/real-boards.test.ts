import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { rotateBoard, composeCourse, computeElevation, BoardLibrary } from '../src/composer.js';
import { BoardData, Course } from '../src/types.js';

function loadRealBoard(name: string): { data: BoardData; sha256: string } {
  const path = new URL(`./real-boards/${name}.json`, import.meta.url);
  const raw = readFileSync(path, 'utf-8');
  const data = JSON.parse(raw) as BoardData;
  const sha256 = createHash('sha256').update(raw).digest('hex');
  return { data, sha256 };
}

describe('real board.json — Chicane3', () => {
  const chicane3 = loadRealBoard('Chicane3');

  it('round-trips through four 90-degree rotations unchanged', () => {
    let board = chicane3.data;
    for (let i = 0; i < 4; i++) board = rotateBoard(board, 90);
    expect(board).toEqual(chicane3.data);
  });

  it('composes as a standalone course and computes elevation without contradiction', () => {
    const library: BoardLibrary = { Chicane3: chicane3 };
    const course: Course = {
      boards: [{ id: 'Chicane3', sha256: chicane3.sha256, gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);
    expect(() => computeElevation(grid)).not.toThrow();
    // Chicane3 has no cliff/stuntRamp edges (confirmed by inspecting the
    // real file directly), so every cell should end up flat.
    expect(grid.cells.every((row) => row.every((c) => c.level === 0))).toBe(true);
  });

  it('rejects a stale content hash', () => {
    const library: BoardLibrary = { Chicane3: chicane3 };
    const course: Course = {
      boards: [{ id: 'Chicane3', sha256: 'not-the-real-hash', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    expect(() => composeCourse(course, library)).toThrow(/hash mismatch/);
  });
});

describe('real board.json — Capstone4', () => {
  const capstone4 = loadRealBoard('Capstone4');

  it('round-trips through four 90-degree rotations unchanged', () => {
    let board = capstone4.data;
    for (let i = 0; i < 4; i++) board = rotateBoard(board, 90);
    expect(board).toEqual(capstone4.data);
  });

  it('composes and computes elevation without contradiction (also flat, no cliffs present)', () => {
    const library: BoardLibrary = { Capstone4: capstone4 };
    const course: Course = {
      boards: [{ id: 'Capstone4', sha256: capstone4.sha256, gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);
    expect(() => computeElevation(grid)).not.toThrow();
    expect(grid.cells.every((row) => row.every((c) => c.level === 0))).toBe(true);
  });
});

describe('real board.json — two boards composed together', () => {
  it('places Chicane3 and Capstone4 side by side without lattice overlap', () => {
    const chicane3 = loadRealBoard('Chicane3');
    const capstone4 = loadRealBoard('Capstone4');
    const library: BoardLibrary = { Chicane3: chicane3, Capstone4: capstone4 };
    const course: Course = {
      boards: [
        { id: 'Chicane3', sha256: chicane3.sha256, gridX: 0, gridY: 0, rotation: 0 },
        { id: 'Capstone4', sha256: capstone4.sha256, gridX: 0, gridY: 1, rotation: 180 },
      ],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);
    expect(grid.width).toBe(12);
    expect(grid.height).toBe(24);
    expect(() => computeElevation(grid)).not.toThrow();
  });
});

describe('real board.json — Chicane3 portals', () => {
  it('every portal colour appears in exactly one pair', () => {
    const chicane3 = loadRealBoard('Chicane3');
    const byColour = new Map<string, number>();
    for (const row of chicane3.data.cells) {
      for (const cell of row) {
        if (cell.portal) {
          byColour.set(cell.portal.colour, (byColour.get(cell.portal.colour) ?? 0) + 1);
        }
      }
    }
    expect(byColour.size).toBeGreaterThan(0);
    for (const count of byColour.values()) expect(count).toBe(2);
  });
});

describe('real board.json — Rolling3 (real cliffs + stunt ramps)', () => {
  const rolling3 = loadRealBoard('Rolling3');

  it('round-trips through four 90-degree rotations unchanged', () => {
    let board = rolling3.data;
    for (let i = 0; i < 4; i++) board = rotateBoard(board, 90);
    expect(board).toEqual(rolling3.data);
  });

  it('computes real elevation without contradiction, matching confirmed values', () => {
    const library: BoardLibrary = { Rolling3: rolling3 };
    const course: Course = {
      boards: [{ id: 'Rolling3', sha256: rolling3.sha256, gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);
    expect(() => computeElevation(grid)).not.toThrow();

    // Confirmed directly against the real board by the project owner:
    // the ramp cell shares its entry-side neighbor's level (0), the valley
    // beyond its exit is 1 level down, and (0,2)/(1,2) are the same level
    // despite having no cliff edge directly between them.
    expect(grid.cells[1][0].level).toBe(0);  // (0,1) — the ramp itself
    expect(grid.cells[2][0].level).toBe(-1); // (0,2)
    expect(grid.cells[2][1].level).toBe(-1); // (1,2) — same as (0,2)
    expect(grid.cells[5][0].level).toBe(0);  // (0,5) — second ramp's entry side

    const levels = new Set<number>();
    for (const row of grid.cells) for (const c of row) levels.add(c.level);
    expect(levels.size).toBeGreaterThan(1);
  });

  it('a ramp edge costs the documented extra move, a plain cliff has none', () => {
    let sawRamp = false;
    let sawPlainCliff = false;
    for (const row of rolling3.data.cells) {
      for (const cell of row) {
        for (const feats of Object.values(cell.edges)) {
          for (const f of feats ?? []) {
            if (f.kind === 'cliff') {
              if (f.ramp) { sawRamp = true; expect(f.ramp.extraMoves).toBeGreaterThanOrEqual(1); }
              else sawPlainCliff = true;
            }
          }
        }
      }
    }
    expect(sawRamp).toBe(true);
    expect(sawPlainCliff).toBe(true);
  });
});

describe('real board.json — Bonkers4 (repulsor, teleporter, chop shop)', () => {
  const bonkers4 = loadRealBoard('Bonkers4');

  it('round-trips through four 90-degree rotations unchanged', () => {
    let board = bonkers4.data;
    for (let i = 0; i < 4; i++) board = rotateBoard(board, 90);
    expect(board).toEqual(bonkers4.data);
  });

  it('composes and computes elevation without contradiction', () => {
    const library: BoardLibrary = { Bonkers4: bonkers4 };
    const course: Course = {
      boards: [{ id: 'Bonkers4', sha256: bonkers4.sha256, gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);
    expect(() => computeElevation(grid)).not.toThrow();
  });

  it('has at least one repulsor edge, teleporter, and chop shop (sanity check on the fixture itself)', () => {
    let repulsors = 0, teleporters = 0, chopShops = 0;
    for (const row of bonkers4.data.cells) {
      for (const cell of row) {
        if (cell.teleporter) teleporters++;
        if (cell.chopShop) chopShops++;
        for (const feats of Object.values(cell.edges)) {
          for (const f of feats ?? []) if (f.kind === 'repulsor') repulsors++;
        }
      }
    }
    expect(repulsors).toBeGreaterThan(0);
    expect(teleporters).toBeGreaterThan(0);
    expect(chopShops).toBeGreaterThan(0);
  });
});
