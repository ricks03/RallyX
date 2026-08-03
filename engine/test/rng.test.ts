import { describe, it, expect } from 'vitest';
import { createRng, randomSeed } from '../src/rng.js';
import { newDeck, drawCards, shuffle, buildProgramDeck } from '../src/cards.js';
import { resolveDeal } from '../src/deal.js';
import { RobotState } from '../src/movement.js';

const robot = (id: string): RobotState =>
  ({ id, x: 0, y: 0, facing: 'N', damage: 0, destroyed: false });

describe('createRng', () => {
  it('produces values in [0, 1)', () => {
    const rng = createRng(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('gives the same sequence for the same seed', () => {
    const a = createRng(999);
    const b = createRng(999);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });

  it('gives different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('does not repeat itself over a short run', () => {
    const rng = createRng(42);
    const seen = new Set(Array.from({ length: 5000 }, () => rng()));
    expect(seen.size).toBeGreaterThan(4900);
  });

  it('spreads roughly evenly across the unit interval', () => {
    const rng = createRng(7);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100000; i++) buckets[Math.floor(rng() * 10)] += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11000);
    }
  });
});

describe('state round-trips', () => {
  it('exposes a uint32 state', () => {
    const rng = createRng(0xdeadbeef);
    rng();
    expect(Number.isInteger(rng.state)).toBe(true);
    expect(rng.state).toBeGreaterThanOrEqual(0);
    expect(rng.state).toBeLessThanOrEqual(0xffffffff);
  });

  it('advances its state as it is consumed', () => {
    const rng = createRng(5);
    const before = rng.state;
    rng();
    expect(rng.state).not.toBe(before);
  });

  it('starts with state equal to the seed, before any call', () => {
    expect(createRng(31337).state).toBe(31337);
  });

  it('CONTINUES the sequence when resumed from a stored state', () => {
    // This is the behaviour the server depends on: rebuild from the stored
    // state between requests and the sequence carries on.
    const original = createRng(2024);
    for (let i = 0; i < 5; i++) original();

    const stored = original.state;
    const expected = Array.from({ length: 5 }, () => original());

    const resumed = createRng(stored);
    const actual = Array.from({ length: 5 }, () => resumed());

    expect(actual).toEqual(expected);
  });

  it('does NOT restart the sequence when resumed', () => {
    const original = createRng(2024);
    const first = original();
    original();
    original();

    const resumed = createRng(original.state);
    expect(resumed()).not.toBe(first);
  });

  it('round-trips repeatedly, as a server would across many requests', () => {
    const oneShot = createRng(77);
    const expected = Array.from({ length: 30 }, () => oneShot());

    let state = 77;
    const actual: number[] = [];
    for (let request = 0; request < 30; request++) {
      const rng = createRng(state); // rebuilt every "request"
      actual.push(rng());
      state = rng.state; // persisted back
    }

    expect(actual).toEqual(expected);
  });

  it('survives a state that has wrapped past 2^31', () => {
    const rng = createRng(0xfffffff0);
    for (let i = 0; i < 100; i++) rng();
    expect(rng.state).toBeGreaterThanOrEqual(0);
    expect(rng.state).toBeLessThanOrEqual(0xffffffff);
    const resumed = createRng(rng.state);
    expect(resumed()).toBeGreaterThanOrEqual(0);
  });
});

describe('randomSeed', () => {
  it('returns a uint32', () => {
    for (let i = 0; i < 20; i++) {
      const seed = randomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('does not return the same value every time', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(40);
  });
});

describe('driving the engine', () => {
  it('shuffles a deck reproducibly from a seed', () => {
    const a = shuffle(buildProgramDeck(), createRng(500));
    const b = shuffle(buildProgramDeck(), createRng(500));
    expect(a.map((c) => c.priority)).toEqual(b.map((c) => c.priority));
  });

  it('deals identical hands from identical seeds', () => {
    const one = resolveDeal([robot('a'), robot('b')], newDeck(createRng(11)), createRng(22));
    const two = resolveDeal([robot('a'), robot('b')], newDeck(createRng(11)), createRng(22));
    expect(one.robots[0].hand!.map((c) => c.priority))
      .toEqual(two.robots[0].hand!.map((c) => c.priority));
  });

  it('deals DIFFERENT hands on a second deal when state is carried forward', () => {
    // The bug this whole module exists to prevent: rebuilding from the
    // seed each time would deal the same hand every turn.
    const rng = createRng(1234);
    const deck = newDeck(rng);

    const turn1 = resolveDeal([robot('a')], deck, rng);
    const turn2 = resolveDeal(
      [robot('a')],
      { draw: turn1.deck.draw, discard: turn1.deck.discard },
      rng,
    );

    expect(turn1.robots[0].hand!.map((c) => c.priority))
      .not.toEqual(turn2.robots[0].hand!.map((c) => c.priority));
  });

  it('reproduces a multi-step draw sequence after a simulated restart', () => {
    const continuous = createRng(8080);
    const deckA = newDeck(continuous);
    const drawA1 = drawCards(deckA, 9, continuous);
    const drawA2 = drawCards(drawA1.deck, 9, continuous);

    const first = createRng(8080);
    const deckB = newDeck(first);
    const drawB1 = drawCards(deckB, 9, first);
    const savedState = first.state;

    const second = createRng(savedState); // process restarted
    const drawB2 = drawCards(drawB1.deck, 9, second);

    expect(drawB1.cards.map((c) => c.priority)).toEqual(drawA1.cards.map((c) => c.priority));
    expect(drawB2.cards.map((c) => c.priority)).toEqual(drawA2.cards.map((c) => c.priority));
  });
});
