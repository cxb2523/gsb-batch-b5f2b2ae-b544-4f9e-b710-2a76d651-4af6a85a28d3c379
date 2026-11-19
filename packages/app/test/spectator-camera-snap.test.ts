// Unit tests for the spectator camera's snap-on-subject-change behaviour
// (SpectatorController). The camera eases frame to frame while the
// subject is stable, but a discontinuous subject change -- entering
// spectate, TAB-cycling to another survivor, toggling overview, or the
// tab coming back from the background -- must land on the new target
// immediately, not glide over from the old one. Pure module, no DOM:
// the MatchAdapter is duck-typed here (same convention as
// sim-adapter.test.ts).
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
// The controller's overview mode goes through the render package's
// module-level camera smoothing; start every test from a clean one.
import { resetCameraSmoothing } from '@bash-fighter/render';
import { SpectatorController } from '../src/spectator/controller.ts';
import type { MatchAdapter } from '../src/spectator/types.ts';

const LOCAL_SLOT = 0;
const ARENA = { minX: -600, maxX: 600, minY: 0, maxY: 300 };
// Matches main.ts's construction: a static arena-centre guess made at
// match start, long before anyone is spectating.
const INITIAL_VIEW = { centerX: 0, centerY: 150, scale: 3 };
const FOLLOW_SCALE = 4.5;
const FOLLOW_VERTICAL_OFFSET = 8;

beforeEach(() => {
  resetCameraSmoothing();
});

function makeAdapter(survivors: number[]): MatchAdapter {
  return {
    fighterCount: 20,
    update(): void {},
    status(index: number) {
      return {
        eliminated: !survivors.includes(index),
        eliminationTick: null,
        placement: null,
        koCount: 0,
      };
    },
    survivorIndices(): number[] {
      return [...survivors];
    },
    liveArenaBounds(): null {
      return null;
    },
    isMatchOver(): boolean {
      return false;
    },
  };
}

/** Positions indexed like the sim: survivor 1 far left, 2 far right,
 *  3 dead centre -- far enough apart that any glide between them would
 *  be plainly visible. */
const POSITIONS = Array.from({ length: 20 }, (_, i) => {
  if (i === 1) return { x: -300, y: 10 };
  if (i === 2) return { x: 300, y: 10 };
  return { x: 0, y: 10 };
});

function frameInput(dtSeconds = 1 / 60) {
  return {
    positions: POSITIONS,
    viewWidth: 1280,
    viewHeight: 720,
    arena: ARENA,
    dtSeconds,
  };
}

function followTarget(index: number) {
  const p = POSITIONS[index]!;
  return { centerX: p.x, centerY: p.y + FOLLOW_VERTICAL_OFFSET, scale: FOLLOW_SCALE };
}

test('entering spectate lands on the first follow target immediately, not on the stale initial view', () => {
  const controller = new SpectatorController(makeAdapter([1, 2, 3]), LOCAL_SLOT, INITIAL_VIEW);
  controller.activate();
  const view = controller.update(frameInput());
  const target = followTarget(1);
  assert.equal(view.centerX, target.centerX);
  assert.equal(view.centerY, target.centerY);
  assert.equal(view.scale, target.scale);
});

test('TAB-cycling to another survivor snaps straight to them', () => {
  const controller = new SpectatorController(makeAdapter([1, 2, 3]), LOCAL_SLOT, INITIAL_VIEW);
  controller.activate();
  controller.update(frameInput()); // landed on survivor 1
  controller.cycleNext();
  assert.equal(controller.followedIndex, 2);
  const view = controller.update(frameInput());
  const target = followTarget(2);
  assert.equal(view.centerX, target.centerX);
  assert.equal(view.centerY, target.centerY);
  assert.equal(view.scale, target.scale);
});

test('a stable subject still eases frame to frame -- the snap must not become a per-frame hard cut', () => {
  const controller = new SpectatorController(makeAdapter([1, 2, 3]), LOCAL_SLOT, INITIAL_VIEW);
  controller.activate();
  const before = controller.update(frameInput());
  // The followed fighter moves a little; the camera must glide, not jump.
  POSITIONS[1] = { x: -280, y: 10 };
  const after = controller.update(frameInput());
  assert.ok(after.centerX > before.centerX, 'camera should move toward the moved fighter');
  assert.ok(
    after.centerX < -280 + 1,
    `camera should still be catching up (centerX=${after.centerX}), not hard-cut onto the fighter`,
  );
  POSITIONS[1] = { x: -300, y: 10 };
});

test('snapToNextTarget (tab back from background) re-lands on the current subject', () => {
  const controller = new SpectatorController(makeAdapter([1, 2, 3]), LOCAL_SLOT, INITIAL_VIEW);
  controller.activate();
  controller.update(frameInput());
  // While hidden, the followed fighter drifted far away.
  POSITIONS[1] = { x: 250, y: 10 };
  controller.snapToNextTarget();
  const view = controller.update(frameInput());
  assert.equal(view.centerX, 250);
  assert.equal(view.centerY, 10 + FOLLOW_VERTICAL_OFFSET);
  POSITIONS[1] = { x: -300, y: 10 };
});

test('toggling overview snaps to the overview framing instead of gliding from the follow target', () => {
  const controller = new SpectatorController(makeAdapter([1, 2, 3]), LOCAL_SLOT, INITIAL_VIEW);
  controller.activate();
  controller.update(frameInput()); // landed on survivor 1 at x=-300
  controller.toggleOverview();
  const view = controller.update(frameInput());
  // The overview frames every survivor; it must not still sit on the
  // follow target (x=-300, tight scale).
  assert.notEqual(view.scale, FOLLOW_SCALE);
  const halfW = 1280 / 2 / view.scale;
  assert.ok(view.centerX - halfW <= -300 + 1e-6, 'overview must include the leftmost survivor');
  assert.ok(view.centerX + halfW >= 300 - 1e-6, 'overview must include the rightmost survivor');
});
