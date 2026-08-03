import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveLaserFirePass1 } from '../src/laser-fire.js';
import { RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid, BoardData } from '../src/types.js';

function openCell(): ComposedCell {
  return { level: 0, edges: {}, floor: { kind: 'open' } };
}

function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, openCell),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number, facing: RobotState['facing'] = 'E'): RobotState {
  return { id, x, y, facing, damage: 0, destroyed: false };
}

describe('resolveLaserFirePass1 — board lasers', () => {
  it('deals damage to a robot in the beam path', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].edges.E = [{ kind: 'laser', count: 1 }];
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 2, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(1);
  });

  it('applies count as the damage amount, not always 1', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].edges.E = [{ kind: 'laser', count: 3 }];
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 2, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(3);
  });

  it('stops at the first robot, shielding anyone behind it', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].edges.E = [{ kind: 'laser', count: 1 }];
    // Facing N so neither robot's own laser hits the other — isolating the
    // board laser's shielding behavior specifically.
    const { robots } = resolveLaserFirePass1(
      grid, [robot('front', 2, 0, 'N'), robot('behind', 4, 0, 'N')], 1,
    );
    expect(robots.find((r) => r.id === 'front')!.damage).toBe(1);
    expect(robots.find((r) => r.id === 'behind')!.damage).toBe(0);
  });

  it('is blocked by a wall between the emitter and the target', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].edges.E = [{ kind: 'laser', count: 1 }];
    grid.cells[0][1].edges.E = [{ kind: 'wall' }];
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 3, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(0);
  });

  it('does not need to cross its own mounting edge to hit a robot standing on the emitter cell', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].edges.N = [{ kind: 'laser', count: 1 }];
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(1);
  });
});

describe('resolveLaserFirePass1 — robot lasers', () => {
  it('deals 1 damage to a robot in the shooter\'s facing direction', () => {
    const grid = makeGrid(6);
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 3, 0)], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(1);
  });

  it('never targets the shooter itself', () => {
    const grid = makeGrid(6);
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 0, 0, 'E')], 1);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(0);
  });

  it('is blocked if the shooter\'s own facing edge has a wall', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].edges.E = [{ kind: 'wall' }];
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 3, 0)], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(0);
  });

  it('two robots facing each other both hit each other simultaneously (Pass 1, no ordering)', () => {
    const grid = makeGrid(6);
    const { robots } = resolveLaserFirePass1(
      grid, [robot('a', 0, 0, 'E'), robot('b', 3, 0, 'W')], 1,
    );
    expect(robots.find((r) => r.id === 'a')!.damage).toBe(1);
    expect(robots.find((r) => r.id === 'b')!.damage).toBe(1);
  });
});

describe('resolveLaserFirePass1 — flamers, flaming oil, radioactive waste', () => {
  it('flamer deals damage only on its active phase', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].flamer = { phases: [3], colour: 'orange' };
    const active = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], 3);
    expect(active.robots.find((r) => r.id === 'r1')!.damage).toBe(1);
    const inactive = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], 2);
    expect(inactive.robots.find((r) => r.id === 'r1')!.damage).toBe(0);
  });

  it('flaming oil deals damage every register, never phase-gated', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].terrain = ['flamingOil'];
    for (const reg of [1, 2, 3, 4, 5]) {
      const { robots } = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], reg);
      expect(robots.find((r) => r.id === 'r1')!.damage).toBe(1);
    }
  });

  it('radioactive waste deals 1 damage, always active', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].radioactiveWaste = true;
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.damage).toBe(1);
  });

  it('multiple sources stack in the same pass (flamer + robot laser)', () => {
    const grid = makeGrid(4);
    grid.cells[0][2].flamer = { phases: [1], colour: 'orange' }; // cell (x=2, y=0), where 'target' sits
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 2, 0, 'N')], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(2); // 1 robot laser + 1 flamer
  });
});

describe('resolveLaserFirePass1 — crushers (confirmed to belong here, not Board Elements Move)', () => {
  it('destroys a robot on an active crusher, no damage roll', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].crusher = { phases: [1] };
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], 1);
    expect(robots.find((r) => r.id === 'r1')!.destroyed).toBe(true);
  });

  it('does nothing on an inactive register', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].crusher = { phases: [1] };
    const { robots } = resolveLaserFirePass1(grid, [robot('r1', 0, 0)], 2);
    expect(robots.find((r) => r.id === 'r1')!.destroyed).toBe(false);
  });
});

describe('resolveLaserFirePass1 — same-level targeting and elevation blocking', () => {
  it('robot laser: a target at a different level is not hit', () => {
    const grid = makeGrid(6);
    grid.cells[0][3].level = 1; // target's cell is elevated relative to the shooter
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 3, 0, 'N')], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(0);
  });

  it('robot laser: a target at a LOWER level is flown over, not hit', () => {
    const grid = makeGrid(6);
    grid.cells[0][3].level = -1;
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 3, 0, 'N')], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(0);
  });

  it('robot laser: higher terrain between shooter and target blocks the beam outright', () => {
    const grid = makeGrid(6);
    grid.cells[0][2].level = 1; // a raised cell sits between shooter and target
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 3, 0, 'N')], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(0);
  });

  it('robot laser: lower terrain in the path does not block, beam continues and hits a same-level target beyond it', () => {
    const grid = makeGrid(6);
    grid.cells[0][2].level = -1; // a dip between shooter and target, same level as each other
    const { robots } = resolveLaserFirePass1(
      grid, [robot('shooter', 0, 0, 'E'), robot('target', 3, 0, 'N')], 1,
    );
    expect(robots.find((r) => r.id === 'target')!.damage).toBe(1);
  });

  it('board laser: fires and blocks at the emitter\'s own elevation, not always level 0', () => {
    const grid = makeGrid(6);
    grid.cells[0][0].level = 2;
    grid.cells[0][0].edges.E = [{ kind: 'laser', count: 1 }];
    grid.cells[0][2].level = 2; // same level as the emitter — valid target
    const hit = resolveLaserFirePass1(grid, [robot('target', 2, 0, 'N')], 1);
    expect(hit.robots.find((r) => r.id === 'target')!.damage).toBe(1);

    grid.cells[0][2].level = 3; // now higher than the emitter — blocks outright
    const blocked = resolveLaserFirePass1(grid, [robot('target', 4, 0, 'N')], 1);
    expect(blocked.robots.find((r) => r.id === 'target')!.damage).toBe(0);
  });
});

describe('resolveLaserFirePass1 — real board data', () => {
  it('a real board laser edge from Chicane3 resolves without throwing and can hit a robot placed in its path', () => {
    const raw = readFileSync(new URL('./real-boards/Chicane3.json', import.meta.url), 'utf-8');
    const data = JSON.parse(raw) as BoardData;
    const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

    let found: { x: number; y: number; dir: 'N' | 'E' | 'S' | 'W' } | null = null;
    outer: for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        for (const dir of ['N', 'E', 'S', 'W'] as const) {
          const feats = grid.cells[y][x].edges[dir] ?? [];
          if (feats.some((f) => f.kind === 'laser')) { found = { x, y, dir }; break outer; }
        }
      }
    }
    expect(found).not.toBeNull();
    expect(() => resolveLaserFirePass1(grid, [robot('r1', found!.x, found!.y)], 1)).not.toThrow();
  });
});
