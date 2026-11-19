import { describe, expect, it } from 'vitest';
import { MAX_CONSECUTIVE_SIX, shouldEndTurn } from '../../src/game/turn/turnResolution';

describe('Test game/turn/turnResolution', () => {
  describe('shouldEndTurn — the single turn-ending predicate', () => {
    const base = {
      hasPlayerWon: false,
      isCaptured: false,
      hasTokenReachedHome: false,
      numberOfConsecutiveSix: 0,
    };

    it('ends the turn on an ordinary non-six roll with no capture or home arrival', () => {
      expect(shouldEndTurn({ ...base, diceNumber: 3 })).toBe(true);
      expect(shouldEndTurn({ ...base, diceNumber: 1 })).toBe(true);
      expect(shouldEndTurn({ ...base, diceNumber: 5 })).toBe(true);
    });

    it('keeps the turn on a six, regardless of other (false) flags', () => {
      expect(shouldEndTurn({ ...base, diceNumber: 6 })).toBe(false);
    });

    it('keeps the turn after a capture even when the roll was not a six', () => {
      expect(shouldEndTurn({ ...base, diceNumber: 4, isCaptured: true })).toBe(false);
    });

    it('keeps the turn after a token reaches home even on a non-six roll', () => {
      expect(
        shouldEndTurn({ ...base, diceNumber: 3, hasTokenReachedHome: true })
      ).toBe(false);
    });

    it(`ends the turn once the consecutive-six run reaches ${MAX_CONSECUTIVE_SIX}, even mid "bonus" conditions`, () => {
      expect(
        shouldEndTurn({
          ...base,
          diceNumber: 6,
          numberOfConsecutiveSix: MAX_CONSECUTIVE_SIX,
        })
      ).toBe(true);
      // A capture or home arrival cannot rescue a forfeited triple-six turn.
      expect(
        shouldEndTurn({
          ...base,
          diceNumber: 6,
          isCaptured: true,
          numberOfConsecutiveSix: MAX_CONSECUTIVE_SIX,
        })
      ).toBe(true);
      expect(
        shouldEndTurn({
          ...base,
          diceNumber: 6,
          hasTokenReachedHome: true,
          numberOfConsecutiveSix: MAX_CONSECUTIVE_SIX,
        })
      ).toBe(true);
    });

    it('does not forfeit on runs shorter than the consecutive-six limit', () => {
      expect(
        shouldEndTurn({ ...base, diceNumber: 6, numberOfConsecutiveSix: 1 })
      ).toBe(false);
      expect(
        shouldEndTurn({ ...base, diceNumber: 6, numberOfConsecutiveSix: 2 })
      ).toBe(false);
    });

    it('always ends the turn when the player has won, even on a six with a capture', () => {
      expect(
        shouldEndTurn({
          ...base,
          diceNumber: 6,
          isCaptured: true,
          hasTokenReachedHome: true,
          hasPlayerWon: true,
        })
      ).toBe(true);
    });

    it('grants a bonus roll on six / capture / home even when only locked tokens remain', () => {
      // Locked tokens can still be unlocked by the next bonus roll, so the
      // bonus is granted unconditionally rather than cancelled.
      expect(shouldEndTurn({ ...base, diceNumber: 6 })).toBe(false);
      expect(shouldEndTurn({ ...base, diceNumber: 4, isCaptured: true })).toBe(false);
      expect(
        shouldEndTurn({ ...base, diceNumber: 3, hasTokenReachedHome: true })
      ).toBe(false);
    });
  });
});
