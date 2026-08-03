import { RobotState } from './movement.js';

/**
 * STATUS: real, complete. Turn step 3 of 5 — RULES_SPEC.md §2's
 * `Announce Power Down`.
 *
 * Ordering confirmed directly by the project owner: this step comes AFTER
 * Program Registers, as the last thing before programming is locked in.
 *
 * There are three places a power-down decision can be made, also confirmed
 * by the project owner, and all three converge on the same flag
 * (`announcedPowerDownNextTurn`) which `deal.ts` consumes at the start of
 * the next turn:
 *
 *   a. Here, at the end of programming, for next turn.
 *   b. When a robot returns from the dead — `end-of-turn.ts`'s Return
 *      Robots to Play, via `returnPowerDownChoices`.
 *   c. When a robot is already powered down and chooses to stay down —
 *      `end-of-turn.ts`'s Continue Power Down, via
 *      `continuePowerDownChoices`.
 *
 * (b) and (c) both happen at End of Turn, i.e. before that robot is dealt
 * cards, which is why none of them need separate handling in Deal.
 *
 * This step therefore covers (a) only, and applies to robots actually in
 * play: a destroyed robot's decision is (b), and an already-powered-down
 * robot's is (c). Both are skipped here rather than being allowed to
 * announce twice through different routes.
 */

export interface AnnouncePowerDownEvent {
  type: 'announcedPowerDown';
  robotId: string;
}

export function resolveAnnouncePowerDown(
  robots: RobotState[],
  announcements: ReadonlyMap<string, boolean> = new Map(),
): { robots: RobotState[]; events: AnnouncePowerDownEvent[] } {
  const working = robots.map((r) => ({ ...r }));
  const events: AnnouncePowerDownEvent[] = [];

  for (const r of working) {
    if (r.destroyed) continue; // case (b)
    if (r.poweredDown) continue; // case (c)

    const announced = announcements.get(r.id);
    if (announced === undefined) continue; // no decision made is not the same as declining

    r.announcedPowerDownNextTurn = announced;
    if (announced) events.push({ type: 'announcedPowerDown', robotId: r.id });
  }

  return { robots: working, events };
}
