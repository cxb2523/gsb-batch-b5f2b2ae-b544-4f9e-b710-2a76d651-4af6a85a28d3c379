/**
 * Guards the one-time settlement of a round (challenge complete or game over).
 *
 * Timeouts, duplicated pointer/keyboard events, and React re-renders can all
 * ask the same round to settle more than once. Every round carries a stable id,
 * and only the first settlement for that id is allowed through. Later rounds
 * have a different id, so they are unaffected by an older settled round.
 */
export interface GameSettlementGate {
  isSettled(roundId: string): boolean;
  trySettle(roundId: string): boolean;
}

export function createGameSettlementGate(): GameSettlementGate {
  const settledRoundIds = new Set<string>();

  return {
    isSettled(roundId) {
      return settledRoundIds.has(roundId);
    },
    trySettle(roundId) {
      if (!roundId || settledRoundIds.has(roundId)) return false;
      settledRoundIds.add(roundId);
      return true;
    },
  };
}
