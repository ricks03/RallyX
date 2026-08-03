import {
  ComposedGrid, TerrainKind, Direction,
} from './types.js';
import { applyDamage } from './reducer.js';
import {
  RobotState, MoveEvent, MoveEventType, MovementCardType,
  getEdgeCrossing, neighborCoords, inBounds, robotAt, isPit, findPortalPair,
} from './movement.js';

/**
 * STATUS: covers the movement-budget/slide side of oil, flaming oil, slime,
 * mud, sand, and gravel — see RULES_SPEC.md §4. Water is NOT here; it's
 * implemented directly in `movement.ts`'s `resolveRobotMove` because it can
 * trigger on any square left during a move, not just the starting one.
 *
 * Explicitly NOT covered here, by scope: flaming oil's damage (1 on
 * entering the first flaming-oil square of a move, 1 more if still present
 * at Resolve Laser Fire) — that belongs with the laser-fire pass, not
 * movement. This module only implements flaming oil's movement behavior,
 * which is identical to plain oil.
 */

function baseSquares(card: MovementCardType): number {
  switch (card) {
    case 'Move1': case 'BackUp': return 1;
    case 'Move2': return 2;
    case 'Move3': return 3;
    default: return 0;
  }
}

const ROTATE_CARDS: ReadonlySet<MovementCardType> = new Set(['RotateLeft', 'RotateRight', 'UTurn']);

export interface StartingTerrainResult {
  /** Adjusted squares for a Move/BackUp card. 0 for a rotate card (not
   * applicable) or when the card's movement is fully negated. */
  squares: number;
  /** True only for slime's Move1/BackUp/rotate case: the card is discarded
   * with zero effect whatsoever — including no rotation, if it was one. */
  cardFizzles: boolean;
}

/**
 * The starting-square terrain adjustment for oil, flaming oil, slime, mud,
 * and sand — computed BEFORE `resolveRobotMove` runs, from the terrain of
 * the robot's cell at the moment this card begins resolving. Each of these
 * rules is independently confirmed against `tiles.yml`'s own wording, not
 * inferred by analogy with the others — they are not all the same shape:
 * oil scales down by 1, slime is all-or-nothing, mud/sand only restrict
 * specific card sizes.
 */
export function adjustForStartingTerrain(
  startTerrain: TerrainKind[] | undefined,
  card: MovementCardType,
): StartingTerrainResult {
  const terrain = startTerrain ?? [];
  const isRotate = ROTATE_CARDS.has(card);
  const base = baseSquares(card);

  if (terrain.includes('slime')) {
    // "a robot starting its move on one ignores Rotate, U-Turn, Back-Up and
    // Move 1, discarding the card without moving; only a Move 2 or Move 3
    // gets it off" — confirmed verbatim against tiles.yml.
    if (card === 'Move2' || card === 'Move3') return { squares: base, cardFizzles: false };
    return { squares: 0, cardFizzles: true };
  }

  if (terrain.includes('oil') || terrain.includes('flamingOil')) {
    // "A robot that BEGINS its movement on oil loses the first square of
    // it. Rotate cards are unaffected." — confirmed verbatim.
    if (isRotate) return { squares: 0, cardFizzles: false };
    return { squares: Math.max(0, base - 1), cardFizzles: false };
  }

  if (terrain.includes('mud')) {
    // "A robot starting a Move 2 or Move 3 in mud does not move at all." —
    // confirmed verbatim. Nothing else is restricted.
    if (card === 'Move2' || card === 'Move3') return { squares: 0, cardFizzles: false };
    return { squares: base, cardFizzles: false };
  }

  if (terrain.includes('sand')) {
    // "A robot executing a Move 3 in sand does not move." — confirmed
    // verbatim, this is the STARTING-square rule. The separate mid-move
    // rule ("a Move-3 that enters sand stops in the first square of sand")
    // is implemented in movement.ts's resolveRobotMove via
    // `stopOnEnteringSand`, since it depends on the path taken, not known
    // until the loop runs — same reason water lives there instead of here.
    if (card === 'Move3') return { squares: 0, cardFizzles: false };
    return { squares: base, cardFizzles: false };
  }

  return { squares: base, cardFizzles: false };
}

/**
 * Attempts to slide a robot exactly one square in `dir`. A slide never
 * pushes — a blocked attempt (wall, unramped uphill cliff, or a robot not
 * on oil) simply stops, except the oil-into-oil case, which chain-slides
 * instead of stopping. Mirrors `attemptOneSquare` in movement.ts, but with
 * this different occupancy rule.
 */
function attemptSlideStep(
  grid: ComposedGrid,
  robots: Map<string, RobotState>,
  robotId: string,
  dir: Direction,
  events: MoveEvent[],
): 'moved' | 'stopped' | 'destroyed' {
  const mover = robots.get(robotId);
  if (!mover || mover.destroyed) return 'stopped';

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
    return 'stopped';
  }

  const [nx, ny] = neighborCoords(mover.x, mover.y, dir);
  const occupant = robotAt(robots, nx, ny);
  if (occupant) {
    const occupantCell = grid.cells[occupant.y][occupant.x];
    const occupantOnOil = occupantCell.terrain?.includes('oil') || occupantCell.terrain?.includes('flamingOil');
    if (!occupantOnOil) {
      // A slide never pushes — it just stops here, without moving.
      events.push({ type: 'blocked', robotId });
      return 'stopped';
    }
    const chainResult = attemptSlideStep(grid, robots, occupant.id, dir, events);
    if (chainResult === 'stopped') {
      events.push({ type: 'blocked', robotId });
      return 'stopped';
    }
    events.push({ type: 'pushed', robotId: occupant.id }); // chain-slide, not a push, but same event shape
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
  }

  mover.x = nx;
  mover.y = ny;
  events.push({ type: 'moved', robotId });
  return 'moved';
}

/**
 * Slides a robot up to `maxSquares` squares in `dir`. Used for mud's
 * single-square slide (`maxSquares: 1`) and oil's continued slide
 * (`maxSquares: Infinity` — the real stopping conditions are the wall/
 * non-oil-robot block and, checked here, leaving oil entirely).
 */
export function executeSlide(
  grid: ComposedGrid,
  robots: RobotState[],
  robotId: string,
  dir: Direction,
  maxSquares: number,
  continueWhileOnOil: boolean,
): { robots: RobotState[]; events: MoveEvent[] } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: MoveEvent[] = [];

  for (let i = 0; i < maxSquares; i++) {
    const mover = working.get(robotId);
    if (!mover || mover.destroyed) break;
    const result = attemptSlideStep(grid, working, robotId, dir, events);
    if (result === 'stopped' || result === 'destroyed') break;
    if (continueWhileOnOil) {
      const nowCell = grid.cells[mover.y][mover.x];
      const stillOnOil = nowCell.terrain?.includes('oil') || nowCell.terrain?.includes('flamingOil');
      if (!stillOnOil) break; // this was the last square of momentum
    }
  }

  return { robots: [...working.values()], events };
}

/**
 * End-of-move terrain effects, checked against the robot's landing square
 * after its card's own movement (via `resolveRobotMove`) has completed.
 * Oil/flaming oil: keep sliding until off the oil, blocked, or stopped by a
 * non-oil robot. Mud: exactly one slide, capped, regardless of what's past
 * it.
 */
export function applyEndOfMoveTerrain(
  grid: ComposedGrid,
  robots: RobotState[],
  robotId: string,
  dir: Direction,
): { robots: RobotState[]; events: MoveEvent[] } {
  const mover = robots.find((r) => r.id === robotId);
  if (!mover || mover.destroyed) return { robots, events: [] };

  const cell = grid.cells[mover.y][mover.x];
  const terrain = cell.terrain ?? [];

  if (terrain.includes('oil') || terrain.includes('flamingOil')) {
    return executeSlide(grid, robots, robotId, dir, Infinity, true);
  }
  if (terrain.includes('mud')) {
    return executeSlide(grid, robots, robotId, dir, 1, false);
  }
  return { robots, events: [] };
}

/**
 * Gravel: a Rotate Left or Right on gravel is followed by a 1-square slide
 * in the robot's ORIGINAL (pre-rotation) facing direction — confirmed
 * against tiles.yml's own clarifying example: "usually looks like a Move 1
 * plus a rotation in the direction of the card." U-Turn is not mentioned by
 * the source and is NOT included here.
 */
export function applyGravelRotateSlide(
  grid: ComposedGrid,
  robots: RobotState[],
  robotId: string,
  card: 'RotateLeft' | 'RotateRight',
  originalFacing: Direction,
): { robots: RobotState[]; events: MoveEvent[] } {
  const mover = robots.find((r) => r.id === robotId);
  if (!mover || mover.destroyed) return { robots, events: [] };
  const cell = grid.cells[mover.y][mover.x];
  if (!cell.terrain?.includes('gravel')) return { robots, events: [] };
  return executeSlide(grid, robots, robotId, originalFacing, 1, false);
}

export type { MoveEvent, MoveEventType };
