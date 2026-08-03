// Small, hand-built synthetic boards for testing the composer/elevation
// algorithms in isolation. These are NOT real converted RoboRally boards —
// once real board.json files are available, replace/supplement with those.

import { BoardCell, BoardData } from '../src/types.js';

function emptyCell(): BoardCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

/** A 12x12 board, all open floor, with a wall on the north edge of the
 * top-left cell (0,0) — used to verify rotation transforms edges correctly. */
export function boardWithCornerWall(): BoardData {
  const cells: BoardCell[][] = Array.from({ length: 12 }, () =>
    Array.from({ length: 12 }, emptyCell),
  );
  cells[0][0] = {
    ...emptyCell(),
    edges: { N: [{ kind: 'wall' }] },
  };
  return { name: 'CornerWallTest', width: 12, height: 12, cells };
}

/** A 12x12 board with a single raised cell at (5,5): a proper closed
 * plateau, bounded by a cliff edge (drop: out — this cell is high) on all
 * four sides, so every bordering cell is consistently 1 level lower. The
 * rest of the board is flat open floor at level 0. */
export function boardWithCliff(): BoardData {
  const cells: BoardCell[][] = Array.from({ length: 12 }, () =>
    Array.from({ length: 12 }, emptyCell),
  );
  cells[5][5] = {
    ...emptyCell(),
    edges: {
      N: [{ kind: 'cliff', drop: 'out' }],
      E: [{ kind: 'cliff', drop: 'out' }],
      S: [{ kind: 'cliff', drop: 'out' }],
      W: [{ kind: 'cliff', drop: 'out' }],
    },
  };
  return { name: 'CliffTest', width: 12, height: 12, cells };
}

export function flatBoard(name = 'Flat'): BoardData {
  const cells: BoardCell[][] = Array.from({ length: 12 }, () =>
    Array.from({ length: 12 }, emptyCell),
  );
  return { name, width: 12, height: 12, cells };
}
