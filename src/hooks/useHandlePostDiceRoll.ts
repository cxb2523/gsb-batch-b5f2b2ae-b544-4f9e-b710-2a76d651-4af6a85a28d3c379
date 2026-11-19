import { useDispatch, useStore } from 'react-redux';
import type { AppDispatch, RootState } from '../state/store';
import { areCoordsEqual } from '../game/coords/logic';
import { isTokenMovable, isAnyTokenActiveOfColour } from '../game/tokens/logic';
import { activateTokens, deactivateAllTokens, setTurnActive } from '../state/slices/playersSlice';
import type { TMoveData, TPlayerColour } from '../types';
import { useMoveAndCaptureToken } from './useMoveAndCaptureToken';
import { useCallback } from 'react';
import { useUnlockAndAlignTokens } from './useUnlockAndAlignTokens';
import { shouldEndTurn } from '../game/turn/turnResolution';

export type TPostDiceRollResult = {
  shouldChangeTurn: boolean;
  moveData: TMoveData | null;
} | null;

export const useHandlePostDiceRoll = () => {
  const store = useStore<RootState>();
  const dispatch = useDispatch<AppDispatch>();
  const moveAndCapture = useMoveAndCaptureToken();
  const unlockAndAlignTokens = useUnlockAndAlignTokens();
  return useCallback(
    async (
      colour: TPlayerColour,
      diceNumber: number,
      isConsecutiveSixLimitReached: boolean
    ): Promise<TPostDiceRollResult> => {
      if (store.getState().players.isGameEnded) return null;

      // Triple six: the roll hook has already reset the counter, deactivated
      // every token and flipped isTurnActive. No piece may move — the turn
      // simply passes on, through the same changeTurn entry as every other
      // turn-ending path.
      if (isConsecutiveSixLimitReached) {
        return { moveData: null, shouldChangeTurn: true };
      }

      dispatch(activateTokens({ all: diceNumber === 6, colour, diceNumber }));

      const players = store.getState().players.players;
      const player = players.find((p) => p.colour === colour);
      if (!player) return null;
      const lockedTokens = player.tokens.filter((t) =>
        areCoordsEqual(t.coordinates, t.initialCoords)
      );

      const movableTokens = player.tokens.filter((t) => isTokenMovable(t, diceNumber));

      // Exactly one locked token left and nothing else can move: unlock it
      // automatically on a six and grant the bonus roll.
      if (diceNumber === 6 && lockedTokens.length === 1 && movableTokens.length === 0) {
        unlockAndAlignTokens({ colour: lockedTokens[0].colour, id: lockedTokens[0].id });
        dispatch(deactivateAllTokens(lockedTokens[0].colour));
        return { moveData: null, shouldChangeTurn: false };
      }

      // Unlockable tokens are waiting for the player to click one.
      const areUnlockableTokensPresent = diceNumber === 6 && lockedTokens.length !== 0;
      if (areUnlockableTokensPresent) return { moveData: null, shouldChangeTurn: false };

      const areAllTokensInSameCoord =
        movableTokens.length === 0
          ? false
          : movableTokens.every((t) => areCoordsEqual(movableTokens[0].coordinates, t.coordinates));

      if (areAllTokensInSameCoord) {
        const moveData = await moveAndCapture(movableTokens[0], diceNumber);
        if (!moveData) {
          dispatch(setTurnActive(false));
          return { moveData, shouldChangeTurn: true };
        }
        const { hasTokenReachedHome, isCaptured, hasPlayerWon } = moveData;
        const freshSixCount = store
          .getState()
          .players.players.find((p) => p.colour === colour)!.numberOfConsecutiveSix;
        const turnEnds = shouldEndTurn({
          diceNumber,
          hasPlayerWon,
          isCaptured,
          hasTokenReachedHome,
          numberOfConsecutiveSix: freshSixCount,
        });
        if (turnEnds) {
          dispatch(setTurnActive(false));
          return { moveData: null, shouldChangeTurn: true };
        }
        return { moveData, shouldChangeTurn: false };
      }

      // No auto-move possible. If activation produced no active token at
      // all, nothing can move with this roll: end the turn through the same
      // changeTurn entry as every other path. Otherwise the player must
      // click one of the active tokens, so the turn stays alive.
      if (!isAnyTokenActiveOfColour(colour, store.getState().players.players)) {
        dispatch(setTurnActive(false));
        return { moveData: null, shouldChangeTurn: true };
      }
      return { moveData: null, shouldChangeTurn: false };
    },
    [dispatch, moveAndCapture, store, unlockAndAlignTokens]
  );
};
