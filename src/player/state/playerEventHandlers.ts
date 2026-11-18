import type { LiveStateChangeEvent } from '../BunnyStreamPlayer.types';
import type {
  PlayerEventHandlers,
  PlayerProgress,
  UseBunnyStreamPlayerOptions,
} from '../hooks/useBunnyStreamPlayer.types';
import type { PlayerAction } from './playerReducer';
import type { Dispatch, SetStateAction } from 'react';

interface CurrentOptionsRef {
  current: UseBunnyStreamPlayerOptions | undefined;
}

/**
 * Ownership token binding a set of event handlers to one source identity.
 * The hook mints a fresh token on every source change; handlers created for
 * a previous token compare it against the ref and drop their events, so
 * late events from a torn-down native instance never reach the new source's
 * state or the user's callbacks.
 */
export interface EventOwnershipRef {
  current: object;
}

/**
 * Builds an event handler that unwraps `nativeEvent`, dispatches a reducer
 * action, and forwards the same payload to the matching user callback in
 * `optionsRef.current`. The callback is read at call time so option changes
 * between renders take effect without recreating the handler. Events whose
 * ownership token is no longer current (late events from a previous source)
 * are dropped before either step.
 */
function bindHandler<E>(
  dispatch: Dispatch<PlayerAction>,
  optionsRef: CurrentOptionsRef,
  key: keyof UseBunnyStreamPlayerOptions,
  toAction: (e: E) => PlayerAction,
  isCurrent: () => boolean,
): (event: { nativeEvent: E }) => void {
  return (event) => {
    if (!isCurrent()) {
      return;
    }
    const payload = event.nativeEvent;
    dispatch(toAction(payload));
    (optionsRef.current?.[key] as ((p: E) => void) | undefined)?.(payload);
  };
}

/** Builds the `onLiveStateChange` payload, dropping undefined optional fields. */
function buildLiveStatePayload(e: LiveStateChangeEvent) {
  const {
    state: liveState,
    isLive,
    reason,
    targetEpochMs,
    title,
    videoId,
    message,
    dvrEnabled,
  } = e;
  return {
    state: liveState,
    isLive,
    ...(reason !== undefined && { reason }),
    ...(targetEpochMs !== undefined && { targetEpochMs }),
    ...(title !== undefined && { title }),
    ...(videoId !== undefined && { videoId }),
    ...(message !== undefined && { message }),
    ...(dvrEnabled !== undefined && { dvrEnabled }),
  };
}

export function createPlayerEventHandlers(
  dispatch: Dispatch<PlayerAction>,
  setProgress: Dispatch<SetStateAction<PlayerProgress>>,
  optionsRef: CurrentOptionsRef,
  ownershipRef: EventOwnershipRef,
  ownership: object,
): PlayerEventHandlers {
  // Events are accepted only while this handler set's ownership token is
  // the current one. After a source change the hook mints a new token, so
  // late events from the previous native instance (still holding these
  // handlers) are dropped instead of polluting the new source's state.
  const isCurrent = () => ownershipRef.current === ownership;
  return {
    onReady: bindHandler(dispatch, optionsRef, 'onReady', (e) => ({
      type: 'READY' as const,
      videoId: e.videoId,
      durationMs: e.durationMs,
    }), isCurrent),
    onPlaybackStateChange: bindHandler(dispatch, optionsRef, 'onPlaybackStateChange', (e) => ({
      type: 'STATE_CHANGE' as const,
      state: e.state,
    }), isCurrent),
    onProgress: (e) => {
      if (!isCurrent()) {
        return;
      }
      const { positionMs, durationMs, progress: prog } = e.nativeEvent;
      // High-frequency: bypass the reducer entirely.
      setProgress({ positionMs, durationMs, progress: prog });
      optionsRef.current?.onProgress?.({ positionMs, durationMs, progress: prog });
    },
    onError: bindHandler(dispatch, optionsRef, 'onError', (e) => ({
      type: 'ERROR' as const,
      error: e,
    }), isCurrent),
    onBuffering: bindHandler(dispatch, optionsRef, 'onBuffering', (e) => ({
      type: 'BUFFERING' as const,
      isBuffering: e.isBuffering,
    }), isCurrent),
    onPlay: bindHandler(dispatch, optionsRef, 'onPlay', () => ({ type: 'PLAY' as const }), isCurrent),
    onPause: bindHandler(dispatch, optionsRef, 'onPause', () => ({ type: 'PAUSE' as const }), isCurrent),
    onEnd: bindHandler(dispatch, optionsRef, 'onEnd', () => ({ type: 'END' as const }), isCurrent),
    onVolumeChange: bindHandler(dispatch, optionsRef, 'onVolumeChange', (e) => ({
      type: 'VOLUME' as const,
      volume: e.volume,
      isMuted: e.isMuted,
    }), isCurrent),
    onPlaybackRateChange: bindHandler(dispatch, optionsRef, 'onPlaybackRateChange', (e) => ({
      type: 'PLAYBACK_RATE' as const,
      rate: e.rate,
    }), isCurrent),
    onVideoSizeChange: bindHandler(dispatch, optionsRef, 'onVideoSizeChange', (e) => ({
      type: 'VIDEO_SIZE' as const,
      width: e.width,
      height: e.height,
    }), isCurrent),
    onPlaybackError: bindHandler(dispatch, optionsRef, 'onPlaybackError', (e) => ({
      type: 'PLAYBACK_ERROR' as const,
      message: e.message,
    }), isCurrent),
    onLiveStateChange: (e) => {
      if (!isCurrent()) {
        return;
      }
      const payload = buildLiveStatePayload(e.nativeEvent);
      dispatch({ type: 'LIVE_STATE', liveState: payload });
      optionsRef.current?.onLiveStateChange?.(payload);
    },
    onLiveError: bindHandler(dispatch, optionsRef, 'onLiveError', (e) => ({
      type: 'LIVE_ERROR' as const,
      message: e.message,
    }), isCurrent),
  };
}
