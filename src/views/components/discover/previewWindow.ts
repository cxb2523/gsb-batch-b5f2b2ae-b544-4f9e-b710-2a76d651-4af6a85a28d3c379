/**
 * The preview-window state machine behind PreviewPlayer.
 *
 * A preview is a window into the full film's stream: playback starts at
 * `startSec`, runs for `durationSec`, then the end card takes over. The film's
 * own seek bar still spans the whole stream, so the machine also has to
 * survive the player reporting positions from outside the window: real seeks
 * by the user, and stale positions that keep arriving until a seek settles.
 *
 * It is pure so the component stays a thin adapter, and so the tricky parts
 * (replay, seeking back, repeated scrubbing) are testable without a browser or
 * a player licence.
 */

import { isBeforePreview, isPastPreview, previewRemaining, type Preview } from '../../../discover/model.js';

export type PreviewPhase = 'playing' | 'ended' | 'error';

export interface PreviewWindowState {
  phase: PreviewPhase;
  /** Seconds left in the window, as shown by the preview chip. */
  remaining: number;
  /**
   * A position inside the window has been seen since playback last moved
   * somewhere deliberately (start, replay, seek). Only then can a position
   * past the window mean the preview played through; before that it is a stale
   * report from the spot the player left, and must change nothing.
   */
  entered: boolean;
  /**
   * The target of a seek still settling, or null once it has landed. While it
   * is set, positions away from it belong to the old spot and are ignored.
   */
  seekTarget: number | null;
}

export interface WindowUpdate {
  state: PreviewWindowState;
  /** The player should seek here to keep playback inside the window. */
  seekTo?: number;
}

type PreviewSpan = Pick<Preview, 'startSec' | 'durationSec'>;

/** How close a reported position must be to a seek's target to count as the seek having landed. */
const SEEK_SETTLE_SEC = 3;

export function initialPreviewState(span: Pick<Preview, 'durationSec'>): PreviewWindowState {
  return { phase: 'playing', remaining: span.durationSec, entered: false, seekTarget: null };
}

const endedState = (state: PreviewWindowState): PreviewWindowState => ({
  ...state,
  phase: 'ended',
  remaining: 0,
  seekTarget: null,
});

/**
 * A deliberate move back to the window's start, with the countdown full again.
 * `entered` is false until the player reports a position there, so a late
 * report from the old spot (the end card, typically) changes nothing.
 */
const seekBackState = (state: PreviewWindowState, span: PreviewSpan): PreviewWindowState => ({
  ...state,
  phase: 'playing',
  remaining: span.durationSec,
  entered: false,
  seekTarget: span.startSec,
});

/**
 * Applies one position the machine is willing to trust.
 *
 * - Past the window: the preview played through; the end card is due.
 * - Before the window: at start-up that is the start offset not having applied
 *   yet (ignore); once playback has been inside, it is the user seeking back,
 *   so jump to the window's start.
 * - Inside: the countdown follows playback.
 */
function resolve(state: PreviewWindowState, span: PreviewSpan, time: number): WindowUpdate {
  if (isPastPreview(span, time)) {
    // No position inside the window yet: this is the spot the preview left,
    // not this pass finishing.
    return { state: state.entered ? endedState(state) : state };
  }
  if (isBeforePreview(span, time)) {
    if (!state.entered) {
      return { state }; // the start offset has not applied yet
    }
    // The user seeked back before the window: return to its start, once.
    return { state: seekBackState(state, span), seekTo: span.startSec };
  }
  return {
    state: {
      ...state,
      phase: 'playing',
      remaining: previewRemaining(span, time),
      entered: true,
      seekTarget: null,
    },
  };
}

/**
 * Playback progress, from every position the player reports. While a seek is
 * in flight only a position at its target counts as the seek landing; anything
 * else is a stale report from the old spot, and must neither end the preview
 * early nor make the countdown jump.
 */
export function onTime(state: PreviewWindowState, span: PreviewSpan, time: number): WindowUpdate {
  if (state.phase !== 'playing') {
    return { state };
  }
  if (state.seekTarget !== null) {
    if (Math.abs(time - state.seekTarget) > SEEK_SETTLE_SEC) {
      return { state }; // stale position from before the seek
    }
    // The seek landed: this position is authoritative, wherever it is.
    return resolve({ ...state, seekTarget: null }, span, time);
  }
  return resolve(state, span, time);
}

/**
 * A seek the user just started, from the player's own seek bar (our own seeks
 * re-report the target they were given, which resolves to the same state). The
 * target is authoritative: the countdown moves to it at once, a target past
 * the window ends the preview, and one before the window sends playback back
 * to the window's start instead of leaving it. Scrubbing inside the window,
 * however often, stays one continuous pass.
 */
export function onSeekTarget(state: PreviewWindowState, span: PreviewSpan, target: number): WindowUpdate {
  if (state.phase !== 'playing') {
    return { state };
  }
  if (isPastPreview(span, target)) {
    return { state: endedState(state) };
  }
  if (isBeforePreview(span, target)) {
    if (state.seekTarget === span.startSec) {
      return { state }; // already on its way back to the start
    }
    return { state: seekBackState(state, span), seekTo: span.startSec };
  }
  return {
    state: {
      ...state,
      remaining: previewRemaining(span, target),
      entered: false, // not until the seek lands
      seekTarget: target,
    },
  };
}

/**
 * The player says the seek is done and data is ready at the target. The
 * position it reports next is the new spot's, so it may be trusted again.
 */
export function onSeekSettled(state: PreviewWindowState, span: PreviewSpan): PreviewWindowState {
  if (state.phase !== 'playing' || state.seekTarget === null) {
    return state;
  }
  return { ...state, remaining: previewRemaining(span, state.seekTarget), seekTarget: null };
}

/** The stream itself ran out (e.g. a window that ends where the film does). */
export function onWindowEnded(state: PreviewWindowState): WindowUpdate {
  // A finish while a seek settles, or before any position has been seen since
  // the last deliberate move, belongs to the spot the preview left.
  if (state.phase !== 'playing' || state.seekTarget !== null || !state.entered) {
    return { state };
  }
  return { state: endedState(state) };
}

export function onWindowError(state: PreviewWindowState): PreviewWindowState {
  return { ...state, phase: 'error', seekTarget: null };
}

/**
 * "Replay preview": re-arm the window at its start, with the countdown back at
 * the full window. The seek to the start is in flight from the first moment,
 * so the end position the player still reports cannot end the fresh pass before
 * it has begun. Only an ended preview can be replayed, so a second click while
 * the first replay sets up changes nothing.
 */
export function onWindowReplay(state: PreviewWindowState, span: PreviewSpan): WindowUpdate {
  if (state.phase !== 'ended') {
    return { state };
  }
  return {
    state: seekBackState(state, span),
    seekTo: span.startSec,
  };
}
