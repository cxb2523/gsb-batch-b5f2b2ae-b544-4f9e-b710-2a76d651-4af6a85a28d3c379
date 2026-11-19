/**
 * Browser-tier tests for zoom-settle cache convergence.
 *
 * These pin the guarantee the scaled-blit tiers exist under but did not
 * fully enforce: the offscreen scene cache's zoom must converge back to
 * the live camera zoom once the zoom gesture ends, a viewport resize
 * during the gesture must not be presentable from the old-size cache, and
 * a committed content change must invalidate the cache so the next zoom
 * tick can't reuse it.
 *
 * Instrumentation: `Renderer.getLastDrawPath()` (which tier painted),
 * `Renderer.getCacheZoom()` (zoom the cache raster is valid for) and
 * `Renderer.isCacheStale()` (invalidation flag). Pixel reads back the
 * blur claim a stale scaled-blit cache would produce.
 */
import { describe, expect, test } from 'vitest'
import { createRenderer } from '../src/render'
import { createCanvasStore } from '../src/store'
import { type Node, asClientId, asNodeId } from '../src/types'

const makeCanvases = (w = 800, h = 600) => {
  const staticCanvas = document.createElement('canvas')
  const interactiveCanvas = document.createElement('canvas')
  staticCanvas.style.width = `${w}px`
  staticCanvas.style.height = `${h}px`
  interactiveCanvas.style.width = `${w}px`
  interactiveCanvas.style.height = `${h}px`
  document.body.appendChild(staticCanvas)
  document.body.appendChild(interactiveCanvas)
  return { staticCanvas, interactiveCanvas }
}

const cleanup = (...els: HTMLElement[]) => {
  for (const el of els) el.remove()
}

const waitFrame = (): Promise<void> =>
  new Promise(resolve => requestAnimationFrame(() => resolve()))

const rectNode = (id: string, overrides: Partial<Node> = {}): Node => ({
  id: asNodeId(id),
  type: 'rect',
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  angle: 0,
  z: 0,
  groups: [],
  ...overrides,
})

const setup = (w = 800, h = 600) => {
  const { staticCanvas, interactiveCanvas } = makeCanvases(w, h)
  const store = createCanvasStore({ clientId: asClientId('u-test') })
  const renderer = createRenderer({
    store,
    staticCanvas,
    interactiveCanvas,
    width: w,
    height: h,
  })
  store.addNode(rectNode('n-1'))
  return { store, renderer, staticCanvas, interactiveCanvas }
}

describe('zoom-settle cache convergence', () => {
  test('zooming -> zoom -> idle: last static paint is full and cache zoom = camera zoom', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBe(store.getCamera().z)

    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.7 })
    await waitFrame()
    await waitFrame()
    // Mid-gesture: scaled-blit reuse. The cache is still the pre-gesture
    // raster, so its zoom is the OLD zoom — that's the transient blur.
    expect(renderer.getLastDrawPath()).toBe('scaled')
    expect(renderer.getCacheZoom()).toBeCloseTo(cam.z, 10)
    expect(renderer.getCacheZoom()).not.toBeCloseTo(store.getCamera().z, 10)

    store.setInteractionState({ mode: 'idle' })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)
    expect(renderer.getCacheZoom()).toBeCloseTo(1.7, 10)

    // And a further static repaint from the settled state presents 1:1,
    // i.e. the cache really is now at the live zoom.
    store.setInteractionState({ mode: 'zooming' })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).not.toBe('scaled')
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('zooming -> zoom -> idle is a full re-render even with several wheel steps', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    for (let i = 0; i < 4; i++) {
      const cam = store.getCamera()
      store.setCamera({ ...cam, z: cam.z * 1.1 })
      await waitFrame()
      await waitFrame()
      expect(renderer.getLastDrawPath()).toBe('scaled')
    }
    const settled = store.getCamera().z
    expect(renderer.getCacheZoom()).not.toBeCloseTo(settled, 10)
    store.setInteractionState({ mode: 'idle' })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBeCloseTo(settled, 10)
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('zooming -> zoom -> idle via resetInteractionState also snaps crisp', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 0.85 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    store.resetInteractionState()
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('leaving zooming for a non-idle mode also settles the cache', async () => {
    // Marquee (or an editing/create mode) can start without passing
    // through idle. The zoom gesture is still over, so the cache must
    // still re-rasterize at the live zoom rather than keep presenting
    // the blurry pre-gesture raster.
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.6 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    expect(renderer.getCacheZoom()).not.toBeCloseTo(store.getCamera().z, 10)

    store.setInteractionState({ mode: 'marqueeing' })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('every non-idle hand-off out of zooming settles the cache', async () => {
    // Regression guard for the branch-shadowing hazard: a mode that its
    // own branch already handles (erasing-ink, editing, creating-shape, ...)
    // must still re-stale on the zoom exit.
    const modes = [
      'erasing-ink',
      'editing',
      'creating-shape',
      'creating-edge',
      'reconnecting-edge',
      'creating-ink',
    ] as const
    for (const mode of modes) {
      const { store, renderer, staticCanvas, interactiveCanvas } = setup()
      renderer.start()
      await waitFrame()
      await waitFrame()
      store.setInteractionState({ mode: 'zooming' })
      const cam = store.getCamera()
      store.setCamera({ ...cam, z: cam.z * 1.5 })
      await waitFrame()
      await waitFrame()
      expect(renderer.getLastDrawPath()).toBe('scaled')
      store.setInteractionState({ mode })
      await waitFrame()
      await waitFrame()
      expect(renderer.getLastDrawPath()).toBe('full')
      expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)
      renderer.dispose()
      cleanup(staticCanvas, interactiveCanvas)
    }
  })

  test('setSize during zooming drops the old-size cache instead of scale-blitting it', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.3 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    // Viewport grows mid-gesture. The old raster covers the old size only;
    // a scaled blit from it would leave an unpainted edge strip.
    renderer.setSize(1000, 720)
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    // The re-rendered cache is for the NEW viewport at the live zoom.
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)

    // A subsequent wheel tick must not fall back to a scaled blit of the
    // dead pre-resize raster either: the cache was rebuilt for this size.
    const cam2 = store.getCamera()
    store.setCamera({ ...cam2, z: cam2.z * 1.1 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    expect(renderer.getCacheZoom()).toBeCloseTo(cam2.z, 10)
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('setSize + zoom in the same task still re-renders at the new size', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.3 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    // No frame boundary between the resize and the next zoom tick.
    renderer.setSize(960, 640)
    store.setCamera({ ...store.getCamera(), z: store.getCamera().z * 1.1 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('a content change during zooming invalidates the cache', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.3 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    expect(renderer.isCacheStale()).toBe(false)

    store.addNode(rectNode('n-2', { x: 320, y: 260 }))
    expect(renderer.isCacheStale()).toBe(true)
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.isCacheStale()).toBe(false)

    // The very next wheel tick must not reuse the pre-edit raster: with
    // the cache rebuilt post-change, it is a scaled blit of the NEW
    // content at the SAME zoom the change was rasterized at.
    const cam2 = store.getCamera()
    store.setCamera({ ...cam2, z: cam2.z * 1.05 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    // Reuse is from the post-change raster, i.e. the cache zoom is the
    // zoom the change was baked at — not some older pre-gesture raster.
    expect(renderer.getCacheZoom()).toBeCloseTo(cam2.z, 10)
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('a content change during zooming is on screen immediately, not cached-stale', async () => {
    // Pixel-level companion to the instrumentation test: the new node must
    // actually be rasterized once the change's full re-render lands.
    const { staticCanvas, interactiveCanvas } = makeCanvases()
    const s = createCanvasStore({ clientId: asClientId('u-pixel') })
    const r = createRenderer({
      store: s,
      staticCanvas,
      interactiveCanvas,
      width: 800,
      height: 600,
      background: { color: 'transparent' },
    })
    s.addNode(rectNode('a', { x: 60, y: 60, w: 120, h: 80, style: { backgroundColor: '#ff0000' } }))
    r.start()
    await waitFrame()
    await waitFrame()
    s.setInteractionState({ mode: 'zooming' })
    const cam = s.getCamera()
    s.setCamera({ ...cam, z: cam.z * 1.25 })
    await waitFrame()
    await waitFrame()
    // Add a red square at a spot that was empty background in the cache.
    s.addNode(
      rectNode('b', {
        x: 420,
        y: 320,
        w: 160,
        h: 120,
        style: { backgroundColor: '#ff0000' },
      }),
    )
    await waitFrame()
    await waitFrame()
    // World (500, 380) is the square's center; camera x/y are 0 and the
    // live zoom is 1.25, so it lands at screen (625, 475).
    const canvasZoom = s.getCamera().z
    const px = staticCanvas
      .getContext('2d')!
      .getImageData(Math.round(500 * canvasZoom), Math.round(380 * canvasZoom), 1, 1).data
    expect(px[0]).toBeGreaterThan(200)
    expect(px[1]).toBeLessThan(60)
    r.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('the scaled-blit ratio caps still gate reuse (no bypass)', async () => {
    // Above SCALED_BLIT_MAX_RATIO (4x) reuse must be refused even mid-zoom.
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 5 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(renderer.getCacheZoom()).toBeCloseTo(store.getCamera().z, 10)
    // And coming back below the cap re-enables reuse (cache is fresh).
    store.setCamera({ ...store.getCamera(), z: store.getCamera().z * 0.9 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('zooming back to the cached zoom presents 1:1 instead of scale-blitting', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = setup()
    renderer.start()
    await waitFrame()
    await waitFrame()
    store.setInteractionState({ mode: 'zooming' })
    const base = store.getCamera().z
    store.setCamera({ ...store.getCamera(), z: base * 1.4 })
    await waitFrame()
    await waitFrame()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    store.setCamera({ ...store.getCamera(), z: base })
    await waitFrame()
    await waitFrame()
    // Cache still at `base`, view back at `base` → tier-1 present.
    expect(renderer.getLastDrawPath()).toBe('present')
    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })
})
