/**
 * Pure physical camera rig rail kinematics and inverse sightline pose derivation.
 *
 * Rail-mounted cameras (linear `track`, Catmull-Rom `spline_track`) decouple the
 * camera eye position from subject framing: the eye is strictly a function of
 * sampled rail progress, and the head orientation is solved inversely from the
 * eye-to-target sightline. This module guarantees:
 *   1. Deterministic, finite rail sampling with explicit fallbacks for rails that
 *      supply only a start point, a single spline point, or no points at all.
 *   2. `sphericalToCartesian(poseFromSightline(eye, target)).position` reproduces
 *      the sampled `eye` bit-for-bit, even at degenerate sightlines where the eye
 *      coincides with the target or the elevation exceeds the scalar pitch clamp.
 * Pure Layer 1 module with zero React or DOM dependencies.
 */

import type { CameraRigSpec, SphericalPose, Vec3 } from './types';
import { CAMERA_LIMITS } from './constants';
import { catmullRomScalar } from './maneuvers';

/**
 * Below this eye-to-target separation a sightline has no stable azimuth/elevation,
 * so a deterministic fallback heading is substituted.
 */
export const RIG_SIGHTLINE_EPSILON_M = 1e-6;

/** Clamps rig sample progress into [0, 1], defaulting non-finite input to 0. */
export function clampRigProgress(u: number): number {
  return Number.isFinite(u) ? Math.max(0, Math.min(1, u)) : 0;
}

/** Returns a finite copy of `v`, substituting `fallback` per non-finite component. */
export function sanitizeVec3(
  v: Vec3 | undefined,
  fallback: Vec3 = { x: 0, y: 0, z: 0 }
): Vec3 {
  return {
    x: v && Number.isFinite(v.x) ? v.x : fallback.x,
    y: v && Number.isFinite(v.y) ? v.y : fallback.y,
    z: v && Number.isFinite(v.z) ? v.z : fallback.z,
  };
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
    z: a.z + t * (b.z - a.z),
  };
}

/**
 * Evaluates the 3D world-space camera nodal position on a rig at eased progress u in [0, 1].
 *
 * Fallback policy (never produces NaN):
 * - `track` with only `from`: holds stationary at `from` (`to` defaults to `from`).
 * - `track` with only `to`: glides from `fallbackEye` to `to`.
 * - `spline_track` with 1 point: glides from `fallbackEye` to that point.
 * - `spline_track` with 0 points: holds stationary at `fallbackEye`.
 */
export function evaluateRigEyePosition(
  rig: CameraRigSpec,
  u: number,
  fallbackEye: Vec3
): Vec3 {
  const t = clampRigProgress(u);
  const fallback = sanitizeVec3(fallbackEye);

  if (rig.type === 'tripod') {
    return rig.position ? sanitizeVec3(rig.position, fallback) : fallback;
  }

  if (rig.type === 'track') {
    const start = rig.from ? sanitizeVec3(rig.from, fallback) : fallback;
    const end = rig.to ? sanitizeVec3(rig.to, start) : start;
    return lerpVec3(start, end, t);
  }

  // 'spline_track': Catmull-Rom interpolation across control points
  const rawPts = (rig.points ?? []).map((p) => sanitizeVec3(p, fallback));
  const pts: Vec3[] =
    rawPts.length >= 2
      ? rawPts
      : rawPts.length === 1
      ? [fallback, rawPts[0]]
      : [fallback, fallback];

  const numSegments = pts.length - 1;
  const scaledT = t * numSegments;
  const segIdx = Math.min(numSegments - 1, Math.max(0, Math.floor(scaledT)));
  const segFrac = scaledT - segIdx;

  const p0 = pts[Math.max(0, segIdx - 1)];
  const p1 = pts[segIdx];
  const p2 = pts[Math.min(pts.length - 1, segIdx + 1)];
  const p3 = pts[Math.min(pts.length - 1, segIdx + 2)];

  return {
    x: catmullRomScalar(p0.x, p1.x, p2.x, p3.x, segFrac),
    y: catmullRomScalar(p0.y, p1.y, p2.y, p3.y, segFrac),
    z: catmullRomScalar(p0.z, p1.z, p2.z, p3.z, segFrac),
  };
}

/**
 * Samples physical 3D rail coordinates for rendering in the 3D diorama.
 * Returns empty array for tripod; returns line endpoints or sampled spline points for tracks.
 * Every returned point is produced by the same `evaluateRigEyePosition` used at runtime,
 * so visualization samples coincide exactly with the evaluator's eye trajectory.
 */
export function sampleRigRailPoints(
  rig: CameraRigSpec,
  fallbackEye: Vec3,
  samples = 32
): Vec3[] {
  if (rig.type === 'tripod') {
    return [];
  }
  if (rig.type === 'track') {
    const fallback = sanitizeVec3(fallbackEye);
    const start = rig.from ? sanitizeVec3(rig.from, fallback) : fallback;
    const end = rig.to ? sanitizeVec3(rig.to, start) : start;
    return [{ ...start }, { ...end }];
  }
  // 'spline_track'
  const count = Number.isFinite(samples) && samples > 0 ? Math.floor(samples) : 32;
  const points: Vec3[] = [];
  for (let i = 0; i <= count; i++) {
    points.push(evaluateRigEyePosition(rig, i / count, fallbackEye));
  }
  return points;
}

function clampPitch(pitch: number): number {
  return Math.max(
    CAMERA_LIMITS.MIN_PITCH_RAD,
    Math.min(CAMERA_LIMITS.MAX_PITCH_RAD, pitch)
  );
}

function clampDistance(distance: number): number {
  return Math.max(
    CAMERA_LIMITS.MIN_DISTANCE_M,
    Math.min(CAMERA_LIMITS.MAX_DISTANCE_M, distance)
  );
}

/** Clamps an elevation angle into the gimbal-safe scalar pitch range. */
export function clampRigPitch(pitch: number): number {
  return clampPitch(Number.isFinite(pitch) ? pitch : 0);
}

/** Clamps a sightline length into the metric camera distance range. */
export function clampRigDistance(distance: number): number {
  return clampDistance(Number.isFinite(distance) ? distance : 0);
}

/**
 * Derives an exact spherical pose that looks from `eye` at `target`.
 *
 * The returned `target` is reconstructed from the (possibly clamped) distance and
 * elevation so that `sphericalToCartesian(pose).position` reproduces `eye` exactly:
 * - When the sightline is unclamped, the reconstructed target equals the input target
 *   (up to floating-point round-off) and the look direction is unchanged.
 * - When eye/target separation falls below `MIN_DISTANCE_M` or exceeds `MAX_DISTANCE_M`,
 *   the target slides along the same sightline to respect metric bounds.
 * - When the separation is numerically degenerate (eye on target), the fallback pose's
 *   heading is reused at `MIN_DISTANCE_M`, guaranteeing finite yaw/pitch/distance.
 * - Elevation is clamped to the scalar pitch limits for gimbal safety.
 */
export function poseFromSightline(
  eye: Vec3,
  target: Vec3 | undefined,
  focalLengthMm: number,
  roll: number,
  fallbackPose?: Pick<SphericalPose, 'pitch' | 'yaw'>
): SphericalPose {
  const eyeSafe = sanitizeVec3(eye);
  const targetSafe = sanitizeVec3(target, eyeSafe);

  const dx = eyeSafe.x - targetSafe.x;
  const dy = eyeSafe.y - targetSafe.y;
  const dz = eyeSafe.z - targetSafe.z;
  const horizDist = Math.hypot(dx, dz);
  const rawDistance = Math.hypot(dx, dy, dz);

  let yaw: number;
  let pitch: number;
  let distance: number;

  if (Number.isFinite(rawDistance) && rawDistance > RIG_SIGHTLINE_EPSILON_M) {
    yaw = horizDist > RIG_SIGHTLINE_EPSILON_M ? Math.atan2(dx, dz) : 0;
    pitch = Math.atan2(dy, horizDist);
    distance = clampDistance(rawDistance);
  } else {
    // Degenerate sightline: reuse the authored/cue-start heading along +Z.
    yaw = fallbackPose && Number.isFinite(fallbackPose.yaw) ? fallbackPose.yaw : 0;
    pitch =
      fallbackPose && Number.isFinite(fallbackPose.pitch)
        ? fallbackPose.pitch
        : 0;
    distance = CAMERA_LIMITS.MIN_DISTANCE_M;
  }

  pitch = clampPitch(Number.isFinite(pitch) ? pitch : 0);
  yaw = Number.isFinite(yaw) ? yaw : 0;

  // Reconstruct the anchor so sphericalToCartesian(pose) returns `eye` exactly.
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);

  return {
    target: {
      x: eyeSafe.x - distance * cosPitch * sinYaw,
      y: eyeSafe.y - distance * sinPitch,
      z: eyeSafe.z - distance * cosPitch * cosYaw,
    },
    distance,
    pitch,
    yaw,
    roll: Number.isFinite(roll) ? roll : 0,
    focalLengthMm,
  };
}

/**
 * Forward-projects a target anchor along an authored fixed-gaze heading from `eye`,
 * reconstructing the anchor from the clamped distance/elevation so the eye round-trips exactly.
 */
export function projectFixedGazeTarget(
  eye: Vec3,
  distance: number,
  pitch: number,
  yaw: number
): Vec3 {
  const eyeSafe = sanitizeVec3(eye);
  const dist = clampRigDistance(distance);
  const safePitch = clampRigPitch(pitch);
  const safeYaw = Number.isFinite(yaw) ? yaw : 0;
  const cosPitch = Math.cos(safePitch);
  return {
    x: eyeSafe.x - dist * cosPitch * Math.sin(safeYaw),
    y: eyeSafe.y - dist * Math.sin(safePitch),
    z: eyeSafe.z - dist * cosPitch * Math.cos(safeYaw),
  };
}
