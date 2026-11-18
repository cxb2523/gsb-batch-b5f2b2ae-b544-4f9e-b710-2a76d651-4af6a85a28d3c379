import type { BunnyStreamSource } from '../player/BunnyStreamPlayer.types';
import type { UseBunnyStreamPlayerOptions } from '../player/hooks/useBunnyStreamPlayer.types';
import type { NativeProps as VodNativeProps } from '../specs/BunnyStreamPlayerNativeComponent';
import type * as ReactTypes from 'react';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, renderHook } from '@testing-library/react-native';

import { getConfiguredLibraryId } from '../config/initialize';
import { BunnyStreamPlayer } from '../player/BunnyStreamPlayer';
import { useBunnyStreamPlayer } from '../player/hooks/useBunnyStreamPlayer';
import { sourceIdentityKey } from '../player/sourceIdentity';
import { fire } from './helpers';

const mockVodHost = jest.fn();
const mockLiveHost = jest.fn();

jest.mock('../config/initialize', () => ({
  getConfiguredLibraryId: jest.fn(),
}));

jest.mock('../specs/BunnyStreamPlayerNativeComponent', () => {
  const React = jest.requireActual<typeof ReactTypes>('react');
  return {
    __esModule: true,
    default: React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
      mockVodHost(props);
      React.useImperativeHandle(ref, () => ({}));
      return null;
    }),
    Commands: {
      play: jest.fn(),
      pause: jest.fn(),
      seekTo: jest.fn(),
      setVolume: jest.fn(),
      setPlaybackRate: jest.fn(),
      mute: jest.fn(),
      unmute: jest.fn(),
      enterPiP: jest.fn(),
      setVideoQuality: jest.fn(),
    },
  };
});

jest.mock('../specs/BunnyLiveStreamPlayerNativeComponent', () => {
  const React = jest.requireActual<typeof ReactTypes>('react');
  return {
    __esModule: true,
    default: React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
      mockLiveHost(props);
      React.useImperativeHandle(ref, () => ({}));
      return null;
    }),
  };
});

async function renderKeyedHook(initialKey: string, options?: UseBunnyStreamPlayerOptions) {
  return renderHook((key: string) => useBunnyStreamPlayer(options, key), {
    initialProps: initialKey,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getConfiguredLibraryId).mockReturnValue(undefined);
});

// --- Event ownership: late events from a previous source ---

describe('useBunnyStreamPlayer event ownership', () => {
  it('drops late events from the previous source without forwarding them to user callbacks', async () => {
    const onReady = jest.fn();
    const onProgress = jest.fn();
    const onError = jest.fn();
    const { result, rerender, unmount } = await renderKeyedHook('vod:1', {
      onReady,
      onProgress,
      onError,
    });

    await fire(result.current.eventHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
    expect(onReady).toHaveBeenCalledTimes(1);

    // The unmounted native instance still holds this handler set.
    const staleHandlers = result.current.eventHandlers;

    await rerender('vod:2');
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.state.isLoading).toBe(true);

    // Late events from the old instance arrive after the switch.
    await fire(staleHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
    await fire(staleHandlers.onProgress, { positionMs: 30_000, durationMs: 60_000, progress: 0.5 });
    await fire(staleHandlers.onError, { code: 'ERR', message: 'late failure' });
    await fire(staleHandlers.onLiveStateChange, { state: 'live', isLive: true });

    // None of them reached the new source's state or progress.
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.state.durationMs).toBe(0);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.liveState).toBeNull();
    expect(result.current.state.isLoading).toBe(true);
    expect(result.current.progress).toEqual({ positionMs: 0, durationMs: 0, progress: 0 });

    // None of them were forwarded to the user callbacks.
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await unmount();
  });

  it('accepts events from the new source after a source change', async () => {
    const onReady = jest.fn();
    const { result, rerender, unmount } = await renderKeyedHook('vod:1', { onReady });

    await fire(result.current.eventHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
    await rerender('vod:2');
    await fire(result.current.eventHandlers.onReady, { videoId: 'vid-2', durationMs: 120_000 });

    expect(result.current.state.videoId).toBe('vid-2');
    expect(result.current.state.durationMs).toBe(120_000);
    expect(result.current.state.isLoading).toBe(false);
    expect(onReady).toHaveBeenLastCalledWith({ videoId: 'vid-2', durationMs: 120_000 });
    await unmount();
  });

  it('keeps handler identity stable within a source and re-mints it on source change', async () => {
    const { result, rerender, unmount } = await renderKeyedHook('vod:1');
    const first = result.current.eventHandlers;
    await rerender('vod:1');
    expect(result.current.eventHandlers).toBe(first);

    await rerender('vod:2');
    expect(result.current.eventHandlers).not.toBe(first);
    const second = result.current.eventHandlers;
    await rerender('vod:2');
    expect(result.current.eventHandlers).toBe(second);
    await unmount();
  });

  it.each([
    {
      label: 'onReady',
      fire: async (handlers: { onReady: (e: { nativeEvent: { videoId: string; durationMs: number } }) => void }) =>
        fire(handlers.onReady, { videoId: 'vid-2', durationMs: 120_000 }),
    },
    {
      label: 'onVideoSizeChange',
      fire: async (handlers: { onVideoSizeChange: (e: { nativeEvent: { width: number; height: number } }) => void }) =>
        fire(handlers.onVideoSizeChange, { width: 1920, height: 1080 }),
    },
    {
      label: 'onLiveStateChange',
      fire: async (handlers: {
        onLiveStateChange: (e: { nativeEvent: { state: 'live'; isLive: boolean } }) => void;
      }) => fire(handlers.onLiveStateChange, { state: 'live', isLive: true }),
    },
  ])(
    'keeps isLoading true after a reset until the new source signals readiness via $label',
    async ({ fire: fireReady }) => {
      const { result, rerender, unmount } = await renderKeyedHook('vod:1');
      await fire(result.current.eventHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
      expect(result.current.state.isLoading).toBe(false);
      const staleHandlers = result.current.eventHandlers;

      await rerender('vod:2');
      expect(result.current.state.isLoading).toBe(true);

      // A late readiness signal from the old instance must not clear it.
      await fireReady(staleHandlers);
      expect(result.current.state.isLoading).toBe(true);

      // The new source's own readiness signal clears it.
      await fireReady(result.current.eventHandlers);
      expect(result.current.state.isLoading).toBe(false);
      await unmount();
    },
  );
});

// --- Configuration errors through the component + hook ---

describe('configuration errors with a sourceKey-bound hook', () => {
  let lastPlayer: ReturnType<typeof useBunnyStreamPlayer> | undefined;

  function Player({ source }: { source: BunnyStreamSource }) {
    const player = useBunnyStreamPlayer(undefined, sourceIdentityKey(source));
    lastPlayer = player;
    return <BunnyStreamPlayer source={source} {...player.eventHandlers} />;
  }

  function vodHostProps(): VodNativeProps {
    return mockVodHost.mock.calls.at(-1)?.[0] as VodNativeProps;
  }

  beforeEach(() => {
    lastPlayer = undefined;
  });

  it('enters the error state on a missing library and reloads after recovery', async () => {
    const view = await render(<Player source={{ type: 'vod', videoId: 'vid-1' }} />);

    // The component reports the configuration error through onError; the
    // hook turns it into an error state with the loader stopped.
    expect(lastPlayer?.state.error).toMatchObject({ code: 'MISSING_LIBRARY_ID' });
    expect(lastPlayer?.state.playbackState).toBe('error');
    expect(lastPlayer?.state.isLoading).toBe(false);
    expect(mockVodHost).not.toHaveBeenCalled();

    // Recovery: a valid source (new identity) resets and mounts natively.
    await view.rerender(<Player source={{ type: 'vod', libraryId: 123, videoId: 'vid-1' }} />);
    expect(lastPlayer?.state.error).toBeNull();
    expect(lastPlayer?.state.isLoading).toBe(true);
    expect(mockVodHost).toHaveBeenCalled();

    await act(async () => {
      vodHostProps().onReady?.({
        nativeEvent: { videoId: 'vid-1', durationMs: 60_000 },
      } as Parameters<NonNullable<VodNativeProps['onReady']>>[0]);
    });
    expect(lastPlayer?.state.isLoading).toBe(false);
    expect(lastPlayer?.state.error).toBeNull();
    expect(lastPlayer?.state.videoId).toBe('vid-1');
    await view.unmount();
  });

  it.each([0, -1, 1.5, NaN])(
    'keeps an early invalid-library (%s) error from being wiped by the reset',
    async (libraryId) => {
      const view = await render(
        <Player source={{ type: 'vod', libraryId: 123, videoId: 'vid-1' }} />,
      );
      await act(async () => {
        vodHostProps().onReady?.({
          nativeEvent: { videoId: 'vid-1', durationMs: 60_000 },
        } as Parameters<NonNullable<VodNativeProps['onReady']>>[0]);
      });
      expect(lastPlayer?.state.isLoading).toBe(false);

      // Switching to a misconfigured source: the reset happens first, then
      // the mount-time configuration error must land and stick.
      await view.rerender(<Player source={{ type: 'vod', libraryId, videoId: 'vid-2' }} />);
      expect(lastPlayer?.state.error).toMatchObject({ code: 'INVALID_LIBRARY_ID' });
      expect(lastPlayer?.state.playbackState).toBe('error');
      expect(lastPlayer?.state.isLoading).toBe(false);
      await view.unmount();
    },
  );
});
