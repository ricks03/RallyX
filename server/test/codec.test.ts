import { describe, it, expect } from 'vitest';
import {
  encodeGameInput, decodeGameInput, encodeGameState, decodeGameState,
} from '../src/codec.js';
import {
  buildProgramDeck, createRng, newDeck, startGame,
} from '@roborally/engine';
import type { ComposedCell, ComposedGrid, GameInput, RobotState } from '@roborally/engine';

const rng = createRng(1234);

function grid(): ComposedGrid {
  const cells: ComposedCell[][] = [];
  for (let y = 0; y < 3; y++) {
    const row: ComposedCell[] = [];
    for (let x = 0; x < 3; x++) row.push({ level: 0, edges: {} });
    cells.push(row);
  }
  return { width: 3, height: 3, cells };
}

const robot = (id: string): RobotState =>
  ({ id, x: 1, y: 1, facing: 'N', damage: 0, destroyed: false });

const card = (i: number) => buildProgramDeck()[i];

describe('GameState encoding', () => {
  it('omits the grid from the stored JSON', () => {
    const state = startGame(grid(), [robot('a')], newDeck(rng));
    const json = encodeGameState(state);
    expect(JSON.parse(json).grid).toBeUndefined();
    expect(json).not.toContain('cells');
  });

  it('round-trips everything else', () => {
    const state = startGame(grid(), [robot('a')], newDeck(rng), { lifeTokens: 3 });
    const back = decodeGameState(encodeGameState(state), grid());
    expect(back.robots).toEqual(state.robots);
    expect(back.turnNumber).toBe(state.turnNumber);
    expect(back.phase).toEqual(state.phase);
    expect(back.deck.draw.length).toBe(state.deck.draw.length);
  });

  it('reattaches the grid handed to it', () => {
    const state = startGame(grid(), [robot('a')], newDeck(rng));
    const g = grid();
    expect(decodeGameState(encodeGameState(state), g).grid).toBe(g);
  });

  it('keeps a sizeable state small without the grid', () => {
    const robots = Array.from({ length: 8 }, (_, i) => robot(`r${i}`));
    const json = encodeGameState(startGame(grid(), robots, newDeck(rng)));
    expect(json.length).toBeLessThan(20000);
  });
});

describe('GameInput encoding — the Map hazard', () => {
  it('demonstrates why this module exists: raw stringify loses a Map', () => {
    const raw = JSON.stringify({ announcements: new Map([['r1', true]]) });
    expect(raw).toBe('{"announcements":{}}');
  });

  it('preserves a powerDown announcements Map', () => {
    const input: GameInput = {
      kind: 'powerDown',
      announcements: new Map([['a', true], ['b', false]]),
    };
    const back = decodeGameInput(encodeGameInput(input));
    expect(back.kind).toBe('powerDown');
    if (back.kind !== 'powerDown') throw new Error('wrong kind');
    expect(back.announcements.get('a')).toBe(true);
    expect(back.announcements.get('b')).toBe(false);
    expect(back.announcements.size).toBe(2);
  });

  it('returns real Maps, not plain objects', () => {
    const input: GameInput = { kind: 'powerDown', announcements: new Map([['a', true]]) };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'powerDown') throw new Error('wrong kind');
    expect(back.announcements).toBeInstanceOf(Map);
  });

  it('preserves both register-choice Maps', () => {
    const input: GameInput = {
      kind: 'registerChoices',
      chopShopChoices: new Map([['a', 'freeDraw']]),
      radioactiveWasteDrawChoices: new Map([['b', true]]),
    };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'registerChoices') throw new Error('wrong kind');
    expect(back.chopShopChoices!.get('a')).toBe('freeDraw');
    expect(back.radioactiveWasteDrawChoices!.get('b')).toBe(true);
  });

  it('preserves all four end-of-turn Maps', () => {
    const input: GameInput = {
      kind: 'endOfTurn',
      facingChoices: new Map([['a', 'E']]),
      repairChoices: new Map([['b', 'option']]),
      continuePowerDownChoices: new Map([['c', true]]),
      returnPowerDownChoices: new Map([['d', false]]),
    };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'endOfTurn') throw new Error('wrong kind');
    expect(back.facingChoices!.get('a')).toBe('E');
    expect(back.repairChoices!.get('b')).toBe('option');
    expect(back.continuePowerDownChoices!.get('c')).toBe(true);
    expect(back.returnPowerDownChoices!.get('d')).toBe(false);
  });

  it('keeps an absent optional Map absent rather than turning it into an empty one', () => {
    const input: GameInput = { kind: 'registerChoices' };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'registerChoices') throw new Error('wrong kind');
    expect(back.chopShopChoices).toBeUndefined();
    expect(back.radioactiveWasteDrawChoices).toBeUndefined();
  });

  it('distinguishes an empty Map from an absent one', () => {
    const input: GameInput = { kind: 'registerChoices', chopShopChoices: new Map() };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'registerChoices') throw new Error('wrong kind');
    expect(back.chopShopChoices).toBeInstanceOf(Map);
    expect(back.chopShopChoices!.size).toBe(0);
  });

  it('round-trips a program submission with its cards', () => {
    const input: GameInput = {
      kind: 'program',
      timerExpired: true,
      submissions: [{
        robotId: 'a',
        registers: [card(0), card(1), null, card(2), card(3)],
        facing: 'S',
      }],
    };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'program') throw new Error('wrong kind');
    expect(back.submissions[0].registers[0]).toEqual(card(0));
    expect(back.submissions[0].registers[2]).toBeNull();
    expect(back.submissions[0].facing).toBe('S');
    expect(back.timerExpired).toBe(true);
  });

  it('survives robot ids that would be awkward as object keys', () => {
    const input: GameInput = {
      kind: 'powerDown',
      announcements: new Map([
        ['__proto__', true],
        ['constructor', false],
        ['0', true],
      ]),
    };
    const back = decodeGameInput(encodeGameInput(input));
    if (back.kind !== 'powerDown') throw new Error('wrong kind');
    expect(back.announcements.get('__proto__')).toBe(true);
    expect(back.announcements.get('constructor')).toBe(false);
    expect(back.announcements.get('0')).toBe(true);
    expect(back.announcements.size).toBe(3);
  });

  it('produces valid JSON for every input kind', () => {
    const inputs: GameInput[] = [
      { kind: 'program', submissions: [] },
      { kind: 'powerDown', announcements: new Map() },
      { kind: 'registerChoices' },
      { kind: 'endOfTurn' },
    ];
    for (const input of inputs) {
      expect(() => JSON.parse(encodeGameInput(input))).not.toThrow();
      expect(decodeGameInput(encodeGameInput(input)).kind).toBe(input.kind);
    }
  });
});
