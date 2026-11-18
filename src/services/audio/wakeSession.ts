// Wake audio session — one re-entrant owner of the wake's music + ambient bed.
//
// Every wake begins a NEW session: the previous session's music and ambient
// bed are stopped first (even mid-fade), then the new round starts. Async
// music loads carry the session id — if a load resolves after its session
// was superseded or ended, the result is discarded and its nodes released
// instead of being played.

import { playMusic, type MusicController } from './music';
import { playAmbientBed } from './ambient';

type Bed = ReturnType<typeof playAmbientBed>;

let sessionId = 0;
let music: MusicController | null = null;
let bed: Bed | null = null;

function teardown(fadeMs = 400) {
  const m = music;
  const b = bed;
  music = null;
  bed = null;
  try { m?.stop(fadeMs); } catch {}
  try { b?.stop(fadeMs); } catch {}
  if (typeof window !== 'undefined' && (window as any).__jarvisMusic) {
    (window as any).__jarvisMusic = null;
  }
}

/** Begin a new wake audio session. Stops the previous session, if any. */
export function beginWakeAudioSession(): number {
  sessionId += 1;
  teardown();
  return sessionId;
}

/** End the active session — stops music + bed and orphans in-flight loads. */
export function endWakeAudioSession(): void {
  sessionId += 1;
  teardown();
}

export function isWakeAudioSession(id: number): boolean {
  return id === sessionId;
}

/**
 * Start the session's music; falls back to the procedural bed if the MP3
 * can't be loaded. If the session is superseded before the load resolves,
 * the controller is discarded (released) and nothing plays.
 */
export function startWakeMusic(id: number, url: string, level: number, bedLevel = 0.18): void {
  playMusic(url, level, { cancelled: () => !isWakeAudioSession(id) })
    .then((ctl) => {
      if (!isWakeAudioSession(id)) {
        // Superseded between the last cancellation check and now — release
        // the MediaElementSource + gain instead of letting them sound.
        ctl?.stop(0);
        return;
      }
      if (ctl) {
        music = ctl;
        // Expose on window so v2.0 voice commands can stop/duck it.
        (window as any).__jarvisMusic = ctl;
      } else {
        bed = playAmbientBed({ level: bedLevel });
      }
    })
    .catch(() => {});
}

/** Duck/unduck the session's music — touches the music's own gain only. */
export function duckWakeMusic(id: number, level: number, durMs?: number): void {
  if (isWakeAudioSession(id)) music?.duck(level, durMs);
}

/** Swell the session's procedural bed (no-op if the MP3 loaded). */
export function swellWakeBed(id: number, level: number, durMs: number): void {
  if (isWakeAudioSession(id)) bed?.swell(level, durMs);
}
