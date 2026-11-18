import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MASK_BASE_RADIUS, MASK_PLOT_INSET, MASK_HARMONICS, maskPhases } from "../terrain";
import { useDisposableMemo } from "./useDisposableMemo";
import { coastWobbleGlsl } from "./townCoast";

/**
 * The sea.
 *
 * ## Why this stopped being a `meshStandardMaterial`
 *
 * Scenery-craft round. The author's verdict on two previous attempts was
 * "water looks bad and grass and so on" and, when asked whether the first
 * fix helped, "still". Retuning hex values had already been tried twice and
 * failed twice, so this round measured the thing itself instead of guessing
 * again — and the measurement says the hex values were never the problem:
 *
 * `WATER_COLOR` was `#18bbcc`, a vivid cyan. The sea rendered a dull
 * grey-green. It rendered a dull grey-green because the water was a
 * `meshStandardMaterial` lit by this scene's own lighting — a warm
 * hemisphere fill (`#ffe6bd`) plus a warm directional sun (`#ffcf94` at
 * intensity 2.2, ~1.8 units of irradiance on an up-facing surface between
 * them) — and then ACES tone-mapped. Multiply a cyan by nearly two units of
 * amber light and compress it, and you get olive. No cyan survives that, at
 * any saturation: the previous round's own measurements (a flat 76%
 * saturation swatch rendering at 61%) were the same finding, read as a
 * reason to push the number higher rather than as a reason to stop putting
 * water through that pipeline at all.
 *
 * Water in this genre is essentially never a PBR surface. Its colour is
 * AUTHORED — you decide what the sea looks like and the sun adds a glint on
 * top, rather than the sun deciding what colour the sea is. That is what
 * this shader does, and it is why the same hue finally reads as the hue it
 * was picked to be.
 *
 * ## What it draws
 *
 * One material, two modes, so the open sea and every island's shallows are
 * literally the same surface and can never seam against each other:
 *
 * - `MODE_OPEN` — the one big background plane per scene. Deep colour,
 *   opaque.
 * - `MODE_ISLAND` — a per-island quad laid over that plane, whose
 *   "shoreness" is evaluated PER PIXEL from the very same wobbled coastline
 *   `terrain.ts`'s `islandMask` traces (shared via `maskPhases` /
 *   `MASK_HARMONICS`, never hand-copied). Shallow bands, a wet-sand tone and
 *   a foam line therefore hug the real, organic shore instead of a circle
 *   roughly near it.
 * - `MODE_RECT` — the same thing for `TownView`, whose ground is a
 *   deliberately rectangular safe dome (see `terrain.ts`'s `safeDomeHeight`)
 *   rather than a masked island: shoreness comes from a rounded-rectangle
 *   distance field with its own gentle angular wobble, so a town gets a
 *   beach and a surf line instead of a rug's straight edge.
 *
 * Every mode's alpha fades to exactly zero before its own quad's edge, which
 * is what makes overlapping island shelves (152 of them, in a dense sea)
 * impossible to see the boundaries of. The previous implementation blended
 * two independently-computed gradients and left a visible hard-edged
 * rectangle around every island — plainly visible in this round's "before"
 * renders, and the actual source of the "patchwork" look an earlier round
 * believed it had already fixed.
 *
 * ## Cost, and the render-loop guarantee
 *
 * Cheaper than what it replaces, in both geometry and per-frame CPU:
 *
 * - Geometry per island went from an 11x11 vertex-coloured gradient plane
 *   (121 vertices) to a TWO-TRIANGLE quad. All the structure is in the
 *   fragment shader now, so it is also resolution-independent rather than
 *   tessellation-limited.
 * - The big ocean plane went from 41x41 (or 49x49) vertices, rewritten on
 *   the CPU every single frame by a `useFrame` loop, to 4 vertices and one
 *   `uniform` write. Waves are analytic — the shader knows the wave
 *   function's derivative, so it can shade a moving surface without anything
 *   ever moving.
 *
 * The one per-frame cost is writing `uTime` and `uViewDir`, inside a
 * `useFrame` that **never calls `invalidate()`**. That matters: this project
 * has already shipped the bug where an `invalidate()` inside `useFrame` made
 * a `frameloop="demand"` scene self-sustaining and it never went idle when
 * blurred. A `useFrame` body that only writes uniforms cannot do that — it
 * runs when a frame is already being rendered and has no way to ask for the
 * next one. `App.tsx`'s `useWindowFocused` remains the only thing that
 * chooses `"always"`, and only while the window is genuinely focused.
 *
 * ## One material per (mode, palette) — never one per island
 *
 * A previous version built a `ShaderMaterial` per island: 152 islands meant
 * 152 copies of the same uniforms, the same shader source, and 152 material
 * objects for three.js to track — all so that each island could hold its own
 * `uPhases`/`uHalf`. That also made the palette a construction-time input,
 * which is why switching to night used to replace every material wholesale
 * (rebuilding the shader program's parameter set, re-cloning fog uniforms,
 * and re-tracking 152 GPU resources on every ⇧M).
 *
 * The material is now keyed by (mode, palette) and shared: in a scene there
 * is ONE open-sea material, ONE material for all island shelves, and ONE for
 * the town's shelf. The per-island values that genuinely differ —
 * `uPhases`, `uHalf`, `uQuadHalf`, and the town's shelf geometry — are
 * written at DRAW TIME from each mesh's `onBeforeRender`, immediately before
 * three.js binds the material for that mesh (see `applyIslandUniforms` /
 * `applyTownUniforms`). The uniforms live on the shared material (three.js
 * uploads `material.uniforms` itself, not a per-object copy), so each draw
 * writes its own values and forces them through with
 * `material.uniformsNeedUpdate`; nothing else about the material changes.
 *
 * Palette is part of the key, so a mood switch acquires a NEW shared
 * material per mode (all six colour uniforms — deep/mid/shallow/sandy/foam/
 * glint — rebuilt from the new palette, so foam, caustics and the surf line
 * inherit it too), while every already-mounted open-sea/island/town mesh
 * simply re-renders against that new material on the next frame. No geometry
 * is rebuilt and no coastline phase is recomputed or lost: the same
 * `maskPhases(seed)` and the same `width`/`depth` are re-applied to the new
 * material by the exact same `onBeforeRender`.
 *
 * Because materials are shared, ownership is reference-counted
 * (`acquireWaterMaterial` returns a lease whose `retain`/`release` are paired
 * from a layout effect): an island unmounting decrements the count and only
 * the LAST user of a material disposes it. `useDisposableMemo` still owns
 * the lease's lifetime, so a replaced palette's lease is dropped at exactly
 * the moment that hook would dispose a per-island material — but because the
 * release is refcounted, the predecessor material is freed only once the
 * last mesh has let go, never while a sibling island is still drawing with
 * it.
 */

// ---------------------------------------------------------------------
// Modes (mirrored as GLSL `const int`s below — keep the two in step).
// ---------------------------------------------------------------------
/** The open sea: deep colour everywhere, fully opaque. */
export const MODE_OPEN = 0;
/** A sea island's shallows, shaped by `terrain.ts`'s seeded coastline. */
export const MODE_ISLAND = 1;
/** A town's shallows, shaped by its rectangular footprint. */
export const MODE_RECT = 2;

/**
 * How far past the coastline the shallow shelf reaches, as a multiple of the
 * island's own coastline radius. `1.0` is the shore itself. Kept modest on
 * purpose: a wide halo around every island is what turned the old sea into
 * soup once 73 of them overlapped.
 */
const ISLAND_SHELF_OUTER = 1.4;
/**
 * The shelf quad's own half-extent, as a multiple of the island's half
 * footprint. Must be large enough that shoreness has already reached 0
 * before the quad ends, at the WORST case — the widest the seeded coastline
 * wobble can push the boundary out (`MASK_BASE_RADIUS * (1 + sum of
 * harmonics)`). Checked by `waterShelfQuadCovers` below, which is unit
 * tested rather than asserted in a comment, because getting this wrong
 * reintroduces exactly the visible rectangle this round removed.
 */
const ISLAND_SHELF_QUAD = 2.0;

/** The widest the seeded coastline wobble can ever push the boundary. */
const MAX_BOUNDARY = MASK_BASE_RADIUS * (1 + MASK_HARMONICS[0] + MASK_HARMONICS[1] + MASK_HARMONICS[2]);

/**
 * Whether a shelf quad of half-extent `quadFactor` (in units of the
 * island's half footprint) is big enough that shoreness has fallen to zero
 * by the time it reaches the quad's own edge, for EVERY seed.
 *
 * The worst case is the quad's edge MIDPOINT (the closest point of the quad
 * boundary to the centre) at the angle where the seeded wobble pushes the
 * coastline furthest out — a bigger boundary means a smaller normalized
 * radius `r = dist / boundary`, i.e. shoreness that has not yet decayed.
 * Exported purely so this has a test rather than a promise.
 */
export function waterShelfQuadCovers(quadFactor: number, shelfOuter: number): boolean {
  return quadFactor / MAX_BOUNDARY >= shelfOuter;
}

// ---------------------------------------------------------------------
// The shader.
// ---------------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

// Plot-local XZ (the quad's own centre is the island/town centre) — used for
// shoreness, which must be in the SAME space terrain.ts normalizes in.
varying vec2 vLocal;
// World XZ — used for the wave field, so waves run continuously across the
// open sea and every island's shelf instead of restarting per quad.
varying vec2 vWorld;

void main() {
  vLocal = position.xz;
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorld = worldPosition.xz;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

const int MODE_OPEN = 0;
const int MODE_ISLAND = 1;
const int MODE_RECT = 2;

uniform int uMode;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uSandy;
uniform vec3 uFoam;
uniform vec3 uGlint;
uniform vec3 uSunDir;
uniform vec3 uViewDir;
uniform float uTime;
// MODE_ISLAND: the three seeded coastline phases and the island's half
// footprint, so the shader can evaluate terrain.ts's own boundary curve.
uniform vec3 uPhases;
uniform vec2 uHalf;
uniform vec2 uQuadHalf;
uniform float uShelfOuter;
// MODE_RECT: how far, in world units, the town's shelf reaches past its own
// rectangular ground.
uniform float uShelfWidth;
// MODE_RECT with a coast (townCoast.ts): the coast's width, and where along
// it (0..1) the land meets the water. 0 = no coast, the ground's own edge is
// the shore.
uniform float uCoast;
uniform float uCoastT;

${coastWobbleGlsl()}

varying vec2 vLocal;
varying vec2 vWorld;

// --- noise -------------------------------------------------------------
// Hash-based value noise and a moving Voronoi. Noise, not sines: a sum of
// sines tiles into a regular lattice of highlights across the open sea (the
// evenly spaced pale blobs the previous version drew), and nothing in real
// water repeats on a grid.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}
// Moving Voronoi: .x is the distance to the nearest cell point, .y the
// distance to the nearest cell EDGE — the edges are the bright net of
// caustics, the points the clumps of shore foam.
vec2 voronoi(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = 0.5 + 0.5 * sin(t + 6.2831 * hash22(n + g));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  float ed = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = 0.5 + 0.5 * sin(t + 6.2831 * hash22(n + g));
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 0.00001) ed = min(ed, dot(0.5 * (mr + r), normalize(r - mr)));
    }
  }
  return vec2(sqrt(md), ed);
}
// The small-scale surface, as a height field: two layers of noise drifting
// against each other, so the pattern churns instead of sliding.
float ripple(vec2 p, float t) {
  return vnoise(p * 0.55 + vec2(t * 0.16, t * 0.07)) * 0.6
       + vnoise(p * 1.3 - vec2(t * 0.09, -t * 0.13)) * 0.4;
}

void main() {
  // --- how shallow is this pixel, 0 (open sea) .. 1 (right at the land) ---
  float shore = 0.0;
  float quadFade = 1.0;

  if (uMode == MODE_ISLAND) {
    vec2 uv = vLocal / uHalf;
    float dist = length(uv);
    float ang = atan(uv.y, uv.x);
    // The identical curve terrain.ts's maskBoundary computes -- same base
    // radius, same three harmonics, same seeded phases (passed in as
    // uPhases), so foam lands on the real coastline rather than near it.
    float boundary = ${MASK_BASE_RADIUS.toFixed(4)} * (1.0
      + ${MASK_HARMONICS[0].toFixed(4)} * sin(2.0 * ang + uPhases.x)
      + ${MASK_HARMONICS[1].toFixed(4)} * sin(3.0 * ang + uPhases.y)
      + ${MASK_HARMONICS[2].toFixed(4)} * sin(5.0 * ang + uPhases.z));
    float plotLimit = ${MASK_PLOT_INSET.toFixed(4)} / pow(pow(abs(cos(ang)), 4.0) + pow(abs(sin(ang)), 4.0), 0.25);
    boundary = min(boundary, plotLimit);
    float r = dist / max(boundary, 0.001);
    shore = clamp((uShelfOuter - r) / max(uShelfOuter - 1.0, 0.001), 0.0, 1.0);
    vec2 q = abs(vLocal) / uQuadHalf;
    quadFade = 1.0 - smoothstep(0.74, 0.99, max(q.x, q.y));
  } else if (uMode == MODE_RECT) {
    // Rounded-rectangle distance field: negative inside the town's own
    // ground rectangle, growing outward past it.
    vec2 q = abs(vLocal) - uHalf;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float ang = atan(vLocal.y, vLocal.x);
    // A gentle angular wobble on the shelf WIDTH (never on the land itself,
    // which stays exactly the honest rectangle it always was) so the beach
    // reads as a coast rather than a picture frame.
    float wob = 1.0 + 0.34 * sin(2.0 * ang + 0.9) + 0.20 * sin(3.0 * ang - 2.1) + 0.11 * sin(5.0 * ang + 0.4);
    // Distance past the actual waterline: the coast's own wobbled edge when
    // the town has one, the rectangle's edge when it does not.
    float pastShore = sd - uCoast * uCoastT * coastWobble(ang);
    shore = clamp(1.0 - pastShore / max(uShelfWidth * wob, 0.001), 0.0, 1.0);
    vec2 qq = abs(vLocal) / uQuadHalf;
    quadFade = 1.0 - smoothstep(0.74, 0.99, max(qq.x, qq.y));
  }

  // --- level of detail ---------------------------------------------------
  // World units per pixel. Every pattern below fades out before its own
  // scale drops under a couple of pixels, so the same material stays clean
  // at the sea's wide zoom (~1.2 units/px) and rich at a town's (~0.07):
  // patterns that shimmer or alias are what make water read as cheap.
  float px = fwidth(vWorld.x) + fwidth(vWorld.y);
  float lodFine = 1.0 - smoothstep(0.06, 0.22, px);
  float lodMid = 1.0 - smoothstep(0.15, 0.6, px);
  float lodBroad = 1.0 - smoothstep(0.8, 3.0, px);
  float t = uTime;

  // --- depth ---------------------------------------------------------------
  // The shelf edge is warped by slow noise, so the shallows have bays and
  // points instead of following the coast like a contour line.
  float warp = (fbm(vWorld * 0.09 + vec2(t * 0.015, -t * 0.01)) - 0.5) * 0.16;
  float s = clamp(shore + warp * (0.3 + 0.7 * shore), 0.0, 1.0);

  vec3 col = uDeep;
  col = mix(col, uMid, smoothstep(0.0, 0.6, s));
  col = mix(col, uShallow, smoothstep(0.45, 0.9, s));
  col = mix(col, uSandy, smoothstep(0.93, 0.985, s));
  // The land's shadow in its own water — the cue that sits an island IN the
  // sea rather than on a picture of it.
  col *= 1.0 - 0.1 * smoothstep(0.5, 0.72, s) * (1.0 - smoothstep(0.78, 0.92, s));

  // Deep water is never one flat value: slow, drifting darker pools and
  // lighter streaks, at a scale that reads at every zoom.
  float pools = fbm(vWorld * 0.018 + vec2(t * 0.006, t * 0.004));
  col *= mix(1.0, 0.86 + 0.26 * pools, 1.0 - smoothstep(0.35, 0.8, s));

  // --- the surface ---------------------------------------------------------
  // A normal from the ripple height field (finite differences, sized to the
  // pixel so it never samples finer than it can show).
  float e = max(0.12, px);
  float h0 = ripple(vWorld, t);
  float hx = ripple(vWorld + vec2(e, 0.0), t);
  float hz = ripple(vWorld + vec2(0.0, e), t);
  vec3 normal = normalize(vec3((h0 - hx) / e * 0.35 * lodMid, 1.0, (h0 - hz) / e * 0.35 * lodMid));

  // --- caustics ------------------------------------------------------------
  // Light focused by the ripples onto the shallow sand: a churning net of
  // bright cell edges, strongest over the shallows and gone in deep water
  // and on the beach itself.
  float causticZone = smoothstep(0.4, 0.72, s) * (1.0 - smoothstep(0.92, 0.965, s)) * lodMid;
  if (causticZone > 0.001) {
    vec2 cp = vWorld * 0.55 + vec2(fbm(vWorld * 0.2 + t * 0.05), fbm(vWorld * 0.2 - t * 0.04)) * 1.2;
    float c1 = voronoi(cp, t * 0.9).y;
    float c2 = voronoi(cp * 1.7 + 3.1, t * 1.2).y;
    float net = (1.0 - smoothstep(0.0, 0.16, c1)) * 0.65 + (1.0 - smoothstep(0.0, 0.11, c2)) * 0.4;
    // RELATIVE light, not white: brighter shallows by day, a faint shimmer
    // by night — mixing toward pure white lit the night lagoon like a web.
    vec3 causticLight = uShallow * 1.55 + uGlint * 0.1;
    col = mix(col, causticLight, clamp(net, 0.0, 1.0) * 0.32 * causticZone);
  }

  // --- foam ----------------------------------------------------------------
  // 1. Lines of surf rolling in toward the shore and dying on it: bands of
  //    constant depth that march inward over time, broken up by noise so
  //    they read as surf, not as rings. Faded out wherever the shelf is too
  //    few pixels across for a line to be a line.
  float linesLod = 1.0 - smoothstep(0.012, 0.035, fwidth(s));
  float band = fract(s * 5.0 - t * 0.22);
  float line = smoothstep(0.0, 0.05, band) * (1.0 - smoothstep(0.05, 0.13, band));
  float broken = smoothstep(0.38, 0.62, vnoise(vWorld * 0.7 + vec2(t * 0.1, 0.0)));
  float surfZone = smoothstep(0.62, 0.8, s) * (1.0 - smoothstep(0.955, 0.975, s));
  float surf = line * broken * surfZone * linesLod;
  // 2. The waterline itself: clumpy, churning foam where water meets sand,
  //    with a darker wet edge just behind it that gives it thickness.
  float edgeZone = smoothstep(0.935, 0.965, s) * (1.0 - smoothstep(0.985, 0.998, s));
  float clumps = 1.0;
  if (edgeZone > 0.001) {
    float v = voronoi(vWorld * 1.6 + vec2(t * 0.12, -t * 0.08), t * 0.6).x;
    clumps = mix(1.0, smoothstep(0.62, 0.3, v), lodFine);
  }
  float edgeFoam = edgeZone * clumps;
  col *= 1.0 - 0.18 * smoothstep(0.9, 0.94, s) * (1.0 - smoothstep(0.945, 0.965, s));
  col = mix(col, uFoam, clamp(surf * 0.55 + edgeFoam * 0.9, 0.0, 1.0));

  // --- light ---------------------------------------------------------------
  vec3 halfVec = normalize(uSunDir + uViewDir);
  float ndh = max(dot(normal, halfVec), 0.0);
  // A broad sheen gives the sea a direction — brighter toward the sun.
  col += uGlint * pow(ndh, 4.0) * 0.05;
  // Sun sparkle: tight highlights that twinkle as the ripples turn, only
  // where the pixel can hold them.
  float sparkle = pow(ndh, 220.0) * lodFine;
  sparkle *= smoothstep(0.55, 0.9, vnoise(vWorld * 2.4 + t * 1.7));
  col += uGlint * sparkle * 1.6;
  // Fading in later than the colour ramp starts keeps the outermost, most
  // overlapped part of every shelf nearly invisible — with 152 islands in a
  // dense sea, shelves that reach far and fade late stack into soup.
  float alpha = uMode == MODE_OPEN ? 1.0 : smoothstep(0.05, 0.40, s) * quadFade;

  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export type WaterColors = {
  deep: string;
  mid: string;
  shallow: string;
  sandy: string;
  foam: string;
  glint: string;
};

/**
 * The sun's world direction, as a unit vector pointing FROM the scene TOWARD
 * the sun, plus the raw offsets it comes from. `TownView`'s `SunLight`
 * positions its directional light from `SUN_OFFSET` and the water shader
 * takes its glint direction from `SUN_DIRECTION`, so the sparkle on the sea
 * is guaranteed to sit under the actual sun — two hand-copied vectors
 * drifting apart would put it on the wrong side of the water, and this
 * codebase has a documented history of exactly that kind of drift
 * (`phase-0-followups.md` §6).
 */
export const SUN_OFFSET = new THREE.Vector3(1.3, 0.95, 1.4);
export const SUN_DIRECTION = SUN_OFFSET.clone().normalize();

// ---------------------------------------------------------------------
// The material itself, and why it is shared.
// ---------------------------------------------------------------------

function makeWaterMaterial(colors: WaterColors, mode: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uMode: { value: mode },
      uDeep: { value: new THREE.Color(colors.deep) },
      uMid: { value: new THREE.Color(colors.mid) },
      uShallow: { value: new THREE.Color(colors.shallow) },
      uSandy: { value: new THREE.Color(colors.sandy) },
      uFoam: { value: new THREE.Color(colors.foam) },
      uGlint: { value: new THREE.Color(colors.glint) },
      uSunDir: { value: SUN_DIRECTION.clone() },
      uViewDir: { value: new THREE.Vector3(0.646, 0.530, 0.646) },
      uTime: { value: 0 },
      uPhases: { value: new THREE.Vector3() },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uQuadHalf: { value: new THREE.Vector2(1, 1) },
      uShelfOuter: { value: ISLAND_SHELF_OUTER },
      uShelfWidth: { value: 1 },
      uCoast: { value: 0 },
      uCoastT: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    fog: true,
    transparent: mode !== MODE_OPEN,
    // Overlapping island shelves sit at one shared Y. Writing depth would
    // make them z-fight each other; not writing it lets them blend, while
    // `depthTest` still keeps them correctly hidden under the land.
    depthWrite: mode === MODE_OPEN,
  });
}

/** The identity of a shared material: every mode's shelf is a different
 * shape, and every palette is a different set of six colours. Two callers
 * asking for the same pair must get the same material; the palette is part
 * of the key so a mood switch can never silently keep drawing last mood's
 * foam or caustics. */
export function waterMaterialKey(colors: WaterColors, mode: number): string {
  return [mode, colors.deep, colors.mid, colors.shallow, colors.sandy, colors.foam, colors.glint].join("\u0000");
}

/** A shared material plus the bookkeeping that keeps it alive while any mesh
 * still draws with it.
 *
 * `dispose()` is required because the lease is the value `useDisposableMemo`
 * owns and may replace/unmount (that is how the material's lifetime follows
 * the resource-hygiene hook). It is deliberately a NO-OP on the material:
 * the actual refcount is `retain`/`release`, called in pairs from a layout
 * effect. Doing the release here too would double-release a material shared
 * by sibling islands, and a `useMemo`-factory acquire would leak a reference
 * under React's development-only StrictMode double-invoke. */
export type WaterMaterialLease = {
  readonly material: THREE.ShaderMaterial;
  retain(): void;
  release(): void;
  dispose(): void;
};

type SharedEntry = {
  material: THREE.ShaderMaterial;
  /** How many live meshes are drawing with this material right now. */
  refs: number;
  /** True between a release-to-zero and the deferred disposal running. It
   * exists so a StrictMode setup→cleanup→setup replay (synchronous, no await)
   * cannot dispose a material the second setup is about to retain again. */
  disposeScheduled: boolean;
  lease: WaterMaterialLease;
};

/**
 * Every water material currently alive, keyed by `waterMaterialKey`. This is
 * a module-level cache on purpose: sharing is a property of the material,
 * not of any one mesh, so the 152nd island's shelf must find the material the
 * first one built. Entries are created on demand and removed by the LAST
 * holder (`release`), never by whichever island happened to unmount first.
 *
 * One assumption this module makes: only ONE water-bearing `<Canvas>` is
 * mounted at a time. `App.tsx` switches between the sea and a town as a hard
 * swap (never both), and `townshot.tsx` renders one view; a single
 * `ShaderMaterial` cannot be correctly driven by two renderers at once, so if
 * that ever changes, the cache must become per-canvas (e.g. keyed by the r3f
 * store) rather than module-global.
 */
const sharedWaterMaterials = new Map<string, SharedEntry>();

/** Runs `fn` after the current synchronous commit. A microtask is enough:
 * layout effects (which retain) all run synchronously before it fires, so a
 * still-live material is never disposed, while a genuinely orphaned one is
 * cleaned up a tick later. */
function deferDispose(fn: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(fn);
  else Promise.resolve().then(fn);
}

function disposeEntryWhenUnused(key: string, entry: SharedEntry): void {
  if (entry.refs > 0 || entry.disposeScheduled) return;
  entry.disposeScheduled = true;
  deferDispose(() => {
    // This callback is now consumed; clear the flag unconditionally. If the
    // entry survived (see below), a FUTURE release must be able to arm a
    // fresh disposal — leaving the flag set would strand the material.
    entry.disposeScheduled = false;
    // Someone retained it again (StrictMode replay, or a sibling still live):
    // its later release re-arms this, so leave the entry alone. Layout-effect
    // retains run synchronously within the commit, before this microtask
    // fires, so this check alone is what protects a re-acquired material —
    // no generation counter is needed.
    if (entry.refs > 0) return;
    if (sharedWaterMaterials.get(key) === entry) sharedWaterMaterials.delete(key);
    entry.material.dispose();
  });
}

/** The shared lease for (mode, palette), creating the material the first time.
 * Idempotent and refcount-free: calling it twice for the same key (React
 * StrictMode does exactly that to a `useMemo` factory) returns the one lease
 * and creates at most one material. The refcount lives in the paired effect
 * (`useSharedWaterMaterial`), which React replays setup/cleanup/setup
 * symmetrically. */
export function acquireWaterMaterial(colors: WaterColors, mode: number): WaterMaterialLease {
  const key = waterMaterialKey(colors, mode);
  const existing = sharedWaterMaterials.get(key);
  if (existing) {
    // A prior holder may have released to zero with disposal queued. This
    // acquisition takes the entry over: clear the flag before its layout
    // effect retains. (Even without this clear, the queued callback's own
    // `refs > 0` check would spare it — belt and braces for readability.)
    existing.disposeScheduled = false;
    return existing.lease;
  }

  const entry = { material: makeWaterMaterial(colors, mode), refs: 0, disposeScheduled: false } as SharedEntry;
  entry.lease = {
    material: entry.material,
    retain() {
      entry.refs += 1;
    },
    release() {
      entry.refs = Math.max(0, entry.refs - 1);
      disposeEntryWhenUnused(key, entry);
    },
    dispose() {
      // No-op by design — see `WaterMaterialLease`'s own comment. The layout
      // effect paired with this lease is what releases it; `useDisposableMemo`
      // only decides when this lease stops being the current one.
    },
  };
  sharedWaterMaterials.set(key, entry);
  return entry.lease;
}

/** Test/observability hook: how many distinct shared water materials exist. */
export function sharedWaterMaterialCount(): number {
  return sharedWaterMaterials.size;
}

/** How many live meshes are drawing with the material for this pair. */
export function waterMaterialRefs(colors: WaterColors, mode: number): number {
  return sharedWaterMaterials.get(waterMaterialKey(colors, mode))?.refs ?? 0;
}

/**
 * Write one island's own coastline parameters onto the SHARED island
 * material, immediately before that island's mesh is drawn.
 *
 * A shared material holds one set of uniform values. Two islands draw with
 * the same material in the same frame, so each has to stake its own values
 * onto it just before its own draw — which is exactly what three.js calls
 * `mesh.onBeforeRender` for. `uniformsNeedUpdate` then forces those values up
 * to the GPU even though three.js would otherwise skip re-uploading a
 * material it has already bound earlier in the same frame.
 *
 * `phases` and the half-extents come straight from `maskPhases(seed)` and the
 * island's real `width`/`depth`, so sharing a material across palettes and
 * islands can never blur one island's coastline into another's.
 */
export function applyIslandUniforms(
  material: THREE.ShaderMaterial,
  phases: readonly [number, number, number],
  halfWidth: number,
  halfDepth: number,
  quadHalfWidth: number,
  quadHalfDepth: number,
): void {
  (material.uniforms.uPhases.value as THREE.Vector3).set(phases[0], phases[1], phases[2]);
  (material.uniforms.uHalf.value as THREE.Vector2).set(halfWidth, halfDepth);
  (material.uniforms.uQuadHalf.value as THREE.Vector2).set(quadHalfWidth, quadHalfDepth);
  material.uniformsNeedUpdate = true;
}

/** The town equivalent of `applyIslandUniforms`: the same per-draw stake, for
 * `MODE_RECT`'s rectangular footprint and (optional) coast. */
export function applyTownUniforms(
  material: THREE.ShaderMaterial,
  halfWidth: number,
  halfDepth: number,
  quadHalfWidth: number,
  quadHalfDepth: number,
  shelfWidth: number,
  coast: number,
  coastT: number,
): void {
  (material.uniforms.uHalf.value as THREE.Vector2).set(halfWidth, halfDepth);
  (material.uniforms.uQuadHalf.value as THREE.Vector2).set(quadHalfWidth, quadHalfDepth);
  material.uniforms.uShelfWidth.value = shelfWidth;
  material.uniforms.uCoast.value = coast;
  material.uniforms.uCoastT.value = coastT;
  material.uniformsNeedUpdate = true;
}

/**
 * The shared material for (mode, palette), acquired through
 * `useDisposableMemo` so the lease is replaced when the palette (or mode)
 * genuinely changes and dropped on unmount — and retained/released from a
 * paired effect so the underlying material outlives any one island and is
 * only disposed once the LAST holder has let go.
 */
function useSharedWaterMaterial(colors: WaterColors, mode: number): WaterMaterialLease {
  // Keying the dependency on the palette's CONTENT (not the object identity)
  // means a caller constructing a fresh but identical `WaterColors` literal
  // each render does not churn the material — while a genuinely different
  // palette (⇧M) is always a different key.
  const key = waterMaterialKey(colors, mode);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` already
  // encodes every field of `colors` and `mode`; the factory closes over them.
  const lease = useDisposableMemo(() => acquireWaterMaterial(colors, mode), [key]);
  // Retain while mounted; release on unmount or when the lease changes. A
  // LAYOUT effect, so retain runs before the renderer's first frame and the
  // release/re-retain replay StrictMode performs happens entirely within one
  // synchronous commit — hence a zero-ref disposal is deferred a microtask
  // (see `disposeEntryWhenUnused`) and never catches a re-retain mid-replay.
  useLayoutEffect(() => {
    lease.retain();
    return () => lease.release();
  }, [lease]);
  return lease;
}

/** Keeps `uTime` and `uViewDir` current. Deliberately contains NO
 * `invalidate()` — see this module's doc comment: that is the exact shape of
 * the bug that once made a `frameloop="demand"` scene never go idle.
 *
 * Every mounted water mesh registers this, so a shared material's time/view
 * uniforms are written by all of its holders each frame — idempotent writes
 * of the same two values, never a request for a new frame. */
function useWaterFrame(material: THREE.ShaderMaterial | null) {
  useFrame(({ clock, camera }) => {
    if (!material) return;
    material.uniforms.uTime.value = clock.elapsedTime;
    const view = material.uniforms.uViewDir.value as THREE.Vector3;
    camera.getWorldDirection(view);
    view.negate();
  });
}

/**
 * Assign `mesh.onBeforeRender` so a shared material wears this mesh's own
 * parameters at its own draw. Kept in a layout effect (rather than the JSX
 * `onBeforeRender` prop) so the callback is attached to the REAL three.js
 * mesh, with no event-prop ambiguity and no stray DOM attribute in tests.
 *
 * The callback reads the LATEST `apply` through a ref, so a re-render (a
 * palette switch, a new phase, a resized island) updates what gets written
 * without tearing down and re-attaching the callback on every render — which
 * matters at 152 islands. The attach itself only runs when the mesh instance
 * changes.
 */
function useBeforeRender(mesh: RefObject<THREE.Mesh | null>, apply: () => void) {
  const latest = useRef(apply);
  useLayoutEffect(() => {
    latest.current = apply;
  });
  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    const callback = () => latest.current();
    target.onBeforeRender = callback;
    return () => {
      // Only clear OUR callback: if another render already replaced it, that
      // newer assignment owns the slot now.
      if (target.onBeforeRender === callback) target.onBeforeRender = () => {};
    };
  }, [mesh]);
}

/**
 * The one big background ocean plane per scene (never per island). Four
 * vertices; everything else is the fragment shader.
 */
export function OpenWater({
  center,
  y = 0,
  size,
  colors,
}: {
  center: { x: number; z: number };
  /** World-Y this water plane sits at — always below the land it surrounds
   * (each caller passes its own offset; there is no universal "ground
   * level" shared between the town and the sea). */
  y?: number;
  size: number;
  colors: WaterColors;
}) {
  const geometry = useDisposableMemo(() => {
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [size]);
  const lease = useSharedWaterMaterial(colors, MODE_OPEN);
  useWaterFrame(lease.material);
  return <mesh geometry={geometry} material={lease.material} position={[center.x, y, center.z]} renderOrder={-1} />;
}

/**
 * One sea island's shallows: a transparent quad over the open water, shaped
 * per pixel by that island's own seeded coastline.
 *
 * `seed` is the island's root path — the same "which repo, never how big"
 * input `terrain.ts` already takes (see its module doc comment). It is read
 * only to reproduce the coastline the terrain mesh is already drawing.
 */
export function IslandShallows({
  seed,
  width,
  depth,
  y,
  colors,
}: {
  seed: string;
  width: number;
  depth: number;
  y: number;
  colors: WaterColors;
}) {
  const quadW = width * ISLAND_SHELF_QUAD;
  const quadD = depth * ISLAND_SHELF_QUAD;
  const geometry = useDisposableMemo(() => {
    const geo = new THREE.PlaneGeometry(quadW, quadD, 1, 1);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [quadW, quadD]);
  const lease = useSharedWaterMaterial(colors, MODE_ISLAND);
  const phases = useMemo(() => maskPhases(seed), [seed]);
  // This island's coastline is applied to the SHARED material immediately
  // before its own draw (see `applyIslandUniforms`), so no island's seed,
  // half-extent or shelf phase can bleed into a sibling drawn with the same
  // material later in the frame.
  const mesh = useRef<THREE.Mesh>(null);
  const material = lease.material;
  useBeforeRender(mesh, () => {
    applyIslandUniforms(material, phases, width / 2, depth / 2, quadW / 2, quadD / 2);
    material.uniforms.uShelfOuter.value = ISLAND_SHELF_OUTER;
  });
  useWaterFrame(material);
  return <mesh ref={mesh} geometry={geometry} material={material} position={[0, y, 0]} />;
}

/**
 * The town's shallows: the same surface, shaped by the town's rectangular
 * ground rather than a seeded coastline (see `MODE_RECT` in this module's
 * doc comment for why the town cannot have a masked one).
 */
export function TownShallows({
  width,
  depth,
  shelfWidth,
  coast = 0,
  coastT = 0,
  y,
  colors,
}: {
  width: number;
  depth: number;
  shelfWidth: number;
  /** The coast around the town (`townCoast.ts`) — width and waterline. */
  coast?: number;
  coastT?: number;
  y: number;
  colors: WaterColors;
}) {
  // Big enough that shoreness is already 0 where `quadFade` begins (74% of
  // the half-extent), at the widest the coast and shelf wobbles reach.
  const reach = coast * coastT * 1.54 + shelfWidth * 1.66;
  const quadW = ((width / 2 + reach) / 0.72) * 2;
  const quadD = ((depth / 2 + reach) / 0.72) * 2;
  const geometry = useDisposableMemo(() => {
    const geo = new THREE.PlaneGeometry(quadW, quadD, 1, 1);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [quadW, quadD]);
  const lease = useSharedWaterMaterial(colors, MODE_RECT);
  const mesh = useRef<THREE.Mesh>(null);
  const material = lease.material;
  // Same per-draw stake as an island's shelf: `MODE_RECT` reads its own
  // footprint/coast/half-extents, applied right before this town's draw.
  useBeforeRender(mesh, () => {
    applyTownUniforms(material, width / 2, depth / 2, quadW / 2, quadD / 2, shelfWidth, coast, coastT);
  });
  useWaterFrame(material);
  return <mesh ref={mesh} geometry={geometry} material={material} position={[0, y, 0]} />;
}
