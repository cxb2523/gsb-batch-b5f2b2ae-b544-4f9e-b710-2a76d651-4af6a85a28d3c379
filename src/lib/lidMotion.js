import * as THREE from "three";

// Lid (screen mesh) endpoint angles.
// 180deg = fully closed (flush with the keyboard deck), 90deg = fully open.
export const CLOSED_ANGLE = THREE.MathUtils.degToRad(180);
export const OPEN_ANGLE = THREE.MathUtils.degToRad(90);

// Base pose of the whole laptop group (matches the original scene baseline).
export const BASE_POSITION = [0, -14, 20];
export const BASE_ROTATION = [0, 0, 0];

// Subtle linked motion of the whole laptop while the lid opens.
export const GROUP_LIFT_Y = 1.5; // rises slightly as it opens
export const GROUP_TILT_X = THREE.MathUtils.degToRad(-6); // leans back a touch

export const clamp01 = (value) => THREE.MathUtils.clamp(value, 0, 1);

// Smooth ease-in-out so the lid never jumps at the scroll endpoints.
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Scroll offset (any real number) -> eased open progress in [0, 1].
export const openProgress = (offset) => easeInOutCubic(clamp01(offset));

// Scroll offset -> lid angle in radians, always within [OPEN_ANGLE, CLOSED_ANGLE].
export const lidAngleForOffset = (offset) =>
  THREE.MathUtils.lerp(CLOSED_ANGLE, OPEN_ANGLE, openProgress(offset));

// Scroll offset -> whole-group pose linked to the lid motion.
export const groupPoseForOffset = (offset) => {
  const t = openProgress(offset);
  return {
    position: [
      BASE_POSITION[0],
      BASE_POSITION[1] + GROUP_LIFT_Y * t,
      BASE_POSITION[2],
    ],
    rotation: [
      BASE_ROTATION[0] + GROUP_TILT_X * t,
      BASE_ROTATION[1],
      BASE_ROTATION[2],
    ],
  };
};

// Frame-rate independent smoothing that still lands exactly on the target:
// damps toward the target and snaps once close enough, so endpoints are
// reached exactly and scroll reversal stays perfectly reversible.
export const dampWithSnap = (current, target, lambda, delta, epsilon = 1e-4) => {
  const next = THREE.MathUtils.damp(current, target, lambda, delta);
  return Math.abs(next - target) < epsilon ? target : next;
};
