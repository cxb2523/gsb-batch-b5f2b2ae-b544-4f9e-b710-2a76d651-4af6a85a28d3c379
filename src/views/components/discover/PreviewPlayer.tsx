import { Player, type PlayerAPI, PlayerEvent, type SourceConfig } from 'bitmovin-player';
import { UIFactory } from 'bitmovin-player-ui';
import 'bitmovin-player-ui/dist/css/bitmovinplayer-ui.css';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { type Film, type Preview } from '../../../discover/model.js';
import { ICON } from '../cover.js';
import { Icon } from '../Icon.js';
import { createPreviewController } from './previewController.js';
import { PlayerLoading, PreviewErrorCard } from './shared.js';

const LOAD_TIMEOUT_MS = 30_000; // how long a source may take to load before the stage reports a failure

export interface PreviewPlayerProps {
  film: Film & { preview: Preview };
  licenseKey: string;
  /** Fires each time the preview window plays through (again after a replay). */
  onEnded?: () => void;
  /** Fires once if the preview cannot load or play here. */
  onError?: () => void;
  /** Fires when the user replays the preview from the end card. */
  onReplay?: () => void;
  /** The hand-off to the full film, shown on the end card and on the error card. */
  handoff?: ReactNode;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Plays a preview window of a film: from `preview.startSec` for
 * `preview.durationSec`, then pauses and shows an end card. The window is
 * enforced client-side on the full film's stream, so a "trailer" needs no
 * separate encode. Any catalogue can offer previews this way. The player's
 * seek bar still spans the whole film: seeking past the window ends the
 * preview, and seeking back before it returns to the window's start.
 *
 * Mounts the Bitmovin Player into a ref'd node that React leaves alone, since
 * the player appends its own DOM. Overlays are siblings React controls. Mount
 * one instance per film (`key={film.id}`); the player is not reused across films.
 *
 * The window rules live in `previewWindow.ts`. This component only feeds it
 * the player's events and publishes what it decides, so the player has one
 * source of truth for "playing", "ended" and "where the window is".
 */
export function PreviewPlayer({ film, licenseKey, onEnded, onError, onReplay, handoff }: PreviewPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Set while the player is mounted; replaying runs through the controller.
  const replayRef = useRef<(() => boolean) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [remaining, setRemaining] = useState(film.preview.durationSec);

  const { stream, startSec, durationSec } = film.preview;

  // Called from player events, which are wired once per film: these always see
  // the parent's latest callbacks without rebuilding the player.
  const fireEnded = useEffectEvent(() => onEnded?.());
  const fireError = useEffectEvent(() => onError?.());

  useEffect(() => {
    const node = mountRef.current;
    if (!node) {
      return;
    }
    let cancelled = false;
    let failed = false;

    // One container per player, so teardown can detach this player's DOM alone.
    const container = document.createElement('div');
    node.appendChild(container);

    const player: PlayerAPI = new Player(container, {
      key: licenseKey,
      // Playback starts manually after load() so the play() promise is ours to
      // catch; config autoplay leaves an uncaught rejection when blocked.
      playback: { autoplay: false, muted: true },
      // A preview plays in a small widget: never fetch renditions larger than
      // the player, which would otherwise climb to 4K on a fast connection.
      adaptation: { limitToPlayerSize: true },
      ui: false,
    });
    const uiManager = UIFactory.buildUI(player);

    // The window machine drives the player: this component only publishes what
    // it decides (the end card and the countdown) and forwards "Replay preview".
    const controller = createPreviewController({
      span: { startSec, durationSec },
      player,
      onChange: state => {
        if (!cancelled) {
          setEnded(state.phase === 'ended');
          setRemaining(state.remaining);
        }
      },
      // Fires exactly on the playing → ended transition, so a replay followed
      // by another pass reports again and stale events report nothing.
      onEnded: () => fireEnded(),
    });
    replayRef.current = () => controller.replay();

    const fail = (detail: string) => {
      if (cancelled || failed) {
        return;
      }
      failed = true;
      controller.fail();
      void player.unload().catch(() => {}); // stop a load that is still in flight
      setError(detail);
      fireError();
    };

    player.on(PlayerEvent.Ready, () => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    player.on(PlayerEvent.TimeChanged, e => {
      if (!cancelled && !failed) {
        controller.time(e.time);
      }
    });
    // The player's seek bar seeks through the public API, and so do our own
    // seeks; a seek we already started just re-reports its target, which the
    // window machine treats as the same target (no second seek).
    player.on(PlayerEvent.Seek, e => {
      if (!cancelled && !failed) {
        controller.seek(e.seekTarget);
      }
    });
    player.on(PlayerEvent.Seeked, () => {
      if (!cancelled && !failed) {
        controller.seeked();
      }
    });
    player.on(PlayerEvent.PlaybackFinished, () => {
      if (!cancelled && !failed) {
        controller.finished();
      }
    });
    player.on(PlayerEvent.Error, e => fail(`Error ${e.code}: ${e.message ?? 'playback failed'}`));

    const source: SourceConfig = { title: film.title, options: { startOffset: startSec } };
    if (stream.type === 'hls') {
      source.hls = stream.url;
    } else {
      source.dash = stream.url;
    }

    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      loadTimer = setTimeout(
        () => rej(new Error(`The preview did not load within ${LOAD_TIMEOUT_MS / 1000}s.`)),
        LOAD_TIMEOUT_MS,
      );
    });
    Promise.race([player.load(source), timeout])
      .then(() => {
        if (cancelled || failed) {
          return;
        }
        // In a sandbox that blocks even muted autoplay the rejection is benign;
        // the user can press play.
        void player.play('api').catch(() => {});
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
      .finally(() => clearTimeout(loadTimer));

    return () => {
      cancelled = true;
      clearTimeout(loadTimer);
      replayRef.current = null;
      uiManager.release();
      container.remove();
      void player.destroy().catch(() => {});
    };
  }, [film.title, stream.url, stream.type, startSec, durationSec, licenseKey]);

  const replay = () => {
    if (replayRef.current?.()) {
      onReplay?.();
    }
  };

  return (
    <div className="player-stage preview-stage">
      <div className="player-mount" ref={mountRef} />
      {!loading && !error && !ended ? (
        <div className="preview-chip" aria-live="off">
          Preview · {clock(remaining)} left
        </div>
      ) : null}
      {loading && !error ? <PlayerLoading title={film.title} /> : null}
      {error ? (
        <PreviewErrorCard title={film.title} handoff={handoff} detail={error} />
      ) : ended ? (
        <div className="preview-end">
          <div className="preview-end-kicker">That was the preview</div>
          <div className="preview-end-title">{film.title}</div>
          <div className="preview-end-actions">
            {handoff}
            <button className="btn btn-ghost" onClick={replay}>
              <Icon html={ICON.replay} />
              Replay preview
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
