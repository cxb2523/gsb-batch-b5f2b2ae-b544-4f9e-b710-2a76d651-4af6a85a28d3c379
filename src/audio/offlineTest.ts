// Offline render test: every voice type and bed in both modes, plus every cue,
// rendered through the real master chain in an OfflineAudioContext and
// measured for peak and RMS. 'nature' renders also assert that no music
// generator was instantiated (music.ts counts them). A final "mode switch"
// render drives a real Soundscape through nature -> period -> nature at fixed
// sample offsets and checks the atomicity guarantees. Used by dev/audio.html.

import { createMaster } from './master.ts';
import { BEDS } from './beds.ts';
import { MUSIC_BEDS, musicStats } from './music.ts';
import { createVoice, VOICE_NAMES, VOICE_PANEL } from './voices.ts';
import { CUES, playCue } from './cues.ts';
import { Soundscape } from './soundscape.ts';
import { dB } from './dsp.ts';
import type { Voice } from './dsp.ts';
import type { CueName } from './cues.ts';
import type { Section } from './master.ts';
import type { VoiceType } from './voices.ts';
import type { Retired, SoundView } from './soundscape.ts';
import type { PanelId, Scene } from '../scene.ts';

// One render: a voice or a bed in a mode, or a cue ('-').
export type TestItem = { mode: string; seconds: number } & (
  { kind: 'voice'; name: VoiceType } | { kind: 'bed'; name: PanelId } | { kind: 'cue'; name: CueName }
);
export type TestRow = Awaited<ReturnType<typeof renderItem>>;

// The mode-switch render's own row: not a voice/bed/cue, but the same shape.
export interface SwitchRow {
  kind: 'switch'; name: string; mode: string; seconds: number;
  peakDb: number; rmsDb: number; rawPeakDb: number; rawRmsDb: number;
  musicBuilt: number; nan: boolean; pass: boolean;
  notes: string[]; // measurements behind the verdict, shown in the dev harness
}

export function testItems(): TestItem[] {
  const items: TestItem[] = [];
  for (const mode of ['nature', 'period']) {
    for (const name of VOICE_NAMES) items.push({ kind: 'voice', name, mode, seconds: 4 });
    for (const name of Object.keys(BEDS) as PanelId[]) items.push({ kind: 'bed', name, mode, seconds: mode === 'period' ? 8 : 4 });
  }
  for (const name of Object.keys(CUES) as CueName[]) items.push({ kind: 'cue', name, mode: '-', seconds: 4 });
  return items;
}

function measure(buffer: AudioBuffer): { peak: number; rms: number; nan: boolean } {
  let peak = 0, sum = 0, nan = false, n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (x !== x) { nan = true; continue; }
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
      sum += x * x;
      n++;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), nan };
}

// raw=true bypasses the master chain so the source level itself can be read.
async function renderOnce(item: TestItem, sampleRate: number, raw: boolean) {
  const seconds = item.seconds;
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * sampleRate), sampleRate);
  const master = raw ? null : createMaster(ctx);
  const dest = (section: Section) => (raw ? ctx.destination : master!.sections[section].bus);
  const music = item.mode === 'period';
  const before = musicStats.instantiated;
  const voices: Voice[] = [];
  if (item.kind === 'voice') {
    const v = createVoice(item.name, ctx, 1, { music });
    v.out.connect(dest(VOICE_PANEL[item.name]));
    voices.push(v);
  } else if (item.kind === 'bed') {
    // the period bed is the nature bed plus the consort, as the Soundscape mixes them
    const v = BEDS[item.name](ctx, 2);
    v.out.connect(dest(item.name));
    voices.push(v);
    if (music) {
      const m = MUSIC_BEDS[item.name](ctx, 3);
      const g = ctx.createGain();
      g.gain.value = 0.55; // musicMaster at the overview
      m.out.connect(g).connect(dest(item.name));
      voices.push(m);
    }
  } else {
    playCue(item.name, ctx, dest('cue'), 0.05);
  }
  const musicBuilt = musicStats.instantiated - before;
  // advance patterns in lookahead-sized steps, as the live update loop does
  for (let t = 0.5; t <= seconds + 0.5; t += 0.5) for (const v of voices) v.schedule(t);
  const buffer = await ctx.startRendering();
  for (const v of voices) v.dispose();
  return { ...measure(buffer), musicBuilt };
}

export async function renderItem(item: TestItem, { sampleRate = 44100 } = {}) {
  const m = await renderOnce(item, sampleRate, false);
  const r = await renderOnce(item, sampleRate, true);
  const peakDb = dB(m.peak), rmsDb = dB(m.rms);
  const natureClean = item.mode !== 'nature' || m.musicBuilt === 0;
  return {
    kind: item.kind, name: item.name, mode: item.mode, seconds: item.seconds,
    peakDb: +peakDb.toFixed(1), rmsDb: +rmsDb.toFixed(1),
    rawPeakDb: +dB(r.peak).toFixed(1), rawRmsDb: +dB(r.rms).toFixed(1),
    musicBuilt: m.musicBuilt, nan: m.nan || r.nan,
    pass: !m.nan && !r.nan && rmsDb > -60 && peakDb < -1 && natureClean,
  };
}

export async function runOfflineTest(opts: { sampleRate?: number; onRow?: (row: TestRow | SwitchRow, n: number, total: number) => void; scene?: Scene } = {}): Promise<(TestRow | SwitchRow)[]> {
  const rows: (TestRow | SwitchRow)[] = [];
  const items = testItems();
  const total = items.length + 1;
  for (const item of items) {
    const row = await renderItem(item, opts);
    rows.push(row);
    if (opts.onRow) opts.onRow(row, rows.length, total);
  }
  const last = await renderModeSwitch(opts.scene ?? switchScene(), opts.sampleRate ?? 44100);
  rows.push(last);
  if (opts.onRow) opts.onRow(last, rows.length, total);
  return rows;
}

// --- mode switch -------------------------------------------------------------

// The scene the switch render uses by default: a few zones of one voice type
// per panel, close together, so a view centred between them keeps three voices
// alive at once.
export function switchScene(): Scene {
  const panels: PanelId[] = ['eden', 'garden', 'hell'];
  return {
    world: { w: 30000, h: 10000 },
    panels: panels.map((id, i) => ({ id, name: id, x0: i * 10000, x1: (i + 1) * 10000, y0: 0, y1: 10000 })),
    pois: [],
    poas: panels.flatMap((panel, i) => [0, 1, 2].map((k) => ({
      i: i * 3 + k, x: i * 10000 + 3000 + k * 2000, y: 5000, r: 2500, volume: 1, panel,
    }))),
  };
}

// One scheduled callback at an exact context time: OfflineAudioContext clips
// gain automation to sample boundaries, so the offsets below are sample-exact.
function atSample(ctx: OfflineAudioContext, sample: number, fn: () => void): void {
  void ctx.suspend(sample / ctx.sampleRate).then(() => { fn(); return ctx.resume(); });
}

export async function renderModeSwitch(scene: Scene = switchScene(), sampleRate = 44100): Promise<SwitchRow> {
  const notes: string[] = [];
  const seconds = 6;
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * sampleRate), sampleRate);
  const sc = new Soundscape(scene, { ctx });
  await sc.start();
  const view = (time: number): SoundView => ({ cx: 15000, cy: 5000, scale: 0.05, viewW: 1280, viewH: 800, time });
  const at = (t: number) => Math.round(t * sampleRate);

  let musicBuiltNature = 0, musicBuiltPeriod = 0;
  let freezeOk = true, disposedOk = true, disposeOrderOk = true, respawnOk = true;
  let frozenWrites = 0; // writes to a retired fade after it was retired: must stay 0
  const RETIRED_AT = 1.0; // the first switch back to nature, in context seconds

  // Watches retired voices' fades: any gain write after retirement means an
  // update (or a spawn) failed to leave the frozen voice alone. Called after
  // each switch, so music and positional fades are both covered.
  const watched = new WeakSet<Retired>();
  const watchFrozen = () => {
    for (const r of sc.retiring) {
      if (watched.has(r)) continue;
      watched.add(r);
      const p = r.fade.gain;
      const setTarget = p.setTargetAtTime.bind(p);
      p.setTargetAtTime = (...args: Parameters<AudioParam['setTargetAtTime']>) => { frozenWrites++; return setTarget(...args); };
    }
  };

  // nature at t=0: update() builds the positional voices, and no music at all.
  const beforeNature = musicStats.instantiated;
  atSample(ctx, 1, () => { sc.update(view(0)); musicBuiltNature = musicStats.instantiated - beforeNature; });
  let oldIds: string[] = [];
  let retiredVoices = 0;

  atSample(ctx, at(0.25), () => {
    oldIds = sc.activeVoices.map((a) => a.id);
    notes.push(`nature ${oldIds.length} voices: ${oldIds.join(', ') || 'none'}`);
    if (Object.values(sc.activeModes).some((m) => m !== 'nature')) freezeOk = false;
    if (oldIds.length === 0) freezeOk = false;
    // the update just before the switch is the last write to the old voices' fades
    sc.update(view(0.24));
    const beforeMusic = musicStats.instantiated;
    sc.setMode('period');
    watchFrozen(); // the retired voices' fades are watched from here on
    musicBuiltPeriod = musicStats.instantiated - beforeMusic;
    // the new mode's duck takes effect in setMode, not in the next update
    if (sc.mixLevels.duck !== 0.6) freezeOk = false;
    retiredVoices = sc.pendingRelease.voices;
    if (retiredVoices !== oldIds.length) freezeOk = false;
    if (sc.activeVoices.length !== 0) freezeOk = false; // the old voices left the pool at once
  });

  // a frame right after the switch: the old voices are gone and not respawned
  // as old-mode voices; only period voices may be active.
  atSample(ctx, at(0.26), () => {
    sc.update(view(0.26));
    if (Object.values(sc.activeModes).some((m) => m !== 'period')) respawnOk = false;
    if (sc.activeVoices.length === 0) notes.push('period spawned no positional voices');
    // retired voices are disposed neither instantly nor before their fade
    if (sc.pendingRelease.voices !== retiredVoices) disposedOk = false;
  });

  // back to nature well before the retired period consorts would be disposed
  let musicRetired = 0;
  atSample(ctx, at(RETIRED_AT), () => {
    sc.update(view(RETIRED_AT));
    const before = musicStats.instantiated;
    sc.setMode('nature');
    watchFrozen(); // music fades and the period voices are watched from here on
    if (musicStats.instantiated !== before) freezeOk = false; // no music may be built on the way back
    if (sc.mixLevels.duck !== 1) freezeOk = false;            // unduck on the same frame
    if (sc.pendingRelease.music < 1) freezeOk = false;        // the period consort was retired at once
    musicRetired = sc.pendingRelease.music;
    if (Object.values(sc.beds).some((b) => b.music)) freezeOk = false; // and left the beds at once
  });
  atSample(ctx, at(1.05), () => {
    sc.update(view(1.05));
    if (Object.values(sc.activeModes).some((m) => m !== 'nature')) respawnOk = false;
  });

  // midway through the music fade: updates must neither revive the retired
  // music (nothing may re-enter the beds) nor dispose it before the fade ends.
  atSample(ctx, at(1.6), () => {
    sc.update(view(1.6));
    if (Object.values(sc.beds).some((b) => b.music)) freezeOk = false;
    if (sc.disposeLog.some((e) => e.kind === 'music')) disposeOrderOk = false;
    if (sc.pendingRelease.music !== musicRetired) freezeOk = false;
    // no update may write a retired voice's gain: that is how a fade gets reset
    if (frozenWrites !== 0) { freezeOk = false; notes.push(`retired fades written ${frozenWrites} times`); }
  });

  // rapid toggling: period -> nature -> period -> nature, under a second, while
  // the first consorts are still fading and the first voices still retiring.
  atSample(ctx, at(2.6), () => { sc.update(view(2.6)); sc.setMode('period'); });
  atSample(ctx, at(2.8), () => { sc.update(view(2.8)); sc.setMode('nature'); });
  atSample(ctx, at(3.0), () => { sc.update(view(3.0)); sc.setMode('period'); });
  atSample(ctx, at(3.2), () => { sc.update(view(3.2)); sc.setMode('nature'); });
  atSample(ctx, at(3.4), () => {
    sc.update(view(3.4));
    if (Object.values(sc.activeModes).some((m) => m !== 'nature')) respawnOk = false;
    // across the whole rapid sequence, no retired fade may have been written
    if (frozenWrites !== 0) { freezeOk = false; notes.push(`retired fades written ${frozenWrites} times`); }
    notes.push(`after rapid toggles: ${sc.activeVoices.length} active (${sc.activeVoices.map((a) => a.id).join(', ') || 'none'}), `
      + `${sc.pendingRelease.music} music / ${sc.pendingRelease.voices} voices retiring`);
  });

  // by the end of the render every retired voice must have been disposed, and
  // only after its fade: no disposal before the switch that retired it, and no
  // music disposal within MODE_TC of it.
  atSample(ctx, at(5.9), () => {
    sc.update(view(5.9)); // the final frame is what prunes everything left retiring
    const music = sc.disposeLog.filter((e) => e.kind === 'music');
    const voices = sc.disposeLog.filter((e) => e.kind === 'voice');
    if (music.length === 0) disposedOk = false;   // the period consorts were eventually disposed
    if (voices.length === 0) disposedOk = false;
    if (music.some((e) => e.at < RETIRED_AT + 0.45)) disposeOrderOk = false;
    if (sc.pendingRelease.music > 0 || sc.pendingRelease.voices > 0) disposedOk = false;
    notes.push(`${music.length} music / ${voices.length} voices disposed, last at ${sc.disposeLog.length ? sc.disposeLog[sc.disposeLog.length - 1].at.toFixed(2) : '-'} s`);
    sc.dispose();
  });

  const buffer = await ctx.startRendering();
  const m = measure(buffer);
  const peakDb = dB(m.peak), rmsDb = dB(m.rms);
  const musicClean = musicBuiltNature === 0;
  const pass = !m.nan && rmsDb > -60 && peakDb < -1 && musicClean
    && musicBuiltPeriod > 0 && freezeOk && respawnOk && disposedOk && disposeOrderOk;
  // the switch row also has to meet the same level bar as every other row
  notes.push(`pass: nan ${m.nan}, rms ${rmsDb.toFixed(1)} dB, peak ${peakDb.toFixed(1)} dB, `
    + `nature music ${musicBuiltNature}, freeze ${freezeOk}, respawn ${respawnOk}, dispose ${disposedOk}, order ${disposeOrderOk}`);
  notes.unshift(`nature built ${musicBuiltNature} music gens, first period built ${musicBuiltPeriod}`);
  return {
    kind: 'switch', name: 'mode switch', mode: 'nature->period->nature', seconds,
    peakDb: +peakDb.toFixed(1), rmsDb: +rmsDb.toFixed(1), rawPeakDb: +peakDb.toFixed(1), rawRmsDb: +rmsDb.toFixed(1),
    musicBuilt: musicBuiltNature, nan: m.nan, pass, notes,
  };
}
