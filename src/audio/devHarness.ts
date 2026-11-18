// Dev harness for dev/audio.html: a map of the triptych with the sound zones,
// a draggable virtual view centre, zoom slider, voice solo list, cue buttons,
// focus select and the offline render test.

import { Soundscape } from './soundscape.ts';
import { VOICE_NAMES, VOICE_PANEL } from './voices.ts';
import { runOfflineTest } from './offlineTest.ts';
import type { SwitchRow, TestRow } from './offlineTest.ts';
import type { CueName } from './cues.ts';
import type { SoundMode } from './soundscape.ts';
import type { VoiceType } from './voices.ts';
import type { PanelId, Scene } from '../scene.ts';

type Row = TestRow | SwitchRow;

declare global {
  interface Window {
    __soundscape?: Soundscape;
    __audioTest?: { rows: Row[]; summary: string; done: boolean };
    // live mode-switch probe: switches, steps the mix by hand and reports
    __soundscapeSwitch?: () => Promise<SwitchReport>;
  }
}

interface SwitchReport {
  pass: boolean;
  notes: string[];
}

// every element the harness looks up is in dev/audio.html
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | EventListener> = {}, ...kids: (Node | string)[]) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v as string;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v as EventListener);
    else n.setAttribute(k, v as string);
  }
  for (const k of kids) n.append(k);
  return n;
};

const PANEL_COLOR: Record<PanelId, string> = { eden: '#5fae6a', garden: '#d8b74a', hell: '#c75b4a' };
const VIEW_W = 1280, VIEW_H = 800;
const SCALE_MIN = 0.006, SCALE_MAX = 2.0;

async function main() {
  const scene: Scene = await (await fetch(`${import.meta.env.BASE_URL}data/scene.json`)).json();
  const sc = new Soundscape(scene);
  window.__soundscape = sc;

  const view = { cx: 78000, cy: 44000, scale: 0.006, viewW: VIEW_W, viewH: VIEW_H, time: 0 };
  const W = scene.world.w, H = scene.world.h;
  const canvas = $<HTMLCanvasElement>('#map');
  const k = canvas.width / W;
  canvas.height = Math.round(H * k);
  const g2 = canvas.getContext('2d')!;

  function draw() {
    g2.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of scene.panels) {
      g2.fillStyle = PANEL_COLOR[p.id] + '22';
      g2.fillRect(p.x0 * k, p.y0 * k, (p.x1 - p.x0) * k, (p.y1 - p.y0) * k);
      g2.strokeStyle = PANEL_COLOR[p.id];
      g2.strokeRect(p.x0 * k, p.y0 * k, (p.x1 - p.x0) * k, (p.y1 - p.y0) * k);
    }
    const active = new Set(sc.activeVoices.map((a) => a.id));
    for (const z of sc.zones) {
      g2.beginPath();
      g2.arc(z.x * k, z.y * k, Math.max(2, z.r * k), 0, Math.PI * 2);
      const on = active.has(z.id);
      g2.fillStyle = on ? PANEL_COLOR[z.panel] + '66' : (z.source === 'poi' ? '#ffffff10' : PANEL_COLOR[z.panel] + '18');
      g2.fill();
      g2.strokeStyle = on ? '#fff' : (z.source === 'poi' ? '#ffffff55' : PANEL_COLOR[z.panel] + '88');
      g2.lineWidth = on ? 1.5 : 0.6;
      g2.stroke();
    }
    g2.lineWidth = 1;
    // view rectangle
    const vw = view.viewW / view.scale, vh = view.viewH / view.scale;
    g2.strokeStyle = '#7fd3ff';
    g2.lineWidth = 1.5;
    g2.strokeRect((view.cx - vw / 2) * k, (view.cy - vh / 2) * k, vw * k, vh * k);
    g2.fillStyle = '#7fd3ff';
    g2.beginPath(); g2.arc(view.cx * k, view.cy * k, 3, 0, Math.PI * 2); g2.fill();
    g2.lineWidth = 1;
  }

  let dragging = false;
  const setCentre = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    view.cx = ((ev.clientX - r.left) / r.width) * W;
    view.cy = ((ev.clientY - r.top) / r.height) * H;
  };
  canvas.addEventListener('pointerdown', (e) => { dragging = true; setCentre(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) setCentre(e); });
  window.addEventListener('pointerup', () => { dragging = false; });

  const zoom = $<HTMLInputElement>('#zoom');
  const zoomToScale = (v: number) => Math.exp(Math.log(SCALE_MIN) + (Math.log(SCALE_MAX) - Math.log(SCALE_MIN)) * v);
  zoom.addEventListener('input', () => { view.scale = zoomToScale(+zoom.value); $('#zoomVal').textContent = view.scale.toFixed(4); });
  view.scale = zoomToScale(+zoom.value);
  $('#zoomVal').textContent = view.scale.toFixed(4);

  $('#start').addEventListener('click', async () => { await sc.start(); $('#start').textContent = 'Audio running'; });
  $('#mute').addEventListener('change', (e) => sc.setMuted((e.target as HTMLInputElement).checked));
  $('#mode').addEventListener('change', (e) => {
    sc.setMode((e.target as HTMLSelectElement).value as SoundMode);
    // the switch is atomic: report the levels it applied, before any update()
    const lv = sc.mixLevels, pr = sc.pendingRelease;
    console.log(`mode ${sc.mode}: duck ${lv.duck.toFixed(2)}, music ${lv.musicMaster.toFixed(2)}, `
      + `${sc.activeVoices.length} active voices, retiring ${pr.music} music / ${pr.voices} voices`);
    renderActive();
  });
  sc.setMode($<HTMLSelectElement>('#mode').value as SoundMode);
  $('#volume').addEventListener('input', (e) => sc.setVolume(+(e.target as HTMLInputElement).value));
  for (const name of ['open', 'poi', 'tour', 'thunder', 'close'] satisfies CueName[]) {
    $('#cues').append(el('button', { onclick: () => sc.cue(name) }, name));
  }
  const focusSel = $<HTMLSelectElement>('#focus');
  focusSel.append(el('option', { value: '' }, '(no focus)'));
  for (const p of [...scene.pois].sort((a, b) => a.title.localeCompare(b.title))) {
    focusSel.append(el('option', { value: p.id }, `${p.title} [${p.panel}]`));
  }
  focusSel.addEventListener('change', () => {
    sc.focus(focusSel.value || null);
    const poi = scene.pois.find((p) => p.id === focusSel.value);
    if (poi && $<HTMLInputElement>('#jump').checked) { view.cx = poi.x; view.cy = poi.y; }
  });

  // voice list with solo buttons
  const list = $('#voices');
  let soloed: VoiceType | null = null;
  const soloButtons = new Map<VoiceType, HTMLElement>();
  for (const name of VOICE_NAMES) {
    const btn = el('button', { class: 'solo', onclick: () => {
      soloed = soloed === name ? null : name;
      sc.solo(soloed);
      for (const [n, b] of soloButtons) b.classList.toggle('on', n === soloed);
    } }, 'solo');
    soloButtons.set(name, btn);
    const count = sc.zones.filter((z) => z.type === name).length;
    list.append(el('li', { style: `border-left: 3px solid ${PANEL_COLOR[VOICE_PANEL[name]]}` }, btn, el('span', { class: 'name' }, name), el('span', { class: 'dim' }, ` ${count} zones`)));
  }

  function renderActive() {
    const modes = sc.activeModes;
    const act = sc.activeVoices.sort((a, b) => b.gain - a.gain);
    $('#active').replaceChildren(...act.map((a) => el('li', {},
      el('span', { class: 'name' }, a.type), ` ${a.title ? a.title : a.id} `,
      el('span', { class: 'dim' }, `g ${a.gain.toFixed(2)} pan ${a.pan.toFixed(2)} [${modes[a.id]}]`))));
    const bw = sc.bedWeights;
    const lv = sc.mixLevels;
    const pr = sc.pendingRelease;
    $('#beds').textContent = `mode ${sc.mode} | duck ${lv.duck.toFixed(2)} music ${lv.musicMaster.toFixed(2)} | beds eden ${bw.eden.toFixed(2)} garden ${bw.garden.toFixed(2)} hell ${bw.hell.toFixed(2)}  | voices ${act.length}  | retiring music ${pr.music} voices ${pr.voices} | ctx ${sc.context ? sc.context.state : 'none'}`;
  }

  let frames = 0;
  function loop(t: number) {
    view.time = t / 1000;
    sc.update(view);
    if (frames++ % 6 === 0) { draw(); renderActive(); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // --- offline test
  async function runTest() {
    const out = $('#testOut');
    out.replaceChildren(el('p', {}, 'Rendering...'));
    const table = el('table', {}, el('thead', {}, el('tr', {}, ...['kind', 'name', 'mode', 's', 'peak dBFS', 'RMS dBFS', 'raw peak', 'raw RMS', 'music gens', 'NaN', 'pass'].map((h) => el('th', {}, h)))));
    const body = el('tbody');
    table.append(body);
    out.replaceChildren(table);
    const rows = await runOfflineTest({
      scene,
      onRow: (r) => body.append(el('tr', { class: r.pass ? 'pass' : 'fail' },
        el('td', {}, r.kind), el('td', {}, r.name), el('td', {}, r.mode), el('td', {}, String(r.seconds)), el('td', {}, String(r.peakDb)), el('td', {}, String(r.rmsDb)), el('td', {}, String(r.rawPeakDb)), el('td', {}, String(r.rawRmsDb)), el('td', {}, String(r.musicBuilt)), el('td', {}, String(r.nan)), el('td', {}, String(r.pass ? 'PASS' : 'FAIL')))),
    });
    const failed = rows.filter((r) => !r.pass);
    const summary = `offline test: ${rows.length - failed.length}/${rows.length} pass` + (failed.length ? ` FAILED: ${failed.map((r) => r.name).join(', ')}` : '');
    out.append(el('p', { id: 'testSummary', class: failed.length ? 'fail' : 'pass' }, summary));
    // the mode-switch row's own measurements, one line each
    const sw = rows.find((r) => r.kind === 'switch');
    if (sw && sw.kind === 'switch') {
      out.append(el('p', { class: 'dim' }, 'mode switch:'), el('ul', { class: 'notes' }, ...sw.notes.map((n) => el('li', { class: 'dim' }, n))));
    }
    console.table(rows);
    console.log(summary);
    window.__audioTest = { rows, summary, done: true };
  }
  $('#runTest').addEventListener('click', runTest);
  if (new URLSearchParams(location.search).has('test')) runTest();

  // --- live mode-switch probe
  // Drives the Soundscape through nature -> period -> nature on the live context,
  // stepping the mix by hand between switches, and checks that the retired
  // voices are frozen and only the new mode's voices are generated. Disposal
  // timing is measured by the offline render, where sample offsets are exact.
  const activeWithMode = () => sc.activeVoices.map((a) => ({ ...a, mode: sc.activeModes[a.id] }));
  const consortCount = () => Object.values(sc.beds).filter((b) => b.music).length;

  async function probeSwitch(): Promise<SwitchReport> {
    const notes: string[] = [];
    let pass = true;
    await sc.start();
    sc.setMode('nature');
    view.time = 0;
    sc.update(view);
    const oldIds = sc.activeVoices.map((a) => a.id);
    notes.push(`nature: ${oldIds.length} active voices (${oldIds.join(', ') || 'none'}), ${consortCount()} consorts`);
    if (oldIds.length === 0 || consortCount() !== 0) pass = false;

    const duckNature = sc.mixLevels.duck;
    sc.setMode('period');
    // no update() yet: the period duck, music level and consorts must be in force now
    notes.push(`setMode(period), before any update: duck ${duckNature.toFixed(2)} -> ${sc.mixLevels.duck.toFixed(2)}, `
      + `music ${sc.mixLevels.musicMaster.toFixed(2)}, ${consortCount()} consorts, `
      + `${sc.pendingRelease.voices} voices / ${sc.pendingRelease.music} music retiring`);
    if (duckNature !== 1 || sc.mixLevels.duck !== 0.6) pass = false;
    if (consortCount() !== 3) pass = false;
    if (sc.pendingRelease.voices !== oldIds.length) pass = false;
    if (sc.activeVoices.length !== 0) pass = false; // the old voices left the pool at once

    sc.update(view);
    if (sc.activeVoices.length === 0 || activeWithMode().some((a) => a.mode !== 'period')) pass = false;
    notes.push(`period after one update: ${sc.activeVoices.length} voices (${sc.activeVoices.map((a) => a.id).join(', ')})`);

    sc.setMode('nature');
    if (sc.mixLevels.duck !== 1) pass = false;
    if (consortCount() !== 0) pass = false;
    if (sc.pendingRelease.music !== 3) pass = false;
    sc.update(view);
    if (activeWithMode().some((a) => a.mode !== 'nature')) pass = false;

    // rapid toggles: no stale voice may survive in activeVoices
    for (const m of ['period', 'nature', 'period', 'nature'] as SoundMode[]) { sc.setMode(m); sc.update(view); }
    const stale = activeWithMode().filter((a) => a.mode !== 'nature');
    if (stale.length) { pass = false; notes.push(`stale after rapid toggles: ${stale.map((a) => `${a.id}[${a.mode}]`).join(', ')}`); }
    notes.push(`after rapid toggles: ${sc.activeVoices.length} active, ${consortCount()} consorts, `
      + `${sc.pendingRelease.music} music / ${sc.pendingRelease.voices} voices retiring`);

    // Disposal happens after the fade, never before it. Measure in audio-clock
    // seconds, not wall time: a headless or background tab runs the clock slower.
    const ctx = sc.context;
    const switchAt = ctx ? ctx.currentTime : 0;
    let musicDelay = -1;
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      sc.update(view);
      await new Promise((r) => setTimeout(r, 50));
      const music = sc.disposeLog.filter((e) => e.kind === 'music' && e.at >= switchAt);
      if (musicDelay < 0 && music.length) musicDelay = music[0].at - switchAt;
      if (sc.pendingRelease.music === 0 && sc.pendingRelease.voices === 0) break;
    }
    const elapsed = ctx ? ctx.currentTime - switchAt : 0;
    notes.push(`after ${elapsed.toFixed(2)} s of audio: retired music disposed at `
      + `${musicDelay >= 0 ? `+${musicDelay.toFixed(2)} s` : 'never'}, `
      + `${sc.pendingRelease.music} music / ${sc.pendingRelease.voices} voices still retiring`);
    if (musicDelay < 0) pass = false;
    if (musicDelay >= 0 && musicDelay < 0.45) pass = false; // earlier than MODE_TC, the music fade's time constant
    if (sc.pendingRelease.voices > 0) pass = false;
    if (sc.pendingRelease.music > 0) pass = false;
    return { pass, notes };
  }
  window.__soundscapeSwitch = probeSwitch;
  $('#runSwitch').addEventListener('click', async () => {
    const out = $('#switchOut');
    out.replaceChildren(el('p', {}, 'Switching...'));
    const r = await probeSwitch();
    out.replaceChildren(
      el('p', { class: r.pass ? 'pass' : 'fail' }, `live mode switch: ${r.pass ? 'PASS' : 'FAIL'}`),
      el('ul', {}, ...r.notes.map((n) => el('li', { class: 'dim' }, n))),
    );
  });
}

main().catch((e) => { console.error(e); document.body.append(el('pre', { class: 'fail' }, String(e.stack || e))); });
