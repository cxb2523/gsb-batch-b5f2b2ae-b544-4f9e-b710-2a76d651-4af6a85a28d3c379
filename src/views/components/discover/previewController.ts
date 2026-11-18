/**
 * Connects the preview-window state machine to a player.
 *
 * PreviewPlayer wires Bitmovin's events to this controller, and the controller
 * decides what the player and the app see: when to seek back, when to pause on
 * the end card, when `onEnded` fires, and what the countdown shows. Keeping it
 * separate from the React component means the event ordering that caused the
 * end-card and replay bugs (stale positions, a seek still in flight, a second
 * finish) is testable against a fake player.
 */

import {
  initialPreviewState,
  onSeekSettled,
  onSeekTarget,
  onTime,
  onWindowEnded,
  onWindowError,
  onWindowReplay,
  type PreviewWindowState,
  type WindowUpdate,
} from './previewWindow.js';

/** The part of the Bitmovin player the preview needs. */
export interface PreviewPlayerPort {
  seek(time: number, issuer?: string): unknown;
  pause(issuer?: string): void;
  play(issuer?: string): Promise<void> | void;
}

export interface PreviewControllerOptions {
  span: { startSec: number; durationSec: number };
  player: PreviewPlayerPort;
  /** Called with the new state whenever the countdown or the phase changes. */
  onChange: (state: PreviewWindowState) => void;
  /** Called once each time the preview plays through (again after a replay). */
  onEnded: () => void;
}

export interface PreviewController {
  /** A playback position the player reported (`TimeChanged`). */
  time(time: number): void;
  /** A seek target the player reported (`Seek`). */
  seek(target: number): void;
  /** The player finished seeking (`Seeked`). */
  seeked(): void;
  /** The stream itself finished (`PlaybackFinished`). */
  finished(): void;
  /** The player failed; the window stops responding. */
  fail(): void;
  /** The user pressed "Replay preview"; false when there is nothing to replay. */
  replay(): boolean;
  readonly state: PreviewWindowState;
}

export function createPreviewController({
  span,
  player,
  onChange,
  onEnded,
}: PreviewControllerOptions): PreviewController {
  let state = initialPreviewState(span);

  const apply = (update: WindowUpdate) => {
    const wasPlaying = state.phase === 'playing';
    state = update.state;
    if (update.seekTo !== undefined) {
      player.seek(update.seekTo, 'api');
    }
    onChange(state);
    if (wasPlaying && state.phase === 'ended') {
      player.pause('api');
      onEnded();
    }
  };

  return {
    time(time) {
      apply(onTime(state, span, time));
    },
    seek(target) {
      apply(onSeekTarget(state, span, target));
    },
    seeked() {
      apply({ state: onSeekSettled(state, span) });
    },
    finished() {
      apply(onWindowEnded(state));
    },
    fail() {
      apply({ state: onWindowError(state) });
    },
    replay() {
      if (state.phase !== 'ended') {
        return false;
      }
      apply(onWindowReplay(state, span));
      void Promise.resolve(player.play('api')).catch(() => {});
      return true;
    },
    get state() {
      return state;
    },
  };
}
