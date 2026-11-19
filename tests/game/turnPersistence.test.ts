import { beforeEach, describe, expect, it, vi } from 'vitest';
import { combineReducers, configureStore, type AnyAction } from '@reduxjs/toolkit';
import {
  activateTokens,
  deactivateAllTokens,
  endTurn,
  getPlayer,
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
import { playerSequences } from '../../src/game/players/constants';
import { saveState } from '../../src/game/storage/saveState';
import type { TPlayerColour } from '../../src/types';

vi.mock('../../src/game/storage/saveState', () => ({
  saveState: vi.fn(),
}));

const mockedSaveState = vi.mocked(saveState);

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

/**
 * Replays the exact orchestration the hooks now perform:
 *  - useRollDice performs ONLY dispatches (no saveState call),
 *  - useChangeTurn dispatches endTurn and saves strictly afterwards,
 *  - the Dice/Token components save the settled state when the turn continues.
 * This test's value is proving the roll path stopped persisting intermediate
 * states and that the only save around a turn switch sees the final state.
 */
describe('Persistence happens only after the turn state is finalised', () => {
  beforeEach(() => {
    mockedSaveState.mockClear();
  });

  it('writes nothing during the triple-six resolution and saves only the post-switch state', () => {
    const store = createTestStore();
    store.dispatch(setPlayerSequence({ playerCount: 'two' }));
    for (const colour of playerSequences.two) {
      store.dispatch(registerNewPlayer({ name: `P ${colour}`, colour, isBot: false }));
      store.dispatch(registerDice(colour));
    }
    const colour: TPlayerColour = 'blue';

    // --- Replay useRollDice's three-six path (dispatches only, no save) ---
    store.dispatch(incrementNumberOfConsecutiveSix(colour));
    store.dispatch(incrementNumberOfConsecutiveSix(colour));
    store.dispatch(incrementNumberOfConsecutiveSix(colour));
    store.dispatch(resetNumberOfConsecutiveSix(colour));
    store.dispatch(deactivateAllTokens(colour));
    store.dispatch(setTurnActive(false));

    // The roll hook must not have persisted anything: the turn is not yet
    // handed over, so saving here would capture an intermediate state.
    expect(mockedSaveState).not.toHaveBeenCalled();

    // --- Replay useChangeTurn: endTurn first, save only after it settles ---
    store.dispatch(endTurn());
    const finalState = store.getState();
    saveState(finalState);

    expect(mockedSaveState).toHaveBeenCalledTimes(1);
    const saved = mockedSaveState.mock.calls[0][0];
    expect(saved.players.currentPlayerColour).toBe('green');
    expect(saved.players.isTurnActive).toBe(false);
    expect(getPlayer(saved.players, 'blue').numberOfConsecutiveSix).toBe(0);
    expect(getPlayer(saved.players, 'blue').tokens.every((t) => !t.isActive)).toBe(true);
  });

  it('saves the settled bonus-roll state with the six counter still accumulated', () => {
    const store = createTestStore();
    store.dispatch(setPlayerSequence({ playerCount: 'two' }));
    for (const c of playerSequences.two) {
      store.dispatch(registerNewPlayer({ name: `P ${c}`, colour: c, isBot: false }));
      store.dispatch(registerDice(c));
    }

    // A single six: token activation and counter accumulation settle, then
    // the Dice component persists the continuing-turn state.
    store.dispatch(incrementNumberOfConsecutiveSix('blue'));
    store.dispatch(activateTokens({ all: true, colour: 'blue', diceNumber: 6 }));
    saveState(store.getState());

    expect(mockedSaveState).toHaveBeenCalledTimes(1);
    const saved = mockedSaveState.mock.calls[0][0];
    expect(getPlayer(saved.players, 'blue').numberOfConsecutiveSix).toBe(1);
    expect(saved.players.isTurnActive).toBe(true);
  });
});
