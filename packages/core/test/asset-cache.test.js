// @vitest-environment jsdom
// Regression tests for the image/pattern render caches: they must converge
// with the document (asset removed or src replaced), with the asset content
// (same id, new src), and with the theme (hatch color), and a late image
// onload must never write back a stale entry or force a redraw.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { drawShape, assetImage } from '../src/shapes.js'
import { Store } from '../src/store.js'
import { themeOf } from '../src/palette.js'

// an Image stand-in: construction is recorded, loading is fired by hand
class MockImage {
  static instances = []
  constructor() { MockImage.instances.push(this) }
  load() { this.onload && this.onload() }
}
const lastImg = () => MockImage.instances[MockImage.instances.length - 1]

const makeCtx = () => {
  const drawn = []
  return {
    drawn,
    fillStyle: null,
    globalAlpha: 1,
    lineWidth: 1,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, roundRect() {}, clip() {}, rect() {},
    fill() {}, stroke() {}, setLineDash() {},
    drawImage(img) { drawn.push(img) },
    createPattern() { return { pat: true } },
  }
}

const imgShape = (assetId) => ({
  id: 's1', typeName: 'shape', type: 'image', x: 0, y: 0, rot: 0, z: 1,
  props: { w: 100, h: 80, assetId },
})

const putAsset = (store, id, src) =>
  store.put({ id, typeName: 'asset', src, w: 100, h: 80 })

afterEach(() => {
  vi.unstubAllGlobals()
  MockImage.instances = []
})

describe('image asset cache', () => {
  it('draws a placeholder while loading, the image after onload + redraw callback', () => {
    vi.stubGlobal('Image', MockImage)
    const store = new Store()
    putAsset(store, 'asset:1', 'data:one')
    const onAssetLoad = vi.fn()
    const ctx = makeCtx()
    const opts = () => ({ theme: themeOf('light'), store, onAssetLoad })

    drawShape(ctx, imgShape('asset:1'), opts())
    expect(ctx.drawn).toHaveLength(0) // placeholder, nothing to draw yet
    expect(onAssetLoad).not.toHaveBeenCalled()

    lastImg().load()
    expect(onAssetLoad).toHaveBeenCalledTimes(1) // load triggers a redraw
    drawShape(ctx, imgShape('asset:1'), opts())
    expect(ctx.drawn).toEqual([lastImg()])
  })

  it('a deleted asset leaves the cache; the same id with a new src reloads', () => {
    vi.stubGlobal('Image', MockImage)
    const store = new Store()
    putAsset(store, 'asset:1', 'data:one')
    drawShape(makeCtx(), imgShape('asset:1'), { theme: themeOf('light'), store })
    lastImg().load()
    expect(assetImage(store, 'asset:1')).toBe(lastImg())

    store.remove(['asset:1'])
    // the cache no longer holds the resource: no image comes back, no reload starts
    const before = MockImage.instances.length
    expect(assetImage(store, 'asset:1')).toBeNull()
    expect(MockImage.instances).toHaveLength(before)

    // same id, different src: a fresh load, and the canvas ends on the new image
    putAsset(store, 'asset:1', 'data:two')
    const ctx = makeCtx()
    drawShape(ctx, imgShape('asset:1'), { theme: themeOf('light'), store })
    expect(ctx.drawn).toHaveLength(0) // not the stale old image
    const img2 = lastImg()
    img2.load()
    drawShape(ctx, imgShape('asset:1'), { theme: themeOf('light'), store })
    expect(ctx.drawn).toEqual([img2])
  })

  it('a late onload from a replaced src neither writes back nor redraws', () => {
    vi.stubGlobal('Image', MockImage)
    const store = new Store()
    putAsset(store, 'asset:1', 'data:one')
    const onAssetLoad = vi.fn()
    const opts = () => ({ theme: themeOf('light'), store, onAssetLoad })

    const ctx = makeCtx()
    drawShape(ctx, imgShape('asset:1'), opts())
    const img1 = lastImg()
    // the asset is replaced before the first image arrives
    putAsset(store, 'asset:1', 'data:two')
    drawShape(ctx, imgShape('asset:1'), opts())
    const img2 = lastImg()
    expect(img2).not.toBe(img1)

    img1.load() // stale echo: must be ignored entirely
    expect(onAssetLoad).not.toHaveBeenCalled()
    drawShape(ctx, imgShape('asset:1'), opts())
    expect(ctx.drawn).toHaveLength(0) // old image never reaches the canvas

    img2.load()
    expect(onAssetLoad).toHaveBeenCalledTimes(1)
    drawShape(ctx, imgShape('asset:1'), opts())
    expect(ctx.drawn).toEqual([img2])
  })

  it('rapid replacements settle on the last src, whichever onload arrives first', () => {
    vi.stubGlobal('Image', MockImage)
    const store = new Store()
    putAsset(store, 'asset:1', 'data:one')
    const opts = () => ({ theme: themeOf('light'), store })
    const ctx = makeCtx()

    drawShape(ctx, imgShape('asset:1'), opts())
    const img1 = lastImg()
    putAsset(store, 'asset:1', 'data:two')
    drawShape(ctx, imgShape('asset:1'), opts())
    const img2 = lastImg()
    putAsset(store, 'asset:1', 'data:three')
    drawShape(ctx, imgShape('asset:1'), opts())
    const img3 = lastImg()

    img3.load() // the current source lands first
    img1.load() // stale echoes arrive after
    img2.load()
    drawShape(ctx, imgShape('asset:1'), opts())
    expect(ctx.drawn).toEqual([img3])
    drawShape(ctx, imgShape('asset:1'), opts())
    expect(ctx.drawn).toEqual([img3, img3]) // stable
  })
})

describe('hatch pattern cache', () => {
  it('pattern fill takes its color from the current theme', () => {
    // record every canvas created so we can read the tile's stroke color
    const tiles = []
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'canvas') tiles.push(el)
      return el
    })
    const shape = {
      id: 'g1', typeName: 'shape', type: 'geo', x: 0, y: 0, rot: 0, z: 1,
      props: { geo: 'rectangle', w: 100, h: 50, color: 'blue', size: 'm', dash: 'solid', fill: 'pattern' },
    }
    const tileColor = () => tiles[tiles.length - 1].getContext('2d').strokeStyle

    const ctx = makeCtx()
    drawShape(ctx, shape, { theme: themeOf('light'), store: new Store() })
    const lightTiles = tiles.length
    expect(tileColor()).toBe(themeOf('light').colors.blue.stroke)
    const lightPattern = ctx.fillStyle

    drawShape(ctx, shape, { theme: themeOf('dark'), store: new Store() })
    expect(tiles.length).toBeGreaterThan(lightTiles) // regenerated, not reused
    expect(tileColor()).toBe(themeOf('dark').colors.blue.stroke)
    expect(ctx.fillStyle).not.toBe(lightPattern)
  })
})
