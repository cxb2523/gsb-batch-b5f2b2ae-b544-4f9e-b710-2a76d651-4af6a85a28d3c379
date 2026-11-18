// Background music loader — reverted to the original working architecture.
// Plays an MP3 through AudioContext with master gain for smooth ducking.
// Returns null if the file can't be loaded (wake uses procedural bed).
//
// Loading is async, so callers can pass a `cancelled` token: if the load is
// superseded (new wake) or stopped before it finishes, the result is
// discarded and every node it created is released — nothing plays.

import { audioBus } from './bus';

export type MusicController = {
  stop: (fadeMs?: number) => void;
  duck: (level: number, durMs?: number) => void;
};

// No-op kept for call-site compatibility. The original working flow
// didn't need pre-warming; the fetch happens inside playMusic().
export function primeMusic(_url: string): void {}

export async function playMusic(
  url: string,
  level: number,
  opts?: { cancelled?: () => boolean },
): Promise<MusicController | null> {
  const { ctx, master } = audioBus();
  const isCancelled = () => !!opts?.cancelled?.();

  let audio: HTMLAudioElement | null = new Audio(url);
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  audio.loop = false;

  let src: MediaElementAudioSourceNode | null = null;
  let lp: BiquadFilterNode | null = null;
  let gain: GainNode | null = null;
  let released = false;

  // Fully release the element and every node this load created.
  const release = () => {
    if (released) return;
    released = true;
    if (audio) {
      try { audio.pause(); } catch {}
      try { audio.removeAttribute('src'); audio.load(); } catch {}
      audio = null;
    }
    for (const n of [src, lp, gain]) { try { n?.disconnect(); } catch {} }
    src = null;
    lp = null;
    gain = null;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const a = audio!;
      const onReady = () => { cleanup(); resolve(); };
      const onErr   = () => { cleanup(); reject(new Error('music load error')); };
      const cleanup = () => {
        a.removeEventListener('canplay', onReady);
        a.removeEventListener('error', onErr);
      };
      a.addEventListener('canplay', onReady);
      a.addEventListener('error', onErr);
    });

    // Superseded or stopped while the MP3 was loading — discard the result,
    // release the element, and never build the graph.
    if (isCancelled()) { release(); return null; }

    src = ctx.createMediaElementSource(audio!);

    // Music's OWN gain with fade-in. This is the only node duck() touches —
    // the volume slider drives the shared master gain, and the two never
    // overwrite each other.
    gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 1.2);

    // Subtle lowpass so music sits under the voice
    lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    lp.Q.value = 0.5;

    src.connect(lp).connect(gain).connect(master);

    // Re-check before and after play() — a newer wake may have taken over
    // in either await. If so, release the MediaElementSource + gain we just
    // built instead of letting them sound.
    if (isCancelled()) { release(); return null; }
    await audio!.play();
    if (isCancelled()) { release(); return null; }

    let stopped = false;

    return {
      stop: (fadeMs = 1500) => {
        if (stopped) return;   // idempotent — safe on re-entrant wakes
        stopped = true;
        const g = gain;
        if (g) {
          const t = ctx.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0.0001, t + fadeMs / 1000);
        }
        // After the fade, actually release: pause the element, detach its
        // src, and disconnect the MediaElementSource / filter / gain.
        setTimeout(release, fadeMs + 80);
      },
      duck: (newLevel, durMs = 600) => {
        if (stopped) return;   // a stopped track must not ramp back up
        const g = gain;
        if (!g) return;
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(newLevel, t + durMs / 1000);
      },
    };
  } catch (err) {
    release();
    console.warn('[music] load failed', err);
    return null;
  }
}
