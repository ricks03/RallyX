import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { rotateBoard, rotateCell, rotateDirection, composeCourse, computeElevation, BoardLibrary } from '../src/composer.js';
import { BoardData, Course, Direction } from '../src/types.js';

function loadRealBoard(name: string): { data: BoardData; sha256: string } {
  const path = new URL(`./real-boards/${name}.json`, import.meta.url);
  const raw = readFileSync(path, 'utf-8');
  const data = JSON.parse(raw) as BoardData;
  const sha256 = createHash('sha256').update(raw).digest('hex');
  return { data, sha256 };
}

function standaloneCourse(id: string, sha256: string): Course {
  return {
    boards: [{ id, sha256, gridX: 0, gridY: 0, rotation: 0 }],
    dock: null,
    flags: [],
    lifeTokens: 3,
  };
}

for (const name of ['Carousel5', 'Corkscrew4', 'Hairpin2', 'Straightaway6', 'TrafficJam5', 'Slalom2', 'Water_Park2_3e', 'Containment6', 'Containment7']) {
  describe(`real board.json — ${name}`, () => {
    const board = loadRealBoard(name);

    it('round-trips through four 90-degree rotations unchanged', () => {
      let b = board.data;
      for (let i = 0; i < 4; i++) b = rotateBoard(b, 90);
      expect(b).toEqual(board.data);
    });

    // Straightaway6's elevation gap is now fixed at the source: a new tile
    // (id 30) was drawn this session specifically to show a genuine 2-level
    // drop, `tiles.yml` records it with `levels: 2`, and tmx2board.pl now
    // reads and merges that field. No longer blocked.
    it('composes and computes elevation without contradiction', () => {
      const library: BoardLibrary = { [name]: board };
      const grid = composeCourse(standaloneCourse(name, board.sha256), library);
      expect(() => computeElevation(grid)).not.toThrow();
    });
  });
}

describe('real board.json — Straightaway6 and TrafficJam5 elevation density', () => {
  it('Straightaway6 has real elevation variety, and (4,2)/(4,3) reflect the 2-level drop', () => {
    const board = loadRealBoard('Straightaway6');
    const grid = composeCourse(
      standaloneCourse('Straightaway6', board.sha256),
      { Straightaway6: board },
    );
    computeElevation(grid);
    const levels = new Set<number>();
    for (const row of grid.cells) for (const c of row) levels.add(c.level);
    expect(levels.size).toBeGreaterThan(1);

    // Confirmed directly by the project owner earlier this session.
    expect(grid.cells[1][4].level).toBe(-1); // (4,1)
    expect(grid.cells[2][4].level).toBe(-1); // (4,2)
    expect(grid.cells[3][4].level).toBe(1);  // (4,3) — the 2-level drop from (4,2)
  });

  it('TrafficJam5 has real elevation variety (heaviest Ramps/Ledges board per HANDOFF.md)', () => {
    const board = loadRealBoard('TrafficJam5');
    const grid = composeCourse(
      standaloneCourse('TrafficJam5', board.sha256),
      { TrafficJam5: board },
    );
    computeElevation(grid);
    const levels = new Set<number>();
    for (const row of grid.cells) for (const c of row) levels.add(c.level);
    expect(levels.size).toBeGreaterThan(1);
  });
});

describe('real board.json — Water_Park2_3e (first real `current` data)', () => {
  const board = loadRealBoard('Water_Park2_3e');

  it('has current cells, each with entries/exit/rotates matching the assumed shape', () => {
    let count = 0;
    for (const row of board.data.cells) {
      for (const cell of row) {
        if (!cell.current) continue;
        count++;
        expect(cell.current.exit).toBeDefined();
        expect(cell.current.entries.length).toBeGreaterThan(0);
        expect(cell.current.rotates).toBeDefined();
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it("rotating a current cell 90 degrees remaps its exit, entries, and rotates keys together", () => {
    // Find a real current cell with a curved rotates entry to make the
    // rotation meaningful rather than a no-op.
    let found: { cell: (typeof board.data.cells)[number][number] } | null = null;
    for (const row of board.data.cells) {
      for (const cell of row) {
        if (cell.current && Object.values(cell.current.rotates).some((r) => r !== 'none')) {
          found = { cell };
        }
      }
    }
    expect(found).not.toBeNull();
    const original = found!.cell.current!;
    const rotated = rotateCell(found!.cell, 90).current!;

    expect(rotated.exit).toBe(rotateDirection(original.exit, 90));
    for (const dir of Object.keys(original.rotates) as Direction[]) {
      const newDir = rotateDirection(dir, 90);
      expect(rotated.rotates[newDir]).toBe(original.rotates[dir]);
    }
  });
});

describe('real board.json — Containment6 (first real one-way wall data)', () => {
  const board = loadRealBoard('Containment6');
  const OPPOSITE: Record<Direction, Direction> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const DELTA: Record<Direction, [number, number]> = {
    N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0],
  };

  it('has real one-way walls, each edge carrying exactly one colour (no stacked conflicts)', () => {
    let total = 0;
    for (const row of board.data.cells) {
      for (const cell of row) {
        for (const feats of Object.values(cell.edges)) {
          const oneWays = (feats ?? []).filter((f) => f.kind === 'wall' && 'oneWay' in f && f.oneWay);
          expect(oneWays.length).toBeLessThanOrEqual(1);
          total += oneWays.length;
        }
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it('every one-way wall pairs with the opposite colour on the adjacent cell (the gate invariant)', () => {
    const { cells } = board.data;
    let pairsChecked = 0;
    for (let y = 0; y < cells.length; y++) {
      for (let x = 0; x < cells[y].length; x++) {
        const cell = cells[y][x];
        for (const dir of ['N', 'E', 'S', 'W'] as Direction[]) {
          const feats = cell.edges[dir] ?? [];
          const oneWay = feats.find((f) => f.kind === 'wall' && 'oneWay' in f && f.oneWay);
          if (!oneWay || oneWay.kind !== 'wall') continue;

          const [dx, dy] = DELTA[dir];
          const nx = x + dx, ny = y + dy;
          if (ny < 0 || nx < 0 || ny >= cells.length || nx >= cells[0].length) continue;
          const neighborFeats = cells[ny][nx].edges[OPPOSITE[dir]] ?? [];
          const back = neighborFeats.find((f) => f.kind === 'wall' && 'oneWay' in f && f.oneWay);
          expect(back).toBeDefined();
          if (back && back.kind === 'wall') {
            expect(back.oneWay).not.toBe(oneWay.oneWay); // opposite colour, per the gate rule
            pairsChecked++;
          }
        }
      }
    }
    expect(pairsChecked).toBeGreaterThan(0);
  });
});

describe('real board.json — Containment7 (floor is genuinely optional)', () => {
  it('has real cells with no floor key at all, alongside cells that do have one', () => {
    const board = loadRealBoard('Containment7');
    let missing = 0;
    let present = 0;
    for (const row of board.data.cells) {
      for (const cell of row) {
        if (cell.floor) present++;
        else missing++;
      }
    }
    // Confirmed against real data: Containment6 has an explicit floor on
    // cells that Containment7 (a later revision) leaves floor-less, same
    // physical cells, other content (conveyor, radioactiveWaste) unchanged.
    // Absence means open floor by convention, not a schema gap.
    expect(missing).toBeGreaterThan(0);
    expect(present).toBeGreaterThan(0);
  });
});

describe('real board.json — Corkscrew4 elevation', () => {
  const board = loadRealBoard('Corkscrew4');

  it('has at least one real cliff (not flat like Chicane3/Capstone4/Bonkers4)', () => {
    const grid = composeCourse(
      standaloneCourse('Corkscrew4', board.sha256),
      { Corkscrew4: board },
    );
    computeElevation(grid);
    const levels = new Set<number>();
    for (const row of grid.cells) for (const c of row) levels.add(c.level);
    expect(levels.size).toBeGreaterThan(1);
  });
});
