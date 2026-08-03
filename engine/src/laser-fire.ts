import { ComposedGrid, Direction } from './types.js';
import { RobotState, robotAt, inBounds, neighborCoords, OPPOSITE } from './movement.js';
import { applyDamage } from './reducer.js';

/**
 * STATUS: covers the deterministic 80% of Resolve Laser Fire — board
 * lasers, robot main lasers, flamers, flaming oil's laser-fire damage,
 * radioactive waste, and crushers, all computed off one simultaneous
 * snapshot (Pass 1) per RULES_SPEC.md §5.
 *
 * Crushers are HERE, not in board-elements.ts — confirmed directly by the
 * project owner, correcting an earlier draft that placed them in Board
 * Elements Move per the "Ultimate Collection" fan rulebook's stated
 * ordering. That was wrong; this project's actual rule is that crushers
 * destroy during Resolve Laser Fire.
 *
 * Explicitly NOT included, deferred to a future session along with the
 * rest of the Options catalog:
 *   - the weapon-choice pre-pass (optional weapons)
 *   - additional weapons, main laser modifications, explosions
 *   - Pass 2 (forced movement) — nothing in this file's current scope
 *     produces forced movement, so there's nothing for it to do yet
 *   - flaming oil's damage-on-ENTRY component (that's a movement-time
 *     effect, out of scope here on purpose — see terrain.ts)
 *
 * Same-level targeting is real now, confirmed by the project owner: a
 * beam travels at a fixed elevation (the emitter's own cell's level for a
 * board laser, the shooter's own cell's level for a robot laser). A cell
 * strictly HIGHER than that blocks the beam outright, the same as a wall —
 * nothing beyond it is reachable. A cell LOWER is simply flown over: no
 * block, and any robot standing there is untouched. Only a cell at exactly
 * the beam's own level can hold a valid target.
 */

export type LaserEventType = 'boardLaserHit' | 'robotLaserHit' | 'flamerDamage'
  | 'flamingOilDamage' | 'radioactiveWasteDamage' | 'crusherDestroyed'
  | 'destroyedByDamage';

export interface LaserEvent {
  type: LaserEventType;
  robotId: string;
}

/**
 * Traces a board laser's beam. The emitter is mounted ON the edge it's
 * recorded on and fires directly INTO that cell, at that cell's own
 * elevation — no edge check to enter the first cell, since the beam
 * doesn't have to cross the very wall the emitter is attached to. From
 * there it continues cell to cell in `dir`, blocked by a wall the same way
 * movement is.
 *
 * Confirmed by the project owner: the beam travels at a fixed elevation
 * (`beamLevel`, the emitter's own cell's level). A cell HIGHER than that
 * physically blocks the beam outright, the same as a wall would — nothing
 * beyond it is reachable, regardless of whether a robot is standing there.
 * A cell at exactly `beamLevel` can hold a valid target (same-level only —
 * robots at a different level are never hit). A cell LOWER than
 * `beamLevel` is simply flown over: no block, and any robot there is
 * untouched.
 */
function traceBoardLaserBeam(
  grid: ComposedGrid,
  robots: RobotState[],
  startX: number,
  startY: number,
  dir: Direction,
  beamLevel: number,
): string | null {
  let x = startX;
  let y = startY;
  while (inBounds(grid, x, y)) {
    const cell = grid.cells[y][x];

    if (cell.level > beamLevel) return null; // higher terrain blocks the beam outright

    if (cell.level === beamLevel) {
      const hit = robotAt(new Map(robots.map((r) => [r.id, r])), x, y);
      if (hit) return hit.id;
    }
    // cell.level < beamLevel: flown over, no block, no hit even if occupied

    const blocked = (cell.edges[dir] ?? []).some((f) => f.kind === 'wall' && f.oneWay !== 'green');
    if (blocked) return null;

    const [nx, ny] = neighborCoords(x, y, dir);
    x = nx;
    y = ny;
  }
  return null;
}

/**
 * Traces a robot's own main laser. Unlike a board laser, the beam
 * originates INSIDE the shooter's cell and must first cross the shooter's
 * own facing edge — if that's blocked, the beam never leaves the shooter's
 * cell and hits nothing. The shooter itself is never a valid target. The
 * beam's elevation is the shooter's own cell's level.
 */
function traceRobotLaserBeam(
  grid: ComposedGrid,
  robots: RobotState[],
  shooterId: string,
): string | null {
  const shooter = robots.find((r) => r.id === shooterId);
  if (!shooter || shooter.destroyed) return null;

  const startCell = grid.cells[shooter.y][shooter.x];
  const beamLevel = startCell.level;
  const blockedAtStart = (startCell.edges[shooter.facing] ?? [])
    .some((f) => f.kind === 'wall' && f.oneWay !== 'green');
  if (blockedAtStart) return null;

  const [nx, ny] = neighborCoords(shooter.x, shooter.y, shooter.facing);
  // Re-use the board-laser tracer from the first cell past the shooter —
  // same "check for a robot, then the wall ahead" walk from there on, at
  // the shooter's own elevation.
  return traceBoardLaserBeam(grid, robots, nx, ny, shooter.facing, beamLevel);
}

/**
 * Resolve Laser Fire, Pass 1 only (see module docstring for what's
 * deferred). All damage/destruction is computed off one snapshot of
 * `robots` as passed in — none of these sources affect each other within
 * this call, matching RULES_SPEC's "no ordering dependency between weapon
 * types."
 */
export function resolveLaserFirePass1(
  grid: ComposedGrid,
  robots: RobotState[],
  currentRegister: number,
): { robots: RobotState[]; events: LaserEvent[] } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: LaserEvent[] = [];
  const damage = new Map<string, number>();
  const destroyed = new Set<string>();

  const addDamage = (robotId: string, amount: number) => {
    damage.set(robotId, (damage.get(robotId) ?? 0) + amount);
  };

  // Board lasers.
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      for (const [dir, feats] of Object.entries(grid.cells[y][x].edges) as [Direction, typeof grid.cells[0][0]['edges']['N']][]) {
        for (const f of feats ?? []) {
          if (f.kind !== 'laser') continue;
          const emitterLevel = grid.cells[y][x].level;
          const hitId = traceBoardLaserBeam(grid, robots, x, y, dir, emitterLevel);
          if (hitId) {
            addDamage(hitId, f.count);
            events.push({ type: 'boardLaserHit', robotId: hitId });
          }
        }
      }
    }
  }

  // Robot main lasers.
  for (const shooter of robots) {
    if (shooter.destroyed) continue;
    const hitId = traceRobotLaserBeam(grid, robots, shooter.id);
    if (hitId) {
      addDamage(hitId, 1);
      events.push({ type: 'robotLaserHit', robotId: hitId });
    }
  }

  // Flamers (phase-gated), flaming oil (always active), radioactive waste
  // (always active), crushers (phase-gated, destroy outright).
  for (const r of robots) {
    if (r.destroyed) continue;
    const cell = grid.cells[r.y][r.x];

    if (cell.flamer?.phases.includes(currentRegister)) {
      addDamage(r.id, 1);
      events.push({ type: 'flamerDamage', robotId: r.id });
    }
    if (cell.terrain?.includes('flamingOil')) {
      addDamage(r.id, 1);
      events.push({ type: 'flamingOilDamage', robotId: r.id });
    }
    if (cell.radioactiveWaste) {
      addDamage(r.id, 1);
      events.push({ type: 'radioactiveWasteDamage', robotId: r.id });
    }
    if (cell.crusher?.phases.includes(currentRegister)) {
      destroyed.add(r.id);
      events.push({ type: 'crusherDestroyed', robotId: r.id });
    }
  }

  // Damage is accumulated across the whole simultaneous pass and applied
  // once, so a robot hit from several sources in one register is judged
  // against its total rather than being destroyed partway through
  // tallying — which would depend on the order sources were counted in.
  for (const [robotId, amount] of damage) {
    const robot = working.get(robotId);
    if (!robot) continue;
    if (applyDamage(robot, amount)) {
      events.push({ type: 'destroyedByDamage', robotId });
    }
  }
  for (const robotId of destroyed) {
    const robot = working.get(robotId);
    if (robot) robot.destroyed = true;
  }

  return { robots: [...working.values()], events };
}
