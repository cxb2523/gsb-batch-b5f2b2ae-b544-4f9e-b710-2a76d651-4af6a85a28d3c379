// Acceptance checks for the MacBook scroll-driven lid + material lifecycle.
// Run with: npm test   (node scripts/verify-mac.mjs)
import * as THREE from "three";
import {
  BASE_POSITION,
  BASE_ROTATION,
  CLOSED_ANGLE,
  GROUP_LIFT_Y,
  GROUP_TILT_X,
  OPEN_ANGLE,
  dampWithSnap,
  groupPoseForOffset,
  lidAngleForOffset,
  openProgress,
} from "../src/lib/lidMotion.js";
import {
  MATTE_SETTINGS,
  applyMacMaterials,
  disposeMacMaterials,
} from "../src/lib/macMaterials.js";

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------- 1. Lid endpoint angles ----------
check("offset 0 -> fully closed (180deg)", lidAngleForOffset(0) === CLOSED_ANGLE);
check("offset 1 -> fully open (90deg)", lidAngleForOffset(1) === OPEN_ANGLE);

// ---------- 2. No overshoot / no jumps across the range ----------
let monotonic = true;
let inBounds = true;
let prev = Infinity;
for (let i = -20; i <= 120; i++) {
  const angle = lidAngleForOffset(i / 100); // includes out-of-range offsets
  if (angle < OPEN_ANGLE - 1e-9 || angle > CLOSED_ANGLE + 1e-9) inBounds = false;
  if (angle > prev + 1e-9) monotonic = false;
  prev = angle;
}
check("angle stays within [90deg, 180deg] even for offset <0 or >1", inBounds);
check("angle is monotonic (eased, no jumps)", monotonic);
check("out-of-range offsets clamp to endpoints",
  lidAngleForOffset(-0.5) === CLOSED_ANGLE && lidAngleForOffset(1.5) === OPEN_ANGLE);

// ---------- 3. Scroll round-trip reversibility (simulated frames) ----------
const simulate = (offsets) => {
  let angle = CLOSED_ANGLE;
  for (const o of offsets) {
    for (let f = 0; f < 600; f++) {
      angle = dampWithSnap(angle, lidAngleForOffset(o), 10, 1 / 60);
    }
  }
  return angle;
};
const opened = simulate([0.5, 1]);
check("scroll to end settles exactly at open angle", opened === OPEN_ANGLE);
const roundTrip = simulate([0, 0.3, 0.7, 1, 0.7, 0.3, 0]);
check("scroll there-and-back returns exactly to closed angle", roundTrip === CLOSED_ANGLE);
const midUp = simulate([0.4]);
const midDown = simulate([1, 0.4]);
check("same offset reached from either direction gives same angle", midUp === midDown);

// ---------- 4. Group pose linkage ----------
const pose0 = groupPoseForOffset(0);
const pose1 = groupPoseForOffset(1);
check("closed pose matches original baseline position/rotation",
  pose0.position.every((v, i) => v === BASE_POSITION[i]) &&
  pose0.rotation.every((v, i) => v === BASE_ROTATION[i]));
check("open pose lifts and tilts relative to baseline",
  near(pose1.position[1], BASE_POSITION[1] + GROUP_LIFT_Y) &&
  near(pose1.rotation[0], BASE_ROTATION[0] + GROUP_TILT_X));
check("open progress eased and clamped", openProgress(0) === 0 && openProgress(1) === 1 &&
  openProgress(2) === 1 && openProgress(-1) === 0);

// ---------- 5. Material lifecycle ----------
const makeFixture = () => {
  const originalMaterial = new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.3 });
  const matte = new THREE.Mesh(new THREE.BoxGeometry(), originalMaterial);
  matte.name = "matte";
  const sourceTexture = new THREE.Texture();
  const flags = { originalDisposed: false, sourceTexDisposed: false };
  originalMaterial.addEventListener("dispose", () => (flags.originalDisposed = true));
  sourceTexture.addEventListener("dispose", () => (flags.sourceTexDisposed = true));
  return { meshes: { matte }, originalMaterial, sourceTexture, flags };
};

// 5a. Settings applied once, to a clone — shared originals untouched.
{
  const { meshes, originalMaterial, sourceTexture, flags } = makeFixture();
  const handle = applyMacMaterials(meshes, sourceTexture);
  const m = meshes.matte.material;
  check("matte material is a clone, not the shared GLTF material", m !== originalMaterial);
  check("metalness/roughness/emissive applied", m.metalness === MATTE_SETTINGS.metalness &&
    m.roughness === MATTE_SETTINGS.roughness && m.emissiveIntensity === MATTE_SETTINGS.emissiveIntensity);
  check("texture applied is a clone of the cached texture",
    m.map && m.map !== sourceTexture && m.map.source === sourceTexture.source);
  check("shared original material not mutated", originalMaterial.metalness === 0.7 &&
    originalMaterial.roughness === 0.3 && originalMaterial.map === null);

  // 5b. Teardown releases only component-owned resources.
  let cloneDisposed = false, texCloneDisposed = false;
  m.addEventListener("dispose", () => (cloneDisposed = true));
  m.map.addEventListener("dispose", () => (texCloneDisposed = true));
  disposeMacMaterials(handle);
  check("unmount disposes cloned material", cloneDisposed);
  check("unmount disposes cloned texture", texCloneDisposed);
  check("unmount does NOT dispose shared GLTF material", !flags.originalDisposed);
  check("unmount does NOT dispose loader-cached texture", !flags.sourceTexDisposed);
  check("unmount restores shared original material on the mesh",
    meshes.matte.material === originalMaterial);
}

// 5c. StrictMode double-mount / repeated entry: params never drift.
{
  const { meshes, originalMaterial, sourceTexture, flags } = makeFixture();
  for (let mount = 0; mount < 3; mount++) {
    const handle = applyMacMaterials(meshes, sourceTexture);
    const m = meshes.matte.material;
    check(`mount #${mount + 1}: params exact (no drift)`,
      m.metalness === 0.1 && m.roughness === 0.9 && m.emissiveIntensity === 0);
    disposeMacMaterials(handle);
  }
  check("shared resources survive repeated mount/unmount",
    !flags.originalDisposed && !flags.sourceTexDisposed &&
    meshes.matte.material === originalMaterial);
}

// 5d. Re-entry after unmount still renders (fresh clones from pristine originals).
{
  const { meshes, sourceTexture } = makeFixture();
  disposeMacMaterials(applyMacMaterials(meshes, sourceTexture)); // mount + unmount
  const again = applyMacMaterials(meshes, sourceTexture);        // re-enter
  check("re-entry after unmount produces a working textured material",
    !!again && meshes.matte.material.map && meshes.matte.material.metalness === 0.1);
  disposeMacMaterials(again);
}

// 5e. Null-safety for incomplete loads.
{
  applyMacMaterials({ matte: null }, new THREE.Texture());
  disposeMacMaterials(null);
  disposeMacMaterials(applyMacMaterials({}, null));
  check("helpers tolerate missing meshes/textures", true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
