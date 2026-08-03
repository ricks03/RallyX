import { MovementCardType, ProgramCard } from './movement.js';

/**
 * STATUS: real, complete. The 84-card Program deck plus the draw/discard
 * pile that Deal Program Cards consumes.
 *
 * Composition confirmed directly by the project owner. Priority lives on
 * the card itself (see movement.ts) and every priority in the deck is
 * unique, so a priority doubles as a card identity — useful for a server
 * that has to name a specific card without shipping an id alongside it.
 *
 * Randomness is injected, never taken from `Math.random` directly, so the
 * engine stays a pure function of (state, action, rng) and a game can be
 * replayed exactly from a seed. Callers that don't care can pass
 * `Math.random`.
 */

export type Rng = () => number;

/** Count and priority range for each card type. Priorities are laid out
 * `start`, `start + step`, ... for `count` cards. */
interface DeckSpecEntry {
  type: MovementCardType;
  count: number;
  start: number;
  step: number;
}

export const PROGRAM_DECK_SPEC: readonly DeckSpecEntry[] = [
  { type: 'UTurn', count: 6, start: 10, step: 10 },
  { type: 'RotateLeft', count: 18, start: 70, step: 20 },
  { type: 'RotateRight', count: 18, start: 80, step: 20 },
  { type: 'BackUp', count: 6, start: 430, step: 10 },
  { type: 'Move1', count: 18, start: 490, step: 10 },
  { type: 'Move2', count: 12, start: 670, step: 10 },
  { type: 'Move3', count: 6, start: 790, step: 10 },
];

export const PROGRAM_DECK_SIZE = 84;

/** Builds the full deck in priority order. Not shuffled — `newDeck` does
 * that. Deterministic, so a test can index into it directly. */
export function buildProgramDeck(): ProgramCard[] {
  const cards: ProgramCard[] = [];
  for (const entry of PROGRAM_DECK_SPEC) {
    for (let i = 0; i < entry.count; i++) {
      cards.push({ type: entry.type, priority: entry.start + i * entry.step });
    }
  }
  cards.sort((a, b) => a.priority - b.priority);
  return cards;
}

/** Fisher-Yates, non-mutating. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface ProgramDeck {
  /** Face-down draw pile, next card at index 0. */
  draw: ProgramCard[];
  /** Cards out of play this turn, reshuffled in when the draw pile empties. */
  discard: ProgramCard[];
}

export function newDeck(rng: Rng): ProgramDeck {
  return { draw: shuffle(buildProgramDeck(), rng), discard: [] };
}

/**
 * Draws up to `n` cards. When the draw pile empties mid-draw the discard
 * pile is shuffled and becomes the new draw pile — the standard rule for
 * a deck that runs dry.
 *
 * If BOTH piles empty this returns fewer cards than asked for rather than
 * throwing: with 84 cards, 8 players and locked registers holding at most
 * 40 cards out of circulation, the arithmetic says it cannot happen, but
 * an Option that holds extra cards out could change that arithmetic later,
 * and a short hand is a recoverable state where an exception is not.
 * Callers that care should compare `cards.length` against `n`.
 */
export function drawCards(
  deck: ProgramDeck,
  n: number,
  rng: Rng,
): { deck: ProgramDeck; cards: ProgramCard[] } {
  let draw = deck.draw.slice();
  let discard = deck.discard.slice();
  const cards: ProgramCard[] = [];

  while (cards.length < n) {
    if (draw.length === 0) {
      if (discard.length === 0) break;
      draw = shuffle(discard, rng);
      discard = [];
    }
    cards.push(draw.shift()!);
  }

  return { deck: { draw, discard }, cards };
}

/** Returns cards to the discard pile. */
export function discardCards(deck: ProgramDeck, cards: readonly ProgramCard[]): ProgramDeck {
  return { draw: deck.draw.slice(), discard: [...deck.discard, ...cards] };
}
