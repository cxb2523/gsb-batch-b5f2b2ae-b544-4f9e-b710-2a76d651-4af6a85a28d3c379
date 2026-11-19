import { type AppDispatch, type RootState } from './../state/store';
import { useDispatch, useStore } from 'react-redux';
import { endTurn } from '../state/slices/playersSlice';
import { useCallback } from 'react';
import { saveState } from '../game/storage/saveState';

/**
 * The only entry point for handing the turn to the next player.
 * All turn-ending paths (dice roll, move, capture, home arrival, triple
 * six, bot move) converge here, so token deactivation, consecutive-six
 * reset, currentPlayerColour and isTurnActive always transition atomically.
 * The save happens strictly after that final state is committed — never on
 * an intermediate state.
 */
export const useChangeTurn = () => {
  const store = useStore<RootState>();
  const dispatch = useDispatch<AppDispatch>();

  return useCallback(() => {
    if (store.getState().players.isGameEnded) return;
    dispatch(endTurn());
    const state = store.getState();
    if (!state.players.isGameEnded) saveState(state);
  }, [dispatch, store]);
};
