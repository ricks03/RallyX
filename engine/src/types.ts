// Field names for board-cell elements are taken verbatim from the project's
// README.md element table. See /docs/RULES_SPEC.md for the rules these types
// implement.

export type Direction = 'N' | 'E' | 'S' | 'W';
export type Rotation = 0 | 90 | 180 | 270;
export type Colour = 'red' | 'green' | 'orange';

export interface WallEdge {
  kind: 'wall';
  spikes?: boolean;
  oneWay?: 'red' | 'green';
}

export interface RepulsorEdge {
  kind: 'repulsor';
}

export interface CliffEdge {
  kind: 'cliff';
  drop: 'in' | 'out';
  ramp?: { extraMoves: 1 | 2 };
  /** Confirmed against real Straightaway6.json: a single layered ledge can
   * represent more than one level of drop. Defaults to 1 when absent —
   * every cliff seen in real data before this case was a plain 1-level
   * step, so this stays optional rather than required. */
  levels?: number;
  /** Confirmed against real TrafficJam5.json: two adjacent ledges can form
   * a ridge — net elevation change of ZERO, but still impassable in both
   * directions (you'd have to climb the first ledge, which needs a ramp,
   * regardless of net height). When true, `drop`/`levels` are ignored for
   * elevation purposes; this edge contributes no level change at all, but
   * still blocks movement like a wall with no ramp exception. */
  ridge?: boolean;
}

export interface LaserEdge {
  kind: 'laser';
  count: number;
}

export interface BollardEdge {
  kind: 'bollard';
  phases: number[];
}

export type AnyEdge =
  | WallEdge
  | RepulsorEdge
  | CliffEdge
  | LaserEdge
  | BollardEdge;

export interface FloorSpec {
  kind: 'open' | 'pit' | 'trapDoorPit';
  phases?: number[];
}

export type TerrainKind =
  | 'oil' | 'slime' | 'flamingOil' | 'spikes' | 'speedBump'
  | 'gravel' | 'mud' | 'sand' | 'water' | 'smoke';

/** A single cell as it appears in a raw, un-composed board.json. */
export interface BoardCell {
  level: number; // always 0 in raw board.json today; composer computes the real value
  edges: Partial<Record<Direction, AnyEdge[]>>;
  // Confirmed against real data (Containment6 vs Containment7, same cells):
  // `floor` is only ever emitted when an explicit floor-kind tile is drawn
  // on the cell, or via the terrain-implies-floor pass in tmx2board.pl.
  // A cell with other content (conveyor, radioactiveWaste, etc.) but no
  // floor tile and no terrain has NO floor key at all — absence means open
  // floor by convention, not a schema violation. Was wrongly required.
  floor?: FloorSpec;
  terrain?: TerrainKind[];
  smoke?: true;

  conveyor?: {
    express: boolean;
    exit: Direction;
    entries: Direction[];
    // Confirmed against real board.json (Chicane3): per-entry rotation
    // behavior for curved sections. Not in README's element table — found
    // only by inspecting actual converted data.
    rotates: Partial<Record<Direction, 'none' | 'CW' | 'CCW'>>;
  };
  current?: {
    exit: Direction;
    entries: Direction[];
    // Confirmed against real board.json (Water_Park2_3e): identical shape
    // to conveyor's rotates field, always present.
    rotates: Partial<Record<Direction, 'none' | 'CW' | 'CCW'>>;
  };
  gear?: { rotation: 'CW' | 'CCW' };
  repair?: { wrenches: 1 | 2; hammer?: boolean };
  portal?: { colour: string }; // confirmed open-ended: red/black/purple/yellow all seen in real data
  chopShop?: true;
  randomizer?: true;
  teleporter?: true;
  start?: number;
  pusher?: {
    edge: Direction;
    phases: number[];
    // Confirmed against real board.json: the direction the robot is
    // shoved, distinct from `edge` (which side the pusher is mounted on).
    // Not in README's element table.
    push: Direction;
  };
  crusher?: { phases: number[] };
  flamer?: { phases: number[]; colour: Colour };
  generator?: { colour: Colour };
  stuntRamp?: { entry: Direction; exit: Direction };
  radiation?: true;
  radioactiveWaste?: true;
  pitStop?: true;
  restStop?: true;
  // Confirmed against real board.json: a top-level field, NOT an edge
  // feature — a beam crossing the cell with no emitter here, for
  // cross-checking beam tracing (README's `laserBeam`, but structurally
  // different from what the element table's edge-feature listing implied).
  beams?: { along: Direction; count: number }[];
}

export interface BoardData {
  name: string;
  width: number;
  height: number;
  cells: BoardCell[][]; // cells[y][x]
}

// ============================================================
// Course authoring + composed grid
// ============================================================

export interface CourseBoardRef {
  id: string;
  sha256: string;
  gridX: number; // in board-units, not cells
  gridY: number;
  rotation: Rotation;
}

export interface CourseFlag {
  number: number;
  board: string; // board id the coordinates below are relative to
  x: number;
  y: number;
}

export interface Course {
  boards: CourseBoardRef[];
  dock: CourseBoardRef | null;
  flags: CourseFlag[];
  lifeTokens: number;
}

/** A cell in the flattened, absolute-coordinate, real-elevation grid the
 * composer produces. Adds a synthetic repair for non-final checkpoint flags. */
export interface ComposedCell extends BoardCell {
  flag?: { number: number; isFinal: boolean };
}

export interface ComposedGrid {
  width: number;
  height: number;
  cells: ComposedCell[][]; // cells[y][x], absolute coordinates
}

export class BoardDataError extends Error {}
