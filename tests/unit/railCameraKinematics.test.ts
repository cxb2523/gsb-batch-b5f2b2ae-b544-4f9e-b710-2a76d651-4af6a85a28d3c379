/**
 * Deterministic acceptance suite for rail-mounted camera kinematics.
 *
 * Verifies the post-refactor contract for physical camera rigs:
 *   1. Straight (`track`) and curved (`spline_track`) rails: the eye point is
 *      decided exclusively by eased rail progress (not by live target motion),
 *      and orientation is reverse-solved from the eye -> target sightline.
 *   2. Eyeball pitch / yaw / distance are derived from the sightline and authored
 *      degrade scalars are ignored in target-tracking mode.
 *   3. Rail sampling progress follows shot easing.
 *   4. Continuous boundaries inherit the previous shot's terminal eye AND heading;
 *      non-continuous boundaries still hard-cut.
 *   5. Missing endpoints (start-only track, single-point / empty spline) fall back
 *      deterministically without NaN.
 *   6. The rendered rail polyline coincides with the live eye at every timestamp.
 */

import { describe, expect, it } from 'vitest';
import { parseStageScore } from '../../src/core/scoreParser';
import { computeStageFrame } from '../../src/core/frameEngine';
import { evaluateCameraEasing } from '../../src/core/maneuvers';
import { radToDeg, sphericalToCartesian } from '../../src/core/sphericalMath';
import { evaluateRigEyePosition } from '../../src/core/cameraRigEvaluator';
import type { StageScore } from '../../src/core/types';

function expectFinitePose(score: StageScore, t: number): void {
  const frame = computeStageFrame(t, score);
  const { position, target, pose } = frame.stageCamera.transform;
  for (const v of [position, target]) {
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(Number.isFinite(v.z)).toBe(true);
  }
  expect(Number.isFinite(pose.pitch)).toBe(true);
  expect(Number.isFinite(pose.yaw)).toBe(true);
  expect(Number.isFinite(pose.distance)).toBe(true);
}

/** Finds the rig spec backing a shot id (stage camera cues only). */
function findRigSpec(score: StageScore, shotId: string) {
  const shot = score.shots.find((s) => s.id === shotId);
  return shot?.stageCamera?.rig;
}

/**
 * Asserts the live eye matches the rail evaluator at the current eased progress
 * (seeded from the rail polyline's own first sample) and that the pose round-trips
 * back to the eye via `sphericalToCartesian`.
 */
function expectEyeOnRail(score: StageScore, t: number): void {
  const frame = computeStageFrame(t, score);
  const cam = frame.stageCamera;
  const rig = cam.rig;
  expect(rig).toBeDefined();
  const rail = rig!.railPoints;
  expect(rail.length).toBeGreaterThanOrEqual(2);

  const rigSpec = findRigSpec(score, cam.shotId!);
  expect(rigSpec).toBeDefined();
  const expected = evaluateRigEyePosition(rigSpec!, rig!.progress, rail[0]);
  expect(cam.transform.position.x).toBeCloseTo(expected.x, 9);
  expect(cam.transform.position.y).toBeCloseTo(expected.y, 9);
  expect(cam.transform.position.z).toBeCloseTo(expected.z, 9);

  // rig.eyePosition mirrors the transform eye.
  expect(rig!.eyePosition.x).toBeCloseTo(cam.transform.position.x, 9);
  expect(rig!.eyePosition.y).toBeCloseTo(cam.transform.position.y, 9);
  expect(rig!.eyePosition.z).toBeCloseTo(cam.transform.position.z, 9);

  // sphericalToCartesian(pose) must reproduce the eye bit-for-bit.
  const roundTrip = sphericalToCartesian(cam.transform.pose, score.aspectRatio).position;
  expect(roundTrip.x).toBeCloseTo(cam.transform.position.x, 9);
  expect(roundTrip.y).toBeCloseTo(cam.transform.position.y, 9);
  expect(roundTrip.z).toBeCloseTo(cam.transform.position.z, 9);
}

describe('rail camera kinematics — straight track', () => {
  const yaml = `
version: "1.0"
id: "rail-straight"
title: "Rail Straight"
duration: 8.0
stage: { width: 12, depth: 12 }
entities:
  - { id: "hero", kind: "character", position: [-3.0, 0, 0] }
blocking:
  - id: "walk"
    entity: "hero"
    start: 0.0
    end: 8.0
    position: [3.0, 0, 0]
    easing: "linear"
shots:
  - id: "s1"
    shot: 1
    start: 0.0
    end: 8.0
    stage_camera:
      rig: { type: "track", from: [-3.0, 1.4, 5.0], to: [3.0, 1.4, 5.0] }
      target: "hero"
      distance: 2.0
      yaw: 70deg
      pitch: 40deg
      easing: "smooth"
      lens: 35mm
`;

  it('locks the eye to rail progress and ignores authored distance/yaw/pitch', () => {
    const { score, error } = parseStageScore(yaml);
    expect(error).toBeNull();
    const s = score!;

    for (let i = 0; i <= 16; i++) {
      const t = (i / 16) * 8;
      const frame = computeStageFrame(t, s);
      const cam = frame.stageCamera;
      const u = evaluateCameraEasing('smooth', i / 16);

      // Eye strictly determined by rail sample (hero motion does not drag it).
      expect(cam.transform.position.x).toBeCloseTo(-3.0 + 6.0 * u, 9);
      expect(cam.transform.position.y).toBeCloseTo(1.4, 9);
      expect(cam.transform.position.z).toBeCloseTo(5.0, 9);
      expect(cam.rig!.progress).toBeCloseTo(u, 9);

      // Orientation reverse-solved from eye -> live target anchor (1.575m).
      const heroX = -3.0 + 6.0 * (i / 16);
      expect(cam.transform.target.x).toBeCloseTo(heroX, 6);
      const dx = cam.transform.position.x - cam.transform.target.x;
      const dy = cam.transform.position.y - cam.transform.target.y;
      const dz = cam.transform.position.z - cam.transform.target.z;
      expect(cam.transform.pose.distance).toBeCloseTo(Math.hypot(dx, dy, dz), 9);
      expect(cam.transform.pose.yaw).toBeCloseTo(Math.atan2(dx, dz), 9);
      expect(cam.transform.pose.pitch).toBeCloseTo(
        Math.atan2(dy, Math.hypot(dx, dz)),
        9
      );

      // Authored distance/yaw/pitch never leak into the target-locked pose.
      expect(cam.transform.pose.distance).not.toBeCloseTo(2.0, 3);
      expect(cam.transform.pose.pitch).not.toBeCloseTo((40 * Math.PI) / 180, 3);

      expectEyeOnRail(s, t);
    }
  });

  it('keeps the rendered rail identical to the live eye samples', () => {
    const { score } = parseStageScore(yaml);
    const s = score!;
    const rig = s.shots[0].stageCamera!.rig!;
    const f0 = computeStageFrame(0, s);
    const rail = f0.stageCamera.rig!.railPoints;
    expect(rail).toHaveLength(2);
    expect(rail[0].x).toBeCloseTo(-3.0, 9);
    expect(rail[1].x).toBeCloseTo(3.0, 9);
    // At u = 0 the cart sits exactly on the rail's first sample.
    expect(f0.stageCamera.transform.position.x).toBeCloseTo(rail[0].x, 9);

    // Live eye at eased progress equals the rail evaluator at that same progress.
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const easedU = evaluateCameraEasing('smooth', frac);
      const expected = evaluateRigEyePosition(rig, easedU, rail[0]);
      const frame = computeStageFrame(frac * 8, s);
      expect(frame.stageCamera.transform.position.x).toBeCloseTo(expected.x, 9);
      expect(frame.stageCamera.transform.position.y).toBeCloseTo(expected.y, 9);
      expect(frame.stageCamera.transform.position.z).toBeCloseTo(expected.z, 9);
    }
  });
});

describe('rail camera kinematics — curved spline track', () => {
  const yaml = `
version: "1.0"
id: "rail-curved"
title: "Rail Curved"
duration: 8.0
stage: { width: 12, depth: 12 }
entities:
  - { id: "hero", kind: "character", position: [2.0, 0, 0] }
shots:
  - id: "s1"
    shot: 1
    start: 0.0
    end: 8.0
    stage_camera:
      rig:
        type: "spline_track"
        points:
          - [-4.0, 1.4, 5.0]
          - [-1.5, 1.9, 3.0]
          - [1.5, 1.9, 3.0]
          - [4.0, 1.4, 5.0]
      target: "hero"
      easing: "smooth"
      lens: 40mm
`;

  it('samples the Catmull-Rom rail at eased progress and aims at the target', () => {
    const { score, error } = parseStageScore(yaml);
    expect(error).toBeNull();
    const s = score!;
    const rig = s.shots[0].stageCamera!.rig!;

    for (let i = 0; i <= 16; i++) {
      const frac = i / 16;
      const t = frac * 8;
      const frame = computeStageFrame(t, s);
      const cam = frame.stageCamera;
      const u = evaluateCameraEasing('smooth', frac);
      expect(cam.rig!.progress).toBeCloseTo(u, 9);

      // The eye must equal the spline evaluator at the same eased u and seed.
      const rail = cam.rig!.railPoints;
      const expected = evaluateRigEyePosition(rig, u, rail[0]);
      expect(cam.transform.position.x).toBeCloseTo(expected.x, 9);
      expect(cam.transform.position.z).toBeCloseTo(expected.z, 9);
      // Eye is finite and rail-bound at the authored endpoints.
      expect(Number.isFinite(cam.transform.position.y)).toBe(true);
      expectEyeOnRail(s, t);
    }

    const f0 = computeStageFrame(0, s);
    expect(f0.stageCamera.transform.position.x).toBeCloseTo(-4.0, 6);
    expect(f0.stageCamera.transform.position.z).toBeCloseTo(5.0, 6);
    const fEnd = computeStageFrame(8, s);
    expect(fEnd.stageCamera.transform.position.x).toBeCloseTo(4.0, 6);
    expect(fEnd.stageCamera.transform.position.z).toBeCloseTo(5.0, 6);

    // Spline bows toward -Z mid-shot.
    const fMid = computeStageFrame(4, s);
    expect(fMid.stageCamera.transform.position.z).toBeLessThan(5.0);

    // Rail polyline is sampled from the same evaluator used at runtime.
    const rail = f0.stageCamera.rig!.railPoints;
    expect(rail.length).toBeGreaterThanOrEqual(16);
    for (let k = 0; k < rail.length; k++) {
      const expected = evaluateRigEyePosition(
        rig,
        k / (rail.length - 1),
        rail[0]
      );
      expect(rail[k].x).toBeCloseTo(expected.x, 9);
      expect(rail[k].y).toBeCloseTo(expected.y, 9);
      expect(rail[k].z).toBeCloseTo(expected.z, 9);
    }
  });
});

describe('rail camera kinematics — continuous vs non-continuous boundaries', () => {
  const yaml = `
version: "1.0"
id: "rail-boundaries"
title: "Rail Boundaries"
duration: 12.0
stage: { width: 12, depth: 12 }
entities:
  - { id: "hero", kind: "character", position: [-2.0, 0, 0] }
  - { id: "villain", kind: "character", position: [3.0, 0, -2.0] }
shots:
  - id: "s1"
    shot: 1
    start: 0.0
    end: 4.0
    stage_camera:
      rig: { type: "track", from: [-2.0, 1.5, 4.0], to: [0.0, 1.5, 4.0] }
      target: "hero"
      easing: "linear"
  - id: "s2"
    shot: 2
    start: 4.0
    end: 8.0
    continuous: true
    stage_camera:
      rig: { type: "track", to: [2.0, 1.5, 4.0] }
      target: "villain"
      easing: "linear"
  - id: "s3"
    shot: 3
    start: 8.0
    end: 12.0
    stage_camera:
      rig: { type: "track", from: [-3.0, 1.5, 6.0], to: [3.0, 1.5, 6.0] }
      target: "villain"
      easing: "linear"
`;

  it('inherits the previous terminal eye on a continuous rig, hard-cuts otherwise', () => {
    const { score, error } = parseStageScore(yaml);
    expect(error).toBeNull();
    const s = score!;

    // Shot 1 terminal eye (sampled just inside the cue; t=4.0 belongs to shot 2).
    const end1 = computeStageFrame(4.0 - 1e-6, s).stageCamera;
    const end1Exact = computeStageFrame(4.0, s).stageCamera;
    expect(end1.transform.position.x).toBeCloseTo(0.0, 3);

    // Shot 2 start (continuous): continue from E_prev in eye AND heading.
    expect(end1Exact.transform.position.x).toBeCloseTo(end1.transform.position.x, 3);
    expect(end1Exact.transform.position.y).toBeCloseTo(end1.transform.position.y, 3);
    expect(end1Exact.transform.position.z).toBeCloseTo(end1.transform.position.z, 3);
    expect(end1Exact.rig!.railPoints[0].x).toBeCloseTo(end1.transform.position.x, 3);
    expect(end1Exact.rig!.railPoints[0].x).toBeCloseTo(0.0, 3);
    // The new target (villain) is instantly aimed at, so no 0-length sightline jump.
    expect(end1Exact.transform.target.x).toBeCloseTo(3.0, 3);

    // Shot 2 terminal eye (sampled just inside the cue; t=8.0 belongs to shot 3).
    const end2 = computeStageFrame(8.0 - 1e-6, s).stageCamera;
    expect(end2.transform.position.x).toBeCloseTo(2.0, 3);

    // Shot 3 non-continuous: hard cut to authored rail start, not from s2 end.
    const start3 = computeStageFrame(8.0, s).stageCamera;
    expect(start3.transform.position.x).toBeCloseTo(-3.0, 6);
    expect(start3.transform.position.z).toBeCloseTo(6.0, 6);

    // Continuous shots stay finite and rail-bound throughout.
    for (const t of [4.0, 5.0, 6.0, 7.0, 7.999]) {
      expectEyeOnRail(s, t);
    }
    // Non-continuous shot starts on its own rail.
    for (const t of [8.0, 9.0, 10.0, 11.0, 11.999]) {
      expectEyeOnRail(s, t);
    }
  });

  it('starts a continuous fixed-gaze rig from the previous eye, not the default pose', () => {
    const fixedGazeYaml = `
version: "1.0"
id: "rail-cont-fixed-gaze"
title: "Rail Continuous Fixed Gaze"
duration: 12.0
stage: { width: 12, depth: 12 }
entities:
  - { id: "hero", kind: "character", position: [-2.0, 0, 0] }
shots:
  - id: "s1"
    shot: 1
    start: 0.0
    end: 6.0
    stage_camera:
      target: "hero"
      distance: 5.0
      yaw: 20deg
      pitch: 8deg
      easing: "linear"
  - id: "s2"
    shot: 2
    start: 6.0
    end: 12.0
    continuous: true
    stage_camera:
      rig: { type: "track", to: [4.0, 1.3, 6.0] }
      yaw: 0deg
      pitch: 0deg
      easing: "linear"
`;
    const { score, error } = parseStageScore(fixedGazeYaml);
    expect(error).toBeNull();
    const s = score!;

    const end1 = computeStageFrame(6.0 - 1e-6, s).stageCamera;
    const start2 = computeStageFrame(6.0, s).stageCamera;
    expect(start2.transform.position.x).toBeCloseTo(end1.transform.position.x, 6);
    expect(start2.transform.position.y).toBeCloseTo(end1.transform.position.y, 6);
    expect(start2.transform.position.z).toBeCloseTo(end1.transform.position.z, 6);
    // Fixed-gaze heading continues from the previous pose (no default reset).
    expect(radToDeg(start2.transform.pose.yaw)).toBeCloseTo(
      radToDeg(end1.transform.pose.yaw),
      3
    );
    expect(start2.rig!.railPoints[0].x).toBeCloseTo(end1.transform.position.x, 9);
  });
});

describe('rail camera kinematics — missing endpoints fallback', () => {
  const yaml = `
version: "1.0"
id: "rail-missing"
title: "Rail Missing Endpoints"
duration: 12.0
stage: { width: 12, depth: 12 }
shots:
  - id: "s1-from-only"
    shot: 1
    start: 0.0
    end: 3.0
    stage_camera:
      rig: { type: "track", from: [-2.0, 1.3, 4.0] }
      target: [0, 1, 0]
      easing: "linear"
  - id: "s2-to-only"
    shot: 2
    start: 3.0
    end: 6.0
    stage_camera:
      rig: { type: "track", to: [2.0, 1.3, 4.0] }
      target: [0, 1, 0]
      easing: "linear"
  - id: "s3-spline-one"
    shot: 3
    start: 6.0
    end: 9.0
    stage_camera:
      rig: { type: "spline_track", points: [[1.0, 1.3, 4.0]] }
      target: [0, 1, 0]
      easing: "linear"
  - id: "s4-spline-empty"
    shot: 4
    start: 9.0
    end: 12.0
    stage_camera:
      rig: { type: "spline_track" }
      target: [0, 1, 0]
      easing: "linear"
`;

  it('falls back deterministically without NaN for start-only, end-only, and degenerate splines', () => {
    const { score, error } = parseStageScore(yaml);
    expect(error).toBeNull();
    const s = score!;

    // 1. Start-only track holds stationary at `from`.
    for (const t of [0, 1.5, 2.999]) {
      const f = computeStageFrame(t, s);
      expect(f.stageCamera.transform.position.x).toBeCloseTo(-2.0, 6);
      expect(f.stageCamera.transform.position.z).toBeCloseTo(4.0, 6);
      expectFinitePose(s, t);
    }

    // 2. End-only track glides from the cue seed eye to `to`.
    const toOnlyStart = computeStageFrame(3.0, s);
    const toOnlyMid = computeStageFrame(4.5, s);
    const toOnlyEnd = computeStageFrame(5.999, s);
    expect(toOnlyStart.stageCamera.transform.position.x).not.toBeCloseTo(2.0, 3);
    expect(Number.isFinite(toOnlyMid.stageCamera.transform.position.x)).toBe(true);
    // Motion is monotonic toward the authored endpoint.
    expect(toOnlyMid.stageCamera.transform.position.x).toBeGreaterThan(
      toOnlyStart.stageCamera.transform.position.x
    );
    expect(toOnlyMid.stageCamera.transform.position.x).toBeLessThan(
      toOnlyEnd.stageCamera.transform.position.x
    );
    // The cue's last internal frame approaches the authored `to` point.
    expect(toOnlyEnd.stageCamera.transform.position.x).toBeCloseTo(2.0, 2);

    // 3. Single-point spline glides from the cue seed eye to the single point.
    const onePtStart = computeStageFrame(6.0, s);
    const onePtEnd = computeStageFrame(9.0, s);
    expect(onePtEnd.stageCamera.transform.position.x).toBeCloseTo(1.0, 6);
    expect(onePtStart.stageCamera.transform.position.x).not.toBeCloseTo(1.0, 3);

    // 4. Empty spline holds stationary at the cue seed eye.
    const emptyStart = computeStageFrame(9.0, s);
    const emptyEnd = computeStageFrame(11.999, s);
    expect(emptyStart.stageCamera.transform.position.x).toBeCloseTo(
      emptyEnd.stageCamera.transform.position.x,
      6
    );
    expect(emptyStart.stageCamera.transform.position.z).toBeCloseTo(
      emptyEnd.stageCamera.transform.position.z,
      6
    );

    // Across every degenerate cue, all pose scalars stay finite.
    for (const t of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11.999]) {
      expectFinitePose(s, t);
      expectEyeOnRail(s, t);
    }
  });

  it('never emits NaN when the eye coincides with the target', () => {
    const coincidentYaml = `
version: "1.0"
id: "rail-coincident"
title: "Rail Coincident"
duration: 4.0
stage: { width: 12, depth: 12 }
shots:
  - id: "s1"
    shot: 1
    start: 0.0
    end: 4.0
    stage_camera:
      rig: { type: "track", from: [0.0, 1.575, 0.0], to: [0.0, 1.575, 0.0] }
      target: [0.0, 1.575, 0.0]
      easing: "linear"
`;
    const { score } = parseStageScore(coincidentYaml);
    const s = score!;
    for (const t of [0, 1, 2, 3, 4]) {
      expectFinitePose(s, t);
      // Eye remains pinned at the authored (degenerate) rail point.
      const cam = computeStageFrame(t, s).stageCamera;
      expect(cam.transform.position.x).toBeCloseTo(0.0, 9);
      expect(cam.transform.position.y).toBeCloseTo(1.575, 9);
      expect(cam.transform.position.z).toBeCloseTo(0.0, 9);
    }
  });
});
