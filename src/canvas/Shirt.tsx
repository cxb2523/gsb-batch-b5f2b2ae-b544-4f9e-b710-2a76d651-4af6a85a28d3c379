import { useEffect, useRef, useState } from "react";
import { easing } from "maath";
import { useSnapshot } from "valtio";
import { useFrame, useThree } from "@react-three/fiber";
import { Decal, useGLTF } from "@react-three/drei";
import type { Mesh, MeshStandardMaterial, Texture } from "three";

import state, {
  beginDecalRequest,
  decalSourceProperty,
  releaseDecalSlot,
  settleDecalRequest,
  type DecalSlot,
} from "../store";
import {
  acquireDecalTexture,
  registerFrameSnapshotHandler,
  releaseDecalTexture,
  waitForStableFrame,
  type DecalTextureHandle,
} from "../config/helpers";

type ShirtNodes = {
  T_Shirt_male: Mesh;
};

type ShirtMaterials = {
  lambert1: MeshStandardMaterial;
};

type DecalLayerProps = {
  slot: DecalSlot;
  position: [number, number, number];
  scale: number;
  depthTest?: boolean;
  depthWrite?: boolean;
};

type AppliedTexture = {
  source: string;
  texture: Texture;
};

// Renderer capability used to upload a texture before the first draw.
type TextureUploader = {
  initTexture?: (texture: Texture) => void;
};

/**
 * A single decal slot. It owns the acquire/release pair for the texture it
 * renders so the store can tell when a texture is no longer referenced.
 */
const DecalLayer = ({
  slot,
  position,
  scale,
  depthTest,
  depthWrite,
}: DecalLayerProps) => {
  const snap = useSnapshot(state);
  const gl = useThree((three) => three.gl);

  const enabled = slot === "logo" ? snap.isLogoTexture : snap.isFullTexture;
  const slotStatus = snap.decalStatus[slot];
  const requestedSource = slotStatus.requestedSource;
  const requestId = slotStatus.requestId;

  const [applied, setApplied] = useState<AppliedTexture | null>(null);
  // Held reference for the texture currently mounted in the scene.
  const appliedRef = useRef<DecalTextureHandle | null>(null);

  useEffect(() => {
    // Switching off must drop the reference (and free the texture once no
    // other decal uses it) and show nothing rather than the previous image.
    if (!enabled) {
      const held = appliedRef.current;
      if (held) {
        appliedRef.current = null;
        releaseDecalTexture(held.source);
      }
      setApplied((previous) => (previous ? null : previous));
      if (state.decalStatus[slot].status !== "idle") {
        releaseDecalSlot(slot);
      }
      return;
    }

    // Enabled but nothing requested yet (initial mount / re-enable).
    if (state.decalStatus[slot].status === "idle") {
      beginDecalRequest(slot, state[decalSourceProperty(slot)]);
      return;
    }

    // Already showing exactly this texture, e.g. after a failed switch fell
    // back to the previous source. If the store has not been told yet (for
    // instance a request was restarted for the same source), settle it here
    // instead of reloading and leaving the slot stuck in "loading".
    if (appliedRef.current?.source === requestedSource) {
      if (state.decalStatus[slot].status !== "ready") {
        settleDecalRequest(slot, requestId, { ok: true });
      }
      return;
    }

    let cancelled = false;
    const handle = acquireDecalTexture(requestedSource);

    handle.ready
      .then(async (texture) => {
        // Superseded by a newer request or the decal was switched off: drop
        // this texture instead of briefly painting a stale image.
        if (
          cancelled ||
          state.decalStatus[slot].requestId !== requestId ||
          !(slot === "logo" ? state.isLogoTexture : state.isFullTexture)
        ) {
          releaseDecalTexture(handle.source);
          return;
        }

        texture.anisotropy = 16;
        texture.needsUpdate = true;
        (gl as unknown as TextureUploader).initTexture?.(texture);

        const previous = appliedRef.current;
        appliedRef.current = handle;
        setApplied({ source: handle.source, texture });

        // Let the scene commit and draw the new decal before declaring it
        // ready; downloads are gated on this status.
        await waitForStableFrame(2);

        // The previous texture is only released after the replacement has
        // been rendered, so a failed load can still keep showing the old
        // decal and no frame ever samples a disposed texture.
        if (previous && previous.source !== handle.source) {
          releaseDecalTexture(previous.source);
        }

        settleDecalRequest(slot, requestId, { ok: true });
      })
      .catch((error: unknown) => {
        releaseDecalTexture(handle.source);
        if (cancelled) return;

        const message =
          error instanceof Error
            ? error.message
            : "Failed to load decal texture";
        // Keeps the previously applied texture (if any) in place.
        settleDecalRequest(slot, requestId, { ok: false, message });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, requestedSource, requestId, slot, gl]);

  // Release on unmount regardless of the effect ordering above.
  useEffect(
    () => () => {
      const held = appliedRef.current;
      if (held) {
        appliedRef.current = null;
        releaseDecalTexture(held.source);
      }
    },
    [],
  );

  if (!enabled || !applied) return null;

  return (
    <Decal
      position={position}
      rotation={[0, 0, 0]}
      scale={scale}
      map={applied.texture}
      depthTest={depthTest}
      {...(depthWrite === undefined ? {} : { depthWrite })}
    />
  );
};

// Shirt
const Shirt = () => {
  // current state snapshot
  const snap = useSnapshot(state);

  // extract nodes and materials from model
  const { nodes, materials } = useGLTF("/shirt_baked.glb") as unknown as {
    nodes: ShirtNodes;
    materials: ShirtMaterials;
  };

  const invalidate = useThree((three) => three.invalidate);

  // update t-shirt color on snapshot updated
  useFrame((_, delta) =>
    easing.dampC(materials.lambert1.color, snap.color, 0.25, delta),
  );

  // Downloads capture the frame immediately: snap the damped colour to the
  // store value so the image never contains a mid-transition colour.
  useEffect(
    () =>
      registerFrameSnapshotHandler(() => {
        materials.lambert1.color.set(state.color);
        invalidate();
      }),
    [materials, invalidate],
  );

  return (
    <mesh
      castShadow
      geometry={nodes.T_Shirt_male.geometry}
      material={materials.lambert1}
      material-roughness={1}
      dispose={null}
    >
      {/* full texture, when enabled and loaded */}
      <DecalLayer slot="full" position={[0, 0, 0]} scale={1} />

      {/* logo decal, when enabled and loaded */}
      <DecalLayer
        slot="logo"
        position={[0, 0.04, 0.15]}
        scale={0.15}
        depthTest={false}
        depthWrite
      />
    </mesh>
  );
};

useGLTF.preload("/shirt_baked.glb");

export default Shirt;
