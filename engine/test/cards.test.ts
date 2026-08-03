import { describe, it, expect } from 'vitest';
import {
  buildProgramDeck, shuffle, newDeck, drawCards, discardCards,
  PROGRAM_DECK_SIZE, Rng,
} from '../src/cards.js';
import { MovementCardType } from '../src/movement.js';

/** Deterministic RNG: a fixed repeating cycle, so shuffles are reproducible
 * without pulling in a seeded-PRNG dependency. */
function fixedRng(values: number[]): Rng {
  let i = 0;
  return () => values[i++ % values.length];
}

const countByType = (cards: { type: MovementCardType }[]) => {
  const counts = new Map<MovementCardType, number>();
  for (const c of cards) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return counts;
};

describe('buildProgramDeck', () => {
  const deck = buildProgramDeck();

  it('has 84 cards', () => {
    expect(deck).toHaveLength(PROGRAM_DECK_SIZE);
  });

  it('has the confirmed count for each card type', () => {
    const counts = countByType(deck);
    expect(counts.get('UTurn')).toBe(6);
    expect(counts.get('RotateLeft')).toBe(18);
    expect(counts.get('RotateRight')).toBe(18);
    expect(counts.get('BackUp')).toBe(6);
    expect(counts.get('Move1')).toBe(18);
    expect(counts.get('Move2')).toBe(12);
    expect(counts.get('Move3')).toBe(6);
  });

  it('gives every card a unique priority', () => {
    const priorities = new Set(deck.map((c) => c.priority));
    expect(priorities.size).toBe(PROGRAM_DECK_SIZE);
  });

  it('spans priorities 10 to 840 and is returned in ascending order', () => {
    expect(deck[0].priority).toBe(10);
    expect(deck[deck.length - 1].priority).toBe(840);
    for (let i = 1; i < deck.length; i++) {
      expect(deck[i].priority).toBeGreaterThan(deck[i - 1].priority);
    }
  });

  it('places the confirmed type at each range boundary', () => {
    const at = (p: number) => deck.find((c) => c.priority === p)?.type;
    expect(at(10)).toBe('UTurn');
    expect(at(60)).toBe('UTurn');
    expect(at(70)).toBe('RotateLeft');
    expect(at(410)).toBe('RotateLeft');
    expect(at(80)).toBe('RotateRight');
    expect(at(420)).toBe('RotateRight');
    expect(at(430)).toBe('BackUp');
    expect(at(480)).toBe('BackUp');
    expect(at(490)).toBe('Move1');
    expect(at(650)).toBe('Move1');
    expect(at(670)).toBe('Move2');
    expect(at(780)).toBe('Move2');
    expect(at(790)).toBe('Move3');
    expect(at(840)).toBe('Move3');
  });

  it('returns a fresh array each call', () => {
    const a = buildProgramDeck();
    a[0].priority = -1;
    expect(buildProgramDeck()[0].priority).toBe(10);
  });
});

describe('shuffle', () => {
  it('preserves every element', () => {
    const source = buildProgramDeck();
    const shuffled = shuffle(source, fixedRng([0.1, 0.9, 0.5, 0.3, 0.7]));
    expect(shuffled).toHaveLength(source.length);
    expect(new Set(shuffled.map((c) => c.priority)))
      .toEqual(new Set(source.map((c) => c.priority)));
  });

  it('does not mutate its input', () => {
    const source = buildProgramDeck();
    const before = source.map((c) => c.priority);
    shuffle(source, fixedRng([0.1, 0.9, 0.5]));
    expect(source.map((c) => c.priority)).toEqual(before);
  });

  it('is reproducible for a given rng sequence', () => {
    const a = shuffle(buildProgramDeck(), fixedRng([0.1, 0.9, 0.5, 0.3]));
    const b = shuffle(buildProgramDeck(), fixedRng([0.1, 0.9, 0.5, 0.3]));
    expect(a.map((c) => c.priority)).toEqual(b.map((c) => c.priority));
  });

  it('actually reorders (an rng of all zeroes still permutes)', () => {
    const source = buildProgramDeck();
    const shuffled = shuffle(source, () => 0);
    expect(shuffled.map((c) => c.priority)).not.toEqual(source.map((c) => c.priority));
  });
});

describe('newDeck', () => {
  it('starts with all 84 cards in the draw pile and none discarded', () => {
    const deck = newDeck(fixedRng([0.2, 0.6, 0.4]));
    expect(deck.draw).toHaveLength(PROGRAM_DECK_SIZE);
    expect(deck.discard).toHaveLength(0);
  });
});

describe('drawCards', () => {
  const rng = () => 0.5;

  it('draws from the front of the draw pile', () => {
    const deck = newDeck(rng);
    const expected = deck.draw.slice(0, 9).map((c) => c.priority);
    const { cards } = drawCards(deck, 9, rng);
    expect(cards.map((c) => c.priority)).toEqual(expected);
  });

  it('removes drawn cards from the deck without discarding them', () => {
    const deck = newDeck(rng);
    const result = drawCards(deck, 9, rng);
    expect(result.deck.draw).toHaveLength(PROGRAM_DECK_SIZE - 9);
    expect(result.deck.discard).toHaveLength(0);
  });

  it('does not mutate the deck it was given', () => {
    const deck = newDeck(rng);
    drawCards(deck, 9, rng);
    expect(deck.draw).toHaveLength(PROGRAM_DECK_SIZE);
  });

  it('deals 8 hands of 9 without exhausting the deck', () => {
    let deck = newDeck(rng);
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const result = drawCards(deck, 9, rng);
      deck = result.deck;
      expect(result.cards).toHaveLength(9);
      for (const c of result.cards) seen.add(c.priority);
    }
    expect(seen.size).toBe(72); // no card dealt to two players
    expect(deck.draw).toHaveLength(12);
  });

  it('reshuffles the discard pile when the draw pile runs dry mid-draw', () => {
    let deck = newDeck(rng);
    const first = drawCards(deck, 80, rng);
    deck = discardCards(first.deck, first.cards); // 4 left to draw, 80 discarded
    const second = drawCards(deck, 10, rng);
    expect(second.cards).toHaveLength(10);
    expect(second.deck.discard).toHaveLength(0);
    expect(second.deck.draw).toHaveLength(74);
  });

  it('returns a short hand rather than throwing when both piles empty', () => {
    const deck = newDeck(rng);
    const result = drawCards(deck, 100, rng);
    expect(result.cards).toHaveLength(PROGRAM_DECK_SIZE);
    expect(result.deck.draw).toHaveLength(0);
    expect(result.deck.discard).toHaveLength(0);
  });

  it('draws nothing for a hand size of 0 (a robot at 9 damage)', () => {
    const deck = newDeck(rng);
    const result = drawCards(deck, 0, rng);
    expect(result.cards).toHaveLength(0);
    expect(result.deck.draw).toHaveLength(PROGRAM_DECK_SIZE);
  });
});

describe('discardCards', () => {
  const rng = () => 0.5;

  it('appends to the discard pile without touching the draw pile', () => {
    const deck = newDeck(rng);
    const { deck: afterDraw, cards } = drawCards(deck, 9, rng);
    const afterDiscard = discardCards(afterDraw, cards);
    expect(afterDiscard.discard).toHaveLength(9);
    expect(afterDiscard.draw).toHaveLength(PROGRAM_DECK_SIZE - 9);
  });

  it('does not mutate the deck it was given', () => {
    const deck = newDeck(rng);
    discardCards(deck, buildProgramDeck().slice(0, 3));
    expect(deck.discard).toHaveLength(0);
  });

  it('keeps the total card count at 84 across a draw-and-discard cycle', () => {
    const deck = newDeck(rng);
    const { deck: afterDraw, cards } = drawCards(deck, 40, rng);
    const afterDiscard = discardCards(afterDraw, cards);
    expect(afterDiscard.draw.length + afterDiscard.discard.length).toBe(PROGRAM_DECK_SIZE);
  });
});
