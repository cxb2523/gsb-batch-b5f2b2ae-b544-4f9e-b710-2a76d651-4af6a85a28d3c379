import { type RootState, type AppDispatch } from './../state/store';
import { useCallback } from 'react';
import { useDispatch, useStore } from 'react-redux';
import type { TPlayerColour } from '../types';
import { setIsPlaceholderShowing, renewRollBag, setDiceNumber } from '../state/slices/diceSlice';
import { sleep } from '../utils/sleep';
import { ERRORS } from '../utils/errors';
import {
  deactivateAllTokens,
  incrementNumberOfConsecutiveSix,
  resetNumberOfConsecutiveSix,
  setTurnActive,
} from '../state/slices/playersSlice';
import { MAX_CONSECUTIVE_SIX } from '../game/turn/turnResolution';

const DICE_PLACEHOLDER_DELAY = 1000;

export type TRollDiceResult = {
  diceNumber: number;
  /**
   * True when the roll was the MAX_CONSECUTIVE_SIX-th consecutive 6.
   * The turn is forfeit: the counter has been reset, every token
   * deactivated and isTurnActive flipped to false before this resolves,
   * so callers must call changeTurn without moving anything.
   */
  isConsecutiveSixLimitReached: boolean;
};

export const useRollDice = () => {
  const store = useStore<RootState>();
  const dispatch = useDispatch<AppDispatch>();
  return useCallback(
    async (colour: TPlayerColour): Promise<TRollDiceResult> => {
      if (store.getState().players.isGameEnded) throw new Error(ERRORS.gameEnded());
      dispatch(setIsPlaceholderShowing({ colour, isPlaceholderShowing: true }));
      await sleep(DICE_PLACEHOLDER_DELAY);
      const diceState = store.getState().dice;
      if (diceState.rollBag[colour].length === 0) dispatch(renewRollBag(colour));
      const bag = store.getState().dice.rollBag[colour];
      const index = Math.floor(Math.random() * bag.length);
      const diceNumber = bag[index];
      dispatch(setIsPlaceholderShowing({ colour, isPlaceholderShowing: false }));

      // Consecutive-six bookkeeping: a non-six always resets the run;
      // capture / home arrival never touch this counter.
      if (diceNumber === 6) dispatch(incrementNumberOfConsecutiveSix(colour));
      else dispatch(resetNumberOfConsecutiveSix(colour));

      const player = store.getState().players.players.find((p) => p.colour === colour)!;
      if (player.numberOfConsecutiveSix >= MAX_CONSECUTIVE_SIX) {
        // The forfeited turn is fully resolved here: no token of this
        // player may move and the run counter starts at zero again.
        dispatch(resetNumberOfConsecutiveSix(colour));
        dispatch(deactivateAllTokens(colour));
        dispatch(setTurnActive(false));
        // No setDiceNumber dispatch: the die keeps its previous value and
        // nothing is saved until the caller finalises the turn transition.
        return { diceNumber, isConsecutiveSixLimitReached: true };
      }

      dispatch(setDiceNumber({ colour, randomIndex: index }));
      return { diceNumber, isConsecutiveSixLimitReached: false };
    },
    [dispatch, store]
  );
};
