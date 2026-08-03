import { describe, it, expect } from 'vitest';
import { resolveProgram, validateSubmission, ProgramSubmission } from '../src/program.js';
import { newDeck, buildProgramDeck, Rng } from '../src/cards.js';
import { ProgramCard, RobotState } from '../src/movement.js';

const rng: Rng = () => 0.5;
const deck = buildProgramDeck();
const card = (i: number): ProgramCard => deck[i];

function robot(overrides: Partial<RobotState> = {}): RobotState {
  return {
    id: 'r1', x: 0, y: 0, facing: 'N', damage: 0, destroyed: false,
    hand: [card(0), card(1), card(2), card(3), card(4), card(5), card(6), card(7), card(8)],
    registers: [null, null, null, null, null],
    lockedRegisters: [false, false, false, false, false],
    ...overrides,
  };
}

const submit = (registers: (ProgramCard | null)[], id = 'r1'): ProgramSubmission =>
  ({ robotId: id, registers });

const fullSubmission = () => submit([card(0), card(1), card(2), card(3), card(4)]);

describe('validateSubmission', () => {
  it('accepts a well-formed submission', () => {
    expect(validateSubmission(robot(), fullSubmission())).toEqual([]);
  });

  it('rejects the wrong number of slots', () => {
    const problems = validateSubmission(robot(), submit([card(0), card(1)]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('5 register slots');
  });

  it('rejects a card that is not in the hand', () => {
    const problems = validateSubmission(
      robot(), submit([card(50), card(1), card(2), card(3), card(4)]),
    );
    expect(problems.some((p) => p.includes('not in this robot'))).toBe(true);
  });

  it('rejects the same card in two registers', () => {
    const problems = validateSubmission(
      robot(), submit([card(0), card(0), card(2), card(3), card(4)]),
    );
    expect(problems.some((p) => p.includes('two registers'))).toBe(true);
  });

  it('rejects programming a locked register', () => {
    const r = robot({ damage: 5, lockedRegisters: [false, false, false, false, true] });
    const problems = validateSubmission(r, fullSubmission());
    expect(problems.some((p) => p.includes('register 5 is locked'))).toBe(true);
  });

  it('accepts null in a locked register', () => {
    const r = robot({
      damage: 5,
      lockedRegisters: [false, false, false, false, true],
      hand: [card(0), card(1), card(2), card(3)],
    });
    expect(validateSubmission(r, submit([card(0), card(1), card(2), card(3), null]))).toEqual([]);
  });

  it('accepts a partial submission while the timer runs', () => {
    expect(validateSubmission(robot(), submit([card(0), null, null, null, null]))).toEqual([]);
  });
});

describe('resolveProgram — a complete submission', () => {
  it('places the cards into the registers in order', () => {
    const result = resolveProgram([robot()], newDeck(rng), [fullSubmission()], rng);
    expect(result.robots[0].registers).toEqual([card(0), card(1), card(2), card(3), card(4)]);
  });

  it('discards the leftovers and clears the hand', () => {
    const result = resolveProgram([robot()], newDeck(rng), [fullSubmission()], rng);
    expect(result.robots[0].hand).toEqual([]);
    expect(result.deck.discard).toHaveLength(4);
    expect(result.events).toContainEqual(
      { type: 'leftoversDiscarded', robotId: 'r1', count: 4 },
    );
  });

  it('reports nothing incomplete or rejected', () => {
    const result = resolveProgram([robot()], newDeck(rng), [fullSubmission()], rng);
    expect(result.incomplete).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('applies a turn-1 facing carried in the submission', () => {
    const result = resolveProgram(
      [robot()], newDeck(rng), [{ ...fullSubmission(), facing: 'E' }], rng,
    );
    expect(result.robots[0].facing).toBe('E');
    expect(result.events).toContainEqual({ type: 'facingSet', robotId: 'r1' });
  });

  it('leaves facing alone when the submission carries none', () => {
    const result = resolveProgram([robot()], newDeck(rng), [fullSubmission()], rng);
    expect(result.robots[0].facing).toBe('N');
  });
});

describe('resolveProgram — locked registers', () => {
  const damaged = () => robot({
    damage: 6,
    lockedRegisters: [false, false, false, true, true],
    registers: [null, null, null, card(40), card(41)],
    hand: [card(0), card(1), card(2)],
  });

  it('keeps the locked cards untouched', () => {
    const result = resolveProgram(
      [damaged()], newDeck(rng),
      [submit([card(0), card(1), card(2), null, null])], rng,
    );
    expect(result.robots[0].registers![3]).toEqual(card(40));
    expect(result.robots[0].registers![4]).toEqual(card(41));
  });

  it('counts a fully-locked-plus-programmed robot as complete', () => {
    const result = resolveProgram(
      [damaged()], newDeck(rng),
      [submit([card(0), card(1), card(2), null, null])], rng,
    );
    expect(result.incomplete).toEqual([]);
    expect(result.robots[0].hand).toEqual([]);
  });

  it('never auto-fills a locked register on timer expiry', () => {
    const r = robot({
      damage: 6,
      lockedRegisters: [false, false, false, true, true],
      registers: [null, null, null, card(40), card(41)],
      hand: [card(0), card(1), card(2)],
    });
    const result = resolveProgram([r], newDeck(rng), [], rng, { timerExpired: true });
    const filled = result.events.filter((e) => e.type === 'autoFilled').map((e) => e.count);
    expect(filled.sort()).toEqual([1, 2, 3]);
  });
});

describe('resolveProgram — timer expiry', () => {
  it('fills all five at random for a player who programmed nothing', () => {
    const result = resolveProgram([robot()], newDeck(rng), [], rng, { timerExpired: true });
    const registers = result.robots[0].registers!;
    expect(registers.every((c) => c !== null)).toBe(true);
    expect(result.events.filter((e) => e.type === 'autoFilled')).toHaveLength(5);
  });

  it('draws those five from that player own hand', () => {
    const result = resolveProgram([robot()], newDeck(rng), [], rng, { timerExpired: true });
    const handPriorities = new Set(robot().hand!.map((c) => c.priority));
    for (const c of result.robots[0].registers!) {
      expect(handPriorities.has(c!.priority)).toBe(true);
    }
  });

  it('keeps the registers a partially-programmed player already filled', () => {
    const partial = submit([card(0), card(1), null, null, null]);
    const result = resolveProgram([robot()], newDeck(rng), [partial], rng, { timerExpired: true });
    const registers = result.robots[0].registers!;
    expect(registers[0]).toEqual(card(0));
    expect(registers[1]).toEqual(card(1));
    expect(registers.every((c) => c !== null)).toBe(true);
    expect(result.events.filter((e) => e.type === 'autoFilled').map((e) => e.count))
      .toEqual([3, 4, 5]);
  });

  it('never reuses a card the player already programmed', () => {
    const partial = submit([card(0), card(1), null, null, null]);
    const result = resolveProgram([robot()], newDeck(rng), [partial], rng, { timerExpired: true });
    const priorities = result.robots[0].registers!.map((c) => c!.priority);
    expect(new Set(priorities).size).toBe(5);
  });

  it('discards what is left after the auto-fill', () => {
    const result = resolveProgram([robot()], newDeck(rng), [], rng, { timerExpired: true });
    expect(result.deck.discard).toHaveLength(4); // 9 dealt, 5 programmed
    expect(result.robots[0].hand).toEqual([]);
  });

  it('is reproducible for a given rng', () => {
    const a = resolveProgram([robot()], newDeck(rng), [], rng, { timerExpired: true });
    const b = resolveProgram([robot()], newDeck(rng), [], rng, { timerExpired: true });
    expect(a.robots[0].registers!.map((c) => c!.priority))
      .toEqual(b.robots[0].registers!.map((c) => c!.priority));
  });
});

describe('resolveProgram — incomplete and rejected', () => {
  it('names a robot with empty registers as incomplete while the timer runs', () => {
    const result = resolveProgram(
      [robot()], newDeck(rng), [submit([card(0), null, null, null, null])], rng,
    );
    expect(result.incomplete).toEqual(['r1']);
  });

  it('keeps an incomplete robot hand so it can submit again', () => {
    const result = resolveProgram(
      [robot()], newDeck(rng), [submit([card(0), null, null, null, null])], rng,
    );
    expect(result.robots[0].hand).toHaveLength(8);
    expect(result.deck.discard).toHaveLength(0);
  });

  it('names a robot with no submission at all as incomplete', () => {
    const result = resolveProgram([robot()], newDeck(rng), [], rng);
    expect(result.incomplete).toEqual(['r1']);
  });

  it('leaves a rejected robot completely untouched', () => {
    const bad = submit([card(50), card(1), card(2), card(3), card(4)]);
    const result = resolveProgram([robot()], newDeck(rng), [bad], rng);
    expect(result.robots[0].registers).toEqual([null, null, null, null, null]);
    expect(result.robots[0].hand).toHaveLength(9);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].robotId).toBe('r1');
    expect(result.incomplete).toEqual([]);
  });

  it('does not let one bad submission stop the rest of the table', () => {
    const good = robot({ id: 'a' });
    const bad = robot({ id: 'b' });
    const result = resolveProgram(
      [good, bad], newDeck(rng),
      [
        submit([card(0), card(1), card(2), card(3), card(4)], 'a'),
        submit([card(50), card(1), card(2), card(3), card(4)], 'b'),
      ],
      rng,
    );
    expect(result.robots[0].registers!.every((c) => c !== null)).toBe(true);
    expect(result.rejected.map((x) => x.robotId)).toEqual(['b']);
  });
});

describe('resolveProgram — general', () => {
  it('skips a powered-down robot', () => {
    const r = robot({ poweredDown: true, hand: [] });
    const result = resolveProgram([r], newDeck(rng), [], rng, { timerExpired: true });
    expect(result.robots[0].registers).toEqual([null, null, null, null, null]);
    expect(result.incomplete).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('skips a destroyed robot', () => {
    const result = resolveProgram(
      [robot({ destroyed: true })], newDeck(rng), [], rng, { timerExpired: true },
    );
    expect(result.robots[0].registers).toEqual([null, null, null, null, null]);
    expect(result.events).toEqual([]);
  });

  it('does not mutate the robots it was given', () => {
    const before = robot();
    resolveProgram([before], newDeck(rng), [fullSubmission()], rng);
    expect(before.registers).toEqual([null, null, null, null, null]);
    expect(before.hand).toHaveLength(9);
  });

  it('does not mutate the deck it was given', () => {
    const d = newDeck(rng);
    resolveProgram([robot()], d, [fullSubmission()], rng);
    expect(d.discard).toHaveLength(0);
  });
});
