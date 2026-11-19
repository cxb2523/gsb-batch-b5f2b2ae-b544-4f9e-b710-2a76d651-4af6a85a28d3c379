import type { RootState } from '../../state/store';
import type { TSequenceCalculationResult, TToken } from '../../types';
import playersReducer, {
  endTurn,
  deactivateAllTokens,
  lockToken,
  markTokenAsReachedHome,
  setTokenAlignmentData,
  updateTokenCoordinatesAndDirection,
} from '../../state/slices/playersSlice';
import { areCoordsEqual } from '../coords/logic';
import { defaultTokenAlignmentData } from '../tokens/alignment';
import { TOKEN_SAFE_COORDINATES } from '../tokens/constants';
import { tokenPaths } from '../tokens/paths';
import { shouldEndTurn } from '../turn/turnResolution';

export const calculateSequence = (
  state: RootState,
  token: TToken,
  diceNumber: number
): TSequenceCalculationResult => {
  const { coordinates, colour, id, direction } = token;
  const nextState = structuredClone(state);
  const captureData: TSequenceCalculationResult['captureData'] = [];

  const tokenPath = tokenPaths[token.colour];
  const initialCoordIndex = tokenPath.findIndex((v) => areCoordsEqual(v, coordinates));
  const finalCoordIndex = initialCoordIndex + diceNumber;
  const moveSequence: TSequenceCalculationResult['moveSequence'] = tokenPath.slice(
    initialCoordIndex + 1,
    finalCoordIndex + 1
  );

  const finalCoordinate = tokenPath[finalCoordIndex];
  const hasTokenReachedHome = areCoordsEqual(finalCoordinate, tokenPath[tokenPath.length - 1]);

  nextState.players = playersReducer(nextState.players, deactivateAllTokens(token.colour));

  nextState.players = playersReducer(
    nextState.players,
    updateTokenCoordinatesAndDirection({
      colour,
      id,
      newCoords: finalCoordinate,
      direction: direction ?? 'forward',
    })
  );
  const clonedPlayers = nextState.players.players;

  const isSafeTile = TOKEN_SAFE_COORDINATES.some((c) => areCoordsEqual(c, finalCoordinate));

  if (!isSafeTile) {
    clonedPlayers.forEach((p) => {
      if (p.colour !== token.colour) {
        p.tokens.forEach((t) => {
          if (areCoordsEqual(t.coordinates, finalCoordinate)) {
            nextState.players = playersReducer(
              nextState.players,
              lockToken({ colour: t.colour, id: t.id })
            );
            nextState.players = playersReducer(
              nextState.players,
              setTokenAlignmentData({
                colour: t.colour,
                id: t.id,
                newAlignmentData: defaultTokenAlignmentData,
              })
            );
            const idx = tokenPaths[t.colour].findIndex((c) => areCoordsEqual(c, t.coordinates));
            const moveSequence = tokenPaths[t.colour].slice(0, idx + 1).reverse();
            captureData.push({ token: t, moveSequence });
          }
        });
      }
    });
  }

  if (hasTokenReachedHome) {
    nextState.players = playersReducer(
      nextState.players,
      markTokenAsReachedHome({ colour: token.colour, id: token.id })
    );
  }

  const updatedPlayer = nextState.players.players.find((p) => p.colour === token.colour);
  const hasPlayerWon = updatedPlayer
    ? updatedPlayer.tokens.every((t) => t.hasTokenReachedHome)
    : false;

  // The persisted snapshot converges on the exact same turn-ending
  // predicate used by the live hooks, so a save never records a turn state
  // that diverges from what the UI will converge on.
  const turnEnds = shouldEndTurn({
    diceNumber,
    hasPlayerWon,
    isCaptured: captureData.length !== 0,
    hasTokenReachedHome,
    numberOfConsecutiveSix: updatedPlayer?.numberOfConsecutiveSix ?? 0,
  });
  if (turnEnds) nextState.players = playersReducer(nextState.players, endTurn());

  return { nextState, moveSequence, captureData };
};
