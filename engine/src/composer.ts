import {
  BoardCell, BoardData, BoardDataError, CliffEdge, ComposedCell, ComposedGrid,
  Course, CourseBoardRef, Direction, Rotation,
} from './types.js';

// ============================================================
// Rotation
// ============================================================

const CW_ORDER: Direction[] = ['N', 'E', 'S', 'W'];

/** Rotate a single compass direction clockwise by `rotation` degrees. */
export function rotateDirection(dir: Direction, rotation: Rotation): Direction {
  const steps = rotation / 90;
  const i = CW_ORDER.indexOf(dir);
  return CW_ORDER[(i + steps) % 4] as Direction;
}

function rotateDirections(dirs: Direction[], rotation: Rotation): Direction[] {
  return dirs.map((d) => rotateDirection(d, rotation));
}

/** Rotate a Partial<Record<Direction, T>> keyed by direction (e.g.
 * conveyor/current `rotates`) by remapping its keys under rotation. */
function rotateDirectionKeyedMap<T>(
  map: Partial<Record<Direction, T>> | undefined,
  rotation: Rotation,
): Partial<Record<Direction, T>> | undefined {
  if (!map) return map;
  const out: Partial<Record<Direction, T>> = {};
  for (const [dir, value] of Object.entries(map) as [Direction, T][]) {
    out[rotateDirection(dir, rotation)] = value;
  }
  return out;
}

/** Rotate every directional field on a single cell. Board-relative concepts
 * that aren't compass directions (gear spin, drop polarity) are untouched,
 * per RULES_SPEC \u00a71. */
export function rotateCell(cell: BoardCell, rotation: Rotation): BoardCell {
  if (rotation === 0) return cell;

  const newEdges: BoardCell['edges'] = {};
  for (const [dir, features] of Object.entries(cell.edges) as [Direction, BoardCell['edges'][Direction]][]) {
    if (!features) continue;
    const rotated = rotateDirection(dir, rotation);
    newEdges[rotated] = features.map((f) => ({ ...f }));
  }

  return {
    ...cell,
    edges: newEdges,
    conveyor: cell.conveyor && {
      ...cell.conveyor,
      exit: rotateDirection(cell.conveyor.exit, rotation),
      entries: rotateDirections(cell.conveyor.entries, rotation),
      rotates: rotateDirectionKeyedMap(cell.conveyor.rotates, rotation) ?? {},
    },
    current: cell.current && {
      ...cell.current,
      exit: rotateDirection(cell.current.exit, rotation),
      entries: rotateDirections(cell.current.entries, rotation),
      rotates: rotateDirectionKeyedMap(cell.current.rotates, rotation) ?? {},
    },
    pusher: cell.pusher && {
      ...cell.pusher,
      edge: rotateDirection(cell.pusher.edge, rotation),
      push: rotateDirection(cell.pusher.push, rotation),
    },
    stuntRamp: cell.stuntRamp && {
      entry: rotateDirection(cell.stuntRamp.entry, rotation),
      exit: rotateDirection(cell.stuntRamp.exit, rotation),
    },
    beams: cell.beams?.map((b) => ({ ...b, along: rotateDirection(b.along, rotation) })),
    // gear.rotation (CW/CCW) is a spin direction, not a compass direction —
    // unaffected by board rotation.
  };
}

/** Rotate an entire NxN board's cell grid (position + per-cell fields). */
export function rotateBoard(board: BoardData, rotation: Rotation): BoardData {
  if (rotation === 0) return board;
  if (board.width !== board.height) {
    throw new BoardDataError(
      `rotateBoard requires a square board; got ${board.width}x${board.height}`,
    );
  }
  const n = board.width;
  const steps = rotation / 90;
  const out: BoardCell[][] = Array.from({ length: n }, () => new Array(n));

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let nx = x;
      let ny = y;
      // one 90deg-clockwise position step, applied `steps` times
      for (let s = 0; s < steps; s++) {
        const px = nx;
        const py = ny;
        nx = n - 1 - py;
        ny = px;
      }
      out[ny][nx] = rotateCell(board.cells[y][x], rotation);
    }
  }

  return { ...board, cells: out };
}

// ============================================================
// Placement / flattening
// ============================================================

const BOARD_SIZE = 12;

export interface BoardLibrary {
  [boardId: string]: { data: BoardData; sha256: string };
}

function checkHash(ref: CourseBoardRef, lib: BoardLibrary) {
  const entry = lib[ref.id];
  if (!entry) throw new BoardDataError(`Course references unknown board "${ref.id}"`);
  if (entry.sha256 !== ref.sha256) {
    throw new BoardDataError(
      `Board "${ref.id}" content hash mismatch — course was authored against a ` +
      `different version of this board than the one currently in the library.`,
    );
  }
  return entry.data;
}

function emptyCell(): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

/** Flatten a course's boards (and optional dock) into one absolute grid,
 * applying rotation, then attach flags and synthesize non-final-flag repair
 * sites. Elevation is computed separately by `computeElevation`. */
export function composeCourse(course: Course, library: BoardLibrary): ComposedGrid {
  const allRefs = course.dock ? [...course.boards, course.dock] : course.boards;

  let maxX = 0;
  let maxY = 0;
  for (const ref of allRefs) {
    maxX = Math.max(maxX, (ref.gridX + 1) * BOARD_SIZE);
    maxY = Math.max(maxY, (ref.gridY + 1) * BOARD_SIZE);
  }

  const grid: ComposedCell[][] = Array.from({ length: maxY }, () =>
    Array.from({ length: maxX }, emptyCell),
  );

  const occupied = new Set<string>();
  for (const ref of allRefs) {
    const boardData = checkHash(ref, library);
    if (boardData.width !== BOARD_SIZE || boardData.height !== BOARD_SIZE) {
      throw new BoardDataError(
        `Board "${ref.id}" is ${boardData.width}x${boardData.height}, expected ${BOARD_SIZE}x${BOARD_SIZE}`,
      );
    }
    const key = `${ref.gridX},${ref.gridY}`;
    if (occupied.has(key)) {
      throw new BoardDataError(`Two boards placed at the same lattice position ${key}`);
    }
    occupied.add(key);

    const rotated = rotateBoard(boardData, ref.rotation);
    const originX = ref.gridX * BOARD_SIZE;
    const originY = ref.gridY * BOARD_SIZE;
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        grid[originY + y][originX + x] = { ...rotated.cells[y][x] };
      }
    }
  }

  const finalFlagNumber = Math.max(0, ...course.flags.map((f) => f.number));
  for (const flag of course.flags) {
    const boardRef = allRefs.find((r) => r.id === flag.board);
    if (!boardRef) {
      throw new BoardDataError(`Flag ${flag.number} references unplaced board "${flag.board}"`);
    }
    // Translate the flag's board-relative coordinate through that board's
    // own rotation before placing it on the absolute grid.
    const rotatedPos = rotatePointInBoard(flag.x, flag.y, BOARD_SIZE, boardRef.rotation);
    const absX = boardRef.gridX * BOARD_SIZE + rotatedPos.x;
    const absY = boardRef.gridY * BOARD_SIZE + rotatedPos.y;
    const cell = grid[absY]?.[absX];
    if (!cell) throw new BoardDataError(`Flag ${flag.number} lands outside the composed grid`);

    const isFinal = flag.number === finalFlagNumber;
    cell.flag = { number: flag.number, isFinal };
    if (!isFinal && !cell.repair) {
      // Synthetic 1-wrench repair site, per RULES_SPEC \u00a77 — a game rule,
      // independent of whatever the underlying board art draws here.
      cell.repair = { wrenches: 1 };
    }
  }

  return { width: maxX, height: maxY, cells: grid };
}

function rotatePointInBoard(x: number, y: number, n: number, rotation: Rotation) {
  const steps = rotation / 90;
  let nx = x;
  let ny = y;
  for (let s = 0; s < steps; s++) {
    const px = nx;
    const py = ny;
    nx = n - 1 - py;
    ny = px;
  }
  return { x: nx, y: ny };
}

// ============================================================
// Elevation ("level") computation — RULES_SPEC \u00a71
// ============================================================

const OPPOSITE: Record<Direction, Direction> = { N: 'S', S: 'N', E: 'W', W: 'E' };
const DELTA: Record<Direction, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  S: { dx: 0, dy: 1 },
  E: { dx: 1, dy: 0 },
  W: { dx: -1, dy: 0 },
};

/** Walk the composed grid and assign every cell a real, absolute `level`,
 * mutating the grid in place. Throws BoardDataError if the same cell is
 * reachable at two different levels — a genuine authoring inconsistency.
 *
 * Stunt ramp elevation, confirmed against real Rolling3.json data (not
 * assumed): a ramp cell's own level equals its entry-side neighbor's level
 * (landing on it normally is an ordinary, damage-free same-level step). Its
 * other sides — including exit — are NOT assumed same-level; their real
 * elevation comes entirely from whatever explicit `cliff` edges exist there.
 * A ramp side with no explicit cliff and no entry relationship is left
 * unresolved by that edge (see `elevationDelta`'s `null` return) — such a
 * cell must get its level from some other path in the grid, or it keeps
 * whatever level it's otherwise reached at (or the default 0, if genuinely
 * unreachable in elevation terms).
 */
export function computeElevation(grid: ComposedGrid): void {
  const { width, height, cells } = grid;
  const levelKnown: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  const queue: Array<{ x: number; y: number }> = [];

  if (height === 0 || width === 0) return;
  cells[0][0].level = 0;
  levelKnown[0][0] = true;
  queue.push({ x: 0, y: 0 });

  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    const cell = cells[y][x];

    for (const dir of CW_ORDER) {
      const { dx, dy } = DELTA[dir];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const delta = elevationDelta(cell, cells[ny][nx], dir);
      if (delta === null) continue; // no relationship can be inferred here — see elevationDelta
      const expectedNeighborLevel = cell.level + delta;

      if (!levelKnown[ny][nx]) {
        cells[ny][nx].level = expectedNeighborLevel;
        levelKnown[ny][nx] = true;
        queue.push({ x: nx, y: ny });
      } else if (cells[ny][nx].level !== expectedNeighborLevel) {
        throw new BoardDataError(
          `Elevation contradiction at (${nx},${ny}): reached at level ` +
          `${cells[ny][nx].level} from one path and ${expectedNeighborLevel} from another.`,
        );
      }
    }
  }
}

/** How much higher the neighbor in `dir` is, relative to `cell`, given the
 * edge feature (if any) between them. `null` means "no relationship can be
 * inferred here" — the caller must not default this to same-level and must
 * not assign or check the neighbor's level via this particular edge.
 *
 * A cliff is recorded on only one of its two cells (per README.md: "only
 * one of the two cells records the edge, so a cliff never appears twice"),
 * so this checks `cell`'s own edge in `dir` first, and if that's absent,
 * falls back to `neighbor`'s edge in the opposite direction, inverting the
 * relationship accordingly.
 *
 * Stunt ramps: a ramp's own level equals its entry-side neighbor's level —
 * that's just the ordinary same-level default, so no special-case delta is
 * needed for the entry direction. Every OTHER side of a ramp cell must not
 * default to same-level (returns null instead, unless an explicit cliff is
 * present, which is checked first and takes priority). Both corrections
 * here came from tracing a real contradiction against Rolling3.json, not
 * from the rulebook or README — a ramp cell only shares elevation with its
 * entry-side neighbor, nothing else. */
function elevationDelta(cell: BoardCell, neighbor: BoardCell, dir: Direction): number | null {
  const ownCliff = findCliff(cell.edges[dir]);
  if (ownCliff) {
    if (ownCliff.ridge) {
      // A ridge has zero net elevation change but is still impassable —
      // the caller's movement/wall logic must treat this edge as blocked
      // regardless of level, but for the elevation GRAPH specifically
      // there's nothing to propagate: same level on both sides.
      return 0;
    }
    const levels = ownCliff.levels ?? 1;
    // drop: 'out' => this cell is high, neighbor is low => neighbor = cell - levels
    // drop: 'in'  => neighbor is high                    => neighbor = cell + levels
    return ownCliff.drop === 'out' ? -levels : levels;
  }

  const neighborCliff = findCliff(neighbor.edges[OPPOSITE[dir]]);
  if (neighborCliff) {
    if (neighborCliff.ridge) return 0;
    const levels = neighborCliff.levels ?? 1;
    // Recorded from the neighbor's side, looking back at `cell`:
    // drop: 'out' => neighbor is high, cell is low => neighbor = cell + levels
    // drop: 'in'  => cell is high                   => neighbor = cell - levels
    return neighborCliff.drop === 'out' ? levels : -levels;
  }

  // A stunt ramp cell's own level equals its entry-side neighbor's level —
  // confirmed against real data: (0,1) in Rolling3.json comes out to the
  // same level as its entry neighbor (0,0), not one higher as originally
  // assumed. Landing on a ramp normally (via its entry side) is therefore
  // just an ordinary same-level transition, needing no special case here —
  // it falls through to the plain `return 0` at the end of this function.
  //
  // What DOES need special handling: a stunt ramp's OTHER sides (anything
  // but its entry) must NOT default to same-level. Confirmed against real
  // data: Rolling3's ramp at (0,1) has an ordinary (uncliffed) edge toward
  // (1,1), and (1,1) is genuine ground level, not the ramp's level — a
  // stunt ramp only shares elevation with its entry-side neighbor, nothing
  // else, and the real elevation of its exit side and beyond is determined
  // entirely by whatever explicit cliffs are there (already handled above).
  const cellIsRampNonEntrySide = cell.stuntRamp && cell.stuntRamp.entry !== dir;
  const neighborIsRampNonEntrySide = neighbor.stuntRamp && neighbor.stuntRamp.entry !== OPPOSITE[dir];
  if (cellIsRampNonEntrySide || neighborIsRampNonEntrySide) return null;

  return 0;
}

function findCliff(features: BoardCell['edges'][Direction]): CliffEdge | undefined {
  if (!features) return undefined;
  for (const f of features) {
    if (f.kind === 'cliff') return f;
  }
  return undefined;
}
