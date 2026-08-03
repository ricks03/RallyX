import { describe, it, expect } from 'vitest';
import { resolveEndOfTurnEffects } from '../src/end-of-turn.js';
import { startGame, advance, advanceUntilInputNeeded, GameState } from '../src/game.js';
import { newDeck, Rng } from '../src/cards.js';
import { RobotState } from '../src/movement.js';
import { ComposedCell, ComposedGrid } from '../src/types.js';

const rng: Rng = () => 0.5;

function grid(): ComposedGrid {
  const cells: ComposedCell[][] = [];
  for (let y = 0; y < 3; y++) {
    const row: ComposedCell[] = [];
    for (let x = 0; x < 3; x++) row.push({ level: 0, edges: {} });
    cells.push(row);
  }
  return { width: 3, height: 3, cells };
}

function destroyed(overrides: Partial<RobotState> = {}): RobotState {
  return {
    id: 'r1', x: 0, y: 0, facing: 'N', damage: 10, destroyed: true,
    archiveMarker: { x: 1, y: 1 }, ...overrides,
  };
}

describe('life tokens at Return Robots to Play', () => {
  it('spends one life token per destruction', () => {
    const result = resolveEndOfTurnEffects(grid(), [destroyed({ lives: 3 })]);
    expect(result.robots[0].lives).toBe(2);
    expect(result.events).toContainEqual({ type: 'lifeLost', robotId: 'r1' });
  });

  it('still returns the robot while lives remain', () => {
    const result = resolveEndOfTurnEffects(grid(), [destroyed({ lives: 3 })]);
    expect(result.robots[0].destroyed).toBe(false);
    expect(result.robots[0].damage).toBe(2);
    expect(result.robots[0].eliminated).toBeUndefined();
  });

  it('eliminates the robot when it spends its last token', () => {
    const result = resolveEndOfTurnEffects(grid(), [destroyed({ lives: 1 })]);
    expect(result.robots[0].lives).toBe(0);
    expect(result.robots[0].eliminated).toBe(true);
    expect(result.events).toContainEqual({ type: 'eliminated', robotId: 'r1' });
  });

  it('leaves an eliminated robot destroyed rather than returning it', () => {
    const result = resolveEndOfTurnEffects(grid(), [destroyed({ lives: 1 })]);
    expect(result.robots[0].destroyed).toBe(true);
    expect(result.robots[0].damage).toBe(10); // not reset to 2
    expect(result.events.some((e) => e.type === 'returnedToPlay')).toBe(false);
  });

  it('does not touch an already-eliminated robot on later turns', () => {
    const already = destroyed({ lives: 0, eliminated: true });
    const result = resolveEndOfTurnEffects(grid(), [already]);
    expect(result.robots[0].lives).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('treats an absent lives count as unlimited', () => {
    const result = resolveEndOfTurnEffects(grid(), [destroyed()]);
    expect(result.robots[0].destroyed).toBe(false);
    expect(result.robots[0].lives).toBeUndefined();
    expect(result.events.some((e) => e.type === 'lifeLost')).toBe(false);
  });

  it('survives repeated destruction until the tokens run out', () => {
    let robots: RobotState[] = [destroyed({ lives: 2 })];
    robots = resolveEndOfTurnEffects(grid(), robots).robots;
    expect(robots[0].lives).toBe(1);
    expect(robots[0].destroyed).toBe(false);

    robots = [{ ...robots[0], destroyed: true, damage: 10 }];
    robots = resolveEndOfTurnEffects(grid(), robots).robots;
    expect(robots[0].lives).toBe(0);
    expect(robots[0].eliminated).toBe(true);
  });
});

describe('life tokens set at game creation', () => {
  const robot = (): RobotState =>
    ({ id: 'r1', x: 1, y: 1, facing: 'N', damage: 0, destroyed: false });

  it('applies the configured count to every robot', () => {
    const state = startGame(grid(), [robot()], newDeck(rng), { lifeTokens: 4 });
    expect(state.robots[0].lives).toBe(4);
  });

  it('leaves lives absent when no count is configured', () => {
    const state = startGame(grid(), [robot()], newDeck(rng));
    expect(state.robots[0].lives).toBeUndefined();
  });

  it('does not overwrite a robot that already carries a count', () => {
    const state = startGame(
      grid(), [{ ...robot(), lives: 1 }], newDeck(rng), { lifeTokens: 4 },
    );
    expect(state.robots[0].lives).toBe(1);
  });

  it('does not mutate the roster it was given', () => {
    const roster = [robot()];
    startGame(grid(), roster, newDeck(rng), { lifeTokens: 4 });
    expect(roster[0].lives).toBeUndefined();
  });
});

describe('the machine and eliminated robots', () => {
  const base = (overrides: Partial<RobotState> = {}): RobotState =>
    ({ id: 'r1', x: 1, y: 1, facing: 'N', damage: 0, destroyed: false, ...overrides });

  it('does not ask an eliminated robot to program', () => {
    const state = startGame(
      grid(),
      [base({ id: 'a' }), base({ id: 'b', destroyed: true, eliminated: true, lives: 0 })],
      newDeck(rng),
    );
    const result = advanceUntilInputNeeded(state, rng);
    const phase = result.state.phase as { kind: 'awaitingProgram'; robotIds: string[] };
    expect(phase.robotIds).toEqual(['a']);
  });

  it('does not ask for a facing choice for a robot spending its last life', () => {
    const state: GameState = {
      grid: grid(),
      robots: [base({ destroyed: true, damage: 10, lives: 1, archiveMarker: { x: 0, y: 0 } })],
      deck: newDeck(rng),
      turnNumber: 3,
      phase: { kind: 'runningRegister', register: 5 },
    };
    const afterMove = advance(state, undefined, rng).state;
    const afterChoices = advance(afterMove, { kind: 'registerChoices' }, rng).state;
    const phase = afterChoices.phase as {
      kind: 'awaitingEndOfTurn'; facing: string[]; returnPowerDown: string[];
    };
    expect(phase.kind).toBe('awaitingEndOfTurn');
    expect(phase.facing).toEqual([]);
    expect(phase.returnPowerDown).toEqual([]);
  });

  it('does ask when the robot has lives to spare', () => {
    const state: GameState = {
      grid: grid(),
      robots: [base({ destroyed: true, damage: 10, lives: 2, archiveMarker: { x: 0, y: 0 } })],
      deck: newDeck(rng),
      turnNumber: 3,
      phase: { kind: 'runningRegister', register: 5 },
    };
    const afterMove = advance(state, undefined, rng).state;
    const afterChoices = advance(afterMove, { kind: 'registerChoices' }, rng).state;
    const phase = afterChoices.phase as { kind: 'awaitingEndOfTurn'; facing: string[] };
    expect(phase.facing).toEqual(['r1']);
  });
});
