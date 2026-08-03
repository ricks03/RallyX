import type {
  ComposedGrid, GameInput, GameState, ProgramSubmission, RobotState,
} from '@roborally/engine';
import type { ProgramDeck } from '@roborally/engine';

/**
 * STATUS: real, complete. Converts between the engine's in-memory objects
 * and the JSON stored in MariaDB.
 *
 * This module exists because two things do not survive a naive
 * `JSON.stringify`:
 *
 * 1. `GameInput` carries `Map` objects in seven places. `JSON.stringify`
 *    renders a Map as `{}` WITHOUT ERRORING, so storing a raw stringify of
 *    a player's action silently discards every choice they made. Encoding
 *    is not optional here; it is the difference between a working log and
 *    one that looks fine and is empty.
 *
 * 2. `GameState.grid` is the flattened ComposedGrid — roughly 40KB per
 *    board, so well over 100KB for a multi-board course, none of which
 *    ever changes. It is derived deterministically from the Course by
 *    `composeCourse`, so it is omitted on write and reattached on read.
 */

/** A GameState without its grid, which is what actually goes in the
 * `games.state_json` column. */
export interface StoredGameState {
  robots: RobotState[];
  deck: ProgramDeck;
  turnNumber: number;
  phase: GameState['phase'];
}

export function encodeGameState(state: GameState): string {
  const stored: StoredGameState = {
    robots: state.robots,
    deck: state.deck,
    turnNumber: state.turnNumber,
    phase: state.phase,
  };
  return JSON.stringify(stored);
}

/** Rebuilds a full GameState. The grid must be supplied by the caller,
 * which gets it from `composeCourse` (and should cache it per course —
 * composing is pure and the result never changes for a given course). */
export function decodeGameState(json: string, grid: ComposedGrid): GameState {
  const stored = JSON.parse(json) as StoredGameState;
  return {
    grid,
    robots: stored.robots,
    deck: stored.deck,
    turnNumber: stored.turnNumber,
    phase: stored.phase,
  };
}

// ============================================================
// GameInput
// ============================================================

/** A Map rendered as an array of pairs. Arrays rather than an object so
 * that a robot id is never coerced through object-key semantics. */
type EncodedMap<V> = [string, V][];

function encodeMap<V>(map: ReadonlyMap<string, V> | undefined): EncodedMap<V> | undefined {
  return map === undefined ? undefined : [...map.entries()];
}

function decodeMap<V>(pairs: EncodedMap<V> | undefined): Map<string, V> | undefined {
  return pairs === undefined ? undefined : new Map(pairs);
}

type EncodedInput =
  | { kind: 'program'; submissions: ProgramSubmission[]; timerExpired?: boolean }
  | { kind: 'powerDown'; announcements: EncodedMap<boolean> }
  | {
      kind: 'registerChoices';
      chopShopChoices?: EncodedMap<'scrapAndRedraw' | 'replenish' | 'freeDraw'>;
      radioactiveWasteDrawChoices?: EncodedMap<boolean>;
    }
  | {
      kind: 'endOfTurn';
      facingChoices?: EncodedMap<RobotState['facing']>;
      repairChoices?: EncodedMap<'heal' | 'option'>;
      continuePowerDownChoices?: EncodedMap<boolean>;
      returnPowerDownChoices?: EncodedMap<boolean>;
    };

export function encodeGameInput(input: GameInput): string {
  let encoded: EncodedInput;

  switch (input.kind) {
    case 'program':
      // No Maps in this one; ProgramSubmission is plain data.
      encoded = {
        kind: 'program',
        submissions: input.submissions,
        timerExpired: input.timerExpired,
      };
      break;
    case 'powerDown':
      encoded = { kind: 'powerDown', announcements: encodeMap(input.announcements)! };
      break;
    case 'registerChoices':
      encoded = {
        kind: 'registerChoices',
        chopShopChoices: encodeMap(input.chopShopChoices),
        radioactiveWasteDrawChoices: encodeMap(input.radioactiveWasteDrawChoices),
      };
      break;
    case 'endOfTurn':
      encoded = {
        kind: 'endOfTurn',
        facingChoices: encodeMap(input.facingChoices),
        repairChoices: encodeMap(input.repairChoices),
        continuePowerDownChoices: encodeMap(input.continuePowerDownChoices),
        returnPowerDownChoices: encodeMap(input.returnPowerDownChoices),
      };
      break;
  }

  return JSON.stringify(encoded);
}

export function decodeGameInput(json: string): GameInput {
  const encoded = JSON.parse(json) as EncodedInput;

  switch (encoded.kind) {
    case 'program':
      return {
        kind: 'program',
        submissions: encoded.submissions,
        timerExpired: encoded.timerExpired,
      };
    case 'powerDown':
      return { kind: 'powerDown', announcements: decodeMap(encoded.announcements)! };
    case 'registerChoices':
      return {
        kind: 'registerChoices',
        chopShopChoices: decodeMap(encoded.chopShopChoices),
        radioactiveWasteDrawChoices: decodeMap(encoded.radioactiveWasteDrawChoices),
      };
    case 'endOfTurn':
      return {
        kind: 'endOfTurn',
        facingChoices: decodeMap(encoded.facingChoices),
        repairChoices: decodeMap(encoded.repairChoices),
        continuePowerDownChoices: decodeMap(encoded.continuePowerDownChoices),
        returnPowerDownChoices: decodeMap(encoded.returnPowerDownChoices),
      };
  }
}
