import { useCallback } from 'react';
import { useJarvis } from '@/state/store';
import { voice } from '@/services/tts';
import { buildSegments, getActiveCues, type BriefingContext, type PanelKey } from '@/services/briefing/mock-data';
import { whoosh, chime, impact, riser } from '@/services/audio/sfx';
import { unlockAudio } from '@/services/audio/bus';
import {
  beginWakeAudioSession,
  startWakeMusic,
  duckWakeMusic,
  swellWakeBed,
} from '@/services/audio/wakeSession';
import { CONFIG } from '@/config';

// Live data fetch — timeboxed so the wake never stalls on a slow API.
async function fetchBriefingContext(timeoutMs = 800): Promise<BriefingContext> {
  const race = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);

  const [stripe, crypto, weather] = await Promise.all([
    race(window.jarvis?.getStripe?.() ?? Promise.resolve(null)),
    race(window.jarvis?.getCrypto?.() ?? Promise.resolve(null)),
    race(window.jarvis?.getWeather?.() ?? Promise.resolve(null)),
  ]);

  return {
    stripeTodayUsd: stripe && !stripe.error ? Math.round(stripe.todayCents / 100) : undefined,
    stripeWeekUsd:  stripe && !stripe.error ? Math.round(stripe.weekCents / 100)  : undefined,
    stripeTxnCount: stripe && !stripe.error ? stripe.todayCount : undefined,
    btcPrice:    crypto?.btc?.price,
    btcChange:   crypto?.btc?.change,
    ethPrice:    crypto?.eth?.price,
    weatherTemp: weather && !weather.error ? weather.temp : undefined,
    weatherCond: weather && !weather.error ? weather.cond : undefined,
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 10-second total wake: clap → briefing done.
 *
 * Timing budget (ms):
 *   0      clap / space
 *   0–700  waking (space → Earth)
 *   700–1600  descending (Earth → NYC)
 *   1600–1900  briefing stance + chime
 *   1900–~9500  single TTS render speaks (~7.5s of audio)
 *   ~9500  music ducks, phase flips to ready
 */
export function useWakeSequence() {
  const setPhase = useJarvis((s) => s.setPhase);
  const setVoiceAmp = useJarvis((s) => s.setVoiceAmp);
  const setVoiceActive = useJarvis((s) => s.setVoiceActive);
  const revealPanel = useJarvis((s) => s.revealPanel);

  return useCallback(async () => {
    const phase = useJarvis.getState().phase;
    if (phase !== 'sleep') return;

    await unlockAudio();

    // Fetch live data (short timeout — we move even if it's slow).
    const ctx = await fetchBriefingContext(800);
    const segments = buildSegments(ctx);
    const script = segments[0]?.text ?? '';

    // Pre-render the single briefing clip — no cascading renders.
    const precachePromise = voice.precache([script], 'jarvis').catch(() => {});

    // Audio bed — local MP3 (AC/DC Shoot to Thrill on disk). No YouTube,
    // no embed block. MusicPanel is purely visual; this plays the actual audio.
    //
    // One re-entrant session owns the wake's music + ambient bed: beginning
    // this session stops the previous wake's music/bed (even mid-fade), and
    // if the async MP3 load resolves after a newer wake has begun, it is
    // discarded without playing.
    const audioSession = beginWakeAudioSession();
    startWakeMusic(audioSession, CONFIG.musicTrack, CONFIG.musicLevel);

    // Phase 1: space → Earth
    whoosh({ level: 0.35, duration: 0.55 });
    setPhase('waking');
    await delay(500);

    // Phase 2: dive to NYC
    whoosh({ level: 0.28, duration: 0.7 });
    riser({ level: 0.15, duration: 0.9 });
    setPhase('descending');
    await delay(700);

    // Phase 3: briefing begins. Music is already playing from disk —
    // duck it so JARVIS cuts through cleanly.
    chime({ level: 0.18 });
    duckWakeMusic(audioSession, CONFIG.musicLevel * 0.42, 400);
    swellWakeBed(audioSession, 0.18, 300);
    setPhase('briefing');
    setVoiceActive(true);

    // Panel reveals fire in sync with when JARVIS speaks the topic.
    // VOICE-GATED panel reveals. Each panel is tied to a keyword phrase in
    // the script — the panel opens when audio playback position crosses
    // that phrase.
    //
    // Old approach (broken): triggerAt = (charIndex / script.length) * duration.
    // That assumed constant chars-per-second, which is false — punctuation
    // pauses, multi-syllable words, and ElevenLabs emphasis all skew the
    // mapping. Some panels fired half a sentence early, others late.
    //
    // New approach: word-count timing with explicit sentence-pause budget.
    // ElevenLabs Alice spends ≈280ms on each '.', '!', '?' regardless of
    // surrounding word count, so we subtract that from total duration to
    // get pure speaking time, then estimate words-per-second from there.
    // Plus a small lead so the panel slides in as the word starts, not after.
    //
    // MUSIC opens instantly (before speech) so AC/DC plays under the narration.
    // Cues come from the active briefing script — generic in the public repo,
    // overridden by `morning.private.ts` (gitignored) on personal installs.
    type Cue = { key: PanelKey; keyword: string | null };
    const cues: Cue[] = getActiveCues();
    const firedCues = new Set<PanelKey>();

    const fireCue = (key: PanelKey) => {
      if (firedCues.has(key)) return;
      firedCues.add(key);
      revealPanel(key);
      chime({ level: 0.07 });
    };

    // Validate cue keywords exist in current script — surface drift early.
    for (const c of cues) {
      if (c.keyword && script.indexOf(c.keyword) < 0) {
        console.warn(`[wake] cue keyword missing from script — '${c.key}' will fire on safety net: "${c.keyword}"`);
      }
    }

    // Fire MUSIC instantly as briefing starts — no keyword, no wait.
    fireCue('music');

    // Build the panel-reveal schedule UPFRONT, before speech starts.
    // Critical: do NOT depend on audio.duration — the TTS layer reports 0
    // when audio.duration is Infinity (streaming MP3 blobs), which would
    // bail every timeupdate and force the safety net to fire everything at
    // the end. We use a fixed words-per-second estimate calibrated against
    // ElevenLabs Alice (British, speed 1.08) on this script.
    //
    // Two redundant trigger paths:
    //   1) wall-clock setTimeouts armed on the audio "play" event
    //   2) audio.currentTime crossings via onTimeUpdate
    // Whichever fires first per cue wins (firedCues set dedupes).
    const ALICE_WPS         = 3.0;   // measured ~3.0 w/s for Alice on this script
    const SENTENCE_PAUSE_S  = 0.28;  // measured pause budget per `.!?`
    const PRE_OFFSET_S      = 0.15;  // open panel ~150ms BEFORE the keyword
    type CueSchedule = { key: PanelKey; time: number };

    const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

    const schedule: CueSchedule[] = cues.map((cue) => {
      if (cue.keyword === null) return { key: cue.key, time: 0 };
      const idx = script.indexOf(cue.keyword);
      if (idx < 0) return { key: cue.key, time: Number.POSITIVE_INFINITY };
      const before = script.slice(0, idx);
      const wordsBefore = countWords(before);
      const sentencesBefore = (before.match(/[.!?]/g) ?? []).length;
      const t = wordsBefore / ALICE_WPS + sentencesBefore * SENTENCE_PAUSE_S - PRE_OFFSET_S;
      return { key: cue.key, time: Math.max(0, t) };
    });

    console.log(
      '[wake] cue schedule (upfront, no duration dep):',
      schedule.map((s) => `${s.key}@${isFinite(s.time) ? s.time.toFixed(2) + 's' : 'late'}`).join(', ')
    );

    // Wall-clock timeouts armed when speech actually starts playing.
    const timeoutIds: number[] = [];

    // Speak the whole briefing as a single pre-rendered clip.
    try {
      await precachePromise;
      await voice.speak(script, {
      voice: 'jarvis',
      onStart: () => {
        // Audio actually started playing — arm wall-clock timers from t=0.
        for (const cs of schedule) {
          if (cs.key === 'music') continue;        // already fired
          if (!isFinite(cs.time)) continue;        // keyword missing
          if (cs.time <= 0) { fireCue(cs.key); continue; }
          const id = window.setTimeout(() => {
            fireCue(cs.key);
          }, cs.time * 1000);
          timeoutIds.push(id);
        }
      },
      // NOTE: amplitude is published directly to ampBus (zero-latency ref
      // read) by the TTS layer. Do NOT wire it through the Zustand store —
      // that was firing a store update 60+Hz and causing every subscribed
      // component to re-check selectors, the #1 lag source in the app.
      onTimeUpdate: (currentTime) => {
        // Use audio currentTime as the more accurate trigger when available.
        // If audio is silent or stuck, the wall-clock timeouts above still fire.
        for (const cs of schedule) {
          if (firedCues.has(cs.key)) continue;
          if (isFinite(cs.time) && currentTime >= cs.time) fireCue(cs.key);
        }
      },
    });
    } finally {
      // Wake is over (or failed) — dispose the voice FX chain so repeated
      // wakes don't stack another chain on the shared AudioContext.
      voice.disposeChain();
    }

    // Speech ended — clear any pending timeouts (most have already fired).
    timeoutIds.forEach((id) => clearTimeout(id));

    // Safety net — anything still missing (e.g. keyword removed) fires now
    // so the layout is complete by ready phase.
    cues.forEach((c) => fireCue(c.key));

    // Done — final stinger. Music swells back to full after George finishes.
    impact({ level: 0.45 });
    duckWakeMusic(audioSession, CONFIG.musicLevel, 1800);  // unduck — restore to full
    swellWakeBed(audioSession, 0.22, 1200);
    setPhase('ready');
    setVoiceActive(false);
    setVoiceAmp(0);
    // Music keeps playing — no auto-stop. Track is the whole morning vibe.
  }, [setPhase, setVoiceAmp, setVoiceActive, revealPanel]);
}
