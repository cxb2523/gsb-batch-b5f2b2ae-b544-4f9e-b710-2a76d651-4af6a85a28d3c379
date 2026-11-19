// Source-level wiring pins (no jsdom/WebGL in this repo -- see
// webgl-context-loss.test.ts for the convention) for the camera/resolution
// convergence rules:
//
//   - new match: the renderer drops camera smoothing AND the adaptive
//     resolution governor's sampling window (Renderer.resetViewState),
//     called from init() and from NetMatch.startMatch (which can run on a
//     reused renderer after a requeue/resume);
//   - tab back from background: same reset, via a visibilitychange
//     listener the renderer registers in init() and removes in destroy(),
//     plus the app-layer spectator camera re-landing on its subject;
//   - play -> spectate (online): NetMatch's 'eliminated' handler resets
//     camera smoothing so the min-size follow recentres on the living
//     centroid instead of gliding from the dead local fighter.
//
// The behaviour itself is unit-tested where it is pure (camera.test.ts,
// min-fighter-size-floor.test.ts, adaptive-resolution.test.ts,
// spectator-camera-snap.test.ts); this file only pins that the
// DOM/Pixi-coupled call sites actually invoke it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderer = readFileSync(new URL('../../render/src/index.ts', import.meta.url), 'utf8');
const governor = readFileSync(new URL('../../render/src/adaptive-resolution.ts', import.meta.url), 'utf8');
const netMatch = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('Renderer.resetViewState resets camera smoothing, the frame clock, and the governor', () => {
  const start = renderer.indexOf('resetViewState(): void {');
  assert.ok(start !== -1, 'Renderer must expose resetViewState()');
  const body = renderer.slice(start, renderer.indexOf('\n  }', start));
  assert.match(body, /resetCameraSmoothing\(\)/);
  assert.match(body, /lastFrameTimeMs = null/);
  assert.match(body, /adaptiveResolution\.reset\(\)/);
});

test('Renderer.init resets view state and re-resets on every return to the foreground', () => {
  assert.match(renderer, /visibilitychange', this\.visibilityResetHandler/);
  const handler = renderer.slice(renderer.indexOf('visibilityResetHandler ='));
  assert.match(handler.slice(0, handler.indexOf('};')), /!document\.hidden/);
  assert.match(handler.slice(0, handler.indexOf('};')), /this\.resetViewState\(\)/);
});

test('Renderer.destroy removes the visibilitychange listener (no leak across attract-mode renderer cycles)', () => {
  const start = renderer.indexOf('destroy(): void {');
  const body = renderer.slice(start, start + 600);
  assert.match(body, /removeEventListener\('visibilitychange', this\.visibilityResetHandler\)/);
});

test('the governor exposes reset() and the renderer (not just a fresh constructor) can clear the window', () => {
  assert.match(governor, /reset\(\): void \{/);
});

test('NetMatch.startMatch resets view state so a requeued/resumed match starts fresh', () => {
  const start = netMatch.indexOf('private startMatch(');
  assert.ok(start !== -1);
  const body = netMatch.slice(start, start + 3000);
  assert.match(body, /this\.renderer\.resetViewState\(\)/);
});

test("NetMatch's eliminated handler resets camera smoothing on the play -> spectate cut", () => {
  const start = netMatch.indexOf("case 'eliminated':");
  assert.ok(start !== -1);
  const body = netMatch.slice(start, start + 1200);
  assert.match(body, /this\.spectating = true/);
  assert.match(body, /resetCameraSmoothing\(\)/);
});

test('main.ts re-lands the spectator camera when the tab comes back from the background', () => {
  assert.match(
    main,
    /addEventListener\('visibilitychange',[\s\S]{0,300}?spectator\?\.snapToNextTarget\(\)/,
  );
});
