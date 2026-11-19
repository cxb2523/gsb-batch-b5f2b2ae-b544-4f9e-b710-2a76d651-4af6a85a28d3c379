import { getNextPlayer } from '../players/logic';
import type { TPlayerColour, TPlayerNameAndColour } from '../../types';

/**
 * Maximum number of consecutive 6s a player may roll in one turn.
 * The 3rd consecutive 6 forfeits the turn without moving.
 */
export const MAX_CONSECUTIVE_SIX = 3;

export type TTurnOutcomeInput = {
  diceNumber: number;
  hasPlayerWon: boolean;
  isCaptured: boolean;
  hasTokenReachedHome: boolean;
  numberOfConsecutiveSix: number;
};

/**
 * THE single source of truth for deciding whether the current turn ends.
 *
 * Pure function: every code path (dice roll, manual move, capture, home
 * arrival, bot move, the snapshot built by calculateSequence) derives its
 * turn-ending decision from this predicate so the dice display and the
 * clickable token state can never drift apart.
 *
 * Rules (standard Ludo):
 *  - finishing the whole board ends the turn;
 *  - the third consecutive 6 forfeits the turn (no piece may move);
 *  - rolling a 6, capturing or sending a token home grants a bonus roll
 *    unconditionally — a locked token can always be unlocked by the next 6,
 *    so "no currently movable token" does not cancel these bonuses;
 *  - every ordinary (non-bonus) roll ends the turn. The distinct "rolled
 *    but no legal move exists" situation is detected by the post-roll hook,
 *    which routes through the same changeTurn entry without moving a piece.
 */
export const shouldEndTurn = ({
  diceNumber,
  hasPlayerWon,
  isCaptured,
  hasTokenReachedHome,
  numberOfConsecutiveSix,
}: TTurnOutcomeInput): boolean => {
  if (hasPlayerWon) return true;
  if (numberOfConsecutiveSix >= MAX_CONSECUTIVE_SIX) return true;
  // A six, a capture or reaching home grants a bonus roll unconditionally —
  // a locked token can always be unlocked by the next 6. Everything else
  // (an ordinary completed move, or an ordinary roll with no legal move)
  // ends the turn; the no-legal-move case is detected by the caller, which
  // only invokes the shared changeTurn entry rather than moving anything.
  if (diceNumber === 6 || isCaptured || hasTokenReachedHome) return false;
  return true;
};

/**
 * Pure turn-finalisation helper used both by the playersSlice `endTurn`
 * reducer and by calculateSequence when it pre-computes the next state
 * snapshot. Keeping the transition here means the live store and the
 * persisted snapshot converge through the same logic.
 *
 * Returns the next player colour, or null when every player has finished.
 */
export const resolveNextPlayerColour = (
  playerSequence: TPlayerColour[],
  playerFinishOrder: TPlayerNameAndColour[],
  currentPlayerColour: TPlayerColour
): TPlayerColour | null =>
  getNextPlayer(playerSequence, playerFinishOrder, currentPlayerColour);
