/**
 * Fixture-driven acceptance suite for rail-mounted camera kinematics.
 *
 * Loads the four locally authored YAML scores in `tests/fixtures/rail-camera/`
 * (straight track, curved spline track, continuous vs non-continuous boundaries,
 * and missing/degenerate endpoints) and verifies the rail camera contract on each:
 *   - Eye point is rail-sampled at eased progress, not dragged by live target motion.
 *   - Orientation (pitch / yaw / distance) is reverse-solved from the eye -> target line.
 *   - `sphericalToCartesian(pose)` reproduces the eye exactly (visual samples coincide).
 *   - Continuous boundaries inherit the previous terminal eye + heading; cuts do not.
 *   - Degenerate rails never emit NaN.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStageScore } from '../../src/core/scoreParser';
import { computeStageFrame } from '../../src/core/frameEngine';
import { evaluateCameraEasing } from '../../src/core/maneuvers';
import { sphericalToCartesian } from '../../src/core/sphericalMath';
import { evaluateRigEyePosition } from '../../src/core/cameraRigEvaluator';
import type { CameraRigSpec, StageScore } from '../../src/core/types';

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/rail-camera'
);

function loadFixture(name: string): StageScore {
  const raw = readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
  const { score, error } = parseStageScore(raw);
  expect(error, `fixture ${name} should parse cleanly`).toBeNull();
  expect(score).not.toBeNull();
  return score!;
}

function rigFor(score: StageScore, shotId: string): CameraRigSpec {
  const shot = score.shots.find((s) => s.id === shotId);
  expect(shot?.stageCamera?.rig, `shot ${shotId} should declare a rig`).toBeDefined();
  return shot!.stageCamera!.rig!;
}

function assertFiniteCamera(score: StageScore, t: number): void {
  const cam = computeStageFrame(t, score).stageCamera;
  for (const v of [cam.transform.position, cam.transform.target]) {
    expect(Number.isFinite(v.x), `t=${t} position finite`).toBe(true);
    expect(Number.isFinite(v.y), `t=${t} position finite`).toBe(true);
    expect(Number.isFinite(v.z), `t=${t} position finite`).toBe(true);
  }
  expect(Number.isFinite(cam.transform.pose.pitch), `t=${t} pitch finite`).toBe(true);
  expect(Number.isFinite(cam.transform.pose.yaw), `t=${t} yaw finite`).toBe(true);
  expect(Number.isFinite(cam.transform.pose.distance), `t=${t} distance finite`).toBe(true);
}

/** Asserts the rail polyline sample and live eye agree at the same eased progress. */
function assertRailCoincidence(score: StageScore, t: number): void {
  const cam = computeStageFrame(t, score).stageCamera;
  const rail = cam.rig!.railPoints;
  expect(rail.length).toBeGreaterThanOrEqual(2);
  const rig = rigFor(score, cam.shotId!);
  const expected = evaluateRigEyePosition(rig, cam.rig!.progress, rail[0]);
  expect(cam.transform.position.x).toBeCloseTo(expected.x, 9);
  expect(cam.transform.position.y).toBeCloseTo(expected.y, 9);
  expect(cam.transform.position.z).toBeCloseTo(expected.z, 9);
  expect(cam.rig!.eyePosition.x).toBeCloseTo(cam.transform.position.x, 9);
  expect(cam.rig!.eyePosition.y).toBeCloseTo(cam.transform.position.y, 9);
  expect(cam.rig!.eyePosition.z).toBeCloseTo(cam.transform.position.z, 9);
  const roundTrip = sphericalToCartesian(cam.transform.pose, score.aspectRatio).position;
  expect(roundTrip.x).toBeCloseTo(cam.transform.position.x, 9);
  expect(roundTrip.y).toBeCloseTo(cam.transform.position.y, 9);
  expect(roundTrip.z).toBeCloseTo(cam.transform.position.z, 9);
}

/**
 * Asserts every time-indexed trajectory sample (the dashed visualization ribbon)
 * coincides exactly with the live evaluated eye at that same timestamp.
 */
function assertTrajectorySamplesCoincide(score: StageScore, shotId: string, shots = 32): void {
  const shot = score.shots.find((s) => s.id === shotId)!;
  const duration = Math.max(0.016, shot.endSec - shot.startSec);
  // Trajectory ribbons are cached per active cue; read them from a mid-cue frame.
  const midT = shot.startSec + duration * 0.5;
  const trajectory = computeStageFrame(midT, score).stageCamera.trajectoryPoints;
  expect(trajectory.length).toBe(shots + 1);
  for (let i = 0; i <= shots; i++) {
    const t = shot.startSec + (i / shots) * duration;
    // Sample just inside the cue's half-open [start, end) window.
    const tSafe = Math.min(t, shot.endSec - 1e-6);
    const liveEye = computeStageFrame(tSafe, score).stageCamera.transform.position;
    const sample = trajectory[i];
    expect(sample.x).toBeCloseTo(liveEye.x, 3);
    expect(sample.y).toBeCloseTo(liveEye.y, 3);
    expect(sample.z).toBeCloseTo(liveEye.z, 3);
  }
}

describe('rail fixtures — straight linear track', () => {
  const score = loadFixture('rail_straight.yaml');

  it('governs the eye purely by rail progress and ignores authored framing scalars', () => {
    for (let i = 0; i <= 16; i++) {
      const t = (i / 16) * 8;
      const cam = computeStageFrame(t, score).stageCamera;
      const u = evaluateCameraEasing('linear', i / 16);

      expect(cam.transform.position.x).toBeCloseTo(-3.0 + 6.0 * u, 9);
      expect(cam.transform.position.y).toBeCloseTo(1.4, 9);
      expect(cam.transform.position.z).toBeCloseTo(5.0, 9);
      expect(cam.rig!.progress).toBeCloseTo(u, 9);

      const dx = cam.transform.position.x - cam.transform.target.x;
      const dy = cam.transform.position.y - cam.transform.target.y;
      const dz = cam.transform.position.z - cam.transform.target.z;
      expect(cam.transform.pose.distance).toBeCloseTo(Math.hypot(dx, dy, dz), 9);
      expect(cam.transform.pose.yaw).toBeCloseTo(Math.atan2(dx, dz), 9);

      // Authored wrong scalars (2.0m / 40deg pitch) never leak into the look-at pose.
      expect(cam.transform.pose.distance).not.toBeCloseTo(2.0, 2);
      expect(cam.transform.pose.pitch).not.toBeCloseTo((40 * Math.PI) / 180, 2);

      assertRailCoincidence(score, t);
    }
  });

  it('tracks the walking actor while the eye stays on the fixed rail', () => {
    const start = computeStageFrame(0, score).stageCamera;
    const end = computeStageFrame(8, score).stageCamera;
    expect(start.transform.target.x).toBeCloseTo(-3.0, 6);
    expect(end.transform.target.x).toBeCloseTo(3.0, 6);
    // Eye y never changes because the rail rail is flat along X; only X moves.
    expect(start.transform.position.y).toBeCloseTo(end.transform.position.y, 9);
  });

  it('keeps the dashed trajectory ribbon coincident with the live eye over time', () => {
    assertTrajectorySamplesCoincide(score, 'shot-01-rail-straight');
  });
});

describe('rail fixtures — curved spline track', () => {
  const score = loadFixture('rail_curved.yaml');

  it('follows the Catmull-Rom rail at eased progress with look-at orientation', () => {
    const rig = rigFor(score, 'shot-01-rail-spline');
    for (let i = 0; i <= 16; i++) {
      const frac = i / 16;
      const t = frac * 8;
      const cam = computeStageFrame(t, score).stageCamera;
      const u = evaluateCameraEasing('smooth', frac);
      expect(cam.rig!.progress).toBeCloseTo(u, 9);
      const expected = evaluateRigEyePosition(rig, u, cam.rig!.railPoints[0]);
      expect(cam.transform.position.x).toBeCloseTo(expected.x, 9);
      expect(cam.transform.position.y).toBeCloseTo(expected.y, 9);
      expect(cam.transform.position.z).toBeCloseTo(expected.z, 9);
      assertRailCoincidence(score, t);
      assertFiniteCamera(score, t);
    }

    const f0 = computeStageFrame(0, score).stageCamera;
    expect(f0.transform.position.x).toBeCloseTo(-4.0, 6);
    expect(f0.transform.position.z).toBeCloseTo(5.0, 6);
    const fEnd = computeStageFrame(8, score).stageCamera;
    expect(fEnd.transform.position.x).toBeCloseTo(4.0, 6);
    expect(fEnd.transform.position.z).toBeCloseTo(5.0, 6);
    // The rail bows downstage (-Z) in the middle.
    expect(computeStageFrame(4, score).stageCamera.transform.position.z).toBeLessThan(5.0);
  });

  it('emits a rail polyline whose samples coincide with the evaluator trajectory', () => {
    const rig = rigFor(score, 'shot-01-rail-spline');
    const rail = computeStageFrame(0, score).stageCamera.rig!.railPoints;
    expect(rail.length).toBeGreaterThanOrEqual(16);
    for (let k = 0; k < rail.length; k++) {
      const expected = evaluateRigEyePosition(rig, k / (rail.length - 1), rail[0]);
      expect(rail[k].x).toBeCloseTo(expected.x, 9);
      expect(rail[k].y).toBeCloseTo(expected.y, 9);
      expect(rail[k].z).toBeCloseTo(expected.z, 9);
    }
  });

  it('keeps the dashed trajectory ribbon coincident with the live eye over time', () => {
    assertTrajectorySamplesCoincide(score, 'shot-01-rail-spline');
  });
});

describe('rail fixtures — continuous vs non-continuous boundaries', () => {
  const score = loadFixture('rail_continuous_boundaries.yaml');

  it('continues eye and heading across a continuous boundary and hard-cuts otherwise', () => {
    // s1 ends at t=4.0 (exclusive); sample just inside for its terminal eye.
    const s1End = computeStageFrame(4.0 - 1e-6, score).stageCamera;
    expect(s1End.transform.position.x).toBeCloseTo(0.0, 3);

    // s2 begins exactly at t=4.0 and is continuous: inherits the terminal eye.
    const s2Start = computeStageFrame(4.0, score).stageCamera;
    expect(s2Start.shotId).toBe('shot-02-track-villain-continuous');
    expect(s2Start.transform.position.x).toBeCloseTo(s1End.transform.position.x, 3);
    expect(s2Start.transform.position.y).toBeCloseTo(s1End.transform.position.y, 3);
    expect(s2Start.transform.position.z).toBeCloseTo(s1End.transform.position.z, 3);
    expect(s2Start.rig!.railPoints[0].x).toBeCloseTo(s1End.transform.position.x, 3);
    // Target instantly re-aimed at villain.
    expect(s2Start.transform.target.x).toBeCloseTo(3.0, 3);

    // s3 is a hard cut at t=8.0: ignores s2 terminal eye, snaps to its own rail start.
    const s2End = computeStageFrame(8.0 - 1e-6, score).stageCamera;
    expect(s2End.transform.position.x).toBeCloseTo(2.0, 3);
    const s3Start = computeStageFrame(8.0, score).stageCamera;
    expect(s3Start.shotId).toBe('shot-03-track-villain-cut');
    expect(s3Start.transform.position.x).toBeCloseTo(-3.0, 6);
    expect(s3Start.transform.position.z).toBeCloseTo(6.0, 6);

    for (const t of [4.0, 5.0, 6.0, 7.5]) {
      assertRailCoincidence(score, t);
      assertFiniteCamera(score, t);
    }
    for (const t of [8.0, 9.0, 10.0, 11.5]) {
      assertRailCoincidence(score, t);
      assertFiniteCamera(score, t);
    }
  });
});

describe('rail fixtures — missing endpoint fallbacks', () => {
  const score = loadFixture('rail_missing_endpoints.yaml');

  it('holds, glides, and stays finite for start-only / end-only / 1-point / empty rails', () => {
    // s1: from-only holds stationary at the authored point.
    for (const t of [0.0, 1.5, 2.999]) {
      const cam = computeStageFrame(t, score).stageCamera;
      expect(cam.transform.position.x).toBeCloseTo(-2.0, 6);
      expect(cam.transform.position.y).toBeCloseTo(1.3, 6);
      expect(cam.transform.position.z).toBeCloseTo(4.0, 6);
    }

    // s2: to-only glides monotonically toward the authored endpoint.
    const s2a = computeStageFrame(3.0, score).stageCamera;
    const s2b = computeStageFrame(4.5, score).stageCamera;
    const s2c = computeStageFrame(5.999, score).stageCamera;
    expect(s2a.transform.position.x).not.toBeCloseTo(2.0, 2);
    expect(s2b.transform.position.x).toBeGreaterThan(s2a.transform.position.x);
    expect(s2b.transform.position.x).toBeLessThan(s2c.transform.position.x);
    expect(s2c.transform.position.x).toBeCloseTo(2.0, 2);

    // s3: single-point spline glides from seed eye to the point.
    const s3a = computeStageFrame(6.0, score).stageCamera;
    const s3c = computeStageFrame(8.999, score).stageCamera;
    expect(s3a.transform.position.x).not.toBeCloseTo(1.0, 2);
    expect(s3c.transform.position.x).toBeCloseTo(1.0, 2);

    // s4: empty spline holds stationary at the seed eye.
    const s4a = computeStageFrame(9.0, score).stageCamera;
    const s4b = computeStageFrame(11.999, score).stageCamera;
    expect(s4a.transform.position.x).toBeCloseTo(s4b.transform.position.x, 6);
    expect(s4a.transform.position.z).toBeCloseTo(s4b.transform.position.z, 6);

    // Every frame in every degenerate cue stays finite and rail-coincident.
    for (let i = 0; i <= 24; i++) {
      const t = (i / 24) * 12;
      assertFiniteCamera(score, t);
      // Skip pure gaps (none here) — each cue fully tiles the 12s timeline.
      assertRailCoincidence(score, Math.min(t, 11.999));
    }
  });
});
