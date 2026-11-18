/**
 * The Trailer Reel's state machine: which preview is playing, whether its end
 * (or error) card is up, and how many previews in a row could not play.
 *
 * Pure so the component only has to turn it into a timer and a player. The
 * pending advance is deliberately *not* part of the state — the component
 * derives it from `shouldAdvance` — which is what makes a leftover beat
 * harmless: it can only move the reel on if it was armed for the preview that
 * is still current, and the state still says it may.
 */

/** Time the end (or error) card stays up before the reel moves on. */
export const ADVANCE_DELAY_MS = 4_000;
/** Then the reel stops: the host is probably blocking every stream. */
export const MAX_FAILURES_IN_A_ROW = 3;

export interface ReelState {
  index: number;
  /** The current preview is showing its end or error card, i.e. waiting to move on. */
  waiting: boolean;
  /** Previews in a row that could not play. */
  failures: number;
  /** This preview has already been counted as a failure, so repeat error signals change nothing. */
  errorCounted: boolean;
  /** Whether the reel moves on by itself after a card. */
  auto: boolean;
}

export type ReelAction =
  | { type: 'ended' }
  | { type: 'error' }
  | { type: 'replay' }
  | { type: 'select'; index: number }
  | { type: 'auto'; on: boolean }
  /** A beat elapsed; `from` is the preview it was armed for, `count` the queue it saw. */
  | { type: 'advance'; from: number; count: number };

export const initialReelState: ReelState = { index: 0, waiting: false, failures: 0, errorCounted: false, auto: true };

/**
 * Whether the reel should be counting down to the next preview right now: a
 * card is up, auto-advance is on, the failure limit is not reached, and there
 * is a next preview to go to.
 */
export function shouldAdvance(state: ReelState, filmCount: number): boolean {
  return state.waiting && state.auto && state.failures < MAX_FAILURES_IN_A_ROW && state.index < filmCount - 1;
}

export function reelReducer(state: ReelState, action: ReelAction): ReelState {
  switch (action.type) {
    case 'ended':
      // A preview that played through breaks the failure streak.
      return { ...state, waiting: true, failures: 0, errorCounted: false };
    case 'error':
      // One failure per preview, however many error signals it produces.
      return state.errorCounted ? state : { ...state, waiting: true, failures: state.failures + 1, errorCounted: true };
    case 'replay':
      // The user restarted the current preview; whatever beat ran is void, and
      // if playback breaks again that is a new failure to count.
      return state.waiting || state.errorCounted ? { ...state, waiting: false, errorCounted: false } : state;
    case 'select':
      // Already playing: nothing to do; only another preview is a move.
      return action.index === state.index
        ? state
        : { ...state, index: action.index, waiting: false, failures: 0, errorCounted: false };
    case 'auto':
      return action.on === state.auto ? state : { ...state, auto: action.on };
    case 'advance':
      // A beat armed for another preview, or one that fired after a replay, a
      // manual pick, the auto switch or the failure limit changed the plan,
      // must move nothing.
      if (action.from !== state.index || !shouldAdvance(state, action.count)) {
        return state;
      }
      return { ...state, index: state.index + 1, waiting: false, errorCounted: false };
    default:
      return state;
  }
}
