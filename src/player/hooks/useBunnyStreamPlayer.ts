/**
 * `useBunnyStreamPlayer` — a React hook that subscribes to all native
 * {@link BunnyStreamPlayer} events and exposes a single aggregated
 * `PlayerState` (low-frequency) + `PlayerProgress` (high-frequency),
 * eliminating the per-screen `useState` boilerplate.
 *
 * The hook is purely additive: it returns `eventHandlers` that the consumer
 * spreads onto `<BunnyStreamPlayer {...player.eventHandlers} />`, plus a
 * stable `controls` object that proxies the imperative ref API.
 *
 * State is split so that consumers reading only `state.*` (e.g. play/pause
 * buttons) do NOT re-render on every `onProgress` tick (~4×/s).
 */

import type { BunnyVodPlayerRef } from '../BunnyStreamPlayer.types';
import type {
  PlayerEventHandlers,
  PlayerProgress,
  UseBunnyStreamPlayerOptions,
  UseBunnyStreamPlayerResult,
} from './useBunnyStreamPlayer.types';

import * as React from 'react';

import { createPlayerEventHandlers } from '../state/playerEventHandlers';
import { playerReducer } from '../state/playerReducer';
import { DEFAULT_PLAYER_STATE, DEFAULT_PROGRESS } from '../state/playerState';

export type {
  PlayerEventHandlers,
  PlayerProgress,
  PlayerState,
  UseBunnyStreamPlayerOptions,
  UseBunnyStreamPlayerResult,
} from './useBunnyStreamPlayer.types';

/**
 * Subscribes to all {@link BunnyStreamPlayer} events and aggregates them into
 * a single `PlayerState` + `PlayerProgress`. See the file docstring for
 * usage.
 *
 * @param options  Optional user-supplied event handlers.
 * @param sourceKey  Identity key for the current source (e.g. from
 *   `sourceIdentityKey`). When this changes, the hook resets `state` and
 *   `progress` to defaults and mints a new event-ownership token — this
 *   prevents stale VOD state (videoId, duration, progress, playback state)
 *   from lingering after a VOD → live transition or a source change, and
 *   drops late events (including `onProgress`) still emitted by the
 *   previous native instance so they never reach the new source's state or
 *   the user callbacks. Pass `undefined` to opt out of resets (legacy
 *   behaviour).
 */
export function useBunnyStreamPlayer(
  options?: UseBunnyStreamPlayerOptions,
  sourceKey?: string | number,
): UseBunnyStreamPlayerResult {
  const ref = React.useRef<BunnyVodPlayerRef | null>(null);

  const [state, dispatch] = React.useReducer(playerReducer, DEFAULT_PLAYER_STATE);
  const [progress, setProgress] = React.useState<PlayerProgress>(DEFAULT_PROGRESS);

  // Ownership token binding the event handlers to the current source
  // identity. Each source change mints a fresh token; handlers created for
  // a previous token (still held by the torn-down native instance) drop
  // their events instead of writing stale state.
  const ownershipRef = React.useRef<object>({});
  const [prevSourceKey, setPrevSourceKey] = React.useState<string | number | undefined>(sourceKey);
  if (prevSourceKey !== sourceKey) {
    // Render-phase adjustment (React's endorsed "adjust state when props
    // change" pattern): reset state + progress and mint the new ownership
    // token BEFORE children render and effects fire. This guarantees that
    // (a) late events from the previous native instance are dropped, and
    // (b) a configuration error reported by the child player's mount effect
    // lands AFTER the reset, so it isn't wiped back to isLoading=true.
    setPrevSourceKey(sourceKey);
    ownershipRef.current = {};
    dispatch({ type: 'RESET' });
    setProgress(DEFAULT_PROGRESS);
  }
  const ownership = ownershipRef.current;

  // Store user handlers in a ref so the memoised event handlers below have a
  // stable identity even when the user passes inline callbacks.
  const optionsRef = React.useRef<UseBunnyStreamPlayerOptions | undefined>(options);
  optionsRef.current = options;

  // Stable imperative API — proxies the ref so consumers can call
  // `player.controls.play()` without touching the ref directly.
  const controls = React.useMemo<BunnyVodPlayerRef>(
    () => ({
      play: () => ref.current?.play(),
      pause: () => ref.current?.pause(),
      seekTo: (positionMs: number) => ref.current?.seekTo(positionMs),
      skipForward: (offsetMs?: number) => ref.current?.skipForward(offsetMs),
      skipBackward: (offsetMs?: number) => ref.current?.skipBackward(offsetMs),
      setVolume: (volume: number) => ref.current?.setVolume(volume),
      setPlaybackRate: (rate: number) => ref.current?.setPlaybackRate(rate),
      mute: () => ref.current?.mute(),
      unmute: () => ref.current?.unmute(),
      enterPiP: () => ref.current?.enterPiP(),
      setVideoQuality: (quality) => ref.current?.setVideoQuality(quality),
    }),
    [],
  );

  // Handlers are re-minted per ownership token: stable across re-renders of
  // the same source, but a source change gives the new native instance a
  // fresh set whose token is current — the old set (held by the unmounted
  // native instance) drops any late events it still receives.
  const eventHandlers = React.useMemo<PlayerEventHandlers>(
    () => createPlayerEventHandlers(dispatch, setProgress, optionsRef, ownershipRef, ownership),
    [ownership],
  );

  return { ref, state, progress, controls, eventHandlers };
}
