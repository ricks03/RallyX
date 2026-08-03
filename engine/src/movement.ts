import { CliffEdge, ComposedCell, ComposedGrid, Direction } from './types.js';
import { applyDamage } from './reducer.js';

/**
 * STATUS: partial, by design — see RULES_SPEC.md §3.
 *
 * Implements the per-square loop for Robot Movement: the wall/one-way check,
 * cliff/ramp blocking + cost + fall damage, chain-push recursion, pit/
 * off-board destruction, portal relocation, and spiked-wall damage.
 *
 * Confirmed, not a simplification: a ramp never "slides back." If a
 * card-driven mover doesn't have enough remaining budget to pay a ramp's
 * full cost, the crossing simply doesn't happen — movement stops with zero
 * further progress, full stop, no partial credit. Verified directly against
 * the project owner: this holds even starting right at the ramp's base
 * (a Move-1 there does not move at all), and there is no separate
 * "slides back" case anywhere else either.
 *
 * Deliberately NOT included yet:
 *   - oil/goo/water/mud (movement-budget adjustments before the loop runs)
 *   - stunt ramps (bonus movement, bypass-next-square, fall-damage credit —
 *     `rampExitFallDamage` in stunt-ramp.ts is a separate, already-tested
 *     building block for the damage part of this, not yet wired in here)
 *
 * Ramp cost is only ever charged against the CARD-DRIVEN mover's own
 * movement budget. A robot being pushed across a ramped edge is not
 * spending its own movement points, so it only needs the edge to not be
 * BLOCKED — the extra cost is irrelevant to it. Fall damage from a downhill
 * cliff applies uniformly to whoever crosses it, pushed or not.
 */

export type MovementCardType =
  | 'Move1' | 'Move2' | 'Move3' | 'BackUp'
  | 'RotateLeft' | 'RotateRight' | 'UTurn';

/** Priority lives on the card itself, not a separate deck — confirmed
 * against the rulebook. */
export interface ProgramCard {
  type: MovementCardType;
  priority: number;
}

export interface RobotState {
  id: string;
  x: number;
  y: number;
  facing: Direction;
  damage: number;
  destroyed: boolean;
  /** Where this robot respawns. Optional so existing callers/tests that
   * never touch checkpoints don't need to supply it — treat an absent
   * value as "the robot's current position", the sensible default for a
   * robot that hasn't archived anywhere yet. */
  archiveMarker?: { x: number; y: number };
  /** Highest-numbered flag touched in order so far, 0 if none. */
  lastTouchedFlag?: number;
  /** Virtual Mode — see RULES_SPEC.md's Virtual Mode section. Duration
   * (turn-1-only grace vs. per-register checks) is NOT decided here; this
   * field just records whether a robot is currently virtual. */
  virtual?: boolean;
  /** This turn's dealt hand, not yet placed into registers. Optional —
   * absent means "no hand dealt" rather than an empty array, so callers
   * that never touch dealing/registers don't need to supply it. */
  hand?: ProgramCard[];
  /** The 5 registers for this turn, left to right. `null` entries are
   * empty (should only happen via a locked-register-stays-filled rule,
   * which fills empties with a random card — see RULES_SPEC.md §6). */
  registers?: (ProgramCard | null)[];
  /** Whether each of the 5 registers is locked, from the damage table. */
  lockedRegisters?: boolean[];
  poweredDown?: boolean;
  announcedPowerDownNextTurn?: boolean;
  /** Life tokens remaining. Configured per game at creation (see
   * `Course.lifeTokens`), so it is not a fixed constant. Spent on
   * destruction by End of Turn Effects. Absent means unlimited, which
   * leaves every caller predating life tokens working unchanged. */
  lives?: number;
  /** Permanently out — spent its last life token. Stays `destroyed`, so
   * every module already skips it; this flag is what stops End of Turn
   * Effects returning it to play. */
  eliminated?: boolean;
}

export type MoveEventType =
  | 'moved' | 'pushed' | 'destroyedPit' | 'destroyedOffBoard'
  | 'portaled' | 'blocked' | 'spikeDamage' | 'fallDamage' | 'waterNegation'
  | 'enteredSand' | 'destroyedByDamage';

export interface MoveEvent {
  type: MoveEventType;
  robotId: string;
}

const DELTA: Record<Direction, [number, number]> = {
  N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0],
};

export const OPPOSITE: Record<Direction, Direction> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export function neighborCoords(x: number, y: number, dir: Direction): [number, number] {
  const [dx, dy] = DELTA[dir];
  return [x + dx, y + dy];
}

export function inBounds(grid: ComposedGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

function findCliff(features: ComposedCell['edges'][Direction]): CliffEdge | undefined {
  for (const f of features ?? []) {
    if (f.kind === 'cliff') return f;
  }
  return undefined;
}

export interface EdgeCrossing {
  blocked: boolean;
  spiked: boolean;
  /** Squares of a card-driven mover's own budget this crossing consumes.
   * Always 1 except an uphill (or ridge) ramp, which is 1 + extraMoves.
   * Irrelevant to a pushed robot — see the module docstring. */
  cost: number;
  /** Levels fallen, for 2×levels fall damage. 0 unless this is a downhill
   * cliff crossing. */
  fallLevels: number;
}

/**
 * Combined wall + cliff/ramp check for crossing the edge leaving `(x,y)` in
 * `dir`. A cliff may be recorded on either this cell's own edge or the
 * neighbor's reverse edge (per this project's "only one side records it"
 * convention) — checked both ways, mirroring `composer.ts`'s
 * `elevationDelta`. A ridge has no high/low side: blocked unless a ramp is
 * present, never causes a fall, regardless of which direction it's crossed.
 */
export function getEdgeCrossing(grid: ComposedGrid, x: number, y: number, dir: Direction): EdgeCrossing {
  const cell = grid.cells[y][x];
  const wallFeats = cell.edges[dir] ?? [];
  for (const f of wallFeats) {
    if (f.kind === 'wall' && f.oneWay !== 'green') {
      return { blocked: true, spiked: !!f.spikes, cost: 1, fallLevels: 0 };
    }
  }
  const spiked = wallFeats.some((f) => f.kind === 'wall' && f.spikes);

  const [nx, ny] = neighborCoords(x, y, dir);
  const ownCliff = findCliff(cell.edges[dir]);
  let ridge = false;
  let ramp: { extraMoves: number } | undefined;
  let levels = 1;
  let sourceIsHigh: boolean | undefined;
  let foundCliff = false;

  if (ownCliff) {
    foundCliff = true;
    ridge = !!ownCliff.ridge;
    ramp = ownCliff.ramp;
    levels = ownCliff.levels ?? 1;
    sourceIsHigh = ownCliff.drop === 'out';
  } else if (inBounds(grid, nx, ny)) {
    const neighborCliff = findCliff(grid.cells[ny][nx].edges[OPPOSITE[dir]]);
    if (neighborCliff) {
      foundCliff = true;
      ridge = !!neighborCliff.ridge;
      ramp = neighborCliff.ramp;
      levels = neighborCliff.levels ?? 1;
      sourceIsHigh = neighborCliff.drop === 'in';
    }
  }

  if (!foundCliff) {
    return { blocked: false, spiked, cost: 1, fallLevels: 0 }; // no cliff feature at all
  }

  if (ridge) {
    // Confirmed earlier this session, no ramp exception: a ridge is
    // impassable in both directions, full stop — a `ramp` field alongside
    // `ridge` (never seen in real data) would not make it crossable.
    return { blocked: true, spiked, cost: 1, fallLevels: 0 };
  }

  if (sourceIsHigh) {
    // Downhill: always allowed, ramp has no effect, fall damage per level.
    return { blocked: false, spiked, cost: 1, fallLevels: levels };
  }

  // Uphill: blocked without a ramp.
  if (ramp) return { blocked: false, spiked, cost: 1 + ramp.extraMoves, fallLevels: 0 };
  return { blocked: true, spiked, cost: 1, fallLevels: 0 };
}

export function isPit(cell: ComposedCell): boolean {
  return cell.floor?.kind === 'pit' || cell.floor?.kind === 'trapDoorPit';
}

export function robotAt(robots: Map<string, RobotState>, x: number, y: number): RobotState | undefined {
  for (const r of robots.values()) {
    if (!r.destroyed && r.x === x && r.y === y) return r;
  }
  return undefined;
}

/** Finds the other cell sharing this portal's colour. Assumes exactly one
 * pair per colour, confirmed against real data (Chicane3: every portal
 * colour appears in exactly one pair). */
export function findPortalPair(
  grid: ComposedGrid,
  colour: string,
  selfX: number,
  selfY: number,
): { x: number; y: number } | undefined {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (x === selfX && y === selfY) continue;
      if (grid.cells[y][x].portal?.colour === colour) return { x, y };
    }
  }
  return undefined;
}

/**
 * Attempts to move a single robot exactly one square in `dir`, recursing
 * into a chain-push if the destination is occupied. Mutates `robots` and
 * appends to `events` only on an outcome that actually happens (a blocked
 * attempt never mutates position). Returns the outcome for this one robot.
 * Does not consider ramp COST — that's the caller's job for a card-driven
 * mover (see `resolveRobotMove`); a pushed robot never pays it.
 */
export function attemptOneSquare(
  grid: ComposedGrid,
  robots: Map<string, RobotState>,
  robotId: string,
  dir: Direction,
  events: MoveEvent[],
): 'moved' | 'blocked' | 'destroyed' {
  const mover = robots.get(robotId);
  if (!mover || mover.destroyed) return 'blocked';

  const edge = getEdgeCrossing(grid, mover.x, mover.y, dir);
  if (edge.spiked) {
    events.push({ type: 'spikeDamage', robotId });
    if (applyDamage(mover, 1)) {
      events.push({ type: 'destroyedByDamage', robotId });
      return 'destroyed';
    }
  }
  if (edge.blocked) {
    events.push({ type: 'blocked', robotId });
    return 'blocked';
  }

  const [nx, ny] = neighborCoords(mover.x, mover.y, dir);

  const occupant = robotAt(robots, nx, ny);
  if (occupant) {
    const pushResult = attemptOneSquare(grid, robots, occupant.id, dir, events);
    if (pushResult === 'blocked') {
      events.push({ type: 'blocked', robotId });
      return 'blocked';
    }
    events.push({ type: 'pushed', robotId: occupant.id });
    // occupant has now moved or been destroyed; (nx,ny) is vacant, fall
    // through to the ordinary destination checks below.
  }

  if (edge.fallLevels > 0) {
    events.push({ type: 'fallDamage', robotId });
    if (applyDamage(mover, edge.fallLevels * 2)) {
      events.push({ type: 'destroyedByDamage', robotId });
      return 'destroyed';
    }
  }

  if (!inBounds(grid, nx, ny)) {
    mover.destroyed = true;
    events.push({ type: 'destroyedOffBoard', robotId });
    return 'destroyed';
  }

  const destCell = grid.cells[ny][nx];
  if (isPit(destCell)) {
    mover.destroyed = true;
    events.push({ type: 'destroyedPit', robotId });
    return 'destroyed';
  }

  if (destCell.portal) {
    const paired = findPortalPair(grid, destCell.portal.colour, nx, ny);
    if (paired && !robotAt(robots, paired.x, paired.y)) {
      mover.x = paired.x;
      mover.y = paired.y;
      events.push({ type: 'portaled', robotId });
      return 'moved';
    }
    // paired destination missing or occupied — inert, fall through as
    // an ordinary square per RULES_SPEC §3.
  }

  mover.x = nx;
  mover.y = ny;
  events.push({ type: 'moved', robotId });
  return 'moved';
}

/**
 * Resolves a robot's Move/Back-Up card: `squares` of movement budget, one
 * square attempted at a time in `dir`, stopping early (without consuming
 * remaining budget) the moment a step is blocked. Ramp crossings consume
 * more than 1 square of budget — if the remaining budget can't cover a
 * ramp's full cost, movement stops there with zero further progress
 * (confirmed: never a slide-back, see the module docstring). Does not yet
 * apply oil/mud/sand/slime pre-adjustments to `squares` itself — see
 * `terrain.ts`, which computes the adjusted `squares` before calling this.
 *
 * Water is handled here directly, not in terrain.ts, because unlike the
 * other terrain effects it isn't a starting-square-only rule — it can
 * trigger on ANY square left during this card's movement, so it has to be
 * checked at every step of the loop, not just before it starts. Capped at
 * once per register: pass `waterNegationAlreadyUsed` from the previous
 * card's result to carry that forward, and reset it to false yourself at
 * the start of each new register. Currents are exempt even though every
 * current tile is also water.
 *
 * Sand's enter-mid-move rule is here for the same reason: "a Move-3 that
 * enters sand stops in the first square of sand" (confirmed verbatim
 * against tiles.yml) depends on which square was just entered, not known
 * until the loop runs. Pass `stopOnEnteringSand: true` only when resolving
 * a Move-3 card — this is NOT the starting-square rule (that one is a full
 * block, handled by `terrain.ts`'s `adjustForStartingTerrain` before this
 * function is ever called); this is specifically about sand reached
 * partway through the move.
 */
export function resolveRobotMove(
  grid: ComposedGrid,
  robots: RobotState[],
  robotId: string,
  dir: Direction,
  squares: number,
  options: { waterNegationAlreadyUsed?: boolean; stopOnEnteringSand?: boolean } = {},
): { robots: RobotState[]; events: MoveEvent[]; waterNegationUsed: boolean } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: MoveEvent[] = [];
  let waterUsed = options.waterNegationAlreadyUsed ?? false;

  let budget = squares;
  while (budget > 0) {
    const mover = working.get(robotId);
    if (!mover || mover.destroyed) break;

    if (!waterUsed) {
      const currentCell = grid.cells[mover.y][mover.x];
      if (currentCell.terrain?.includes('water') && !currentCell.current) {
        waterUsed = true;
        events.push({ type: 'waterNegation', robotId });
        budget -= 1;
        if (budget <= 0) break;
      }
    }

    const edge = getEdgeCrossing(grid, mover.x, mover.y, dir);
    if (edge.blocked) {
      if (edge.spiked) {
        events.push({ type: 'spikeDamage', robotId });
        if (applyDamage(mover, 1)) {
          events.push({ type: 'destroyedByDamage', robotId });
          break;
        }
      }
      events.push({ type: 'blocked', robotId });
      break;
    }
    if (edge.cost > budget) {
      // Confirmed: insufficient budget for a ramp's full cost just means
      // zero further progress — no slide-back, no partial credit.
      break;
    }

    const result = attemptOneSquare(grid, working, robotId, dir, events);
    if (result === 'blocked' || result === 'destroyed') break;
    budget -= edge.cost;

    if (options.stopOnEnteringSand) {
      const landed = working.get(robotId);
      if (landed && !landed.destroyed) {
        const landedCell = grid.cells[landed.y][landed.x];
        if (landedCell.terrain?.includes('sand')) {
          events.push({ type: 'enteredSand', robotId });
          break;
        }
      }
    }
  }

  return { robots: [...working.values()], events, waterNegationUsed: waterUsed };
}
