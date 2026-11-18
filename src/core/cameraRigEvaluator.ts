/**
 * Camera rig mount parser and rig pose dispatch (Tripod, Linear Track, Spline Track).
 * Rail sampling and inverse sightline math live in `cameraRigKinematics.ts`.
 * Pure Layer 1 module with zero React or DOM dependencies.
 */

import type {
  CameraCueSpec, CameraRigSpec, CameraRigType,
  EvaluatedEntityState, SphericalPose, Vec3,
} from './types';
import { parseOptionalVec3 } from './scorePrimitives';
import { shortestAngleDiff, sphericalToCartesian } from './sphericalMath';
import { interpolateRoll } from './maneuvers';
import {
  ZERO_OFFSET, resolveShotDestOffset, resolveShotDestRoll, resolveTargetPoint3D,
} from './cameraTargetResolver';
import {
  clampRigDistance, clampRigPitch,
  evaluateRigEyePosition, poseFromSightline, projectFixedGazeTarget,
} from './cameraRigKinematics';

// Re-export rail kinematics so existing Layer 4/5 consumers keep a single import site.
export {
  evaluateRigEyePosition, sampleRigRailPoints,
} from './cameraRigKinematics';

/**
 * Parses an optional `rig:` block from a camera cue.
 */
export function parseCameraRigSpec(raw: unknown): CameraRigSpec | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const rawType = String(obj.type ?? obj.kind ?? obj.mode ?? '').trim().toLowerCase();

  let type: CameraRigType = 'tripod';
  if (
    ['track', 'dolly', 'rail', 'slider', 'linear'].includes(rawType) ||
    (rawType === '' && (obj.from !== undefined || obj.to !== undefined))
  ) {
    type = 'track';
  } else if (
    ['spline_track', 'spline-track', 'curved_track', 'curved-track', 'spline'].includes(rawType) ||
    Array.isArray(obj.points ?? obj.waypoints)
  ) {
    type = 'spline_track';
  }

  const position = parseOptionalVec3(obj.position ?? obj.pos ?? obj.at ?? obj.eye);
  const from = parseOptionalVec3(obj.from ?? obj.start);
  const to = parseOptionalVec3(obj.to ?? obj.end);

  const rawPoints = obj.points ?? obj.waypoints;
  const points: Vec3[] | undefined = Array.isArray(rawPoints)
    ? rawPoints.map((p) => parseOptionalVec3(p)).filter((p): p is Vec3 => Boolean(p))
    : undefined;

  return {
    type,
    ...(position ? { position } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(points && points.length > 0 ? { points } : {}),
  };
}

/**
 * Resolves the active gaze target for a rail-mounted camera at progress u.
 *
 * Target-tracking mode (`target:` or `from:` authored) interpolates from `from`
 * to `target` (both resolved against live entities at the current time). Fixed
 * gaze mode has no anchor at all and is handled separately.
 */
function resolveRigGazeTarget(
  spec: CameraCueSpec,
  u: number,
  entitiesById: Map<string, EvaluatedEntityState>,
  P0: SphericalPose,
  startOffset: Vec3,
  endOffset: Vec3
): Vec3 {
  const destTarget =
    spec.target !== undefined
      ? resolveTargetPoint3D(spec.target, entitiesById, P0.target, endOffset)
      : {
          x: P0.target.x + (endOffset.x - startOffset.x),
          y: P0.target.y + (endOffset.y - startOffset.y),
          z: P0.target.z + (endOffset.z - startOffset.z),
        };

  const startTarget =
    spec.from !== undefined
      ? resolveTargetPoint3D(spec.from, entitiesById, P0.target, startOffset)
      : {
          x: destTarget.x - (endOffset.x - startOffset.x),
          y: destTarget.y - (endOffset.y - startOffset.y),
          z: destTarget.z - (endOffset.z - startOffset.z),
        };

  return {
    x: startTarget.x + u * (destTarget.x - startTarget.x),
    y: startTarget.y + u * (destTarget.y - startTarget.y),
    z: startTarget.z + u * (destTarget.z - startTarget.z),
  };
}

/**
 * Evaluates the full SphericalPose for a camera mounted on a physical rig.
 *
 * Eye position is ALWAYS the rail sample `evaluateRigEyePosition(rig, u, fallbackEye)`.
 * `fallbackEyeOverride` is the deterministic per-cue rail fallback (previous shot's
 * terminal eye when continuous, otherwise the cue's authored start-pose eye); when
 * omitted it is derived from `P0` for standalone API callers.
 *
 * - Target-tracking mode: pitch / yaw / distance are reverse-solved from the
 *   eye -> target sightline; authored distance/pitch/yaw scalars are ignored.
 * - Fixed-gaze mode: authored (or forward-chained) pitch/yaw define the heading,
 *   and the anchor is projected forward along that heading at the authored distance.
 *
 * Both modes reconstruct the anchor from the eye, so `sphericalToCartesian(pose).position`
 * reproduces the rail eye exactly, including at degenerate sightlines.
 */
export function evaluateRigCameraPose(
  P0: SphericalPose,
  spec: CameraCueSpec,
  u: number,
  entitiesById: Map<string, EvaluatedEntityState>,
  baselinePose?: SphericalPose,
  startOffset: Vec3 = ZERO_OFFSET,
  destOffset?: Vec3,
  isContinuous = false,
  fallbackEyeOverride?: Vec3
): SphericalPose {
  const rig = spec.rig!;
  const startEye = fallbackEyeOverride ?? sphericalToCartesian(P0).position;
  const eye = evaluateRigEyePosition(rig, u, startEye);

  const endOffset =
    destOffset ?? resolveShotDestOffset(spec, startOffset, isContinuous);
  const effectiveBaseline = baselinePose ?? { ...P0, roll: 0 };
  const destRoll = resolveShotDestRoll(P0, spec, effectiveBaseline, isContinuous);

  const destFocalLength =
    spec.focalLengthEndMm ?? spec.focalLengthMm ?? P0.focalLengthMm;
  const focalLengthMm = P0.focalLengthMm + u * (destFocalLength - P0.focalLengthMm);

  const P1_proto: SphericalPose = {
    ...P0,
    roll: destRoll,
    focalLengthMm: destFocalLength,
  };
  const roll = interpolateRoll(P0, P1_proto, spec, u);

  // Branch A: Target-Tracking Mode — inverse look-at from the rail eye.
  if (spec.target !== undefined || spec.from !== undefined) {
    const currentTarget = resolveRigGazeTarget(
      spec,
      u,
      entitiesById,
      P0,
      startOffset,
      endOffset
    );
    return poseFromSightline(eye, currentTarget, focalLengthMm, roll, P0);
  }

  // Branch B: Fixed or Animated Gaze Mode (No Target Lock)
  let destYaw = P0.yaw;
  if (spec.yawEndRad !== undefined) {
    destYaw = spec.yawEndRad;
  } else if (spec.yawRad !== undefined) {
    destYaw = spec.yawRad;
  } else if (spec.yawDeltaRad !== undefined) {
    destYaw = P0.yaw + spec.yawDeltaRad;
  }

  const destPitch = spec.pitchEndRad ?? spec.pitchRad ?? P0.pitch;
  const currentPitch = clampRigPitch(P0.pitch + u * (destPitch - P0.pitch));
  const currentYaw = P0.yaw + u * shortestAngleDiff(destYaw, P0.yaw);

  const refDist = clampRigDistance(
    spec.distanceEnd ?? spec.distance ?? P0.distance
  );

  return {
    target: projectFixedGazeTarget(eye, refDist, currentPitch, currentYaw),
    distance: refDist,
    pitch: currentPitch,
    yaw: currentYaw,
    roll,
    focalLengthMm,
  };
}
