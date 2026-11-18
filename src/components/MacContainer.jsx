import { useGLTF, useScroll, useTexture } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BASE_POSITION,
  CLOSED_ANGLE,
  dampWithSnap,
  groupPoseForOffset,
  lidAngleForOffset,
} from "../lib/lidMotion";
import { applyMacMaterials, disposeMacMaterials } from "../lib/macMaterials";

const MacContainer = () => {
  // Load model and texture once; both are shared, cache-owned resources.
  const { scene } = useGLTF("./mac.glb");
  const tex = useTexture("./img.webp");
  const groupRef = useRef();

  // Memoize mesh extraction for performance
  const meshes = useMemo(() => {
    const found = {};
    scene.traverse((e) => {
      found[e.name] = e;
    });
    return found;
  }, [scene]);

  // Apply material/texture settings once per model-ready, and release the
  // clones this component created on unmount. StrictMode double-mounts and
  // HMR re-runs stay idempotent: cleanup restores the shared originals, so
  // each run restyles pristine materials instead of stacking side effects.
  useEffect(() => {
    const handle = applyMacMaterials(meshes, tex);
    if (meshes.screen) {
      // Start fully closed; useFrame drives it from the scroll offset.
      meshes.screen.rotation.x = CLOSED_ANGLE;
    }
    return () => disposeMacMaterials(handle);
  }, [meshes, tex]);

  const data = useScroll();

  useFrame((_, delta) => {
    const offset = data.offset;

    if (meshes.screen) {
      meshes.screen.rotation.x = dampWithSnap(
        meshes.screen.rotation.x,
        lidAngleForOffset(offset),
        10,
        delta
      );
    }

    // Linked whole-laptop motion: slight lift + tilt as the lid opens.
    if (groupRef.current) {
      const pose = groupPoseForOffset(offset);
      const { position, rotation } = groupRef.current;
      position.set(
        dampWithSnap(position.x, pose.position[0], 10, delta),
        dampWithSnap(position.y, pose.position[1], 10, delta),
        dampWithSnap(position.z, pose.position[2], 10, delta)
      );
      rotation.set(
        dampWithSnap(rotation.x, pose.rotation[0], 10, delta),
        dampWithSnap(rotation.y, pose.rotation[1], 10, delta),
        dampWithSnap(rotation.z, pose.rotation[2], 10, delta)
      );
    }
  });

  return (
    <group ref={groupRef} position={BASE_POSITION}>
      <primitive object={scene} />
    </group>
  );
};

export default MacContainer;
