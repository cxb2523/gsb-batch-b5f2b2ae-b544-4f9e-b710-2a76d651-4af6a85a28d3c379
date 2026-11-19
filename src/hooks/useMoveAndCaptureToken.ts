import { useDispatch, useStore } from 'react-redux';
import { deactivateAllTokens, getToken, markTokenAsReachedHome } from '../state/slices/playersSlice';
import { type TToken } from '../types';
import { useCaptureTokenInSameCoord } from './useCaptureTokenInSameCoord';
import { useMoveTokenForward } from './useMoveTokenForward';
import type { TMoveData } from '../types/tokens';
import { getAvailableSteps } from '../game/tokens/logic';
import { useCallback } from 'react';
import { calculateSequence } from '../game/movement/calculateSequence';
import { type RootState } from '../state/store';
import { ERRORS } from '../utils/errors';
import { deleteSaveFromStorage } from '../game/storage/storage';

/**
 * Computes the next state via the pure calculateSequence, plays the move /
 * capture animations against the live store, then reports the move outcome.
 *
 * Deliberately does NOT save: the snapshot may already contain a turn
 * transition (endTurn) that the live store only converges on once the
 * caller runs the shared changeTurn logic. Persisting here would write an
 * intermediate, half-converged state. Callers save only after the turn
 * state has been finalised (reroll settled or changeTurn dispatched).
 */
export function useMoveAndCaptureToken() {
  const moveToken = useMoveTokenForward();
  const captureToken = useCaptureTokenInSameCoord();
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  return useCallback(
    async (token: TToken, diceNumber: number): Promise<TMoveData | null> => {
      if (diceNumber < 0) throw new Error(ERRORS.numberOfStepsNegative());
      if (getAvailableSteps(token) < diceNumber) {
        dispatch(deactivateAllTokens(token.colour));
        return null;
      }
      const { nextState, moveSequence, captureData } = calculateSequence(
        store.getState(),
        token,
        diceNumber
      );
      if (nextState.players.isGameEnded) {
        deleteSaveFromStorage();
      }
      await moveToken(moveSequence, token);
      if (moveSequence.length === 0) return null;
      if (captureData.length !== 0) await captureToken(captureData, token);
      const { hasTokenReachedHome } = getToken(nextState.players, token.colour, token.id);
      const hasPlayerWon = nextState.players.players
        .find((p) => p.colour === token.colour)!
        .tokens.every((t) => t.hasTokenReachedHome);
      if (hasTokenReachedHome)
        dispatch(markTokenAsReachedHome({ colour: token.colour, id: token.id }));
      return {
        isCaptured: captureData.length !== 0,
        hasTokenReachedHome,
        hasPlayerWon,
      };
    },
    [captureToken, dispatch, moveToken, store]
  );
}
