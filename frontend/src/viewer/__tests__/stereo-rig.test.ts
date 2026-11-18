import { describe, expect, it } from 'vitest';

import {
  MAX_EYE_Z,
  TrackedEyeGuard,
  clampedBaseline,
  eyeViewports,
  planStereoRig,
  type EyeRig,
} from '../stereo-rig';
import { projectThroughEye, screenHalfExtents } from '../off-axis';

const CANVAS = { width: 1920, height: 1080 };
const ZERO_PARALLAX = 2.5;
// Half-angle subtended by a unit-half-height window at the zero-parallax
// distance. The clamp and the frustum must see the same screen height.
const FOV_FROM_WINDOW = 2 * Math.atan(1 / ZERO_PARALLAX) * 180 / Math.PI;

/** Project a point through an eye rig, reusing the off-axis module's NDC math. */
function project(rig: EyeRig, point: { x: number; y: number; z: number }) {
  return projectThroughEye(
    { offsetX: rig.offsetX, frustum: rig.frustum },
    point,
  )!;
}

function rigFor(overrides: {
  canvasWidth?: number;
  canvasHeight?: number;
  stereo?: boolean;
  baseline?: number;
  centre?: { x: number; y: number; z: number };
  windowHalfHeight?: number;
  fovYDeg?: number;
  clampPx?: number;
  compression?: number;
  near?: number;
  far?: number;
} = {}) {
  const stereo = overrides.stereo ?? true;
  const canvasWidth = overrides.canvasWidth ?? CANVAS.width;
  const canvasHeight = overrides.canvasHeight ?? CANVAS.height;
  const viewports = eyeViewports(canvasWidth, canvasHeight, stereo);
  const windowHalfHeight = overrides.windowHalfHeight ?? 1;
  // The vertical field of view is whatever angle the window subtends from the
  // eye plane, so the clamp's screen half extents match the frustum's exactly.
  const fovYDeg = overrides.fovYDeg
    ?? 2 * Math.atan(windowHalfHeight / ZERO_PARALLAX) * 180 / Math.PI;
  const near = overrides.near ?? 0.05;
  const far = overrides.far ?? 5000;
  const baseline = clampedBaseline({
    baseline: overrides.baseline ?? 0.12,
    compression: overrides.compression ?? 1,
    clampPx: overrides.clampPx ?? 0,
    eyeViewport: viewports.left,
    zeroParallaxDistance: ZERO_PARALLAX,
    fovYDeg,
  });
  const rig = planStereoRig({
    centre: overrides.centre ?? { x: 0.3, y: -0.2, z: ZERO_PARALLAX },
    stereo,
    baseline,
    windowHalfHeight,
    viewports,
    near,
    far,
  });
  return { rig, viewports, baseline, fovYDeg };
}

describe('eye viewports', () => {
  it('splits the buffer into two equal halves in side-by-side', () => {
    const { left, right } = eyeViewports(1920, 1080, true);
    expect(left.rect).toEqual({ x: 0, y: 0, z: 0.5, w: 1 });
    expect(right.rect).toEqual({ x: 0.5, y: 0, z: 0.5, w: 1 });
    expect(left.widthPx).toBe(960);
    expect(right.widthPx).toBe(960);
    expect(left.heightPx).toBe(1080);
    expect(right.heightPx).toBe(1080);
    expect(left.aspect).toBeCloseTo(960 / 1080, 12);
    // Both halves are identical, so one set of parameters serves both eyes.
    expect(left.aspect).toBe(right.aspect);
  });

  it('gives the single eye the whole buffer in mono', () => {
    const { left, right } = eyeViewports(1920, 1080, false);
    expect(left.rect).toEqual({ x: 0, y: 0, z: 1, w: 1 });
    expect(right.rect).toEqual({ x: 0, y: 0, z: 1, w: 1 });
    expect(left.widthPx).toBe(1920);
    expect(left.aspect).toBeCloseTo(1920 / 1080, 12);
  });

  it('never returns a zero or nonsensical size for a degenerate canvas', () => {
    const { left, right } = eyeViewports(0, 0, true);
    expect(left.widthPx).toBeGreaterThan(0);
    expect(left.heightPx).toBeGreaterThan(0);
    expect(Number.isFinite(left.aspect)).toBe(true);
    expect(right.widthPx).toBe(left.widthPx);
  });
});

describe('a normal stereo pair', () => {
  const { rig, baseline } = rigFor({ centre: { x: 0.3, y: -0.2, z: ZERO_PARALLAX } });

  it('places the eyes symmetrically about the head centre, horizontally only', () => {
    expect(rig.right.position.x - rig.left.position.x).toBeCloseTo(baseline, 12);
    expect(rig.left.position.x).toBeCloseTo(0.3 - baseline / 2, 12);
    expect(rig.right.position.x).toBeCloseTo(0.3 + baseline / 2, 12);
    // Depth and vertical position are shared: nothing toe-in-like happens.
    expect(rig.left.position.y).toBe(rig.right.position.y);
    expect(rig.left.position.z).toBe(rig.right.position.z);
  });

  it('gives both eyes exactly the same top and bottom', () => {
    expect(rig.left.frustum.top).toBe(rig.right.frustum.top);
    expect(rig.left.frustum.bottom).toBe(rig.right.frustum.bottom);
  });

  it('has no vertical disparity anywhere, including off-axis head positions', () => {
    for (const point of [
      { x: 1.1, y: 0.8, z: -6 },
      { x: -2.0, y: 1.3, z: -1.2 },
      { x: 0.4, y: -0.9, z: -40 },
      { x: 0, y: 0, z: -ZERO_PARALLAX },
    ]) {
      const l = project(rig.left, point);
      const r = project(rig.right, point);
      expect(r.y - l.y).toBe(0);
    }
  });

  it('puts zero horizontal disparity on the zero-parallax plane', () => {
    for (const point of [
      { x: 0.4, y: 0.3, z: -ZERO_PARALLAX },
      { x: -1.2, y: 0.7, z: -ZERO_PARALLAX },
      { x: 0, y: 0, z: -ZERO_PARALLAX },
    ]) {
      const l = project(rig.left, point);
      const r = project(rig.right, point);
      expect(r.x - l.x).toBeCloseTo(0, 12);
      expect(r.y - l.y).toBe(0);
    }
  });

  it('keeps the far field behind the screen and lets the near field pop out', () => {
    const far = project(rig.right, { x: 0, y: 0, z: -40 }).x
      - project(rig.left, { x: 0, y: 0, z: -40 }).x;
    const near = project(rig.right, { x: 0, y: 0, z: -0.5 }).x
      - project(rig.left, { x: 0, y: 0, z: -0.5 }).x;
    expect(far).toBeGreaterThan(0);
    expect(near).toBeLessThan(0);
  });

  it('uses the per-eye aspect for the shared screen half width', () => {
    const { halfWidth, halfHeight } = screenHalfExtents(
      ZERO_PARALLAX,
      2 * Math.atan(1 / ZERO_PARALLAX) * 180 / Math.PI,
      rig.left.viewport.aspect,
    );
    // The frustum's horizontal extent at the screen is the same half width for
    // both eyes, even though the eyes are displaced sideways.
    const scale = rig.left.frustum.near / ZERO_PARALLAX;
    const spanLeft = (rig.left.frustum.right - rig.left.frustum.left) / scale;
    const spanRight = (rig.right.frustum.right - rig.right.frustum.left) / scale;
    expect(spanLeft).toBeCloseTo(2 * halfWidth, 12);
    expect(spanRight).toBeCloseTo(2 * halfWidth, 12);
    expect(rig.left.frustum.top - rig.left.frustum.bottom)
      .toBeCloseTo(2 * halfHeight * scale, 12);
  });

  it('degrades to a single centred eye in mono', () => {
    const mono = rigFor({ stereo: false });
    expect(mono.rig.left.offsetX).toBe(0);
    expect(mono.rig.right.offsetX).toBe(0);
    expect(mono.rig.left.position).toEqual(mono.rig.right.position);
    expect(mono.rig.left.viewport.rect.z).toBe(1);
  });
});

describe('the pixel clamp when the window changes size', () => {
  it('binds tighter as the per-eye aspect narrows with the window height', () => {
    // A width-only resize keeps the baseline (the aspect cancels, so the cap in
    // pixels stays exactly right). A taller aspect -- from a shorter window at
    // the same width -- widens the virtual screen and relaxes the cap, so the
    // binding baseline moves the other way.
    const tall = rigFor({ canvasHeight: 1080, clampPx: 10, baseline: 0.12 });
    const short = rigFor({ canvasHeight: 400, clampPx: 10, baseline: 0.12 });
    expect(short.baseline).toBeGreaterThan(tall.baseline);
    expect(tall.baseline).toBeLessThan(0.12);
  });

  it('recomputes the clamp against the current eye viewport, never a stale size', () => {
    // A height change alters the per-eye aspect and therefore the virtual
    // screen's half width. A baseline capped for the tall canvas and reused on
    // the short one under-separates the far field; rebuilding from the live
    // viewport restores the intended cap. (A width-only resize needs no change:
    // the aspect and the pixel width scale together, so the baseline is
    // already invariant -- asserted in the test above.)
    const tall = rigFor({ canvasWidth: 1920, canvasHeight: 1080, clampPx: 10, baseline: 0.12 });
    const short = rigFor({ canvasWidth: 1920, canvasHeight: 540, clampPx: 10, baseline: 0.12 });
    const staleFarPx = (() => {
      const { halfWidth } = screenHalfExtents(
        ZERO_PARALLAX, short.fovYDeg, short.viewports.left.aspect);
      return (tall.baseline / halfWidth / 2) * short.viewports.left.widthPx;
    })();
    expect(staleFarPx).toBeCloseTo(5, 6); // half the cap: the defect the recompute avoids
    const liveL = project(short.rig.left, { x: 0, y: 0, z: -1e9 });
    const liveR = project(short.rig.right, { x: 0, y: 0, z: -1e9 });
    const liveFarPx = ((liveR.x - liveL.x) / 2) * short.viewports.left.widthPx;
    expect(liveFarPx).toBeCloseTo(10, 5);
  });

  it('holds the far-field separation at the cap in current pixels at any width', () => {
    for (const canvasWidth of [1920, 1200, 800]) {
      const { rig, viewports } = rigFor({ canvasWidth, clampPx: 10, baseline: 0.12 });
      const farL = project(rig.left, { x: 0, y: 0, z: -1e9 });
      const farR = project(rig.right, { x: 0, y: 0, z: -1e9 });
      const separationPx = ((farR.x - farL.x) / 2) * viewports.left.widthPx;
      // Points at effectively infinite distance reach the asymptotic
      // baseline/halfWidth limit exactly, which the cap pins to clampPx.
      expect(separationPx).toBeCloseTo(10, 5);
    }
  });

  it('does not cap near-field pop-out', () => {
    const clamped = rigFor({ clampPx: 10, baseline: 0.12 });
    const unclamped = rigFor({ clampPx: 0, baseline: 0.12 });
    const near = (r: typeof clamped) => project(r.rig.right, { x: 0, y: 0, z: -0.3 }).x
      - project(r.rig.left, { x: 0, y: 0, z: -0.3 }).x;
    // The clamp shrinks the far field baseline but a point close to the eye
    // still separates, and more strongly than anything in the background.
    expect(clamped.baseline).toBeLessThan(unclamped.baseline);
    expect(near(clamped)).toBeLessThan(0);
    expect(Math.abs(near(clamped))).toBeGreaterThan(
      Math.abs(project(clamped.rig.right, { x: 0, y: 0, z: -10000 }).x
        - project(clamped.rig.left, { x: 0, y: 0, z: -10000 }).x),
    );
  });

  it('leaves the baseline alone when the clamp is not binding', () => {
    const { baseline } = rigFor({ clampPx: 10000, baseline: 0.12 });
    expect(baseline).toBeCloseTo(0.12, 12);
  });
});

describe('the tracked eye guard', () => {
  it('accepts and returns a finite, in-front eye', () => {
    const guard = new TrackedEyeGuard();
    const result = guard.update({ x: 0.4, y: -0.1, z: 3 });
    expect(result?.fellBack).toBe(false);
    expect(result?.eye).toEqual({ x: 0.4, y: -0.1, z: 3 });
    expect(guard.current).toEqual({ x: 0.4, y: -0.1, z: 3 });
  });

  it('replays the last valid eye when a sample is non-finite', () => {
    const guard = new TrackedEyeGuard();
    guard.update({ x: 0.4, y: -0.1, z: 3 });
    for (const bad of [
      { x: Number.NaN, y: 0, z: 3 },
      { x: 0, y: Number.POSITIVE_INFINITY, z: 3 },
      { x: 0, y: 0, z: Number.NaN },
      null,
      undefined,
      { x: 1 },
    ]) {
      const result = guard.update(bad as never);
      expect(result?.fellBack).toBe(true);
      expect(result?.eye).toEqual({ x: 0.4, y: -0.1, z: 3 });
    }
  });

  it('rejects a non-positive distance and falls back rather than degenerating', () => {
    const guard = new TrackedEyeGuard();
    guard.update({ x: 0, y: 0, z: 3 });
    for (const z of [0, -2]) {
      const result = guard.update({ x: 0.2, y: 0.2, z });
      expect(result?.fellBack).toBe(true);
      expect(result?.eye.z).toBe(3);
    }
  });

  it('clamps an implausible finite distance instead of rejecting it', () => {
    const guard = new TrackedEyeGuard();
    const result = guard.update({ x: 0, y: 0, z: MAX_EYE_Z * 4 });
    expect(result?.fellBack).toBe(false);
    expect(result?.eye.z).toBe(MAX_EYE_Z);
  });

  it('returns null before any valid eye has been seen', () => {
    const guard = new TrackedEyeGuard();
    expect(guard.update({ x: Number.NaN, y: 0, z: 3 })).toBe(null);
    expect(guard.current).toBe(null);
  });

  it('can be reset to forget the fallback position', () => {
    const guard = new TrackedEyeGuard();
    guard.update({ x: 1, y: 1, z: 3 });
    guard.reset();
    expect(guard.current).toBe(null);
    expect(guard.update({ x: 0, y: 0, z: Number.NaN })).toBe(null);
    // A reset can seed a fresh neutral eye as well.
    guard.reset({ x: 0, y: 0, z: 2.5 });
    expect(guard.current).toEqual({ x: 0, y: 0, z: 2.5 });
  });
});

describe('idempotency under continuous updates', () => {
  it('rebuilds identical rigs for the same inputs, again and again', () => {
    const viewports = eyeViewports(1920, 1080, true);
    const baseline = clampedBaseline({
      baseline: 0.12,
      compression: 1,
      clampPx: 10,
      eyeViewport: viewports.left,
      zeroParallaxDistance: ZERO_PARALLAX,
      fovYDeg: FOV_FROM_WINDOW,
    });
    const input = {
      centre: { x: 0.3, y: -0.2, z: ZERO_PARALLAX },
      stereo: true,
      baseline,
      windowHalfHeight: 1,
      viewports,
      near: 0.05,
      far: 5000,
    };
    const first = planStereoRig(input);
    for (let i = 0; i < 50; i += 1) {
      const again = planStereoRig(input);
      expect(again).toEqual(first);
    }
  });

  it('alternating two window sizes never accumulates error', () => {
    const build = (width: number) => {
      const viewports = eyeViewports(width, 1080, true);
      const baseline = clampedBaseline({
        baseline: 0.12,
        compression: 1,
        clampPx: 10,
        eyeViewport: viewports.left,
        zeroParallaxDistance: ZERO_PARALLAX,
        fovYDeg: FOV_FROM_WINDOW,
      });
      return planStereoRig({
        centre: { x: 0.1, y: 0, z: ZERO_PARALLAX },
        stereo: true,
        baseline,
        windowHalfHeight: 1,
        viewports,
        near: 0.05,
        far: 5000,
      });
    };
    const wideSnapshot = JSON.stringify(build(1920));
    const narrowSnapshot = JSON.stringify(build(800));
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(build(1920))).toBe(wideSnapshot);
      expect(JSON.stringify(build(800))).toBe(narrowSnapshot);
    }
  });

  it('a run of invalid head samples leaves the stored eye untouched', () => {
    const guard = new TrackedEyeGuard();
    guard.update({ x: 0.25, y: -0.5, z: 4 });
    for (let i = 0; i < 100; i += 1) {
      guard.update({ x: Number.NaN, y: Number.NaN, z: Number.NaN });
    }
    expect(guard.current).toEqual({ x: 0.25, y: -0.5, z: 4 });
    // And the next valid sample is accepted cleanly.
    const recovered = guard.update({ x: -0.3, y: 0.1, z: 2 });
    expect(recovered?.fellBack).toBe(false);
    expect(recovered?.eye).toEqual({ x: -0.3, y: 0.1, z: 2 });
  });

  it('re-feeding the same head sample is a fixed point', () => {
    const guard = new TrackedEyeGuard();
    const first = guard.update({ x: 0.7, y: 0.2, z: 5 });
    for (let i = 0; i < 20; i += 1) {
      expect(guard.update({ x: 0.7, y: 0.2, z: 5 })).toEqual(first);
    }
  });
});
