import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  adjustForStartingTerrain, applyEndOfMoveTerrain, applyGravelRotateSlide, executeSlide,
} from '../src/terrain.js';
import { resolveRobotMove, RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid, BoardData } from '../src/types.js';

function cell(terrain?: ComposedCell['terrain']): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' }, ...(terrain ? { terrain } : {}) };
}

function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => cell()),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number): RobotState {
  return { id, x, y, facing: 'E', damage: 0, destroyed: false };
}

describe('adjustForStartingTerrain — oil', () => {
  it('Move-1 and Back-Up become 0', () => {
    expect(adjustForStartingTerrain(['oil'], 'Move1').squares).toBe(0);
    expect(adjustForStartingTerrain(['oil'], 'BackUp').squares).toBe(0);
  });
  it('Move-2 becomes 1, Move-3 becomes 2', () => {
    expect(adjustForStartingTerrain(['oil'], 'Move2').squares).toBe(1);
    expect(adjustForStartingTerrain(['oil'], 'Move3').squares).toBe(2);
  });
  it('rotates are unaffected (not fizzled)', () => {
    const result = adjustForStartingTerrain(['oil'], 'RotateLeft');
    expect(result.cardFizzles).toBe(false);
  });
  it('flaming oil follows the identical movement rule', () => {
    expect(adjustForStartingTerrain(['flamingOil'], 'Move2').squares).toBe(1);
  });
});

describe('adjustForStartingTerrain — slime', () => {
  it('Move-1, Back-Up, and rotates all fizzle completely', () => {
    for (const card of ['Move1', 'BackUp', 'RotateLeft', 'RotateRight', 'UTurn'] as const) {
      const result = adjustForStartingTerrain(['slime'], card);
      expect(result.cardFizzles).toBe(true);
      expect(result.squares).toBe(0);
    }
  });
  it('Move-2 and Move-3 are completely unaffected (full value, no negation)', () => {
    expect(adjustForStartingTerrain(['slime'], 'Move2').squares).toBe(2);
    expect(adjustForStartingTerrain(['slime'], 'Move3').squares).toBe(3);
    expect(adjustForStartingTerrain(['slime'], 'Move2').cardFizzles).toBe(false);
  });
});

describe('adjustForStartingTerrain — mud', () => {
  it('Move-2 and Move-3 starting in mud do not move at all', () => {
    expect(adjustForStartingTerrain(['mud'], 'Move2').squares).toBe(0);
    expect(adjustForStartingTerrain(['mud'], 'Move3').squares).toBe(0);
  });
  it('Move-1 and Back-Up are unaffected', () => {
    expect(adjustForStartingTerrain(['mud'], 'Move1').squares).toBe(1);
    expect(adjustForStartingTerrain(['mud'], 'BackUp').squares).toBe(1);
  });
});

describe('adjustForStartingTerrain — sand', () => {
  it('Move-3 starting in sand does not move at all', () => {
    expect(adjustForStartingTerrain(['sand'], 'Move3').squares).toBe(0);
  });
  it('Move-1, Move-2, and Back-Up are unaffected', () => {
    expect(adjustForStartingTerrain(['sand'], 'Move1').squares).toBe(1);
    expect(adjustForStartingTerrain(['sand'], 'Move2').squares).toBe(2);
    expect(adjustForStartingTerrain(['sand'], 'BackUp').squares).toBe(1);
  });
});

describe('applyEndOfMoveTerrain — oil sliding', () => {
  it('keeps sliding across multiple oil squares until reaching non-oil ground', () => {
    const grid = makeGrid(6);
    grid.cells[0][1] = cell(['oil']);
    grid.cells[0][2] = cell(['oil']);
    grid.cells[0][3] = cell(['oil']); // robot lands here after its card's move
    grid.cells[0][4] = cell(); // ordinary ground — slide stops here
    const { robots } = applyEndOfMoveTerrain(grid, [robot('r1', 3, 0)], 'r1', 'E');
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(4);
  });

  it('stops at a wall', () => {
    const grid = makeGrid(6);
    grid.cells[0][3] = cell(['oil']);
    grid.cells[0][3].edges.E = [{ kind: 'wall' }];
    const { robots } = applyEndOfMoveTerrain(grid, [robot('r1', 3, 0)], 'r1', 'E');
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(3);
  });

  it('stops when hitting a robot that is not on oil (does not push)', () => {
    const grid = makeGrid(6);
    grid.cells[0][3] = cell(['oil']);
    grid.cells[0][4] = cell(); // ordinary ground, robot 'blocker' sits here
    const { robots } = applyEndOfMoveTerrain(
      grid, [robot('r1', 3, 0), robot('blocker', 4, 0)], 'r1', 'E',
    );
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(3); // did not push, did not move
    expect(robots.find((r) => r.id === 'blocker')!.x).toBe(4);
  });

  it('chain-slides both robots when the one in the way is also on oil', () => {
    const grid = makeGrid(6);
    grid.cells[0][3] = cell(['oil']);
    grid.cells[0][4] = cell(['oil']);
    grid.cells[0][5] = cell(); // ordinary ground
    const { robots } = applyEndOfMoveTerrain(
      grid, [robot('r1', 3, 0), robot('onOil', 4, 0)], 'r1', 'E',
    );
    expect(robots.find((r) => r.id === 'onOil')!.x).toBe(5);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(4);
  });
});

describe('applyEndOfMoveTerrain — mud sliding', () => {
  it('slides exactly one square, capped, even with open ground beyond', () => {
    const grid = makeGrid(6);
    grid.cells[0][3] = cell(['mud']);
    // no further mud past it — should still only slide 1, not stop short either
    const { robots } = applyEndOfMoveTerrain(grid, [robot('r1', 3, 0)], 'r1', 'E');
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(4);
  });

  it('does not continue a second square even if that square is also mud', () => {
    const grid = makeGrid(6);
    grid.cells[0][3] = cell(['mud']);
    grid.cells[0][4] = cell(['mud']);
    const { robots } = applyEndOfMoveTerrain(grid, [robot('r1', 3, 0)], 'r1', 'E');
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(4); // capped at 1, not 2
  });
});

describe('applyGravelRotateSlide', () => {
  it('slides 1 square in the original facing direction after a rotate on gravel', () => {
    const grid = makeGrid(5);
    grid.cells[2][2] = cell(['gravel']);
    const { robots } = applyGravelRotateSlide(grid, [robot('r1', 2, 2)], 'r1', 'RotateRight', 'E');
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(3);
  });

  it('does nothing off gravel', () => {
    const grid = makeGrid(5);
    const { robots } = applyGravelRotateSlide(grid, [robot('r1', 2, 2)], 'r1', 'RotateRight', 'E');
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(2);
  });
});

describe('adjustForStartingTerrain — real data (Capstone4, combined terrain)', () => {
  it('a real gravel+spikes cell still triggers the gravel rule (membership, not exact match)', () => {
    // Confirmed against real data: Capstone4 has cells with terrain
    // ['gravel', 'spikes'] together, not just plain 'gravel'.
    const result = adjustForStartingTerrain(['gravel', 'spikes'], 'Move2');
    expect(result.squares).toBe(2); // gravel doesn't touch Move cards at all
  });

  it('a real sand+spikes cell still applies the sand Move-3 restriction', () => {
    const result = adjustForStartingTerrain(['sand', 'spikes'], 'Move3');
    expect(result.squares).toBe(0);
  });
});

describe('adjustForStartingTerrain — real data (Rolling3, flamingOil)', () => {
  it('a real flamingOil cell applies the same negation as plain oil', () => {
    const raw = readFileSync(new URL('./real-boards/Rolling3.json', import.meta.url), 'utf-8');
    const data = JSON.parse(raw);
    let found: string[] | undefined;
    for (const row of data.cells) {
      for (const c of row) {
        if (c.terrain?.includes('flamingOil')) { found = c.terrain; break; }
      }
      if (found) break;
    }
    expect(found).toBeDefined();
    expect(adjustForStartingTerrain(found, 'Move2').squares).toBe(1);
  });
});

describe('resolveRobotMove — sand enter-mid-move rule', () => {
  it('a Move-3 that enters sand stops at the first sand square reached', () => {
    const grid = makeGrid(6);
    grid.cells[0][2] = cell(['sand']); // robot doesn't start here, enters it as square 2 of 3
    const { robots, events } = resolveRobotMove(
      grid, [robot('r1', 0, 0)], 'r1', 'E', 3, { stopOnEnteringSand: true },
    );
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(2); // stopped, not 3
    expect(events.some((e) => e.type === 'enteredSand')).toBe(true);
  });

  it('does not trigger for a Move-2 (the flag is only ever passed for Move-3)', () => {
    const grid = makeGrid(6);
    grid.cells[0][2] = cell(['sand']);
    // Simulates a Move-2 by simply not passing stopOnEnteringSand at all —
    // the caller (not yet built) is responsible for only setting this flag
    // when resolving an actual Move-3 card.
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 2);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(2); // full Move-2, no stop
  });

  it('does not fire if the sand square is never actually entered', () => {
    const grid = makeGrid(6);
    grid.cells[0][2] = cell(['sand']);
    const { robots, events } = resolveRobotMove(
      grid, [robot('r1', 0, 0)], 'r1', 'E', 1, { stopOnEnteringSand: true },
    );
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
    expect(events.some((e) => e.type === 'enteredSand')).toBe(false);
  });

  it('real sand data (Capstone4): entering it mid-move stops the robot there', () => {
    const raw = readFileSync(new URL('./real-boards/Capstone4.json', import.meta.url), 'utf-8');
    const data = JSON.parse(raw) as BoardData;
    const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

    let sandCell: { x: number; y: number } | null = null;
    outer: for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.cells[y][x].terrain?.includes('sand') && x > 0) {
          sandCell = { x, y };
          break outer;
        }
      }
    }
    expect(sandCell).not.toBeNull();

    const startX = sandCell!.x - 1;
    const { robots } = resolveRobotMove(
      grid, [robot('r1', startX, sandCell!.y)], 'r1', 'E', 3, { stopOnEnteringSand: true },
    );
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(sandCell!.x);
  });
});

describe('resolveRobotMove — water (implemented directly in movement.ts)', () => {
  it('negates the first square of movement when leaving water', () => {
    const grid = makeGrid(5);
    grid.cells[0][0] = cell(['water']);
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 2);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1); // Move-2 acts as Move-1
  });

  it('only negates once per register, tracked via waterNegationAlreadyUsed', () => {
    const grid = makeGrid(8);
    grid.cells[0][0] = cell(['water']);
    grid.cells[0][3] = cell(['water']);
    const first = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 2);
    expect(first.robots.find((r) => r.id === 'r1')!.x).toBe(1);
    expect(first.waterNegationUsed).toBe(true);

    // Second card this register, starting on ANOTHER water square, with the
    // negation already marked used — should NOT negate again.
    const second = resolveRobotMove(
      grid, first.robots, 'r1', 'E', 2, { waterNegationAlreadyUsed: first.waterNegationUsed },
    );
    const r1 = second.robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(3); // full Move-2, no second negation
  });

  it('currents are exempt even though the tile is also water', () => {
    const grid = makeGrid(5);
    grid.cells[0][0] = { level: 0, edges: {}, floor: { kind: 'open' }, terrain: ['water'], current: { exit: 'E', entries: ['W'], rotates: {} } };
    const { robots, waterNegationUsed } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 2);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(2); // full Move-2, no negation
    expect(waterNegationUsed).toBe(false);
  });
});
