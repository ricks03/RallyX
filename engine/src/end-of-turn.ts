import { ComposedGrid, Direction } from './types.js';
import { RobotState } from './movement.js';
import { applyDamage } from './reducer.js';

/**
 * STATUS: covers the full rulebook order now — Radiation, Repair sites
 * (including flags, folded in for free since both just check
 * `cell.repair`), Wipe Registers, Continue Power Down, Return Robots to
 * Play.
 *
 * The two-wrench site's "heal 2 OR option/upgrade" is a real choice now
 * (`repairChoices`), defaulting to heal if unspecified. The wrench+hammer
 * site is NOT a choice — per RULES_SPEC it's "heal 1 AND option/upgrade",
 * both automatic — so only the 2-wrench site reads `repairChoices` at all.
 * The option/upgrade grant itself is still a no-op event, not a real card
 * — there's no Options system to grant into yet, and that's the one
 * genuinely deferred half here, not guessed at.
 *
 * Wipe Registers: confirmed directly by the project owner, correcting an
 * earlier draft's assumption. A powered-down robot clears ALL 5 registers
 * here, ignoring lock status entirely. A robot that's actively playing
 * (not powered down) only wipes its non-locked registers, keeping locked
 * ones as usual.
 *
 * Explicitly NOT included:
 *   - The "empty locked register gets filled with a random card" rule —
 *     that's a dealing-time concern (no Deal step exists yet), not a
 *     wipe-time one.
 *   - Actually powering a robot back up (clearing `poweredDown`, applying
 *     the "discard all damage at next Deal" effect) — this only sets
 *     `announcedPowerDownNextTurn`, which is as far as End of Turn Effects
 *     itself goes; the transition happens at the next Deal step, not built.
 *   - Virtual Mode's duration (turn-1-only grace vs. per-register checks
 *     on later turns) is not decided here — this only sets `virtual: true`
 *     on the newly-returning robot at the moment of return (confirmed
 *     against the rulebook: only the robot re-entering becomes virtual,
 *     not whoever was already there). Clearing it on a later register is
 *     handled by `orchestration.ts`'s `clearVirtualIfSeparated` — and per
 *     the rulebook, becoming real again just means clearing the flag: the
 *     robot stays exactly where it physically is, with its current facing.
 *     An earlier reading of this rule (now fixed in RULES_SPEC.md) wrongly
 *     assumed it snaps back to its archive marker — the exact text says
 *     "placed in THAT space" (the one it just stopped sharing), not the
 *     marker's square.
 */

export type EndOfTurnEventType =
  | 'radiationDamage' | 'healed' | 'optionGranted' | 'registersWiped'
  | 'continuingPowerDown' | 'returnedToPlay' | 'becameVirtual'
  | 'announcedPowerDownOnReturn' | 'lifeLost' | 'eliminated'
  | 'destroyedByDamage';

export interface EndOfTurnEvent {
  type: EndOfTurnEventType;
  robotId: string;
}

export function resolveEndOfTurnEffects(
  grid: ComposedGrid,
  robots: RobotState[],
  options: {
    facingChoices?: Map<string, Direction>;
    repairChoices?: Map<string, 'heal' | 'option'>;
    continuePowerDownChoices?: Map<string, boolean>;
    /** Power-down decision (b) of three — see announce-power-down.ts. A
     * robot returning from destruction may choose to come back powered
     * down, regardless of whether it had announced one beforehand.
     * Confirmed as the real 1st edition rule, not a house rule. Recorded
     * as an announcement for NEXT turn's Deal, which is where the robot
     * actually powers down and discards the 2 damage it receives here. */
    returnPowerDownChoices?: Map<string, boolean>;
  } = {},
): { robots: RobotState[]; events: EndOfTurnEvent[] } {
  const facingChoices = options.facingChoices ?? new Map();
  const repairChoices = options.repairChoices ?? new Map();
  const continuePowerDownChoices = options.continuePowerDownChoices ?? new Map();
  const returnPowerDownChoices = options.returnPowerDownChoices ?? new Map();

  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: EndOfTurnEvent[] = [];

  // 1. Radiation — checked against CURRENT position, not archive history.
  for (const r of working.values()) {
    if (r.destroyed) continue;
    if (grid.cells[r.y][r.x].radiation) {
      events.push({ type: 'radiationDamage', robotId: r.id });
      // Radiation runs first at End of Turn, so a robot killed here is
      // destroyed in time for Return Robots to Play below to spend a life
      // token and bring it back this same turn.
      if (applyDamage(r, 1)) {
        events.push({ type: 'destroyedByDamage', robotId: r.id });
      }
    }
  }

  // 2 & 3. Repair sites, including flags (unified for free — see docstring).
  for (const r of working.values()) {
    if (r.destroyed) continue;
    const repair = grid.cells[r.y][r.x].repair;
    if (!repair) continue;

    if (repair.wrenches === 2) {
      const choice = repairChoices.get(r.id) ?? 'heal';
      if (choice === 'option') {
        events.push({ type: 'optionGranted', robotId: r.id });
      } else {
        r.damage = Math.max(0, r.damage - 2);
        events.push({ type: 'healed', robotId: r.id });
      }
    } else if (repair.hammer) {
      r.damage = Math.max(0, r.damage - 1); // heal 1 AND option — not a choice
      events.push({ type: 'healed', robotId: r.id });
      events.push({ type: 'optionGranted', robotId: r.id });
    } else {
      r.damage = Math.max(0, r.damage - 1);
      events.push({ type: 'healed', robotId: r.id });
    }
  }

  // 4. Wipe Registers. Confirmed by the project owner, correcting an
  // earlier assumption in this file: a powered-down robot clears ALL 5
  // registers here, ignoring lock status entirely — not skipped. Only a
  // robot that's actively playing (not powered down) respects the
  // per-register lock.
  for (const r of working.values()) {
    if (r.destroyed || !r.registers) continue;
    let wiped = false;
    if (r.poweredDown) {
      for (let i = 0; i < r.registers.length; i++) {
        if (r.registers[i] !== null) {
          r.registers[i] = null;
          wiped = true;
        }
      }
    } else {
      const locked = r.lockedRegisters ?? [false, false, false, false, false];
      for (let i = 0; i < r.registers.length; i++) {
        if (!locked[i] && r.registers[i] !== null) {
          r.registers[i] = null;
          wiped = true;
        }
      }
    }
    if (wiped) events.push({ type: 'registersWiped', robotId: r.id });
  }

  // 5. Continue Power Down.
  for (const r of working.values()) {
    if (r.destroyed || !r.poweredDown) continue;
    const continuing = continuePowerDownChoices.get(r.id) ?? false;
    r.announcedPowerDownNextTurn = continuing;
    if (continuing) events.push({ type: 'continuingPowerDown', robotId: r.id });
  }

  // 6. Return Robots to Play.
  for (const r of working.values()) {
    if (!r.destroyed) continue;
    if (r.eliminated) continue; // already out for good; nothing left to do

    // Life tokens. `lives` absent means unlimited — the pre-life-token
    // behaviour, kept so existing callers are unaffected. The rulebook
    // also has the player discard one Option card of their choice here;
    // that half is deferred with the rest of the Options catalog.
    if (r.lives !== undefined) {
      r.lives -= 1;
      events.push({ type: 'lifeLost', robotId: r.id });
      if (r.lives <= 0) {
        r.eliminated = true;
        events.push({ type: 'eliminated', robotId: r.id });
        continue; // stays destroyed; does not re-enter play
      }
    }

    const archive = r.archiveMarker ?? { x: r.x, y: r.y };
    const facing = facingChoices.get(r.id) ?? r.facing;

    r.destroyed = false;
    r.damage = 2;
    r.x = archive.x;
    r.y = archive.y;
    r.facing = facing;
    events.push({ type: 'returnedToPlay', robotId: r.id });

    if (returnPowerDownChoices.get(r.id)) {
      r.announcedPowerDownNextTurn = true;
      events.push({ type: 'announcedPowerDownOnReturn', robotId: r.id });
    }

    // Confirmed against the rulebook's exact wording: "If a robot
    // re-enters play on the same space as another robot, THEY do so in
    // Virtual Mode" — only the robot re-entering becomes virtual. The
    // already-present occupant is untouched by this; it isn't described
    // as becoming virtual too, so it doesn't.
    const occupiedByOther = [...working.values()].some(
      (other) => other.id !== r.id && !other.destroyed && other.x === r.x && other.y === r.y,
    );
    if (occupiedByOther) {
      r.virtual = true;
      events.push({ type: 'becameVirtual', robotId: r.id });
    }
  }

  return { robots: [...working.values()], events };
}
