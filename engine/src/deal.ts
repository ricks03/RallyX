import { ProgramCard, RobotState } from './movement.js';
import { ProgramDeck, Rng, discardCards, drawCards } from './cards.js';
import { cardsDealt, lockedRegisters } from './reducer.js';

/**
 * STATUS: real, complete for the base game. Turn step 1 of 5 —
 * RULES_SPEC.md §2's `Deal Program Cards`.
 *
 * Power-down timing, confirmed directly by the project owner: power down
 * is announced while programming turn N and takes effect for turn N+1, so
 * the transition lands HERE, at the Deal that opens the powered-down turn.
 * At that moment the robot discards all its damage and all its cards —
 * hand and registers alike, locked registers included — and is dealt
 * nothing.
 *
 * The "empty locked register is filled with a random card from the deck"
 * rule is real base-game behaviour and lives here, also confirmed by the
 * project owner. The case that produces it: a robot powers down (emptying
 * every register), takes 5 or more damage WHILE powered down, and powers
 * back up to find registers locked but empty. Reading the rulebook alone
 * would suggest otherwise — the only place it states the rule outright is
 * on the Overload Override Option card — but the situation above arises
 * with no Options in play at all.
 *
 * Deliberately NOT included:
 *   - The Option-card half of a Deal (Interceptor's card exchange, etc.)
 *   - A destroyed robot's return-to-play power-down choice, which
 *     RULES_SPEC assigns to whoever orchestrates the full turn: this
 *     function reads `poweredDown` and `announcedPowerDownNextTurn` as it
 *     finds them and does not decide who set them.
 */

export type DealEventType =
  | 'poweredDown' | 'poweredUp' | 'dealt' | 'lockedRegisterFilled';

export interface DealEvent {
  type: DealEventType;
  robotId: string;
  /** Set on `dealt` (hand size) and `lockedRegisterFilled` (register
   * number, 1-5). Absent on the power-state events. */
  count?: number;
}

export function resolveDeal(
  robots: RobotState[],
  deck: ProgramDeck,
  rng: Rng,
): { robots: RobotState[]; deck: ProgramDeck; events: DealEvent[] } {
  const working = robots.map((r) => ({ ...r }));
  const events: DealEvent[] = [];
  let currentDeck = deck;

  for (const r of working) {
    if (r.destroyed) continue; // returns to play at End of Turn, so shouldn't be seen here

    // 1. Power-state transition, before anything reads damage or locks.
    if (r.announcedPowerDownNextTurn) {
      r.poweredDown = true;
      r.announcedPowerDownNextTurn = false;
      r.damage = 0;

      const surrendered: ProgramCard[] = [
        ...(r.hand ?? []),
        ...((r.registers ?? []).filter((c): c is ProgramCard => c !== null)),
      ];
      if (surrendered.length > 0) currentDeck = discardCards(currentDeck, surrendered);

      r.hand = [];
      r.registers = [null, null, null, null, null];
      r.lockedRegisters = lockedRegisters(r.damage);
      events.push({ type: 'poweredDown', robotId: r.id });
      continue; // receives no Program cards while powered down
    }

    if (r.poweredDown) {
      r.poweredDown = false;
      events.push({ type: 'poweredUp', robotId: r.id });
    }

    // 2. Locks are recomputed from current damage every Deal — damage
    // taken while powered down is exactly how a robot arrives here with
    // locks over registers that were emptied.
    const locked = lockedRegisters(r.damage);
    r.lockedRegisters = locked;

    const registers: (ProgramCard | null)[] = (r.registers ?? [null, null, null, null, null]).slice();
    while (registers.length < 5) registers.push(null);

    // 3. Fill any locked register left empty with a random card off the deck.
    for (let i = 0; i < 5; i++) {
      if (!locked[i] || registers[i] !== null) continue;
      const draw = drawCards(currentDeck, 1, rng);
      currentDeck = draw.deck;
      if (draw.cards.length === 0) break; // deck exhausted; see cards.ts
      registers[i] = draw.cards[0];
      events.push({ type: 'lockedRegisterFilled', robotId: r.id, count: i + 1 });
    }
    r.registers = registers;

    // 4. Deal the hand.
    const handSize = cardsDealt(r.damage);
    const dealt = drawCards(currentDeck, handSize, rng);
    currentDeck = dealt.deck;
    r.hand = dealt.cards;
    events.push({ type: 'dealt', robotId: r.id, count: dealt.cards.length });
  }

  return { robots: working, deck: currentDeck, events };
}
