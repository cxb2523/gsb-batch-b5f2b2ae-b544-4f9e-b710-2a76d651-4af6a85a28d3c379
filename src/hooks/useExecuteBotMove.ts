import { useCallback } from 'react';
import type { TPlayerColour } from '../types';
import { selectBestTokenForBot } from '../game/bot/selectBestTokenForBot';
import { saveState } from '../game/storage/saveState';
import { type RootState } from '../state/store';
import { useStore } from 'react-redux';
import { useMoveAndCaptureToken } from './useMoveAndCaptureToken';
import { useRollDice, type TRollDiceResult } from './useRollDice';
import { useUnlockAndAlignTokens } from './useUnlockAndAlignTokens';
import { useChangeTurn } from './useChangeTurn';
import { sleep } from '../utils/sleep';
import { logError } from '../utils/logError';
import { shouldEndTurn } from '../game/turn/turnResolution';

export const useExecuteBotMove = () => {
  const store = useStore<RootState>();
  const moveAndCapture = useMoveAndCaptureToken();
  const unlockAndAlignTokens = useUnlockAndAlignTokens();
  const rollDice = useRollDice();
  const changeTurnFn = useChangeTurn();

  return useCallback(
    async function executeBotMove(
      colour: TPlayerColour,
      rollResult: TRollDiceResult
    ): Promise<void> {
      const { diceNumber, isConsecutiveSixLimitReached } = rollResult;
      try {
        // Triple six: no piece may move, hand the turn over through the
        // same converged entry as every other turn-ending path.
        if (isConsecutiveSixLimitReached) return changeTurnFn();

        const allTokens = store.getState().players.players.flatMap((p) => p.tokens);
        const bestToken = selectBestTokenForBot(colour, diceNumber, allTokens);
        if (!bestToken) return changeTurnFn();

        if (bestToken.isLocked && !bestToken.hasTokenReachedHome && diceNumber === 6) {
          unlockAndAlignTokens({ colour, id: bestToken.id });
          saveState(store.getState());
          await sleep(500);
          // Six grants a bonus roll; the counter for the run lives in the
          // roll hook, never reset here.
          return executeBotMove(colour, await rollDice(colour));
        }
        const moveData = await moveAndCapture(bestToken, diceNumber);
        if (!moveData) return changeTurnFn();
        const { hasTokenReachedHome, isCaptured, hasPlayerWon } = moveData;

        const freshPlayer = store.getState().players.players.find((p) => p.colour === colour)!;
        const turnEnds = shouldEndTurn({
          diceNumber,
          hasPlayerWon,
          isCaptured,
          hasTokenReachedHome,
          numberOfConsecutiveSix: freshPlayer.numberOfConsecutiveSix,
        });

        await sleep(500);
        if (turnEnds) return changeTurnFn();
        // Bonus roll after a six / capture / home arrival.
        return executeBotMove(colour, await rollDice(colour));
      } catch (e) {
        logError('useExecuteBotMove')(e);
        changeTurnFn();
      }
    },
    [changeTurnFn, moveAndCapture, unlockAndAlignTokens, store, rollDice]
  );
};
