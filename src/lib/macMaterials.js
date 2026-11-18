// Material lifecycle helpers for the MacBook model.
//
// The GLTF scene and the loader-cached texture are shared resources owned by
// drei/useLoader caches — they must never be disposed or permanently mutated
// by this component. Instead we clone the materials we need to restyle and
// clone the texture, apply our settings to the clones, and dispose exactly
// those clones on teardown. Re-running setup after teardown (StrictMode
// double-mount, HMR, remount) starts from the pristine originals again, so
// effects never stack up.

export const MATTE_SETTINGS = {
  emissiveIntensity: 0,
  metalness: 0.1,
  roughness: 0.9,
};

/**
 * Clone the matte mesh's material, apply the shared texture + PBR settings
 * to the clone, and swap it onto the mesh.
 *
 * @param {Object} meshes  name -> Object3D map extracted from the GLTF scene
 * @param {THREE.Texture} sourceTexture  loader-cached texture (NOT disposed here)
 * @returns {{materials: THREE.Material[], textures: THREE.Texture[], restore: Function} | null}
 *          Handles to everything this call created, plus a restore() that puts
 *          the original shared materials back on the meshes.
 */
export const applyMacMaterials = (meshes, sourceTexture) => {
  const matte = meshes?.matte;
  if (!matte || !matte.material || !sourceTexture) return null;

  const originalMaterial = matte.material;

  // Component-owned texture clone (the cached original stays untouched).
  const texture = sourceTexture.clone();
  texture.needsUpdate = true;

  // Component-owned material clone with our one-time PBR settings.
  const material = originalMaterial.clone();
  material.map = texture;
  material.emissiveIntensity = MATTE_SETTINGS.emissiveIntensity;
  material.metalness = MATTE_SETTINGS.metalness;
  material.roughness = MATTE_SETTINGS.roughness;
  material.needsUpdate = true;

  matte.material = material;

  return {
    materials: [material],
    textures: [texture],
    restore: () => {
      // Only restore if the mesh still points at our clone — another setup
      // run may already have replaced it.
      if (matte.material === material) {
        matte.material = originalMaterial;
      }
    },
  };
};

/**
 * Dispose everything applyMacMaterials created and restore the shared
 * original materials onto the meshes. Safe to call with null.
 */
export const disposeMacMaterials = (handle) => {
  if (!handle) return;
  handle.restore();
  for (const material of handle.materials) {
    material.dispose();
  }
  for (const texture of handle.textures) {
    texture.dispose();
  }
};
