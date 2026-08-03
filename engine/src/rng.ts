import { Rng } from './cards.js';

/**
 * STATUS: real, complete. A seeded pseudo-random generator whose internal
 * state can be read out, stored, and resumed.
 *
 * The engine takes an `Rng` per `advance` call rather than holding one, so
 * that concurrent games never share a generator. That works for a single
 * process, but a server handling one HTTP request per player action has to
 * rebuild the generator on every request. Rebuilding it from the ORIGINAL
 * SEED each time would hand out the same numbers turn after turn: the same
 * shuffle, the same hands, forever.
 *
 * So the thing to persist is not the seed but the generator's current
 * state. `create` takes a state, `state` reads the current one back, and
 * the two round-trip exactly: a generator resumed from a stored state
 * continues the sequence rather than restarting it.
 *
 * mulberry32 is used because its entire state is a single 32-bit integer,
 * which stores in one INT UNSIGNED column with no encoding. It is not
 * cryptographically secure and must not be used for session tokens or
 * anything else an adversary benefits from predicting; for shuffling a
 * deck it is fine, and its period (2^32) is far beyond what a game of
 * RoboRally will consume.
 */

export interface SeededRng extends Rng {
  /** The generator's current internal state, always a uint32. Persist
   * THIS, not the seed it started from. */
  readonly state: number;
}

/**
 * Builds a generator resuming from `state`. Any uint32 is a valid state,
 * including a fresh seed, so this doubles as "start a new game from seed".
 */
export function createRng(state: number): SeededRng {
  let a = state >>> 0;

  const rng = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  Object.defineProperty(rng, 'state', {
    get: () => a,
    enumerable: true,
  });

  return rng as SeededRng;
}

/**
 * A fresh seed for a new game. Uses `crypto.getRandomValues` where it
 * exists (Node 19+, and every browser) so two games created in the same
 * millisecond do not collide, falling back to `Math.random` otherwise.
 */
export function randomSeed(): number {
  const c = (globalThis as {
    crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array };
  }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}
