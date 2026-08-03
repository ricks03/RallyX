import { ComposedGrid, Direction } from './types.js';
import {
  RobotState, ProgramCard, MoveEvent, resolveRobotMove, OPPOSITE,
} from './movement.js';
import { adjustForStartingTerrain, applyEndOfMoveTerrain, applyGravelRotateSlide } from './terrain.js';
import { resolveBoardElementsMove } from './board-elements.js';
import { resolveLaserFirePass1, LaserEvent } from './laser-fire.js';
import { resolveTouchCheckpoints, CheckpointEvent } from './checkpoints.js';

/**
 * STATUS: real, tested. `resolveProgramCard` is the per-card orchestrator
 * that was the missing link between terrain.ts's pre/post-adjustments and
 * movement.ts's core loop — until now, each piece was independently real
 * but nothing called them together in the right order for one card.
 * `resolveRegister` runs a full register: step B in priority order (using
 * each robot's own card, since priority lives on the card, not a separate
 * deck), then C, D (Pass 1 only), E, then Virtual Mode's per-register
 * clearing check.
 *
 * Explicitly NOT included:
 *   - Announce Power Down / Deal / Program (turn-level steps outside a
 *     single register's scope)
 *   - Pass 2 of Resolve Laser Fire (nothing in current scope produces
 *     forced movement)
 *   - sand's enter-mid-move stop is wired in here (via
 *     `stopOnEnteringSand` on Move-3 specifically), but flaming oil's
 *     damage-on-entry is not — that's still deliberately scoped to
 *     laser-fire.ts's presence check only, per terrain.ts's own docstring
 */

const ROTATE_MAP_CW: Record<Direction, Direction> = { N: 'E', E: 'S', S: 'W', W: 'N' };
const ROTATE_MAP_CCW: Record<Direction, Direction> = { N: 'W', W: 'S', S: 'E', E: 'N' };
const ROTATE_MAP_180: Record<Direction, Direction> = { N: 'S', S: 'N', E: 'W', W: 'E' };

function rotateFacingForCard(facing: Direction, cardType: ProgramCard['type']): Direction {
  if (cardType === 'RotateRight') return ROTATE_MAP_CW[facing];
  if (cardType === 'RotateLeft') return ROTATE_MAP_CCW[facing];
  if (cardType === 'UTurn') return ROTATE_MAP_180[facing];
  return facing;
}

/**
 * Resolves exactly one robot's one program card: terrain's starting-square
 * adjustment, then (for a Move/Back-Up card) the core movement loop
 * followed by terrain's end-of-move slide, or (for a rotate card) the
 * facing change followed by gravel's slide if applicable. This is the
 * "missing orchestrator" — each piece it calls was already real and
 * tested; this is what runs them together in the right order.
 */
export function resolveProgramCard(
  grid: ComposedGrid,
  robots: RobotState[],
  robotId: string,
  card: ProgramCard,
): { robots: RobotState[]; events: MoveEvent[] } {
  const mover = robots.find((r) => r.id === robotId);
  if (!mover || mover.destroyed) return { robots, events: [] };

  const startCell = grid.cells[mover.y][mover.x];
  const adjustment = adjustForStartingTerrain(startCell.terrain, card.type);

  if (adjustment.cardFizzles) {
    return { robots, events: [] }; // slime: card discarded, zero effect, including no rotation
  }

  if (card.type === 'RotateLeft' || card.type === 'RotateRight' || card.type === 'UTurn') {
    const working = robots.map((r) => (r.id === robotId ? { ...r } : r));
    const target = working.find((r) => r.id === robotId)!;
    const originalFacing = target.facing;
    target.facing = rotateFacingForCard(originalFacing, card.type);

    if (card.type === 'UTurn') {
      // Gravel's slide is only documented for Rotate Left/Right — not
      // mentioned for U-Turn by the source, so deliberately not applied.
      return { robots: working, events: [] };
    }
    return applyGravelRotateSlide(grid, working, robotId, card.type, originalFacing);
  }

  const dir = card.type === 'BackUp' ? OPPOSITE[mover.facing] : mover.facing;
  const moveResult = resolveRobotMove(grid, robots, robotId, dir, adjustment.squares, {
    stopOnEnteringSand: card.type === 'Move3',
  });
  const terrainResult = applyEndOfMoveTerrain(grid, moveResult.robots, robotId, dir);

  return {
    robots: terrainResult.robots,
    events: [...moveResult.events, ...terrainResult.events],
  };
}

/**
 * Virtual Mode's per-register clearing check (every turn except turn 1,
 * which gets a whole-turn grace period handled by the caller, not here —
 * this function has no notion of "which turn" at all). Becoming real again
 * just clears the flag: the robot stays exactly where it physically is,
 * with its current facing — confirmed against the rulebook's exact
 * wording ("placed in THAT space", the one it just stopped sharing, not
 * its archive marker's square) after an earlier draft of this project's
 * own documentation had it backwards.
 */
export function clearVirtualIfSeparated(
  robots: RobotState[],
): { robots: RobotState[]; events: { type: 'becameReal'; robotId: string }[] } {
  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: { type: 'becameReal'; robotId: string }[] = [];

  for (const r of working.values()) {
    if (!r.virtual || r.destroyed) continue;
    const stillSharing = [...working.values()].some(
      (other) => other.id !== r.id && !other.destroyed && other.x === r.x && other.y === r.y,
    );
    if (!stillSharing) {
      r.virtual = false;
      events.push({ type: 'becameReal', robotId: r.id });
    }
  }

  return { robots: [...working.values()], events };
}

export type RegisterEvent = MoveEvent | LaserEvent | CheckpointEvent
  | { type: 'becameReal'; robotId: string };

/**
 * Runs one full register: step B (priority order, each robot's own card
 * for this register — index `registerNumber - 1` into its `registers`
 * array), then C, D (Pass 1), E, then Virtual Mode's clearing check.
 * `skipVirtualClearing` should be true for every register of turn 1 (the
 * whole-turn grace period) and false otherwise — this function doesn't
 * track turn number itself, so the caller decides.
 */
export function resolveRegister(
  grid: ComposedGrid,
  robots: RobotState[],
  registerNumber: number,
  skipVirtualClearing: boolean,
  checkpointOptions: {
    chopShopChoices?: Map<string, 'scrapAndRedraw' | 'replenish' | 'freeDraw'>;
    radioactiveWasteDrawChoices?: Map<string, boolean>;
  } = {},
): { robots: RobotState[]; events: RegisterEvent[]; winnerId: string | null } {
  const first = resolveRegisterMovement(grid, robots, registerNumber);
  const second = resolveRegisterCheckpoints(
    grid, first.robots, registerNumber, skipVirtualClearing, checkpointOptions,
  );
  return {
    robots: second.robots,
    events: [...first.events, ...second.events],
    winnerId: second.winnerId,
  };
}

/**
 * The first half of a register: steps B, C and D. Split out from
 * `resolveRegister` so a turn can be driven interruptibly — whether any
 * player owes a chop-shop or radioactive-waste decision depends on where
 * robots END UP after these three steps, so it cannot be known before
 * they run. `game.ts` calls this, works out who owes a choice, collects
 * the answers, and then calls `resolveRegisterCheckpoints`.
 */
export function resolveRegisterMovement(
  grid: ComposedGrid,
  robots: RobotState[],
  registerNumber: number,
): { robots: RobotState[]; events: RegisterEvent[] } {
  const events: RegisterEvent[] = [];
  let current = robots;

  // Step B: priority order, using each robot's own assigned card.
  const turnOrder = current
    .filter((r) => !r.destroyed)
    .map((r) => ({ id: r.id, card: r.registers?.[registerNumber - 1] ?? null }))
    .filter((entry): entry is { id: string; card: ProgramCard } => entry.card !== null)
    .sort((a, b) => b.card.priority - a.card.priority);

  for (const { id, card } of turnOrder) {
    const result = resolveProgramCard(grid, current, id, card);
    current = result.robots;
    events.push(...result.events);
  }

  // Step C.
  const boardElements = resolveBoardElementsMove(grid, current, registerNumber);
  current = boardElements.robots;
  events.push(...boardElements.events);

  // Step D, Pass 1 only.
  const laserFire = resolveLaserFirePass1(grid, current, registerNumber);
  current = laserFire.robots;
  events.push(...laserFire.events);

  return { robots: current, events };
}

/**
 * The second half of a register: step E, then Virtual Mode's per-register
 * clearing check. Takes the choices that only become answerable once the
 * first half has run.
 */
export function resolveRegisterCheckpoints(
  grid: ComposedGrid,
  robots: RobotState[],
  registerNumber: number,
  skipVirtualClearing: boolean,
  checkpointOptions: {
    chopShopChoices?: Map<string, 'scrapAndRedraw' | 'replenish' | 'freeDraw'>;
    radioactiveWasteDrawChoices?: Map<string, boolean>;
  } = {},
): { robots: RobotState[]; events: RegisterEvent[]; winnerId: string | null } {
  const events: RegisterEvent[] = [];
  let current = robots;

  // Step E.
  const checkpoints = resolveTouchCheckpoints(grid, current, registerNumber, checkpointOptions);
  current = checkpoints.robots;
  events.push(...checkpoints.events);

  // Virtual Mode's per-register clearing.
  if (!skipVirtualClearing) {
    const virtualResult = clearVirtualIfSeparated(current);
    current = virtualResult.robots;
    events.push(...virtualResult.events);
  }

  return { robots: current, events, winnerId: checkpoints.winnerId };
}
