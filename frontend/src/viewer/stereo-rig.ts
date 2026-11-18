// Per-eye viewports, baselines and eye validation for a head-tracked stereo
// window.
//
// The off-axis module builds one skewed view volume at a time. A side-by-side
// viewer has to keep two of them in lockstep: both eyes look through the same
// vertical extent and differ only sideways, each is drawn into its own half of
// the drawing buffer, and the baseline is capped against the *current* width of
// that half -- a width that changes every time the window is resized. This
// module holds that bookkeeping as pure functions so the rules can be measured
// without a graphics device, plus one small stateful guard for head input.
//
// Everything here is idempotent by construction: the planners are pure
// functions of their inputs and the eye guard stores exactly one position, so
// feeding the same inputs through again returns the same outputs rather than
// drifting.

import {
  MAX_SUPPORTED_EYE_Z,
  computeOffAxisFrustum,
  effectiveBaseline,
  sanitizeEye,
  type Eye,
  type Frustum,
} from './off-axis';

export type EyeSide = 'left' | 'right';

export type EyeViewport = {
  /** Normalized device rect, as PlayCanvas's camera.rect expects. */
  rect: { x: number; y: number; z: number; w: number };
  /** Pixel width of this eye's share of the drawing buffer. */
  widthPx: number;
  /** Pixel height of the drawing buffer. */
  heightPx: number;
  /** Width divided by height for this eye's viewport. */
  aspect: number;
};

/**
 * Split the drawing buffer between the two eyes.
 *
 * In side-by-side each eye owns exactly half the width and the full height; in
 * mono the single centre eye owns the whole buffer. The two halves are always
 * the same size, which is what lets one baseline and one vertical field of view
 * serve both eyes.
 *
 * Widths are computed from the buffer size on every call rather than remembered,
 * so a resize cannot leave a viewport or a clamp computed against stale pixels.
 */
export function eyeViewports(
  canvasWidthPx: number,
  canvasHeightPx: number,
  stereo: boolean,
): { left: EyeViewport; right: EyeViewport } {
  const width = Number.isFinite(canvasWidthPx) && canvasWidthPx > 0 ? canvasWidthPx : 1;
  const height = Number.isFinite(canvasHeightPx) && canvasHeightPx > 0 ? canvasHeightPx : 1;
  if (!stereo) {
    const full: EyeViewport = {
      rect: { x: 0, y: 0, z: 1, w: 1 },
      widthPx: width,
      heightPx: height,
      aspect: width / height,
    };
    return { left: full, right: full };
  }
  const halfWidth = width / 2;
  const half: Omit<EyeViewport, 'rect'> = {
    widthPx: halfWidth,
    heightPx: height,
    aspect: halfWidth / height,
  };
  return {
    left: { rect: { x: 0, y: 0, z: 0.5, w: 1 }, ...half },
    right: { rect: { x: 0.5, y: 0, z: 0.5, w: 1 }, ...half },
  };
}

/**
 * The baseline after compression and the far-field pixel clamp.
 *
 * The clamp is expressed in pixels of one eye's viewport, so the effective
 * baseline must be recomputed with that viewport's current width whenever the
 * window changes size. Passing a stale width from before a resize would cap the
 * background against a separation measured in pixels that no longer exist.
 *
 * It bounds the far field only: the closed form in off-axis's
 * `effectiveBaseline` caps the asymptotic background separation, and near-field
 * pop-out grows without regard to the cap, as it must.
 */
export function clampedBaseline({
  baseline,
  compression,
  clampPx,
  eyeViewport,
  zeroParallaxDistance,
  fovYDeg,
}: {
  baseline: number;
  compression: number;
  clampPx: number;
  eyeViewport: EyeViewport;
  zeroParallaxDistance: number;
  fovYDeg: number;
}): number {
  return effectiveBaseline({
    baseline,
    compression,
    clampPx,
    eyeViewportWidthPx: eyeViewport.widthPx,
    zeroParallaxDistance,
    fovYDeg,
    aspect: eyeViewport.aspect,
  });
}

export type EyeRig = {
  /** Which eye this is. */
  side: EyeSide;
  /** Where the eye entity is placed, relative to the head centre. */
  position: Eye;
  /** Horizontal displacement from the head centre, in scene units. */
  offsetX: number;
  frustum: Frustum;
  viewport: EyeViewport;
};

export type StereoRigInput = {
  /** Head centre in window units; must already have passed an eye guard. */
  centre: Eye;
  stereo: boolean;
  /** Effective (already clamped) baseline; 0 for mono. */
  baseline: number;
  /** Half height of the virtual window, in scene units. */
  windowHalfHeight: number;
  viewports: { left: EyeViewport; right: EyeViewport };
  near: number;
  far: number;
};

/**
 * The two view volumes for a head-tracked window.
 *
 * Both eyes share the head centre's depth and vertical position, and are moved
 * apart sideways by half the baseline without any rotation. The screen half
 * extents are the same for both, so `top` and `bottom` come out identical by
 * construction: any vertical difference between the images is therefore
 * impossible, and a point on the zero-parallax plane projects to the same
 * horizontal place in both eyes as well.
 *
 * Mono is the same rig with a zero baseline and a full-width viewport, so there
 * is a single code path for the two modes.
 */
export function planStereoRig({
  centre,
  stereo,
  baseline,
  windowHalfHeight,
  viewports,
  near,
  far,
}: StereoRigInput): { left: EyeRig; right: EyeRig } {
  const build = (side: EyeSide, viewport: EyeViewport): EyeRig => {
    const offsetX = !stereo ? 0 : (side === 'left' ? -baseline / 2 : baseline / 2);
    const halfWidth = windowHalfHeight * viewport.aspect;
    const eye: Eye = { x: centre.x + offsetX, y: centre.y, z: centre.z };
    const frustum = computeOffAxisFrustum({
      eyeX: eye.x,
      eyeY: eye.y,
      eyeZ: eye.z,
      screenHalfWidth: halfWidth,
      screenHalfHeight: windowHalfHeight,
      near,
      far,
    });
    return { side, position: eye, offsetX, frustum, viewport };
  };
  return {
    left: build('left', viewports.left),
    right: build('right', viewports.right),
  };
}

/**
 * Head input that survives a tracker losing the face.
 *
 * A live face tracker can hand back NaN, an infinite coordinate or a
 * non-positive distance, and a degenerate eye produces a degenerate frustum
 * rather than an obvious failure. Such a sample is rejected and the last
 * accepted eye is replayed instead, so one bad frame neither crashes the render
 * loop nor visibly jumps. A finite distance is additionally clamped to the
 * supported range exactly as `sanitizeEye` does, so an implausibly far reading
 * is a clamped reading rather than a rejection.
 *
 * The first accepted position becomes the fallback until a better one arrives.
 * Re-feeding the same input returns the same eye: no filtering, no accumulated
 * state beyond the single stored position.
 */
export class TrackedEyeGuard {
  private last: Eye | null = null;

  constructor(initial?: Eye | null) {
    if (initial) {
      try {
        this.last = sanitizeEye(initial);
      } catch {
        this.last = null;
      }
    }
  }

  /** The most recent accepted eye, or null before one has been seen. */
  get current(): Eye | null {
    return this.last ? { ...this.last } : null;
  }

  /**
   * Validate a tracker sample.
   *
   * Returns the sanitized eye and records it when the sample is usable;
   * otherwise returns the previous eye unchanged. When there is no previous
   * eye either, returns null so the caller can keep whatever neutral view it
   * already holds rather than inventing a position.
   */
  update(candidate: Partial<Eye> | null | undefined): { eye: Eye; fellBack: boolean } | null {
    if (isFiniteEye(candidate)) {
      try {
        const eye = sanitizeEye(candidate);
        this.last = eye;
        return { eye: { ...eye }, fellBack: false };
      } catch {
        // Fall through to the stored position.
      }
    }
    if (!this.last) return null;
    return { eye: { ...this.last }, fellBack: true };
  }

  /** Forget the stored eye, e.g. when tracking is stopped or recentered. */
  reset(initial?: Eye | null): void {
    if (initial) {
      try {
        this.last = sanitizeEye(initial);
        return;
      } catch {
        // Fall through to empty.
      }
    }
    this.last = null;
  }
}

function isFiniteEye(candidate: Partial<Eye> | null | undefined): candidate is Eye {
  return Boolean(
    candidate
      && Number.isFinite(candidate.x)
      && Number.isFinite(candidate.y)
      && Number.isFinite(candidate.z),
  );
}

/**
 * The largest distance the guard will accept, re-exported so callers have one
 * place to name the bound the eye distance is clamped to.
 */
export const MAX_EYE_Z = MAX_SUPPORTED_EYE_Z;
