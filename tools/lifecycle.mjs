#!/usr/bin/env node
// Scene lifecycle / bake-cache synchronisation checks.
//
//   node tools/lifecycle.mjs [--quick]
//
// Covers the acceptance contract:
//   1. normal playback across scene seams never shows a blank panel
//   2. a quick jump far away (scene unloaded, bakes dropped) and back rebuilds
//      the scene correctly — identical pixels to a never-unloaded render
//   3. a scene being rendered/prepared is never unloaded and never evicted by
//      the LRU budget, even when a giant new bake pushes the total over budget
//   4. after a long play-through the bake memory stays bounded (LRU + unload)
//   5. retention tokens are always released once the frame is done
import crypto from 'node:crypto';
import { startServer } from './server.mjs';
import { launch, openPage, CHROME } from './lib/browser.mjs';
import { parseArgs } from './lib/args.mjs';
import * as TL from '../src/beat/timeline.js';

const a = parseArgs(process.argv.slice(2));
let failed = false;
const fail = (m) => { failed = true; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);
const section = (m) => console.log('\n' + m);

if (!CHROME) { console.error('Chrome not found (set CHROME_PATH)'); process.exit(1); }
const srv = await startServer(0);
const { browser, close } = await launch();
let page;
try {
  ({ page } = await openPage(browser, `${srv.url}/film.html`));
} catch (e) {
  console.error('failed to open page:', e);
  await close(); await srv.close(); process.exit(1);
}

/**
 * Render film time t and report lifecycle state. drawStory skips panels that are
 * not prepared, so `missing` (visible but not initialised) is exactly the
 * blank-panel condition this fix targets.
 */
const renderState = (t) => page.evaluate(async (tt) => {
  const res = await window.renderAt(tt);
  const film = window.film, TL = window.TL;
  const cam = film.camera(Math.min(tt, TL.OUTRO_START));
  const vis = tt < TL.OUTRO_START ? film.visibleStory(cam) : [];
  return {
    t: tt,
    error: res.error,
    visible: vis,
    missing: vis.filter((j) => !film.inited.has(j)),
    inited: [...film.inited].sort((x, y) => x - y),
    bakeBytes: window.K.bakeBytes(),
    bakeCount: window.K.bakeCount(),
    retained: window.film.retained.length,
  };
}, t);

/** Pixel hash of the canvas for time t (same screenshot path as tools/check.mjs). */
const renderHash = async (t) => {
  await page.evaluate((tt) => window.renderAt(tt), t);
  const buf = await page.screenshot({ type: 'png' });
  return crypto.createHash('sha1').update(buf).digest('hex');
};

const sceneTime = (i, u) => TL.sceneStart(i) + u;

// ---------------------------------------------------------------- 1. seam playback
section('1. normal playback across scene seams — no blank panels, no errors');
let blankFrames = 0, errorFrames = 0, retainedLeaks = 0;
const seamTimes = [];
for (let i = 0; i < TL.N_SCENES; i++) {
  for (const u of [5.9, 5.95, 6.0, 6.05]) {
    const t = sceneTime(i, u);
    if (t < TL.OUTRO_START) seamTimes.push(+t.toFixed(4));
  }
}
// one-frame-at-a-time stepping across the opening scenes
const stepEnd = TL.FPS * (a.quick ? 6 : 12);
for (let f = 0; f <= stepEnd; f++) seamTimes.push(+(f / TL.FPS).toFixed(4));
const seen = new Set();
for (const t of seamTimes) {
  if (seen.has(t)) continue;
  seen.add(t);
  const r = await renderState(t);
  if (r.error) { errorFrames++; if (errorFrames <= 3) fail(`t=${t} render error: ${r.error}`); }
  if (r.missing.length) { blankFrames++; if (blankFrames <= 3) fail(`t=${t} visible panel(s) not prepared: ${r.missing.join(',')}`); }
  if (r.retained !== 0) { retainedLeaks++; fail(`t=${t} retention leaked (${r.retained} prefixes held after draw)`); }
}
if (!blankFrames && !errorFrames) ok(`${seen.size} seam/step frames: every visible panel prepared, no scene errors`);
if (!retainedLeaks) ok('every frame released its bake retentions');

// ------------------------------------------------- 2. far jump away and back rebuild
section('2. jump far away and back — unloaded scenes rebuild pixel-identically');
const probes = a.quick ? [0, 9, 19] : [0, 4, 9, 14, 19];
const rounds = a.quick ? 2 : 3;
const baseline = new Map();
for (const i of probes) baseline.set(i, await renderHash(sceneTime(i, 3)));
for (let round = 0; round < rounds; round++) {
  // jump to the far end: every probe scene is > 3 panels away and gets unloaded
  await renderState(sceneTime(19, 1));
  for (const i of probes) {
    const before = await page.evaluate((idx) => {
      const f = window.film;
      return { inited: f.inited.has(idx), bake: window.K.hasBakePrefix(f.scenes[idx].id) };
    }, i);
    if (before.inited || before.bake) fail(`scene ${i + 1} still resident after far jump (inited=${before.inited}, bake=${before.bake})`);
    const backHash = await renderHash(sceneTime(i, 3));
    if (backHash !== baseline.get(i)) fail(`scene ${i + 1} rebuilt differently on return (round ${round + 1})`);
    const state = await renderState(sceneTime(i, 3));
    if (state.error) fail(`scene ${i + 1} errored after rebuild: ${state.error}`);
    if (state.missing.length) fail(`scene ${i + 1} blank after rebuild (missing panels ${state.missing.join(',')})`);
  }
}
ok('unloaded scenes rebuilt with identical pixels on every return');

// scrub back from the far end to the start (the reported stutter/flicker path)
let scrubBlanks = 0;
const far = Math.round(sceneTime(19, 0.5) * TL.FPS);
const scrubStride = TL.FPS * (a.quick ? 2 : 1);             // 1 s steps (2 s in quick)
for (let f = far; f >= 0; f -= scrubStride) {
  const r = await renderState(f / TL.FPS);
  if (r.error || r.missing.length) { scrubBlanks++; fail(`back-scrub frame ${f} broken (error=${r.error}, missing=${r.missing.join(',')})`); }
}
if (!scrubBlanks) ok('back-scrub from scene 20 to the preface never blanks');

// --------------------------------------- 3. rendered/queued scenes cannot be dropped
section('3. in-use scenes are protected from unload and LRU eviction');
const protect = await page.evaluate(async () => {
  const film = window.film, K = window.K, TL = window.TL;
  const out = { checks: [] };
  const t = TL.sceneStart(5) + 3;
  // begin the frame exactly like renderAt does, then inspect between prepare and draw
  await film.prepare(t);
  const vis = film.visibleStory(film.camera(t));
  const active = vis.filter((j) => j >= 0);
  out.active = active;
  for (const j of active) {
    const id = film.scenes[j].id;
    out.checks.push({ j, retained: K.bakeRetained(id), inited: film.inited.has(j), bake: K.hasBakePrefix(id) });
  }
  // unloadFar with the real keep-set must not touch any active panel
  const ci = TL.sceneIndexAt(t);
  film.unloadFar(ci, film.framePanels(t, vis));
  out.afterUnload = active.map((j) => ({ j, inited: film.inited.has(j), bake: K.hasBakePrefix(film.scenes[j].id) }));
  // raw dropBakes on an active prefix must be refused while retained
  const target = film.scenes[active[0]].id;
  K.dropBakes(target);
  out.dropRefused = K.hasBakePrefix(target);
  // Force a genuine budget overflow. The probe prefix is itself retained so its
  // framebuffers survive eviction; active scene bakes must survive as well.
  K._state.scenePrefix = '__lifecycle_probe__';
  K.retainBakes('__lifecycle_probe__');
  for (let k = 0; k < 100; k++) K.bake('giant' + k, 2048, 2048, () => {});   // 100 × 16 MB ≈ 1.6 GB
  out.overBudgetBytes = K.bakeBytes();
  out.activeSurvivedEviction = active.map((j) => ({ j, bake: K.hasBakePrefix(film.scenes[j].id) }));
  // finish the frame exactly as app.js does: draw() paints, then releases retention
  film.draw(t);
  out.retainedAfterDraw = film.retained.length;
  K.releaseBakes('__lifecycle_probe__');
  // with the frame done and the probe unretained, its bakes must be droppable
  K.dropBakes('__lifecycle_probe__');
  out.probeDroppedAfterFrame = !K.hasBakePrefix('__lifecycle_probe__');
  out.bytesAfterCleanup = K.bakeBytes();
  return out;
});
let protectBad = 0;
for (const c of protect.checks) if (!c.retained || !c.inited || !c.bake) { protectBad++; fail(`panel ${c.j + 1} not protected during prepare (${JSON.stringify(c)})`); }
for (const c of protect.afterUnload) if (!c.inited || !c.bake) { protectBad++; fail(`panel ${c.j + 1} unloaded while queued for render`); }
if (!protectBad) ok(`panels ${protect.active.map((j) => j + 1).join(',')} retained, initialised and baked through prepare`);
if (protect.dropRefused) ok('dropBakes() refuses a prefix retained for the current frame');
else fail('dropBakes() removed an in-use bake cache');
if (protect.overBudgetBytes > 1400 * 1024 * 1024) ok(`budget was genuinely exceeded (${(protect.overBudgetBytes / 1048576).toFixed(0)} MB)`);
else fail(`probe did not exceed budget (${(protect.overBudgetBytes / 1048576).toFixed(0)} MB)`);
const evictedActive = protect.activeSurvivedEviction.filter((c) => !c.bake).length;
if (!evictedActive) ok('LRU eviction under overflow removed no active scene bake');
else fail(`${evictedActive} active scene bakes were evicted under budget pressure`);
if (protect.retainedAfterDraw === 0) ok('retention released after draw()');
else fail(`retention leaked after draw (${protect.retainedAfterDraw})`);
if (protect.probeDroppedAfterFrame && protect.bytesAfterCleanup < protect.overBudgetBytes) {
  ok(`unretained probe bakes dropped after the frame (${(protect.overBudgetBytes / 1048576).toFixed(0)} → ${(protect.bytesAfterCleanup / 1048576).toFixed(0)} MB)`);
} else fail('unretained bakes could not be reclaimed after the frame');

// ----------------------------------------------- 4. long play-through stays bounded
section('4. long playback — resident scenes and bake bytes stay bounded');
const peak = { inited: 0, bytes: 0 };
let last = null;
const step = Math.round(TL.FPS / 2);                       // twice a second
const endFrame = Math.round((TL.OUTRO_START - 2) * TL.FPS);
for (let f = 0; f < endFrame; f += step) {
  last = await renderState(f / TL.FPS);
  peak.inited = Math.max(peak.inited, last.inited.length);
  peak.bytes = Math.max(peak.bytes, last.bakeBytes);
}
if (peak.inited <= 10) ok(`at most ${peak.inited} scenes resident at once (distance window + look-ahead)`);
else fail(`resident scene count grew to ${peak.inited}`);
if (peak.bytes <= 1400 * 1024 * 1024) ok(`bake peak ${(peak.bytes / 1048576).toFixed(0)} MB within the 1400 MB budget`);
else fail(`bake peak ${(peak.bytes / 1048576).toFixed(0)} MB exceeded budget`);

// repeated full sweeps must not accumulate
const sweepStartBytes = last.bakeBytes;
for (let sweep = 0; sweep < 2; sweep++) {
  for (let f = 0; f < endFrame; f += step * 4) await renderState(f / TL.FPS);
}
const afterSweeps = await renderState(TL.OUTRO_START - 3);
if (afterSweeps.bakeBytes <= 1400 * 1024 * 1024 && afterSweeps.inited.length <= 10) {
  ok(`repeated sweeps stay bounded (${(afterSweeps.bakeBytes / 1048576).toFixed(0)} MB, ${afterSweeps.inited.length} scenes; sweep start ${(sweepStartBytes / 1048576).toFixed(0)} MB)`);
} else fail(`repeated sweeps accumulated (${afterSweeps.bakeBytes} bytes, ${afterSweeps.inited.length} scenes)`);

// ---------------------------------------------------------------- 5. summary
section('result');
await close();
await srv.close();
console.log(failed ? 'LIFECYCLE CHECK FAILED' : 'LIFECYCLE CHECK PASSED');
process.exit(failed ? 1 : 0);
