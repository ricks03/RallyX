import { ComposedGrid } from './types.js';
import { RobotState } from './movement.js';

/**
 * STATUS: covers flag ordering, victory, and archiving — both from real
 * board repair sites and the composer's synthetic non-final-flag repair
 * (that one comes for free, since composeCourse already attaches
 * `repair: { wrenches: 1 }` to every non-final flag cell — no special
 * case needed here at all). Chop shop and radioactive-waste-draw are now
 * real CHOICES (accepted as input maps, same shape as the weapon-choice
 * decision elsewhere), but the choice itself is a structural no-op: there
 * is still no Options catalog for either to actually scrap/redraw/
 * replenish/draw a real card into. The decision-making mechanic is real;
 * the downstream card effect is deliberately not modeled.
 */

export type CheckpointEventType = 'flagTouched' | 'victory' | 'repairSiteTouched'
  | 'chopShopVisited' | 'radioactiveWasteDrawn';

export interface CheckpointEvent {
  type: CheckpointEventType;
  robotId: string;
}

/**
 * Runs Touch Checkpoints for every robot, using each one's FINAL position
 * this register (never cross-over — this function only ever looks at
 * where a robot currently is, not its path this register).
 */
export function resolveTouchCheckpoints(
  grid: ComposedGrid,
  robots: RobotState[],
  currentRegister: number,
  options: {
    chopShopChoices?: Map<string, 'scrapAndRedraw' | 'replenish' | 'freeDraw'>;
    radioactiveWasteDrawChoices?: Map<string, boolean>;
  } = {},
): { robots: RobotState[]; events: CheckpointEvent[]; winnerId: string | null } {
  const chopShopChoices = options.chopShopChoices ?? new Map();
  const radioactiveWasteDrawChoices = options.radioactiveWasteDrawChoices ?? new Map();

  const working = new Map(robots.map((r) => [r.id, { ...r }]));
  const events: CheckpointEvent[] = [];
  let winnerId: string | null = null;

  for (const r of working.values()) {
    if (r.destroyed) continue;
    const cell = grid.cells[r.y][r.x];
    const lastTouched = r.lastTouchedFlag ?? 0;

    if (cell.flag) {
      const inOrder = cell.flag.number === lastTouched + 1;
      if (cell.flag.isFinal) {
        // "Last card, last flag, last hand" — the final flag doesn't
        // register as touched AT ALL outside register 5, as if the square
        // were empty floor for that robot at that moment.
        if (currentRegister === 5 && inOrder) {
          r.lastTouchedFlag = cell.flag.number;
          r.archiveMarker = { x: r.x, y: r.y };
          winnerId = r.id;
          events.push({ type: 'victory', robotId: r.id });
        }
      } else if (inOrder) {
        r.lastTouchedFlag = cell.flag.number;
        r.archiveMarker = { x: r.x, y: r.y };
        events.push({ type: 'flagTouched', robotId: r.id });
      }
    }

    // Any wrench space archives on touch, unconditionally — including a
    // non-final flag's synthetic repair, regardless of whether the flag
    // touch above was in order. Healing itself happens at End of Turn
    // Effects, not here.
    if (cell.repair) {
      r.archiveMarker = { x: r.x, y: r.y };
      events.push({ type: 'repairSiteTouched', robotId: r.id });
    }

    if (cell.chopShop && chopShopChoices.has(r.id)) {
      events.push({ type: 'chopShopVisited', robotId: r.id });
    }

    if (cell.radioactiveWaste && radioactiveWasteDrawChoices.get(r.id)) {
      events.push({ type: 'radioactiveWasteDrawn', robotId: r.id });
    }
  }

  return { robots: [...working.values()], events, winnerId };
}
