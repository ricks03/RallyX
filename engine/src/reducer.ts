// STATUS: partial. Fully implemented: the damage table. Everything else in
// this file is a structural skeleton — the phase machine's shape is real,
// but the per-square movement loop, laser resolution, terrain effects, and
// checkpoint handling from RULES_SPEC.md are NOT yet implemented. Treat the
// TODO-marked functions as stubs, not working code.

import { ComposedGrid } from './types.js';

// ============================================================
// Damage table — RULES_SPEC \u00a76, fully implemented
// ============================================================

export function cardsDealt(damage: number): number {
  return Math.max(0, 9 - damage);
}

/** Which of registers 1..5 are locked, given a damage total. Locking
 * proceeds from register 5 downward as damage rises 5..9. */
export function lockedRegisters(damage: number): boolean[] {
  const locked = [false, false, false, false, false]; // index 0 = register 1
  if (damage < 5) return locked;
  const numLocked = Math.min(5, damage - 4); // damage 5 -> 1 locked ... damage 9 -> 5 locked
  for (let i = 0; i < numLocked; i++) {
    locked[4 - i] = true; // fill from register 5 down to register 1
  }
  return locked;
}

export function isDestroyed(damage: number): boolean {
  return damage >= 10;
}

/**
 * Applies `amount` damage and destroys the robot at once if that brings it
 * to 10. Returns true only when this call is what killed it, so a caller
 * can emit its own event and abandon whatever it was doing.
 *
 * Confirmed directly by the project owner: a robot reaching 10 damage is
 * dead at that instant, even if there is more of the current step still to
 * run. That is why this is called at each point damage is applied rather
 * than sweeping up between steps.
 *
 * Takes a structural type rather than `RobotState` deliberately:
 * `movement.ts` declares `RobotState` and imports this module, so naming
 * that type here would close an import cycle.
 */
export function applyDamage(
  robot: { damage: number; destroyed: boolean },
  amount: number,
): boolean {
  robot.damage += amount;
  if (robot.destroyed || !isDestroyed(robot.damage)) return false;
  robot.destroyed = true;
  return true;
}

// ============================================================
// Phase machine skeleton — RULES_SPEC \u00a72
// ============================================================

export type TurnStep =
  | 'deal'
  | 'program'
  | 'announcePowerDown'
  | 'register'
  | 'endOfTurn';

export type RegisterStep = 'reveal' | 'move' | 'boardElements' | 'laserFire' | 'checkpoints';

/**
 * TODO (RULES_SPEC \u00a73): orchestrates Robot Movement across ALL robots in
 * priority order, one card each. The actual per-square mechanics (wall/
 * one-way check, chain-push, pit/off-board destruction, portal relocation,
 * spiked-wall damage) are real now — see `resolveRobotMove` in
 * `movement.ts`, tested against real board data. Still missing here: cliffs/
 * ramps, oil/water/mud/slime pre-adjustments, and the priority-ordering
 * orchestration across the whole register.
 */
export function resolveRobotMovement(_grid: ComposedGrid /*, ...args TBD */): never {
  throw new Error('resolveRobotMovement: not yet implemented — see RULES_SPEC \u00a73');
}

/**
 * Board Elements Move (register step C) is real now — see
 * `board-elements.ts`'s `resolveBoardElementsMove`, exported from the
 * package root. This stub is gone rather than kept as a duplicate name.
 */
/**
 * Pass 1 (board lasers, robot lasers, flamers, flaming oil, radioactive
 * waste, crushers) is real now — see `laser-fire.ts`'s
 * `resolveLaserFirePass1`, exported from the package root. Still stubs:
 * the weapon-choice pre-pass (optional weapons), additional weapons, main
 * laser modifications, explosions, and Pass 2 (forced movement — nothing
 * in the current Pass 1 scope produces any yet).
 */
/**
 * Touch Checkpoints is real now — see `checkpoints.ts`'s
 * `resolveTouchCheckpoints`, exported from the package root. Chop shop /
 * radioactive waste draw choices are still deferred (no Options system).
 */

/**
 * End of Turn Effects is real now — see `end-of-turn.ts`'s
 * `resolveEndOfTurnEffects`, exported from the package root. Register wipe
 * and Continue Power Down are still deferred (RobotState has no
 * register/hand or poweredDown fields yet).
 */
