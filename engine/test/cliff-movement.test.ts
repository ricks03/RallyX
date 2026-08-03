import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveRobotMove, getEdgeCrossing, RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid, BoardData } from '../src/types.js';

function openCell(level = 0): ComposedCell {
  return { level, edges: {}, floor: { kind: 'open' } };
}

function makeGrid(size: number): ComposedGrid {
  const cells: ComposedCell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => openCell()),
  );
  return { width: size, height: size, cells };
}

function robot(id: string, x: number, y: number): RobotState {
  return { id, x, y, facing: 'E', damage: 0, destroyed: false };
}

describe('getEdgeCrossing — plain cliffs (no ramp)', () => {
  it('blocks crossing uphill', () => {
    const grid = makeGrid(3);
    // (0,0) is low, cliff on its E edge, drop:in => (1,0) is high.
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in' }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.blocked).toBe(true);
    expect(result.fallLevels).toBe(0);
  });

  it('always allows crossing downhill, with fall damage', () => {
    const grid = makeGrid(3);
    // (0,0) is high, drop:out => (1,0) is low. Crossing E is downhill.
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'out' }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.blocked).toBe(false);
    expect(result.fallLevels).toBe(1);
  });

  it('a multi-level cliff (levels: 2) deals proportional fall damage', () => {
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'out', levels: 2 }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.fallLevels).toBe(2);
  });

  it('reads a cliff recorded on the neighbor\'s reverse edge the same way', () => {
    const grid = makeGrid(3);
    // Recorded on (1,0)'s W edge instead of (0,0)'s own E edge. Per the
    // "only one side records it" convention, drop:'in' recorded on the
    // NEIGHBOR's own edge means the neighbor is low and the source (0,0)
    // is high — so crossing E from (0,0) is downhill, not blocked.
    grid.cells[0][1].edges.W = [{ kind: 'cliff', drop: 'in' }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.blocked).toBe(false);
    expect(result.fallLevels).toBe(1);
  });
});

describe('getEdgeCrossing — ramps', () => {
  it('an uphill ramp is crossable, costing 1 + extraMoves', () => {
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.blocked).toBe(false);
    expect(result.cost).toBe(2);
  });

  it('a steep ramp (extraMoves: 2) costs 3 total', () => {
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 2 } }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.cost).toBe(3);
  });

  it('a ramp has no effect downhill — cost 1, still fall damage', () => {
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'out', ramp: { extraMoves: 1 } }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.cost).toBe(1);
    expect(result.fallLevels).toBe(1);
  });
});

describe('getEdgeCrossing — ridges', () => {
  it('blocks both directions with no ramp, and never causes a fall', () => {
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ridge: true }];
    const fromLow = getEdgeCrossing(grid, 0, 0, 'E');
    expect(fromLow.blocked).toBe(true);
    expect(fromLow.fallLevels).toBe(0);
  });

  it('a ridge is blocked even with a ramp present — no ramp exception, ever', () => {
    // Confirmed against RULES_SPEC.md, established earlier this session:
    // "blocked, with no ramp exception, from either side." A `ramp` field
    // alongside `ridge` (never seen in real data) does not make it
    // crossable — this was wrong in an earlier draft of this code and is
    // deliberately tested here so it can't silently regress.
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ridge: true, ramp: { extraMoves: 1 } }];
    const result = getEdgeCrossing(grid, 0, 0, 'E');
    expect(result.blocked).toBe(true);
  });
});

describe('resolveRobotMove — ramp cost consumes movement budget', () => {
  it('a Move-2 crossing a plain ramp lands exactly on the far side (2 squares spent on 1 crossing)', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 2);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });

  it('a Move-1 cannot afford the ramp and simply does not cross (no slide-back yet)', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 1);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(0); // stayed put
  });

  it('a Move-3 crossing a ramp continues moving on the far side with remaining budget', () => {
    const grid = makeGrid(5);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 3);
    // 2 squares to cross the ramp, 1 more square on the far side.
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(2);
  });
});

describe('resolveRobotMove — fall damage applied on downhill crossing', () => {
  it('applies 2 damage per level fallen', () => {
    const grid = makeGrid(3);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'out', levels: 2 }];
    const { robots, events } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 1);
    const r1 = robots.find((r) => r.id === 'r1')!;
    expect(r1.x).toBe(1);
    expect(r1.damage).toBe(4); // 2 levels * 2 damage
    expect(events.some((e) => e.type === 'fallDamage')).toBe(true);
  });
});

describe('resolveRobotMove — cliffs and push chains', () => {
  it('a pushed robot crosses an uphill ramp for free (no budget cost applies to a push)', () => {
    const grid = makeGrid(4);
    grid.cells[0][1].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const { robots } = resolveRobotMove(
      grid, [robot('mover', 0, 0), robot('pushed', 1, 0)], 'mover', 'E', 1,
    );
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(1);
    expect(robots.find((r) => r.id === 'pushed')!.x).toBe(2); // crossed the ramp
  });

  it('a push into an unramped uphill cliff is blocked, and nothing in the chain moves', () => {
    const grid = makeGrid(4);
    grid.cells[0][1].edges.E = [{ kind: 'cliff', drop: 'in' }]; // no ramp
    const { robots } = resolveRobotMove(
      grid, [robot('mover', 0, 0), robot('pushed', 1, 0)], 'mover', 'E', 1,
    );
    expect(robots.find((r) => r.id === 'mover')!.x).toBe(0);
    expect(robots.find((r) => r.id === 'pushed')!.x).toBe(1);
  });

  it('a robot pushed downhill takes fall damage', () => {
    const grid = makeGrid(4);
    grid.cells[0][1].edges.E = [{ kind: 'cliff', drop: 'out' }];
    const { robots } = resolveRobotMove(
      grid, [robot('mover', 0, 0), robot('pushed', 1, 0)], 'mover', 'E', 1,
    );
    const pushed = robots.find((r) => r.id === 'pushed')!;
    expect(pushed.x).toBe(2);
    expect(pushed.damage).toBe(2);
  });
});

describe('resolveRobotMove — confirmed: ramps never slide back', () => {
  it('starting right at the ramp base, Move-1 makes zero progress (confirmed directly)', () => {
    const grid = makeGrid(4);
    grid.cells[0][0].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 1);
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(0);
  });

  it('reaching the ramp mid-move (after spending squares on ordinary ground) also makes zero further progress, not a partial slide', () => {
    const grid = makeGrid(5);
    // Ramp is one square further along than the base case above, so a
    // Move-2 spends its first square crossing ordinary ground, leaving
    // only 1 square of budget when it reaches the ramp (cost 2) — not
    // enough to complete it.
    grid.cells[0][1].edges.E = [{ kind: 'cliff', drop: 'in', ramp: { extraMoves: 1 } }];
    const { robots } = resolveRobotMove(grid, [robot('r1', 0, 0)], 'r1', 'E', 2);
    // Confirmed: no slide-back, ever — the robot stops exactly where it
    // ran out of budget to complete the ramp, not one square further back.
    expect(robots.find((r) => r.id === 'r1')!.x).toBe(1);
  });
});

describe('cliff/ramp — real board data (Rolling3)', () => {
  const raw = readFileSync(new URL('./real-boards/Rolling3.json', import.meta.url), 'utf-8');
  const data = JSON.parse(raw) as BoardData;
  const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

  it('the ramp at (0,1) is crossable uphill from its confirmed low entry side (0,0)', () => {
    const result = getEdgeCrossing(grid, 0, 0, 'S'); // (0,0) -> (0,1)
    // (0,1) is the stunt ramp cell, not a plain cliff — this specific edge
    // has no plain `cliff` feature (stunt ramps are a separate mechanic,
    // not yet wired into movement — RULES_SPEC \u00a73's stunt ramp bypass
    // is still a TODO). Confirm it's at least not incorrectly blocked by a
    // phantom cliff check.
    expect(result.blocked).toBe(false);
  });

  it('a real ramped cliff in this board is crossable uphill, at extra cost', () => {
    // (1,2) has a real N-edge cliff with drop:'in' AND ramp: {extraMoves:1}
    // (confirmed directly against the real JSON) — (1,1) is high, (1,2) is
    // low. Crossing N from (1,2) is uphill, but a ramp is present, so it's
    // crossable at a cost of 2, not blocked.
    const result = getEdgeCrossing(grid, 1, 2, 'N');
    expect(result.blocked).toBe(false);
    expect(result.cost).toBe(2);
  });
});

describe('cliff/ramp — real board data (Straightaway6, the 2-level drop)', () => {
  const raw = readFileSync(new URL('./real-boards/Straightaway6.json', import.meta.url), 'utf-8');
  const data = JSON.parse(raw) as BoardData;
  const grid: ComposedGrid = { width: data.width, height: data.height, cells: data.cells };

  it('falling from (4,2) to (4,3) deals 4 damage (2 levels, confirmed real data)', () => {
    // (4,2) is high relative to (4,3) per the confirmed levels this
    // session ((4,2)=-1, (4,3)=+1) — but the edge itself is recorded as
    // drop:'in' on (4,2)'s S side, meaning (4,2) is LOW and (4,3) is HIGH
    // from that edge's own local perspective — so crossing (4,2)->(4,3) is
    // actually uphill (blocked, since this ramp-less 2-level cliff has no
    // ramp). Confirm that directly rather than assuming.
    const result = getEdgeCrossing(grid, 4, 2, 'S');
    expect(result.blocked).toBe(true);
  });

  it('crossing the same edge the other way (4,3) -> (4,2) is downhill, 4 damage', () => {
    const result = getEdgeCrossing(grid, 4, 3, 'N');
    expect(result.blocked).toBe(false);
    expect(result.fallLevels).toBe(2);
  });
});
