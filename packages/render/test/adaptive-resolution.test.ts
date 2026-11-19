// Regression tests for the frame-time-driven adaptive resolution
// governor added 2026-09-21 (see wiki: Real Player Measurements
// 2026-09-14 -- 82% of real sessions are touch, p95 71ms, and the
// static MAX_RESOLUTION clamp cannot help a phone still too slow at
// resolution 2). Pure module, no DOM/Pixi -- see adaptive-resolution.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolutionGovernor } from '../src/adaptive-resolution.ts';

function feed(gov: AdaptiveResolutionGovernor, ms: number, times: number): void {
  for (let i = 0; i < times; i++) gov.sample(ms);
}

test('downgrades once after 120 sustained slow frames (p95 > 45ms)', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  assert.equal(gov.resolution, 2);
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1.5);
  assert.equal(gov.downgrades, 1);
});

test('does not downgrade again inside the 180-sample cooldown', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.downgrades, 1);
  // still slow, but within cooldown of the first downgrade
  feed(gov, 60, 150);
  assert.equal(gov.downgrades, 1);
  assert.equal(gov.resolution, 1.5);
});

test('downgrades a second time once the cooldown has fully elapsed', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.downgrades, 1);
  feed(gov, 60, 180);
  feed(gov, 60, 120);
  assert.equal(gov.downgrades, 2);
  assert.equal(gov.resolution, 1);
});

test('upgrades one level after 240 sustained fast frames (p95 < 22ms)', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1.5);
  feed(gov, 10, 240);
  assert.equal(gov.resolution, 2);
  assert.equal(gov.upgrades, 1);
});

test('never upgrades more than twice in a session', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120); // -> 1.5
  feed(gov, 300, 180); // cooldown elapses without tripping upgrade (bogus-free but slow-ish? use fast below)
  feed(gov, 60, 120); // -> 1, downgrade #2
  feed(gov, 10, 240); // -> 1.5, upgrade #1
  feed(gov, 10, 240); // -> 2, upgrade #2 (already at device cap, should be no-op)
  assert.ok(gov.upgrades <= 2);
  assert.equal(gov.resolution, 2);
});

test('never goes below resolution 1', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 500, 120);
  feed(gov, 500, 180);
  feed(gov, 500, 120);
  feed(gov, 500, 500);
  assert.equal(gov.resolution, 1);
});

test('never goes above the device initial resolution', () => {
  const gov = new AdaptiveResolutionGovernor(1);
  feed(gov, 5, 1000);
  assert.equal(gov.resolution, 1);
  assert.equal(gov.upgrades, 0);
});

test('a device initial resolution below 2 caps the starting step accordingly', () => {
  const gov = new AdaptiveResolutionGovernor(1.5);
  assert.equal(gov.resolution, 1.5);
});

test('bogus samples (<=0ms or >2000ms) are ignored, not counted', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 0, 500);
  feed(gov, -5, 500);
  feed(gov, 5000, 500);
  assert.equal(gov.resolution, 2);
  assert.equal(gov.downgrades, 0);
});

// reset() exists for discontinuous context changes -- a new match
// starting, or the tab coming back from the background (a sub-2000ms
// background gap is not bogus-filtered and would otherwise sit in the
// window as one giant frame). The new context must be measured fresh:
// last match's jank must not pre-emptively downshift this one's opening.
test('reset() discards the sampling window and restores the device initial resolution', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1.5);
  gov.reset();
  assert.equal(gov.resolution, 2);
  // The old slow frames are gone: a whole fresh window must fill before
  // any downgrade -- 119 slow frames alone are not enough.
  feed(gov, 60, 119);
  assert.equal(gov.resolution, 2);
  gov.sample(60);
  assert.equal(gov.resolution, 1.5);
});

test('reset() restarts the downgrade/upgrade counters and cooldowns', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  feed(gov, 60, 180);
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1);
  assert.equal(gov.downgrades, 2);
  gov.reset();
  assert.equal(gov.downgrades, 0);
  assert.equal(gov.upgrades, 0);
  // A fresh governor would downgrade here -- and so does the reset one.
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1.5);
  assert.equal(gov.downgrades, 1);
});

test('an upgrade re-arms the downgrade cooldown, so the governor cannot seesaw', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120); // -> 1.5
  feed(gov, 10, 240); // -> 2 (upgrade)
  assert.equal(gov.resolution, 2);
  // Frames go slow again right after the upgrade: without the re-armed
  // cooldown this would downshift back within 120 frames of the upgrade,
  // which is exactly the down-up-down flicker this guards against.
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 2);
  assert.equal(gov.downgrades, 1);
  // Once the cooldown has fully elapsed the governor may still react.
  feed(gov, 60, 180);
  assert.equal(gov.resolution, 1.5);
});
