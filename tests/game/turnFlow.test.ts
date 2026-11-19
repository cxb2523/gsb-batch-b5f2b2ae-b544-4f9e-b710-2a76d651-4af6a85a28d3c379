import { beforeEach, describe, expect, it, vi } from 'vitest';
import { combineReducers, configureStore, type AnyAction } from '@reduxjs/toolkit';
import {
  activateTokens,
  deactivateAllTokens,
  endTurn,
  getPlayer,
  getToken,
  incrementNumberOfConsecutiveSix,
  registerNewPlayer,
  resetNumberOfConsecutiveSix,
  setPlayerSequence,
  setTurnActive,
} from '../../src/state/slices/playersSlice';
import playersReducer from '../../src/state/slices/playersSlice';
import diceReducer from '../../src/state/slices/diceSlice';
import boardReducer from '../../src/state/slices/boardSlice';
import sessionReducer from '../../src/state/slices/sessionSlice';
import { registerDice } from '../../src/state/slices/diceSlice';
import { hydrateRootState, type RootState } from '../../src/state/store';
import { calculateSequence } from '../../src/game/movement/calculateSequence';
import { playerSequences } from '../../src/game/players/constants';
import { tokenPaths } from '../../src/game/tokens/paths';
import { shouldEndTurn } from '../../src/game/turn/turnResolution';
import type { TPlayerColour, TToken } from '../../src/types';

// Persistence must only observe fully-settled turn states.
const saveStateMock = vi.fn<(state: RootState) => void>();
vi.mock('../../src/game/storage/saveState', () => ({
  saveState: (state: RootState): void => saveStateMock(state),
}));

type TTestStore = ReturnType<typeof createTestStore>;

const appReducer = combineReducers({
  players: playersReducer,
  board: boardReducer,
  dice: diceReducer,
  session: sessionReducer,
});

function createTestStore() {
  return configureStore({
    reducer: (state: RootState | undefined, action: AnyAction): RootState => {
      if (action.type === hydrateRootState.type) return action.payload as RootState;
      return appReducer(state, action);
    },
  });
}

function placeOnPath(store: TTestStore, colour: TPlayerColour, id: number, pathIndex: number) {
  // RTK freezes live state; mutate a clone then commit it through the same
  // hydration path used for saved games.
  const snapshot = structuredClone(store.getState());
  const token = getToken(snapshot.players, colour, id);
  token.coordinates = tokenPaths[colour][pathIndex];
  token.isLocked = false;
  token.hasTokenReachedHome = false;
  store.dispatch(hydrateRootState(snapshot));
}

function setTokenActive(store: TTestStore, colour: TPlayerColour, isActive: boolean) {
  const snapshot = structuredClone(store.getState());
  getPlayer(snapshot.players, colour).tokens.forEach((t) => (t.isActive = isActive));
  store.dispatch(hydrateRootState(snapshot));
}

function buildTwoPlayerStore(): TTestStore {
  const store = createTestStore();
  store.dispatch(setPlayerSequence({ playerCount: 'two' }));
  for (const colour of playerSequences.two) {
    store.dispatch(
      registerNewPlayer({ name: `Player ${colour}`, colour, isBot: false })
    );
    store.dispatch(registerDice(colour));
  }
  return store;
}

/**
 * Drives the exact convergence the hooks perform for a completed move:
 * calculateSequence produces the pure next snapshot (movement + capture +
 * home), it is committed via hydrateRootState, then the SAME shared
 * shouldEndTurn predicate decides whether endTurn runs. No turn logic is
 * re-implemented inside the test.
 */
function settleMove(
  store: TTestStore,
  token: TToken,
  diceNumber: number
): { turnEnds: boolean; isCaptured: boolean; hasTokenReachedHome: boolean } {
  const before = store.getState();
  const { nextState } = calculateSequence(before, token, diceNumber);
  store.dispatch(hydrateRootState(nextState));

  const moved = getToken(nextState.players, token.colour, token.id);
  const hasTokenReachedHome = moved.hasTokenReachedHome;
  const hasPlayerWon = getPlayer(nextState.players, token.colour).tokens.every(
    (t) => t.hasTokenReachedHome
  );
  const opponentsBefore = before.players.players
    .filter((p) => p.colour !== token.colour)
    .flatMap((p) => p.tokens);
  const isCaptured = opponentsBefore.some((candidate) => {
    const after = getToken(nextState.players, candidate.colour, candidate.id);
    return !candidate.isLocked && after.isLocked;
  });

  const player = getPlayer(store.getState().players, token.colour);
  const turnEnds = shouldEndTurn({
    diceNumber,
    hasPlayerWon,
    isCaptured,
    hasTokenReachedHome,
    numberOfConsecutiveSix: player.numberOfConsecutiveSix,
  });
  if (turnEnds) store.dispatch(endTurn());
  return { turnEnds, isCaptured, hasTokenReachedHome };
}

describe('Turn-flow integration (single turn-ending source)', () => {
  beforeEach(() => {
    saveStateMock.mockClear();
  });

  it('three consecutive 6s end the turn, hand it over and leave the old player unable to move', () => {
    const store = buildTwoPlayerStore();
    const colour: TPlayerColour = 'blue';

    // First two sixes: counter accumulates, turn retained.
    store.dispatch(incrementNumberOfConsecutiveSix(colour));
    store.dispatch(activateTokens({ all: true, colour, diceNumber: 6 }));
    expect(getPlayer(store.getState().players, colour).numberOfConsecutiveSix).toBe(1);
    expect(store.getState().players.isTurnActive).toBe(true);

    store.dispatch(incrementNumberOfConsecutiveSix(colour));
    expect(getPlayer(store.getState().players, colour).numberOfConsecutiveSix).toBe(2);

    // Third six: useRollDice resolves the forfeit fully before returning —
    // counter reset, all tokens deactivated, turn flag flipped.
    store.dispatch(incrementNumberOfConsecutiveSix(colour));
    expect(getPlayer(store.getState().players, colour).numberOfConsecutiveSix).toBe(3);
    store.dispatch(resetNumberOfConsecutiveSix(colour));
    store.dispatch(deactivateAllTokens(colour));
    store.dispatch(setTurnActive(false));

    expect(store.getState().players.currentPlayerColour).toBe('blue');
    // useChangeTurn runs the single converged transition.
    store.dispatch(endTurn());

    const finalState = store.getState().players;
    expect(finalState.currentPlayerColour).toBe('green');
    expect(finalState.isTurnActive).toBe(false);
    expect(getPlayer(finalState, 'blue').numberOfConsecutiveSix).toBe(0);
    // Requirement: the outgoing player cannot move any token after the switch.
    expect(getPlayer(finalState, 'blue').tokens.every((t) => !t.isActive)).toBe(true);
    // The incoming player's turn stays inactive until they roll.
    expect(finalState.isTurnActive).toBe(false);
  });

  it('grants another roll after a capture while keeping the consecutive-six counter intact', () => {
    const store = buildTwoPlayerStore();
    placeOnPath(store, 'blue', 0, 2);
    // The two-player sequence is blue/green. Green path[32] shares blue's
    // destination tile (blue path[2] + 4), so this move captures it.
    placeOnPath(store, 'green', 0, 32);

    // A non-six roll (4) that captures: counter stays at zero, turn kept.
    store.dispatch(resetNumberOfConsecutiveSix('blue'));
    const result = settleMove(store, getToken(store.getState().players, 'blue', 0), 4);

    expect(result.isCaptured).toBe(true);
    expect(result.turnEnds).toBe(false);
    const state = store.getState().players;
    expect(state.currentPlayerColour).toBe('blue');
    expect(getPlayer(state, 'blue').numberOfConsecutiveSix).toBe(0);
    // The captured opponent is back in its base, locked.
    expect(getToken(state, 'green', 0).isLocked).toBe(true);
  });

  it('grants another roll after a token reaches home', () => {
    const store = buildTwoPlayerStore();
    const lastIndex = tokenPaths.blue.length - 1;
    placeOnPath(store, 'blue', 0, lastIndex - 3);

    const result = settleMove(store, getToken(store.getState().players, 'blue', 0), 3);

    expect(result.hasTokenReachedHome).toBe(true);
    expect(result.turnEnds).toBe(false);
    const state = store.getState().players;
    expect(state.currentPlayerColour).toBe('blue');
    expect(getToken(state, 'blue', 0).hasTokenReachedHome).toBe(true);
  });

  it('after the turn switches, every token of the outgoing player is deactivated and unmovable', () => {
    const store = buildTwoPlayerStore();
    setTokenActive(store, 'blue', true);
    store.dispatch(setTurnActive(true));

    store.dispatch(endTurn());

    const state = store.getState().players;
    expect(state.currentPlayerColour).toBe('green');
    expect(state.isTurnActive).toBe(false);
    expect(getPlayer(state, 'blue').tokens.every((t) => !t.isActive)).toBe(true);
    // Incoming player also starts with no active token until they roll.
    expect(getPlayer(state, 'green').tokens.every((t) => !t.isActive)).toBe(true);
  });
});
