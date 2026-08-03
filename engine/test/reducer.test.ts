import { describe, it, expect } from 'vitest';
import { cardsDealt, lockedRegisters, isDestroyed } from '../src/reducer.js';

describe('damage table (RULES_SPEC \u00a76)', () => {
  it('deals 9 minus damage cards, floored at 0', () => {
    expect(cardsDealt(0)).toBe(9);
    expect(cardsDealt(4)).toBe(5);
    expect(cardsDealt(9)).toBe(0);
    expect(cardsDealt(10)).toBe(0);
  });

  it('locks no registers below 5 damage', () => {
    expect(lockedRegisters(0)).toEqual([false, false, false, false, false]);
    expect(lockedRegisters(4)).toEqual([false, false, false, false, false]);
  });

  it('locks from register 5 downward as damage rises', () => {
    // index 0 = register 1 ... index 4 = register 5
    expect(lockedRegisters(5)).toEqual([false, false, false, false, true]);
    expect(lockedRegisters(6)).toEqual([false, false, false, true, true]);
    expect(lockedRegisters(7)).toEqual([false, false, true, true, true]);
    expect(lockedRegisters(8)).toEqual([false, true, true, true, true]);
    expect(lockedRegisters(9)).toEqual([true, true, true, true, true]);
  });

  it('destroys at exactly 10 damage', () => {
    expect(isDestroyed(9)).toBe(false);
    expect(isDestroyed(10)).toBe(true);
  });
});
