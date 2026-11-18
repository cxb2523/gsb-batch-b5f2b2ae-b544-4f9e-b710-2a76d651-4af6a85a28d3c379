// Soundscape: the public audio API for the app. Owns the AudioContext, the
// master chain, the three section beds and the pool of positional voices.
//
// A mode change is one atomic state transition. setMode() first freezes the
// outgoing music and positional voices (their gain targets are set to fade out
// once and are never written again), takes them out of the active pool, and
// only then builds the new mode's music. The new mode's ambience duck and music
// level are applied on that same frame, without waiting for the next update().
// Retired voices are disposed after their fade has finished, never before the
// fade time constant, so no panner or music voice is left behind.

import { clamp, gainNode } from './dsp.ts';
import { createMaster } from './master.ts';
import { BEDS } from './beds.ts';
import { createVoice, VOICE_PANEL } from './voices.ts';
import { buildZones } from './zones.ts';
import { playCue } from './cues.ts';
import { MUSIC_BEDS } from './music.ts';
import type { Voice } from './dsp.ts';
import type { Master } from './master.ts';
import type { CueName } from './cues.ts';
import type { VoiceType } from './voices.ts';
import type { Zone } from './zones.ts';
import type { PanelId, Scene } from '../scene.ts';

export type SoundMode = 'nature' | 'period';
// The view the sound follows: centre in world px, CSS px per world px, screen size in CSS px.
export interface SoundView { cx: number; cy: number; scale: number; viewW: number; viewH: number; time: number }
// Where a voice sounds: a zone, or the dev harness's solo voice in the view centre.
type Source = Pick<Zone, 'id' | 'type' | 'panel' | 'x' | 'y' | 'r'> & { poiTitle?: string | null };
interface Bed { bed: Voice; fade: GainNode; music: Voice | null; musicFade: GainNode | null }
interface Active {
  zone: Source; voice: Voice; fade: GainNode; panner: StereoPannerNode;
  gain: number; pan: number; mode: SoundMode; dying: boolean;
}
// A voice that has left the active set but is still fading out. `releaseAt` is
// in AudioContext time and is never earlier than the fade time constant.
// Exported so tests can instrument the retired fades.
export interface Retired {
  voice: Voice; fade: GainNode; panner: StereoPannerNode | null;
  releaseAt: number; disposed: boolean; timer: ReturnType<typeof setTimeout> | null;
}
// Everything the mix needs for one view under the current mode.
interface Mix {
  weights: Record<PanelId, number>; duck: number;
  voiceMaster: number; bedMaster: number; musicMaster: number;
  tc: number;
}
// What a caller may inject; a live AudioContext is made on demand in start().
export interface SoundscapeOptions { ctx?: BaseAudioContext }

const MAX_VOICES = 12;
const MAX_PER_TYPE = 2;
const NEAR_FACTOR = 2.5;      // build voices within this many view radii
const LOOKAHEAD = 0.5;        // seconds of events scheduled ahead of the clock
const FADE_TC = 0.2;          // time constant: ~0.6 s to settle
const MODE_TC = 0.45;         // mode switch crossfade: ~1.5 s to settle
// A retired voice is disposed only once its fade has finished: at least this
// long after the release, and never before FADE_SETTLE_TC time constants. An
// exact zero is scheduled at releaseAt, so disposal cannot cut a tail.
const MUSIC_RELEASE_SEC = 2.0;
const VOICE_RELEASE_SEC = 0.9;
const FADE_SETTLE_TC = 4;    // a setTarget fade is below -30 dB after this many time constants
const MODES: SoundMode[] = ['nature', 'period'];
const SCALE_OVERVIEW = 0.006;
const SCALE_CLOSE = 0.1;

// Period balance, measured in the live app: the consort sits about 10 dB above the
// ambience, and both modes play at a similar overall loudness.
const MUSIC_LEVEL = 1.7;    // consort gain at the overview; 0.65 of it when zoomed into a scene
const AMBIENCE_DUCK = 0.6;  // ambience level while period music plays

export class Soundscape {
  scene: Scene;
  zones: Zone[];
  zoneById: Map<string, Zone>;
  ctx: BaseAudioContext | null; // made in start(), or injected (offline tests)
  master: Master | null; // made with ctx
  beds: Record<PanelId, Bed>;
  active: Map<string, Active>;
  retiring: Retired[];
  _mode: SoundMode;
  slowFadeUntil: number;
  focusId: string | null;
  soloType: VoiceType | null;
  muted: boolean;
  volume: number;
  bedWeights: Record<PanelId, number>;
  lastView: SoundView | null;
  lastMix: Mix;
  offline: boolean;   // the context was injected: no user gesture needed, no timers
  disposed: boolean;
  // When each retired voice was disposed, in AudioContext time: the dev harness
  // and the offline test check that music disposal never precedes its fade.
  disposeLog: { kind: 'music' | 'voice'; at: number }[];

  constructor(scene: Scene, options: SoundscapeOptions = {}) {
    this.scene = scene;
    this.zones = buildZones(scene);
    this.zoneById = new Map(this.zones.map((z) => [z.id, z]));
    this.ctx = options.ctx ?? null;
    this.offline = !!options.ctx;
    this.disposed = false;
    this.master = null;
    this.beds = {} as Record<PanelId, Bed>; // filled by start(), before anything reads it
    this.active = new Map(); // zone id -> { zone, voice, fade, panner, gain, pan, mode }
    this.retiring = []; // voices taken out of the active set, fading out until disposed
    this._mode = 'nature';
    this.slowFadeUntil = 0;
    this.focusId = null;
    this.soloType = null;
    this.muted = false;
    this.volume = 1;
    this.bedWeights = { eden: 0, garden: 0, hell: 0 };
    this.lastView = null;
    this.lastMix = this.mixFor(null);
    this.disposeLog = [];
  }

  get context(): AudioContext | null { return this.ctx as AudioContext | null; }

  // Update and cue may run when the context is live and running, or when it is
  // an OfflineAudioContext that is being rendered (its state is not 'running'
  // between suspend callbacks).
  get audible(): boolean {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return false;
    return this.offline ? ctx.state !== 'closed' : ctx.state === 'running';
  }

  async start(): Promise<void> {
    if (this.disposed) return; // torn down: make a new Soundscape instead
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    const ctx = this.ctx;
    if (!this.master) {
      this.master = createMaster(ctx);
      this.master.setVolume(this.volume);
      this.master.setMuted(this.muted);
      let seed = 101;
      for (const panel of Object.keys(BEDS) as PanelId[]) {
        const bed = BEDS[panel](ctx, seed++);
        const fade = gainNode(ctx, 0);
        bed.out.connect(fade).connect(this.master.sections[panel].bus);
        this.beds[panel] = { bed, fade, music: null, musicFade: null };
      }
    }
    if (this._mode === 'period') this.buildMusic();
    // An OfflineAudioContext starts suspended and only resumes while rendering;
    // only a live AudioContext is resumed here (it needs a user gesture).
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext && ctx.state !== 'running') await ctx.resume();
    if (this.lastView) this.update(this.lastView);
  }

  get mode(): SoundMode { return this._mode; }

  /**
   * 'nature': ambience only. 'period': ambience plus consort music. Crossfades
   * ~1.5 s. The switch is atomic: the old music and positional voices are
   * frozen and retired at once, and the new mode's duck and music level take
   * effect on this frame.
   */
  setMode(mode: SoundMode): void {
    if (!MODES.includes(mode) || mode === this._mode || this.disposed) return;
    this._mode = mode;
    const ctx = this.ctx;
    if (!ctx) {
      // no audio yet: remember the mode and report its levels, which start()
      // applies when the context is made
      this.mixFor(this.lastView);
      return;
    }
    const now = ctx.currentTime;
    this.slowFadeUntil = now + 1.5;
    // 1. Freeze the outgoing state before anything new exists, so no later
    //    update() can raise these gains again.
    this.retireMusic(now);
    this.retireVoices(now);
    // 2. Only the new mode builds music.
    if (mode === 'period') this.buildMusic();
    // 3. Apply the new mode's ambience duck and music level immediately.
    const mix = this.mixFor(this.lastView);
    this.applyBedMix(now, mix.tc, mix);
  }

  buildMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    let seed = 301;
    for (const [panel, b] of Object.entries(this.beds) as [PanelId, Bed][]) {
      if (b.music) continue;
      const voice = MUSIC_BEDS[panel](ctx, seed++);
      // each music instance owns its fade node: a retiring instance keeps its
      // own curve even if the mode switches back and a new consort is built
      const fade = gainNode(ctx, 0);
      fade.connect(this.master.sections[panel].bus);
      voice.out.connect(fade);
      b.music = voice;
      b.musicFade = fade;
    }
  }

  setMuted(m: boolean): void { this.muted = !!m; if (this.master) this.master.setMuted(this.muted); }
  setVolume(v: number): void { this.volume = clamp(v, 0, 1); if (this.master) this.master.setVolume(this.volume); }
  focus(poiId: string | null): void { this.focusId = poiId || null; }
  // Dev harness: play exactly one voice type, centred, beds off. null restores.
  solo(type: VoiceType | null): void { this.soloType = type || null; }

  cue(name: CueName, gain = 1): void {
    if (!this.master || !this.audible || gain <= 0) return;
    playCue(name, this.ctx!, this.master.sections.cue.bus, undefined, undefined, gain);
  }

  update(view: SoundView): void {
    this.lastView = view;
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.audible) return;
    const now = ctx.currentTime;
    this.pruneRetired(now);

    const { cx, cy, scale, viewW, viewH } = view;
    const mix = this.mixFor(view);
    const tc = mix.tc;
    const focusing = this.focusId != null;
    const voiceMaster = mix.voiceMaster;

    this.applyBedMix(now, tc, mix);

    // --- positional voices: only the current mode's voices are ever generated
    const viewR = 0.5 * Math.hypot(viewW, viewH) / scale;
    const wanted: { zone: Source; gain: number; pan: number; pinned?: boolean }[] = [];
    if (this.soloType) {
      wanted.push({ zone: { id: `solo-${this.soloType}`, type: this.soloType, panel: VOICE_PANEL[this.soloType] || 'garden', x: cx, y: cy, r: 1 }, gain: 1, pan: 0 });
    } else {
      const focusZone = focusing ? this.zoneForPoi(this.focusId!) : null;
      for (const zone of this.zones) {
        const d = Math.hypot(zone.x - cx, zone.y - cy);
        if (d > zone.r + NEAR_FACTOR * viewR && zone !== focusZone) continue;
        const rel = d / (zone.r + viewR);
        let g = rel < 1 ? zone.volume * Math.pow(1 - rel, 1.5) : 0;
        g *= voiceMaster;
        if (zone === focusZone) g = Math.max(g, 0.9);
        else if (focusing) g *= 0.7;
        if (g < 0.004) continue;
        const pan = clamp(((zone.x - cx) * scale) / (viewW * 0.6), -1, 1);
        wanted.push({ zone, gain: g, pan, pinned: zone === focusZone });
      }
      wanted.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.gain - a.gain));
      // neighbouring zones often share a voice type; two instances of one type is plenty
      const perType = new Map<VoiceType, number>();
      for (let i = 0; i < wanted.length;) {
        const n = perType.get(wanted[i].zone.type) || 0;
        if (n >= MAX_PER_TYPE && !wanted[i].pinned) wanted.splice(i, 1);
        else { perType.set(wanted[i].zone.type, n + 1); i++; }
      }
      wanted.length = Math.min(wanted.length, MAX_VOICES);
    }

    const keep = new Set<string>();
    for (const w of wanted) {
      keep.add(w.zone.id);
      let a = this.active.get(w.zone.id);
      if (!a || a.dying) {
        a = this.spawn(w.zone);
        a.gain = w.gain; a.pan = w.pan;
        // a new voice starts silent and rises into its first target
        a.fade.gain.setValueAtTime(0, now);
      }
      a.gain = w.gain; a.pan = w.pan;
      a.fade.gain.setTargetAtTime(w.gain, now, tc);
      a.panner.pan.setTargetAtTime(w.pan, now, 0.1);
    }
    for (const [id, a] of [...this.active]) {
      if (!keep.has(id)) this.release(id, a);
    }

    // --- lookahead scheduling of every running pattern: current voices only
    const until = now + LOOKAHEAD;
    for (const b of Object.values(this.beds)) {
      b.bed.schedule(until);
      if (b.music) b.music.schedule(until);
    }
    for (const a of this.active.values()) a.voice.schedule(until);
  }

  zoneForPoi(poiId: string): Zone | null {
    return this.zoneById.get(`poi-${poiId}`) || this.zones.find((z) => z.poiId === poiId) || null;
  }

  // The mix for a view under the current mode. Kept separate from update() so
  // setMode() can apply the new mode's levels without scheduling any voice.
  mixFor(view: SoundView | null): Mix {
    const period = this._mode === 'period';
    const duck = period ? AMBIENCE_DUCK : 1;
    const focusing = this.focusId != null;
    let z = 0;
    const weights = { eden: 0, garden: 0, hell: 0 } as Record<PanelId, number>;
    if (view) {
      // 0 at the whole-painting overview, 1 once zoomed into a scene
      z = clamp((Math.log(view.scale) - Math.log(SCALE_OVERVIEW)) / (Math.log(SCALE_CLOSE) - Math.log(SCALE_OVERVIEW)), 0, 1);
      const cx = view.cx, cy = view.cy;
      const halfW = view.viewW / (2 * view.scale);
      const x0 = cx - halfW, x1 = cx + halfW;
      let sum = 0;
      for (const p of this.scene.panels) {
        const overlap = Math.max(0, Math.min(x1, p.x1) - Math.max(x0, p.x0)) / (x1 - x0);
        const dCentre = cx < p.x0 ? p.x0 - cx : cx > p.x1 ? cx - p.x1 : 0;
        const centre = Math.max(0, 1 - dCentre / 12000);
        weights[p.id] = overlap + 0.6 * centre;
        sum += weights[p.id];
      }
      for (const p of this.scene.panels) {
        weights[p.id] = sum > 0 ? Math.sqrt(weights[p.id] / sum) : 0; // equal-power
      }
    }
    // In 'period' the consort leads: it plays well above the ambience, which ducks under it,
    // and it stays clearly present when zoomed into a scene.
    const voiceMaster = (0.12 + 0.88 * Math.pow(z, 0.8)) * duck;
    const bedMaster = (1 - 0.5 * z) * (focusing ? 0.65 : 1) * duck;
    const musicMaster = MUSIC_LEVEL * (1 - 0.35 * z) * (focusing ? 0.7 : 1);
    const now = this.ctx ? this.ctx.currentTime : 0;
    const tc = now < this.slowFadeUntil ? MODE_TC : FADE_TC;
    this.lastMix = { weights, duck, voiceMaster, bedMaster, musicMaster, tc };
    return this.lastMix;
  }

  // Levels of the mix currently in force, for verification in the dev harness.
  get mixLevels(): { duck: number; bedMaster: number; voiceMaster: number; musicMaster: number } {
    const m = this.lastMix;
    return { duck: m.duck, bedMaster: m.bedMaster, voiceMaster: m.voiceMaster, musicMaster: m.musicMaster };
  }

  // How many voices are still fading out and will be disposed, by kind.
  get pendingRelease(): { music: number; voices: number } {
    let music = 0, voices = 0;
    for (const r of this.retiring) { if (r.panner) voices++; else music++; }
    return { music, voices };
  }

  // Writes the current mix's bed and consort levels. Safe to call twice a frame.
  private applyBedMix(now: number, tc: number, mix: Mix): void {
    for (const p of this.scene.panels) {
      const w = mix.weights[p.id] ?? 0;
      this.bedWeights[p.id] = w;
    }
    if (!this.master) return;
    for (const p of this.scene.panels) {
      const b = this.beds[p.id];
      if (!b) continue;
      const w = mix.weights[p.id] ?? 0;
      b.fade.gain.setTargetAtTime(this.soloType ? 0 : w * mix.bedMaster, now, tc);
      if (b.music && b.musicFade) {
        b.musicFade.gain.setTargetAtTime(this.soloType ? 0 : w * mix.musicMaster, now, tc);
      }
    }
  }

  spawn(zone: Source): Active {
    const ctx = this.ctx!;
    const mode = this._mode;
    const voice = createVoice(zone.type, ctx, hashSeed(zone.id), { music: mode === 'period' });
    const fade = gainNode(ctx, 0);
    const panner = ctx.createStereoPanner();
    const bus = this.master!.sections[zone.panel]?.bus || this.master!.sections.garden.bus;
    voice.out.connect(fade).connect(panner).connect(bus);
    const a: Active = { zone, voice, fade, panner, gain: 0, pan: 0, mode, dying: false };
    this.active.set(zone.id, a);
    return a;
  }

  // Fade a voice out and schedule its disposal; it leaves the active pool now.
  release(id: string, a: Active, tc = FADE_TC, delaySec = VOICE_RELEASE_SEC): void {
    if (a.dying) return;
    if (this.active.get(id) === a) this.active.delete(id);
    this.retireVoice(a, this.ctx!.currentTime, tc, delaySec);
  }

  private retireVoices(now: number): void {
    for (const [id, a] of [...this.active]) {
      if (this.active.get(id) === a) this.active.delete(id);
      this.retireVoice(a, now, MODE_TC, VOICE_RELEASE_SEC);
    }
  }

  private retireVoice(a: Active, now: number, tc: number, delaySec: number): void {
    if (a.dying) return;
    a.dying = true;
    // Freeze the target: no later update() touches a retired voice's gain, so
    // this fade is the last word. The voice has already left the active pool.
    const releaseAt = now + Math.max(FADE_SETTLE_TC * tc, delaySec);
    a.fade.gain.setTargetAtTime(0, now, tc);
    a.fade.gain.setValueAtTime(0, releaseAt); // exact silence before disposal
    this.scheduleDispose({ voice: a.voice, fade: a.fade, panner: a.panner, releaseAt, disposed: false, timer: null });
  }

  // Only the current consort per panel exists in beds[].music. Switching away
  // moves it into the retired list with its own fade node and no further writes.
  private retireMusic(now: number): void {
    for (const b of Object.values(this.beds)) {
      const voice = b.music, fade = b.musicFade;
      if (!voice || !fade) continue;
      b.music = null;
      b.musicFade = null;
      const releaseAt = now + Math.max(FADE_SETTLE_TC * MODE_TC, MUSIC_RELEASE_SEC);
      fade.gain.setTargetAtTime(0, now, MODE_TC);
      fade.gain.setValueAtTime(0, releaseAt);
      this.scheduleDispose({ voice, fade, panner: null, releaseAt, disposed: false, timer: null });
    }
  }

  private scheduleDispose(r: Retired): void {
    this.retiring.push(r);
    if (this.offline) return; // OfflineAudioContext time advances only during rendering
    // A suspended (hidden) tab stops advancing currentTime, so poll rather than
    // trust one long timeout; pruneRetired() in update() also disposes it.
    const ctx = this.ctx!;
    const tick = () => {
      r.timer = null;
      if (r.disposed) return;
      if (ctx.currentTime >= r.releaseAt - 1e-3) { this.disposeRetired(r); return; }
      r.timer = setTimeout(tick, Math.max(100, Math.min(1000, (r.releaseAt - ctx.currentTime) * 1000 + 30)));
    };
    r.timer = setTimeout(tick, Math.max(100, Math.min(1000, (r.releaseAt - ctx.currentTime) * 1000 + 30)));
  }

  private pruneRetired(now: number): void {
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      const r = this.retiring[i];
      if (now >= r.releaseAt - 1e-3) this.disposeRetired(r);
    }
  }

  private disposeRetired(r: Retired): void {
    if (r.disposed) return;
    r.disposed = true;
    if (r.timer !== null) { clearTimeout(r.timer); r.timer = null; }
    const i = this.retiring.indexOf(r);
    if (i >= 0) this.retiring.splice(i, 1);
    this.disposeLog.push({ kind: r.panner ? 'voice' : 'music', at: this.ctx ? this.ctx.currentTime : 0 });
    if (this.disposeLog.length > 200) this.disposeLog.splice(0, this.disposeLog.length - 200);
    r.voice.dispose();
    try { r.fade.disconnect(); } catch { /* detached */ }
    if (r.panner) { try { r.panner.disconnect(); } catch { /* detached */ } }
  }

  // Teardown: stop every voice, including retired ones. A torn-down Soundscape
  // cannot be restarted; make a new one instead.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of [...this.retiring]) this.disposeRetired(r);
    for (const [id, a] of [...this.active]) {
      if (this.active.get(id) === a) this.active.delete(id);
      a.dying = true;
      a.voice.dispose();
      try { a.fade.disconnect(); } catch { /* detached */ }
      try { a.panner.disconnect(); } catch { /* detached */ }
    }
    for (const b of Object.values(this.beds)) {
      b.music?.dispose();
      b.bed.dispose();
      try { b.fade.disconnect(); } catch { /* detached */ }
      if (b.musicFade) { try { b.musicFade.disconnect(); } catch { /* detached */ } }
      b.music = null;
      b.musicFade = null;
    }
    this.master?.dispose();
    this.master = null;
  }

  // Snapshot for the dev harness. Every voice in the pool belongs to the
  // current mode: setMode() retires the old ones before any new one is built.
  get activeVoices() {
    return [...this.active.values()].map((a) => ({ id: a.zone.id, type: a.zone.type, title: a.zone.poiTitle, gain: a.gain, pan: a.pan }));
  }

  // The mode each active voice was spawned for, by zone id (a verification aid:
  // after a switch to nature every entry is 'nature').
  get activeModes(): Record<string, SoundMode> {
    const out: Record<string, SoundMode> = {};
    for (const [id, a] of this.active) out[id] = a.mode;
    return out;
  }
}

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
