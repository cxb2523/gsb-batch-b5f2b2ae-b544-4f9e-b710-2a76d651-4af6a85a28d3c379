// @vitest-environment jsdom
//
// Water + mood convergence round.
//
// Two defects motivate these tests, and neither is visible in a single frame:
//
// 1. ⇧M used to change the sea's own colours but leave every island's foam,
//    caustics and surf line rendered from the previous palette's material.
//    These tests drive a real mood change through `MoodProvider` and assert
//    every mounted water mesh is drawing with the NEW six-colour palette on
//    the very next render — including foam and glint, the two the shader uses
//    for surf lines and caustics.
// 2. Every island built its own `ShaderMaterial`: 152 islands meant 152
//    identical shader compiles and uniform sets. Now there is one material per
//    (mode, palette) and per-island values (`uPhases`, `uHalf`, ...) are
//    applied at draw time via the mesh's `onBeforeRender`. These tests prove
//    the sharing AND that sharing never blurs one island's coastline phase or
//    half-extent into another's.
//
// No WebGL is needed: the water meshes' materials are plain three.js objects,
// `onBeforeRender` is a JS callback, and `ref` in a non-`<Canvas>` render is a
// plain DOM node — so every assertion here is about the REAL objects the
// components build, not a stand-in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import * as THREE from "three";

type FakeFrameState = {
  clock: { elapsedTime: number };
  camera: { getWorldDirection(v: THREE.Vector3): void };
  invalidate: () => void;
};
const captured: Array<(state: FakeFrameState) => void> = [];

vi.mock("@react-three/fiber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@react-three/fiber")>();
  return {
    ...actual,
    useFrame: (cb: (state: FakeFrameState) => void) => {
      captured.push(cb);
    },
  };
});

const { MoodProvider, MOOD_LOOK, useMood } = await import("../mood");
const {
  IslandShallows,
  MODE_ISLAND,
  MODE_OPEN,
  MODE_RECT,
  OpenWater,
  TownShallows,
  applyIslandUniforms,
  sharedWaterMaterialCount,
  waterMaterialRefs,
} = await import("./Water");
const { WATER_COLORS } = await import("./TownView");
const { maskPhases } = await import("../terrain");

const DAY = WATER_COLORS;
type Palette = typeof WATER_COLORS;
/** The mood ⇧M reaches first from `day`. Spelled as the palette object the
 * shader will actually receive, so the assertion is about the six colours,
 * not a hand-copied hex list that could drift from `mood.tsx`. */
const NEXT = MOOD_LOOK.golden.water as Palette;

type Drawn = {
  material: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  /** What three.js invokes immediately before drawing this mesh. */
  onBeforeRender?: () => void;
};

/** Every `<mesh>` in the tree, with the props React committed to it and the
 * draw callback the component attached to that same node. In a real r3f
 * `<Canvas>` the ref is the `THREE.Mesh` and `useBeforeRender` sets
 * `mesh.onBeforeRender`; off-Canvas (here) the ref is the DOM node and the
 * SAME property is set on it, so reading it back is the faithful stand-in. */
function drawnMeshes(container: HTMLElement): Drawn[] {
  return Array.from(container.querySelectorAll("mesh")).map((node) => {
    const key = Object.keys(node).find((k) => k.startsWith("__reactProps"));
    const props = (node as unknown as Record<string, unknown>)[key as string] as Omit<Drawn, "onBeforeRender">;
    return { ...props, onBeforeRender: (node as unknown as Drawn).onBeforeRender };
  });
}

const hex = (value: unknown) => (value as THREE.Color).getHexString();
const expected = (value: string) => hex(new THREE.Color(value));

/** A scene whose water colours follow the mood exactly the way the real sea
 * and town do (`SeaIslandGroup`/`Ground` read `useMood().look`). */
function MoodScene({ seeds }: { seeds: string[] }) {
  const colors = useMood().look.water ?? DAY;
  return (
    <>
      <OpenWater center={{ x: 0, z: 0 }} size={100} colors={colors} />
      {seeds.map((seed, i) => (
        <IslandShallows key={seed} seed={seed} width={10 + i} depth={8 + i} y={-0.5} colors={colors} />
      ))}
      <TownShallows width={20} depth={14} shelfWidth={4} y={-0.5} colors={colors} />
    </>
  );
}

afterEach(async () => {
  cleanup();
  captured.length = 0;
  vi.restoreAllMocks();
  // Let any deferred disposal from the unmounted scene run so the module-level
  // shared-material cache starts each test empty (a leaked entry would let one
  // test's material satisfy another's assertion).
  await Promise.resolve();
  expect(sharedWaterMaterialCount()).toBe(0);
});

describe("water materials converge on the mood palette", () => {
  const seeds = ["/a/one", "/b/two", "/c/three"];

  it("recolours every mounted sea/island/town mesh on the next render after ⇧M", () => {
    const { container } = render(
      <MoodProvider initial="day">
        <MoodScene seeds={seeds} />
      </MoodProvider>,
    );
    const day = drawnMeshes(container);
    // open + 3 islands + town
    expect(day).toHaveLength(5);
    for (const mesh of day) {
      expect(hex(mesh.material.uniforms.uDeep.value)).toBe(expected(DAY.deep));
      // The two colours this bug was really about: foam (surf/waterline) and
      // glint (caustic light + sun sparkle).
      expect(hex(mesh.material.uniforms.uFoam.value)).toBe(expected(DAY.foam));
      expect(hex(mesh.material.uniforms.uGlint.value)).toBe(expected(DAY.glint));
    }

    fireEvent.keyDown(window, { key: "M", shiftKey: true });

    const next = drawnMeshes(container);
    expect(next).toHaveLength(5);
    for (const mesh of next) {
      expect(hex(mesh.material.uniforms.uDeep.value)).toBe(expected(NEXT.deep));
      expect(hex(mesh.material.uniforms.uShallow.value)).toBe(expected(NEXT.shallow));
      // Foam, and the glint the caustics are built from, both follow.
      expect(hex(mesh.material.uniforms.uFoam.value)).toBe(expected(NEXT.foam));
      expect(hex(mesh.material.uniforms.uGlint.value)).toBe(expected(NEXT.glint));
    }
    // And it is genuinely a different palette, not a lucky coincidence.
    expect(expected(NEXT.deep)).not.toBe(expected(DAY.deep));
  });

  it("does not rebuild geometry or lose the coastline phase when the palette changes", () => {
    const { container } = render(
      <MoodProvider initial="day">
        <MoodScene seeds={seeds} />
      </MoodProvider>,
    );
    const before = drawnMeshes(container);
    fireEvent.keyDown(window, { key: "M", shiftKey: true });
    const after = drawnMeshes(container);

    // Same geometry objects, index for index: a palette change must never
    // rebuild the quads (that would also be a GPU churn on every ⇧M).
    for (let i = 0; i < before.length; i++) expect(after[i].geometry).toBe(before[i].geometry);

    // And each island's own seeded phases/half-extents survive intact on the
    // NEW material, because they are re-applied per draw, not baked in.
    for (let i = 0; i < seeds.length; i++) {
      const mesh = after[1 + i];
      mesh.onBeforeRender?.();
      const phases = mesh.material.uniforms.uPhases.value as THREE.Vector3;
      expect([phases.x, phases.y, phases.z]).toEqual(maskPhases(seeds[i]));
      const half = mesh.material.uniforms.uHalf.value as THREE.Vector2;
      expect([half.x, half.y]).toEqual([(10 + i) / 2, (8 + i) / 2]);
    }
  });
});

describe("water materials are shared per (mode, palette)", () => {
  const seeds = Array.from({ length: 12 }, (_, i) => `/repo/${i}`);

  it("builds exactly one island material for any number of islands with one palette", () => {
    const { container } = render(
      <MoodProvider initial="day">
        <MoodScene seeds={seeds} />
      </MoodProvider>,
    );
    const meshes = drawnMeshes(container);
    const islandMaterials = meshes.slice(1, 1 + seeds.length).map((m) => m.material);
    expect(new Set(islandMaterials).size).toBe(1);
    expect(sharedWaterMaterialCount()).toBe(3); // one per mode (open, island, rect)
    expect(waterMaterialRefs(DAY, MODE_ISLAND)).toBe(seeds.length);
  });

  it("keeps the three modes distinct even on the same palette", () => {
    const { container } = render(
      <MoodProvider initial="day">
        <MoodScene seeds={seeds.slice(0, 2)} />
      </MoodProvider>,
    );
    const meshes = drawnMeshes(container);
    const opens = meshes.filter((m) => m.material.uniforms.uMode.value === MODE_OPEN);
    const islands = meshes.filter((m) => m.material.uniforms.uMode.value === MODE_ISLAND);
    const rects = meshes.filter((m) => m.material.uniforms.uMode.value === MODE_RECT);
    expect(opens).toHaveLength(1);
    expect(islands).toHaveLength(2);
    expect(rects).toHaveLength(1);
    expect(new Set([opens[0].material, islands[0].material, rects[0].material]).size).toBe(3);
  });

  it("gives each island its OWN phases on the shared material, draw by draw", () => {
    const { container } = render(
      <MoodProvider initial="day">
        <MoodScene seeds={seeds} />
      </MoodProvider>,
    );
    const meshes = drawnMeshes(container);
    const shared = meshes[1].material;
    const seen = new Set<string>();
    for (let i = 0; i < seeds.length; i++) {
      const mesh = meshes[1 + i];
      expect(mesh.material).toBe(shared); // literally one material
      mesh.onBeforeRender?.();
      const phases = mesh.material.uniforms.uPhases.value as THREE.Vector3;
      expect([phases.x, phases.y, phases.z]).toEqual(maskPhases(seeds[i]));
      seen.add([phases.x, phases.y, phases.z].join(","));
    }
    // 12 distinct seeds must produce 12 distinct phase triples, never a
    // single value bled across the shared material.
    expect(seen.size).toBe(seeds.length);
  });
});

describe("shared-material disposal follows useDisposableMemo without killing live users", () => {
  it("disposes the previous palette's material only after the last holder lets go", async () => {
    const disposeSpy = vi.spyOn(THREE.ShaderMaterial.prototype, "dispose");
    const { container } = render(
      <MoodProvider initial="day">
        <MoodScene seeds={["/a", "/b"]} />
      </MoodProvider>,
    );
    const dayMaterials = drawnMeshes(container).map((m) => m.material);
    expect(disposeSpy).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "M", shiftKey: true });
    const nextMaterials = drawnMeshes(container).map((m) => m.material);

    // Every live mesh is now on a new material; the old ones are released.
    for (let i = 0; i < dayMaterials.length; i++) expect(nextMaterials[i]).not.toBe(dayMaterials[i]);

    // Deferred one microtask (StrictMode-replay safety), so flush it.
    await Promise.resolve();
    const disposed = new Set(disposeSpy.mock.instances as unknown[]);
    for (const old of dayMaterials) expect(disposed.has(old)).toBe(true);
    // Nothing the new palette is still drawing with was disposed.
    for (const live of nextMaterials) expect(disposed.has(live)).toBe(false);
  });

  it("does not dispose a shared material when ONE island unmounts", async () => {
    const disposeSpy = vi.spyOn(THREE.ShaderMaterial.prototype, "dispose");

    function Sea({ seeds }: { seeds: string[] }) {
      return (
        <>
          {seeds.map((seed) => (
            <IslandShallows key={seed} seed={seed} width={10} depth={10} y={-0.5} colors={DAY} />
          ))}
        </>
      );
    }

    const { rerender } = render(<Sea seeds={["/a", "/b", "/c"]} />);
    const shared = drawnMeshes(document.body)[0].material;
    expect(waterMaterialRefs(DAY, MODE_ISLAND)).toBe(3);

    rerender(<Sea seeds={["/a", "/b"]} />);
    await Promise.resolve();
    // Two islands still draw with it, so it must be untouched.
    expect(waterMaterialRefs(DAY, MODE_ISLAND)).toBe(2);
    expect(disposeSpy.mock.instances).not.toContain(shared);
    expect(drawnMeshes(document.body)[0].material).toBe(shared);

    rerender(<Sea seeds={[]} />);
    await Promise.resolve();
    // The last holder is gone, so now — and only now — it is disposed.
    expect(disposeSpy.mock.instances).toContain(shared);
    expect(sharedWaterMaterialCount()).toBe(0);
  });

  it("survives React StrictMode's effect replay, and a mid-life palette switch under it", async () => {
    // `main.tsx` renders the whole app under `<StrictMode>`, which replays
    // every effect setup→cleanup→setup. The refcount therefore lives in a
    // paired LAYOUT effect keyed on the lease — React replays it in setup/
    // cleanup/setup order, so the count stays exact — while the zero-ref
    // disposal is deferred a microtask so a replay's re-retain cancels it.
    // The switch mid-life additionally proves a palette change under the
    // replay disposes only the OLD palette, and only once nothing uses it.
    const disposeSpy = vi.spyOn(THREE.ShaderMaterial.prototype, "dispose");

    function Scene({ colors }: { colors: Palette }) {
      return <IslandShallows seed="/a" width={10} depth={10} y={-0.5} colors={colors} />;
    }

    const { container, rerender, unmount } = render(
      <StrictMode>
        <Scene colors={DAY} />
      </StrictMode>,
    );
    await Promise.resolve();
    expect(waterMaterialRefs(DAY, MODE_ISLAND)).toBe(1);
    expect(disposeSpy).not.toHaveBeenCalled();

    const dayMaterial = drawnMeshes(container)[0].material;

    rerender(
      <StrictMode>
        <Scene colors={NEXT} />
      </StrictMode>,
    );
    await Promise.resolve();
    const nextMaterial = drawnMeshes(container)[0].material;
    expect(nextMaterial).not.toBe(dayMaterial);
    // The old palette's material is gone now that nothing uses it; the live
    // one never was.
    expect(disposeSpy.mock.instances).toContain(dayMaterial);
    expect(disposeSpy.mock.instances).not.toContain(nextMaterial);

    unmount();
    await Promise.resolve();
    expect(sharedWaterMaterialCount()).toBe(0);
  });

  it("unmounting an island in the same commit as a palette change never disposes a live material", async () => {
    const disposeSpy = vi.spyOn(THREE.ShaderMaterial.prototype, "dispose");

    function Sea({ seeds, colors }: { seeds: string[]; colors: Palette }) {
      return (
        <>
          {seeds.map((seed) => (
            <IslandShallows key={seed} seed={seed} width={10} depth={10} y={-0.5} colors={colors} />
          ))}
        </>
      );
    }

    const { rerender } = render(<Sea seeds={["/a", "/b", "/c"]} colors={DAY} />);
    // One island leaves AS the palette flips: the other two keep drawing, so
    // the OLD material must survive until they, too, move to the new palette
    // in this same commit — and then it may go.
    rerender(<Sea seeds={["/a", "/b"]} colors={NEXT} />);
    await Promise.resolve();

    const live = drawnMeshes(document.body).map((m) => m.material);
    const disposed = new Set(disposeSpy.mock.instances as unknown[]);
    for (const material of live) expect(disposed.has(material)).toBe(false);
    // Both survivors share one new-palette material.
    expect(new Set(live).size).toBe(1);
    expect(waterMaterialRefs(NEXT, MODE_ISLAND)).toBe(2);
    expect(waterMaterialRefs(DAY, MODE_ISLAND)).toBe(0);
  });

  it("re-acquiring a palette before the deferred disposal fires keeps the material alive", async () => {
    // The real sequence: every island unmounts (zero refs, disposal queued on
    // the microtask), then — before React flushes microtasks — a new render
    // asks for the SAME palette again. The queued callback must NOT dispose
    // the material the fresh render is about to retain.
    const disposeSpy = vi.spyOn(THREE.ShaderMaterial.prototype, "dispose");

    function Sea({ on }: { on: boolean }) {
      return on ? <IslandShallows seed="/a" width={10} depth={10} y={-0.5} colors={DAY} /> : null;
    }

    const { container, rerender } = render(<Sea on />);
    const shared = drawnMeshes(container)[0].material;

    rerender(<Sea on={false} />);
    // Synchronously re-mount, without awaiting the pending microtask.
    rerender(<Sea on />);
    await Promise.resolve();

    // The material the re-mounted island draws with is the SAME object and
    // was never disposed.
    expect(drawnMeshes(container)[0].material).toBe(shared);
    expect(disposeSpy.mock.instances).not.toContain(shared);
    expect(waterMaterialRefs(DAY, MODE_ISLAND)).toBe(1);
  });

  it("re-arms the deferred disposal after a cancelled one, so a later last release still disposes", async () => {
    const disposeSpy = vi.spyOn(THREE.ShaderMaterial.prototype, "dispose");

    function Sea({ on }: { on: boolean }) {
      return on ? <IslandShallows seed="/a" width={10} depth={10} y={-0.5} colors={DAY} /> : null;
    }

    const { container, rerender } = render(<Sea on />);
    const shared = drawnMeshes(container)[0].material;
    // Unmount + remount in one synchronous turn: disposal queued, then
    // cancelled by the re-retain — the entry stays flagged.
    rerender(<Sea on={false} />);
    rerender(<Sea on />);
    await Promise.resolve();
    expect(disposeSpy.mock.instances).not.toContain(shared);

    // Now genuinely the last holder leaves; the disposal must run this time.
    rerender(<Sea on={false} />);
    await Promise.resolve();
    expect(disposeSpy.mock.instances).toContain(shared);
    expect(sharedWaterMaterialCount()).toBe(0);
  });
});

describe("the per-frame uniform contract is unchanged", () => {
  it("writes uTime and uViewDir in useFrame and never calls invalidate()", () => {
    render(
      <MoodProvider initial="day">
        <MoodScene seeds={["/a", "/b"]} />
      </MoodProvider>,
    );
    expect(captured.length).toBeGreaterThan(0);
    const invalidate = vi.fn();
    const camera = {
      getWorldDirection: (v: THREE.Vector3) => v.set(0, 0, -1),
    };
    for (const cb of captured) cb({ clock: { elapsedTime: 3.25 }, camera, invalidate });
    // The exact shape of the shipped bug: an invalidate() in a frame loop
    // keeps a frameloop="demand" scene awake forever.
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("applyIslandUniforms / applyTownUniforms force a fresh upload", () => {
  it("sets uniformsNeedUpdate so a material re-used within a frame re-uploads its per-mesh values", () => {
    const [first] = drawnMeshes(
      render(<IslandShallows seed="/x" width={10} depth={10} y={0} colors={DAY} />).container,
    );
    const { material } = first;
    material.uniformsNeedUpdate = false;
    applyIslandUniforms(material, [0.1, 0.2, 0.3], 5, 4, 10, 8);
    expect(material.uniformsNeedUpdate).toBe(true);
    expect((material.uniforms.uHalf.value as THREE.Vector2).toArray()).toEqual([5, 4]);
    material.uniformsNeedUpdate = false;
    applyIslandUniforms(material, [0.4, 0.5, 0.6], 6, 3, 12, 6);
    expect(material.uniformsNeedUpdate).toBe(true);
    expect((material.uniforms.uQuadHalf.value as THREE.Vector2).toArray()).toEqual([12, 6]);
  });
});
