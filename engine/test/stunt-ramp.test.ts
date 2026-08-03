import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { composeCourse, computeElevation, BoardLibrary } from '../src/composer.js';
import { rampExitFallDamage } from '../src/stunt-ramp.js';
import { BoardData, Course } from '../src/types.js';

function loadRolling3() {
  const path = new URL('./real-boards/Rolling3.json', import.meta.url);
  const raw = readFileSync(path, 'utf-8');
  const data = JSON.parse(raw) as BoardData;
  const sha256 = createHash('sha256').update(raw).digest('hex');
  return { data, sha256 };
}

describe('rampExitFallDamage — three worked examples confirmed against real Rolling3.json', () => {
  const rolling3 = loadRolling3();
  const library: BoardLibrary = { Rolling3: rolling3 };
  const course: Course = {
    boards: [{ id: 'Rolling3', sha256: rolling3.sha256, gridX: 0, gridY: 0, rotation: 0 }],
    dock: null,
    flags: [],
    lifeTokens: 3,
  };
  const grid = composeCourse(course, library);
  computeElevation(grid);

  const rampLevel = grid.cells[1][0].level; // (0,1)

  it('Move-1 from the ramp (0,1): 1 + 1 bonus = 2 squares, lands on (0,3), falls 2 levels (4 damage)', () => {
    const landing = grid.cells[3][0]; // (0,3)
    expect(rampExitFallDamage(rampLevel, landing)).toBe(4);
  });

  it('Move-2 from the ramp (0,1): 2 + 1 bonus = 3 squares, lands exactly on the second ramp (0,4), no damage', () => {
    const landing = grid.cells[4][0]; // (0,4), also a stunt ramp
    expect(landing.stuntRamp).toBeDefined();
    expect(rampExitFallDamage(rampLevel, landing)).toBe(0);
  });

  it('Move-3 from the ramp (0,1): 3 + 1 bonus = 4 squares, lands on (0,5), falls 1 level (2 damage)', () => {
    const landing = grid.cells[5][0]; // (0,5), ordinary ground
    expect(landing.stuntRamp).toBeUndefined();
    expect(rampExitFallDamage(rampLevel, landing)).toBe(2);
  });

  // Note: this function is only ever correct to call for an actual
  // ramp-to-ramp bonus-exit crossing. A robot arriving on a stunt-ramp
  // square by any other means (pushed there, falling from an unrelated
  // cliff) must use the plain level-difference formula instead — that's
  // the caller's responsibility (the movement resolver, not yet built),
  // not something this function can detect on its own from the cell data.
});
