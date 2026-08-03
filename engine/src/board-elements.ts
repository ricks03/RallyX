import { ComposedCell, ComposedGrid, Direction } from './types.js';
import {
  RobotState, MoveEvent, MoveEventType,
  attemptOneSquare, neighborCoords, inBounds, robotAt, OPPOSITE,
} from './movement.js';

/**
 * STATUS: real, tested. Implements register step C's five sub-steps:
 * express belts, all belts, currents, pushers, gears. Crushers are NOT
 * here — confirmed by the project owner, correcting an earlier assumption
 * (from the "Ultimate Collection" fan rulebook) that they belonged at the
 * end of this step. They destroy only during Resolve Laser Fire instead —
 * see laser-fire.ts.
 *
 * Belts and currents share one resolution model (`resolveConveyance`):
 * never push, resolved simultaneously across every riding robot at once —
 * two robots converging on one destination means neither moves, and a
 * robot blocked only by a stationary (non-moving-this-substep) occupant
 * doesn't move either, even though nothing here is "pushing" it. This is
 * an iterative fixed-point, not a single pass: excluding one robot can
 * free up (or newly block) another's destination, checked until nothing
 * more changes.
 *
 * Pushers reuse `attemptOneSquare` from movement.ts directly — a pusher's
 * push is mechanically identical to a card-driven push (can chain multiple
 * robots), just triggered by phase-gating instead of a card. Multiple
 * active pushers this register are resolved one at a time, in grid-scan
 * order — RULES_SPEC doesn't specify true simultaneity for this case the
 * way it does for belts, so this is a reasonable default rather than a
 * confirmed rule.
 *
 * The "Millennium Falcon" phased-element immunity needs no special code
 * here at all: a robot that left a pusher square under its own card in
 * step B is simply no longer physically there when step C checks
 * occupancy, and a robot dragged back onto that square by an earlier
 * sub-step (belts/currents) is correctly NOT protected, because by the
 * time pushers run, it really is there again.
 */

export interface ConveyorLike {
  exit: Direction;
  rotates: Partial<Record<Direction, 'none' | 'CW' | 'CCW'>>;
}

function conveyorInfo(cell: ComposedCell): ConveyorLike | undefined {
  return cell.conveyor && { exit: cell.conveyor.exit, rotates: cell.conveyor.rotates };
}

function expressConveyorInfo(cell: ComposedCell): ConveyorLike | undefined {
  return cell.conveyor?.express ? { exit: cell.conveyor.exit, rotates: cell.conveyor.rotates } : undefined;
}

function currentInfo(cell: ComposedCell): ConveyorLike | undefined {
  return cell.current && { exit: cell.current.exit, rotates: cell.current.rotates ?? {} };
}

function rotateFacing(facing: Direction, rot: 'none' | 'CW' | 'CCW' | undefined): Direction {
  const CW_MAP: Record<Direction, Direction> = { N: 'E', E: 'S', S: 'W', W: 'N' };
  const CCW_MAP: Record<Direction, Direction> = { N: 'W', W: 'S', S: 'E', E: 'N' };
  if (rot === 'CW') return CW_MAP[facing];
  if (rot === 'CCW') return CCW_MAP[facing];
  return facing;
}

/**
 * Simultaneous belt/current resolution, shared by express belts, all
 * belts, and currents — the only difference between them is `selector`.
 */
export function resolveConveyance(
  grid: ComposedGrid,
  robots: RobotState[],
  selector: (cell: ComposedCell) => ConveyorLike | undefined,
): { robots: RobotState[]; events: MoveEvent[] } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: MoveEvent[] = [];

  const intents = new Map<string, { x: number; y: number; entryDir: Direction; info: ConveyorLike }>();
  for (const r of working.values()) {
    if (r.destroyed) continue;
    const info = selector(grid.cells[r.y][r.x]);
    if (!info) continue;
    const [nx, ny] = neighborCoords(r.x, r.y, info.exit);
    intents.set(r.id, { x: nx, y: ny, entryDir: OPPOSITE[info.exit], info });
  }

  const excluded = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;

    const byDest = new Map<string, string[]>();
    for (const [id, intent] of intents) {
      if (excluded.has(id)) continue;
      const key = `${intent.x},${intent.y}`;
      const list = byDest.get(key);
      if (list) list.push(id);
      else byDest.set(key, [id]);
    }
    for (const ids of byDest.values()) {
      if (ids.length > 1) {
        for (const id of ids) {
          if (!excluded.has(id)) { excluded.add(id); changed = true; }
        }
      }
    }

    for (const [id, intent] of intents) {
      if (excluded.has(id)) continue;
      if (!inBounds(grid, intent.x, intent.y)) continue; // off-board handled at apply time
      const occupant = robotAt(working, intent.x, intent.y);
      if (occupant && occupant.id !== id) {
        const occupantMoving = intents.has(occupant.id) && !excluded.has(occupant.id);
        if (!occupantMoving) { excluded.add(id); changed = true; }
      }
    }
  }

  for (const [id, intent] of intents) {
    if (excluded.has(id)) continue;
    const mover = working.get(id)!;
    if (!inBounds(grid, intent.x, intent.y)) {
      mover.destroyed = true;
      events.push({ type: 'destroyedOffBoard', robotId: id });
      continue;
    }
    mover.x = intent.x;
    mover.y = intent.y;
    events.push({ type: 'moved', robotId: id });
    const destCell = grid.cells[intent.y][intent.x];
    const destInfo = selector(destCell);
    if (destInfo) {
      mover.facing = rotateFacing(mover.facing, destInfo.rotates[intent.entryDir]);
    }
  }

  return { robots: [...working.values()], events };
}

export const resolveExpressBelts = (grid: ComposedGrid, robots: RobotState[]) =>
  resolveConveyance(grid, robots, expressConveyorInfo);

export const resolveAllBelts = (grid: ComposedGrid, robots: RobotState[]) =>
  resolveConveyance(grid, robots, conveyorInfo);

export const resolveCurrents = (grid: ComposedGrid, robots: RobotState[]) =>
  resolveConveyance(grid, robots, currentInfo);

/** Pushers: phase-gated, can chain-push like a card-driven move. Every
 * robot currently on an active pusher is pushed, one pusher at a time in
 * grid-scan order. */
export function resolvePushers(
  grid: ComposedGrid,
  robots: RobotState[],
  currentRegister: number,
): { robots: RobotState[]; events: MoveEvent[] } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: MoveEvent[] = [];

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.cells[y][x];
      if (!cell.pusher?.phases.includes(currentRegister)) continue;
      const occupant = robotAt(working, x, y);
      if (!occupant) continue;
      attemptOneSquare(grid, working, occupant.id, cell.pusher.push, events);
    }
  }

  return { robots: [...working.values()], events };
}

/** Gears: never phase-gated, always rotate whoever's on them, every
 * register. No movement involved. */
export function resolveGears(
  grid: ComposedGrid,
  robots: RobotState[],
): { robots: RobotState[]; events: MoveEvent[] } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: MoveEvent[] = [];

  for (const r of working.values()) {
    if (r.destroyed) continue;
    const gear = grid.cells[r.y][r.x].gear;
    if (!gear) continue;
    r.facing = rotateFacing(r.facing, gear.rotation);
    events.push({ type: 'moved', robotId: r.id }); // reuse 'moved' — a rotation-in-place event isn't modeled separately yet
  }

  return { robots: [...working.values()], events };
}

/** Runs the five sub-steps of Board Elements Move, in the fixed order.
 * Crushers are NOT here — confirmed by the project owner, corrected after
 * an earlier draft wrongly placed them here per the "Ultimate Collection"
 * fan rulebook's stated ordering. Crushers destroy only during Resolve
 * Laser Fire — see laser-fire.ts. */
export function resolveBoardElementsMove(
  grid: ComposedGrid,
  robots: RobotState[],
  currentRegister: number,
): { robots: RobotState[]; events: MoveEvent[] } {
  const events: MoveEvent[] = [];
  let current = robots;

  const steps: Array<(g: ComposedGrid, r: RobotState[]) => { robots: RobotState[]; events: MoveEvent[] }> = [
    resolveExpressBelts,
    resolveAllBelts,
    resolveCurrents,
    (g, r) => resolvePushers(g, r, currentRegister),
    resolveGears,
  ];

  for (const step of steps) {
    const result = step(grid, current);
    current = result.robots;
    events.push(...result.events);
  }

  return { robots: current, events };
}

export type { MoveEvent, MoveEventType };
