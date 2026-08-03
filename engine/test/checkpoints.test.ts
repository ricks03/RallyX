import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveTouchCheckpoints } from '../src/checkpoints.js';
import { composeCourse, BoardLibrary } from '../src/composer.js';
import { RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid, BoardData, Course } from '../src/types.js';

function openCell(): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, openCell),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number, lastTouchedFlag = 0): RobotState {
  return { id, x, y, facing: 'E', damage: 0, destroyed: false, lastTouchedFlag };
}

describe('resolveTouchCheckpoints — flag ordering', () => {
  it('touching flag 1 first archives and progresses', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 1, isFinal: false };
    const { robots, events } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0)], 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.lastTouchedFlag).toBe(1);
    expect(r1.archiveMarker).toEqual({ x: 0, y: 0 });
    expect(events.some((e) => e.type === 'flagTouched')).toBe(true);
  });

  it('touching flag 2 before flag 1 does nothing — as if the square were empty floor', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 2, isFinal: false };
    const { robots, events } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0, 0)], 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.lastTouchedFlag).toBe(0);
    expect(r1.archiveMarker).toBeUndefined();
    expect(events.length).toBe(0);
  });

  it('touching flag 2 after already touching flag 1 progresses normally', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 2, isFinal: false };
    const { robots } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0, 1)], 1);
    expect(robots.find((r) => r.id === 'r1')!.lastTouchedFlag).toBe(2);
  });
});

describe('resolveTouchCheckpoints — the final flag', () => {
  it('has no effect at all outside register 5, even if in order', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 3, isFinal: true };
    const { robots, events } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0, 2)], 3);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.lastTouchedFlag).toBe(2); // unchanged
    expect(events.length).toBe(0);
  });

  it('grants victory at register 5, in order', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 3, isFinal: true };
    const { winnerId, events } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0, 2)], 5);
    expect(winnerId).toBe('r1');
    expect(events.some((e) => e.type === 'victory')).toBe(true);
  });

  it('does NOT grant victory at register 5 if out of order', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 3, isFinal: true };
    const { winnerId } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0, 1)], 5); // skipped flag 2
    expect(winnerId).toBeNull();
  });
});

describe('resolveTouchCheckpoints — repair sites archive unconditionally', () => {
  it('archives on any wrench touch regardless of flag state', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].repair = { wrenches: 1 };
    const { robots, events } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.archiveMarker).toEqual({ x: 0, y: 0 });
    expect(events.some((e) => e.type === 'repairSiteTouched')).toBe(true);
  });

  it('a non-final flag with its synthetic repair fires both events on the same touch', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flag = { number: 1, isFinal: false };
    grid.cells[0][0].repair = { wrenches: 1 }; // as composeCourse would attach
    const { events } = resolveTouchCheckpoints(grid, [robot('r1', 0, 0)], 1);
    expect(events.some((e) => e.type === 'flagTouched')).toBe(true);
    expect(events.some((e) => e.type === 'repairSiteTouched')).toBe(true);
  });
});

describe('resolveTouchCheckpoints — chop shop and radioactive waste draw (choice mechanic, no card effects)', () => {
  it('records a chop shop visit only when a choice was actually made', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].chopShop = true;
    const withChoice = resolveTouchCheckpoints(
      grid, [robot('r1', 0, 0)], 1,
      { chopShopChoices: new Map([['r1', 'freeDraw']]) },
    );
    expect(withChoice.events.some((e) => e.type === 'chopShopVisited')).toBe(true);

    const withoutChoice = resolveTouchCheckpoints(grid, [robot('r1', 0, 0)], 1);
    expect(withoutChoice.events.some((e) => e.type === 'chopShopVisited')).toBe(false);
  });

  it('records a radioactive waste draw only when the robot chooses to draw', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].radioactiveWaste = true;
    const drew = resolveTouchCheckpoints(
      grid, [robot('r1', 0, 0)], 1,
      { radioactiveWasteDrawChoices: new Map([['r1', true]]) },
    );
    expect(drew.events.some((e) => e.type === 'radioactiveWasteDrawn')).toBe(true);

    const declined = resolveTouchCheckpoints(
      grid, [robot('r1', 0, 0)], 1,
      { radioactiveWasteDrawChoices: new Map([['r1', false]]) },
    );
    expect(declined.events.some((e) => e.type === 'radioactiveWasteDrawn')).toBe(false);
  });
});

describe('resolveTouchCheckpoints — real composed course data', () => {
  it('the synthetic non-final-flag repair from composeCourse is picked up correctly here', () => {
    const raw = readFileSync(new URL('./real-boards/Chicane3.json', import.meta.url), 'utf-8');
    const data = JSON.parse(raw) as BoardData;
    const library: BoardLibrary = { Chicane3: { data, sha256: 'fake' } };
    const course: Course = {
      boards: [{ id: 'Chicane3', sha256: 'fake', gridX: 0, gridY: 0, rotation: 0 }],
      dock: null,
      flags: [
        { number: 1, board: 'Chicane3', x: 1, y: 1 },
        { number: 2, board: 'Chicane3', x: 5, y: 5 },
      ],
      lifeTokens: 3,
    };
    const grid = composeCourse(course, library);

    const { robots, events } = resolveTouchCheckpoints(grid, [robot('r1', 1, 1)], 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.lastTouchedFlag).toBe(1);
    expect(events.some((e) => e.type === 'repairSiteTouched')).toBe(true); // synthetic repair
  });
});
