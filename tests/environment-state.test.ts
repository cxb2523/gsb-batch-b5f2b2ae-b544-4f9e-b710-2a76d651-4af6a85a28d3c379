import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { EnvironmentCache, GlassStudio, environmentFor, type EnvironmentKind, type StudioStage } from '~/utils/glassScene'
import { DEFAULT_GLASS_PARAMS, type Finish } from '~/utils/presets'

// The shader package includes browser-only imports; environment state involves no shaders here.
vi.mock('@pmndrs/vanilla', () => ({ MeshTransmissionMaterial: class {} }))

const shader = () => Object.assign(new THREE.MeshBasicMaterial(), { dispose: vi.fn() })

/** A stand-in for the glass material: the environment path only needs it to exist. */
const glassMaterial = () => Object.assign(new THREE.MeshPhysicalMaterial(), {
  uniforms: { chromaticAberration: { value: 0 }, anisotropicBlur: { value: 0 }, _transmission: { value: 0 } },
})

/**
 * A `GlassStudio` without its WebGL renderer: the fields the stage/environment path touches are
 * wired to real Three.js objects, and every bake is counted through the cache it is given.
 */
function makeStudio() {
  const bakes: EnvironmentKind[] = []
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    disposed: false,
    stage: null as StudioStage | null,
    envKind: null as EnvironmentKind | null,
    params: { ...DEFAULT_GLASS_PARAMS },
    target: { ...DEFAULT_GLASS_PARAMS },
    scene: new THREE.Scene(),
    renderer: { toneMapping: THREE.NeutralToneMapping },
    hemi: { visible: false },
    fill: Object.assign(new THREE.Object3D(), { visible: false }),
    key: Object.assign(new THREE.Object3D(), { color: new THREE.Color(), intensity: 0 }),
    rim: Object.assign(new THREE.Object3D(), { color: new THREE.Color(), intensity: 0 }),
    keyDistance: 1,
    modelCentre: new THREE.Vector3(),
    aimedAngle: NaN,
    // Materials and the params the environment path leaves to `applyMaterials`/`apply`.
    material: glassMaterial(),
    backMaterial: glassMaterial(),
    metal: new THREE.MeshPhysicalMaterial(),
    print: new THREE.MeshPhysicalMaterial(),
    tirUniforms: { tirStrength: { value: 0 }, rimChroma: { value: 0 }, liquid: { value: 0 }, spectralSpread: { value: 0 } },
    weaveUniforms: { weaveStrength: { value: 0 }, weaveFreq: { value: 0 } },
    surface: { albedo: null, normal: null, roughness: null },
  }) as GlassStudio
  studio.environments = new EnvironmentCache((kind) => {
    bakes.push(kind)
    return new THREE.WebGLRenderTarget(1, 1)
  })
  return { studio, bakes }
}

type Internals = {
  applyEnvironment(): void
  applyMaterials(): void
  setStage(stage: StudioStage): void
}
const internals = (studio: GlassStudio) => studio as unknown as Internals

/** Change the finish the way the UI does, without running the whole eased `apply`. */
function setFinish(studio: GlassStudio, finish: Finish) {
  studio.params.finish = finish
  studio.target.finish = finish
  internals(studio).applyEnvironment()
}

beforeEach(() => {
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('stage and finish select a room', () => {
  it('maps every combination, with Color on the floor bare', () => {
    expect(environmentFor('wall', 'glass')).toBe('studio')
    expect(environmentFor('wall', 'metal')).toBe('studio')
    expect(environmentFor('wall', 'print')).toBe('studio')
    expect(environmentFor('wall', 'liquid')).toBe('liquid')
    expect(environmentFor('floor', 'glass')).toBe('room')
    expect(environmentFor('floor', 'metal')).toBe('room')
    expect(environmentFor('floor', 'liquid')).toBe('room')
    expect(environmentFor('floor', 'print')).toBeNull()
  })
})

describe('environment reuse', () => {
  it('keeps tile count and bakes flat while the stage is switched repeatedly', () => {
    const { studio, bakes } = makeStudio()
    const seen = new Set<THREE.Texture>()
    for (let i = 0; i < 20; i++) {
      internals(studio).setStage(i % 2 === 0 ? 'floor' : 'wall')
      const env = studio.scene.environment
      expect(env).not.toBeNull()
      seen.add(env!)
      // The scene points at the room the current stage wants before the frame is drawn.
      expect(env).toBe(studio.environments.texture(i % 2 === 0 ? 'room' : 'studio'))
    }
    expect(studio.environments.size).toBe(2)
    expect(seen.size).toBe(2)
    // Each room was baked once, in the order the stages first asked for it.
    expect([...bakes].sort()).toEqual(['room', 'studio'])
  })

  it('keeps tile count and bakes flat while glass and liquid alternate', () => {
    const { studio, bakes } = makeStudio()
    internals(studio).setStage('wall')
    const studioEnv = studio.scene.environment
    const seen = new Set<THREE.Texture>()
    for (let i = 0; i < 20; i++) {
      setFinish(studio, i % 2 === 0 ? 'liquid' : 'glass')
      const env = studio.scene.environment
      seen.add(env!)
      expect(env).toBe(studio.environments.texture(i % 2 === 0 ? 'liquid' : 'studio'))
      if (i % 2 === 1) expect(env).toBe(studioEnv)
    }
    expect(studio.environments.size).toBe(2)
    expect(seen.size).toBe(2)
    expect(bakes).toEqual(['studio', 'liquid'])
  })

  it('reuses each room across both stage and finish changes', () => {
    const { studio, bakes } = makeStudio()
    internals(studio).setStage('wall')
    const studioEnv = studio.scene.environment
    setFinish(studio, 'liquid')
    const liquidEnv = studio.scene.environment
    internals(studio).setStage('floor')
    const roomEnv = studio.scene.environment
    expect(new Set([studioEnv, liquidEnv, roomEnv]).size).toBe(3)
    // Every combination again: the maps are the ones already baked.
    setFinish(studio, 'glass')
    expect(studio.scene.environment).toBe(roomEnv)
    internals(studio).setStage('wall')
    expect(studio.scene.environment).toBe(studioEnv)
    setFinish(studio, 'liquid')
    expect(studio.scene.environment).toBe(liquidEnv)
    internals(studio).setStage('floor')
    expect(studio.scene.environment).toBe(roomEnv)
    expect(bakes).toEqual(['studio', 'liquid', 'room'])
    expect(studio.environments.size).toBe(3)
  })
})

describe('the scene follows the current combination', () => {
  it('points Color on the floor at no environment, and restores the room after', () => {
    const { studio, bakes } = makeStudio()
    internals(studio).setStage('floor')
    const roomEnv = studio.scene.environment
    expect(roomEnv).not.toBeNull()
    setFinish(studio, 'print')
    expect(studio.scene.environment).toBeNull()
    // The floor room stays baked for the other finishes, and comes back as the same map.
    setFinish(studio, 'glass')
    expect(studio.scene.environment).toBe(roomEnv)
    expect(bakes).toEqual(['room'])
  })

  it('applies the new room at once even when the snapshot defers the rebuild', () => {
    const { studio } = makeStudio()
    internals(studio).setStage('wall')
    const studioEnv = studio.scene.environment
    // `snapParams(..., false)` lands the finish and the room without a rebuild; the frame that
    // follows must already reflect the new material.
    studio.snapParams({ finish: 'liquid' }, false)
    expect(studio.params.finish).toBe('liquid')
    expect(studio.scene.environment).not.toBe(studioEnv)
    expect(studio.scene.environment).toBe(studio.environments.texture('liquid'))
  })

  it('shares the studio room between the wall material finishes', () => {
    const { studio, bakes } = makeStudio()
    internals(studio).setStage('wall')
    const env = studio.scene.environment
    for (const finish of ['metal', 'print', 'glass'] as const) {
      setFinish(studio, finish)
      expect(studio.scene.environment).toBe(env)
    }
    expect(bakes).toEqual(['studio'])
    expect(studio.environments.size).toBe(1)
  })

  it('keeps the room when exports re-snap the current parameters', () => {
    const { studio, bakes } = makeStudio()
    internals(studio).setStage('floor')
    const env = studio.scene.environment
    // Every export starts with `snapParams({ ...target })`; the room must survive it unchanged.
    for (let i = 0; i < 3; i++) {
      expect(() => studio.snapParams({ ...studio.target }, false)).not.toThrow()
      expect(studio.scene.environment).toBe(env)
    }
    expect(studio.environments.size).toBe(1)
    expect(bakes).toEqual(['room'])
  })
})

describe('environment cache release', () => {
  it('frees a room once, through the render target that owns it', () => {
    const target = new THREE.WebGLRenderTarget(1, 1)
    const cache = new EnvironmentCache(() => target)
    const env = cache.acquire('studio')
    const textureDisposed = vi.fn()
    const targetDisposed = vi.fn()
    env.addEventListener('dispose', textureDisposed)
    target.addEventListener('dispose', targetDisposed)
    expect(cache.size).toBe(1)
    expect(cache.release('studio')).toBe(true)
    expect(cache.size).toBe(0)
    expect(cache.has('studio')).toBe(false)
    expect(textureDisposed).toHaveBeenCalledOnce()
    expect(targetDisposed).toHaveBeenCalledOnce()
    // Releasing twice, or releasing a room never baked, is a no-op.
    expect(cache.release('studio')).toBe(false)
    expect(cache.release('liquid')).toBe(false)
  })

  it('prunes only the rooms no combination can select again', () => {
    const cache = new EnvironmentCache(() => new THREE.WebGLRenderTarget(1, 1))
    for (const kind of ['studio', 'room', 'liquid'] as const) cache.acquire(kind)
    const dropped = cache.prune(new Set<EnvironmentKind>(['studio', 'room']))
    expect(dropped).toEqual(['liquid'])
    expect(cache.kinds()).toEqual(['studio', 'room'])
  })

  it('stops baking and leaves the scene alone after the studio is disposed', () => {
    const bakes: EnvironmentKind[] = []
    const target = new THREE.WebGLRenderTarget(1, 1)
    const disposed = vi.fn()
    target.addEventListener('dispose', disposed)
    const cache = new EnvironmentCache((kind) => { bakes.push(kind); return target })
    const studio = Object.assign(Object.create(GlassStudio.prototype), {
      lifetime: new AbortController(), raf: 0, onRebuild: null, relief: null, printTex: null,
      disposed: false, stage: 'wall' as StudioStage, envKind: 'studio' as EnvironmentKind | null,
      params: { ...DEFAULT_GLASS_PARAMS }, target: { ...DEFAULT_GLASS_PARAMS },
      scene: new THREE.Scene(), pmrem: { dispose: vi.fn() },
      renderer: { dispose: vi.fn() }, canvas: { removeEventListener: vi.fn() },
      controls: { dispose: vi.fn() }, key: { dispose: vi.fn() }, timer: { dispose: vi.fn() },
      mesh: null, floor: new THREE.Mesh(), backdrop: new THREE.Mesh(),
      material: shader(), backMaterial: shader(), metal: shader(), print: shader(),
      shadowPlane: new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture() })),
      fboMain: { dispose: vi.fn() }, fboBack: { dispose: vi.fn() },
      surface: { albedo: null, normal: null, roughness: null },
    }) as GlassStudio
    studio.environments = cache
    studio.scene.environment = cache.acquire('studio')
    const asInternals = studio as unknown as { camera: THREE.PerspectiveCamera; focus: { shift: number; scale: number } }
    asInternals.camera = new THREE.PerspectiveCamera()
    asInternals.focus = { shift: 0, scale: 1 }

    studio.dispose()

    expect(studio.scene.environment).toBeNull()
    expect(studio.environments.size).toBe(0)
    expect(disposed).toHaveBeenCalledOnce()
    expect(bakes).toEqual(['studio'])

    // Nothing reaches for the cache again, and nothing throws.
    expect(() => internals(studio).setStage('floor')).not.toThrow()
    expect(() => internals(studio).applyEnvironment()).not.toThrow()
    expect(() => setFinish(studio, 'liquid')).not.toThrow()
    expect(() => studio.snapParams({ finish: 'liquid' })).not.toThrow()
    expect(() => studio.snapParams({ finish: 'print' }, false)).not.toThrow()
    expect(() => studio.setParams({ finish: 'print' })).not.toThrow()
    expect(() => studio.setTrace(null)).not.toThrow()
    expect(() => studio.setRelief(null)).not.toThrow()
    expect(() => studio.setView('front', true)).not.toThrow()
    expect(() => studio.setPose(null)).not.toThrow()
    expect(() => studio.frame(true, true)).not.toThrow()
    expect(() => studio.setFocus(10, 0.8)).not.toThrow()
    expect(() => studio.resize(true)).not.toThrow()
    // A destroyed studio never bakes again, and its scene keeps pointing at nothing.
    expect(studio.environments.size).toBe(0)
    expect(studio.scene.environment).toBeNull()
    expect(bakes).toEqual(['studio'])
  })
})
