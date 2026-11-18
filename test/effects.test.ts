// Renders real pixels in Node: @napi-rs/canvas (Skia) stands in for
// OffscreenCanvas, the same way vintagejs runs in a Web Worker.
import { Canvas, Image } from '@napi-rs/canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  grainSize,
  lightLeakOrigin,
  seededRandom,
} from '../src/effects';

let vintagejs: typeof import('../src/index').default;
let grain: typeof import('../src/effects');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('Image', undefined);
  vi.stubGlobal('OffscreenCanvas', Canvas);
  vi.stubGlobal('ImageBitmap', Image);
  grain = await import('../src/effects');
  vintagejs = (await import('../src/index')).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flat = (width: number, height: number, value: number) => {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${value},${value},${value})`;
  ctx.fillRect(0, 0, width, height);
  return canvas;
};

const render = async (source: Canvas, effect: object) => {
  const res = await vintagejs<OffscreenCanvas>(
    source as unknown as OffscreenCanvas,
    effect,
  );
  const canvas = res.getCanvas() as unknown as Canvas;
  return canvas
    .getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height).data;
};

/** Mean and standard deviation of the red channel in a column range. */
const stats = (
  data: Uint8ClampedArray,
  width: number,
  fromX = 0,
  toX = width,
) => {
  const values: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const x = (i / 4) % width;
    if (x >= fromX && x < toX) values.push(data[i]);
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
  );
  return { mean, sd };
};

describe('helpers', () => {
  it('seededRandom repeats its sequence and stays in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(values);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });

  it('grain texture is capped relative to the image, never upscaled', () => {
    expect(grainSize(6000, 4000)).toEqual([1200, 800]);
    expect(grainSize(4000, 6000)).toEqual([800, 1200]);
    expect(grainSize(600, 400)).toEqual([600, 400]);
  });

  it('puts the light leak just outside the chosen edge', () => {
    expect(lightLeakOrigin(100, 100, 'right')[0]).toBeGreaterThan(100);
    expect(lightLeakOrigin(100, 100, 'left')[0]).toBeLessThan(0);
    expect(lightLeakOrigin(100, 100, 'top')[1]).toBeLessThan(0);
    expect(lightLeakOrigin(100, 100, 'bottom')[1]).toBeGreaterThan(100);
  });
});

describe('grain', () => {
  it('adds texture to a flat image without shifting its brightness', async () => {
    const data = await render(flat(200, 120, 128), { grain: 0.6 });
    const { mean, sd } = stats(data, 200);
    expect(sd).toBeGreaterThan(5);
    expect(Math.abs(mean - 128)).toBeLessThan(4);
  });

  it('is identical on every run', async () => {
    const a = await render(flat(120, 80, 128), { grain: 0.5 });
    const b = await render(flat(120, 80, 128), { grain: 0.5 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('does nothing at 0', async () => {
    const data = await render(flat(60, 40, 128), { grain: 0 });
    expect(stats(data, 60).sd).toBe(0);
  });
});

describe('light leak', () => {
  it('brightens and warms the chosen edge', async () => {
    const width = 300;
    const data = await render(flat(width, 200, 60), {
      lightLeak: { intensity: 0.8, edge: 'right' },
    });
    const left = stats(data, width, 0, 60).mean;
    const right = stats(data, width, 240, 300).mean;
    expect(right).toBeGreaterThan(left + 40);

    // Warm: at the right edge, red rises more than blue.
    const i = (100 * width + 290) * 4;
    expect(data[i]).toBeGreaterThan(data[i + 2] + 40);
  });

  it('does nothing at intensity 0', async () => {
    const data = await render(flat(60, 40, 60), {
      lightLeak: { intensity: 0 },
    });
    expect(stats(data, 60).sd).toBe(0);
    expect(stats(data, 60).mean).toBe(60);
  });
});

describe('grain texture cache', () => {
  /** Reads the raw RGBA pixels of a cached grain texture. */
  const texturePixels = (width: number, height: number) => {
    const canvas = grain.createGrain(width, height) as unknown as Canvas;
    const ctx = canvas.getContext('2d');
    return Buffer.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  };

  it('reuses one texture per size across alternating renders', async () => {
    const first = grain.createGrain(200, 120);
    const keys = () => grain.getGrainCacheKeys();

    // Alternate two sizes: each is built once and then reused, so the same
    // canvas references come back and the cache never thrashes.
    expect(grain.createGrain(200, 120)).toBe(first);
    const other = grain.createGrain(300, 180);
    expect(grain.createGrain(200, 120)).toBe(first);
    expect(grain.createGrain(300, 180)).toBe(other);
    expect(grain.createGrain(200, 120)).toBe(first);

    expect(keys()).toEqual([
      grain.grainCacheKey(300, 180),
      grain.grainCacheKey(200, 120),
    ]);

    // Images with the same grain size share a texture even if their pixel
    // dimensions differ slightly.
    const [gw, gh] = grain.grainSize(200, 120);
    expect(grain.grainCacheKey(gw, gh)).toBe(grain.grainCacheKey(200, 120));
  });

  it('evicts the least recently used size and rebuilds it pixel-identically', async () => {
    const limit = grain.GRAIN_CACHE_LIMIT;
    const targetKey = grain.grainCacheKey(60, 40);
    const coldPixels = texturePixels(60, 40);

    // Fill the cache with `limit` distinct sizes (all small, so grain size
    // equals image size), touching the target in between so it is not the
    // oldest entry.
    const filler: Array<[number, number]> = [];
    for (let i = 0; i < limit - 1; i++) filler.push([70 + i, 40]);

    for (const [w, h] of filler.slice(0, 2)) {
      await render(flat(w, h, 128), { grain: 0.5 });
    }
    await render(flat(60, 40, 128), { grain: 0.5 });
    for (const [w, h] of filler.slice(2)) {
      await render(flat(w, h, 128), { grain: 0.5 });
    }
    expect(grain.getGrainCacheKeys()).toHaveLength(limit);

    // One more distinct size pushes the least recently used entry out; keep
    // going until the target itself is evicted.
    let evicted = false;
    let next = 200;
    while (grain.getGrainCacheKeys().includes(targetKey)) {
      await render(flat(next, 40, 128), { grain: 0.5 });
      next += 10;
      evicted = true;
    }
    expect(evicted).toBe(true);
    expect(grain.getGrainCacheKeys()).not.toContain(targetKey);
    expect(grain.grainCache.size).toBe(limit);

    // Rebuilding the evicted size yields exactly the cold-start pixels.
    expect(texturePixels(60, 40).equals(coldPixels)).toBe(true);
  });

  const stubFailingViewfinder = () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
  };

  const stubViewfinder = () => {
    const overlay = new Canvas(60, 40);
    const ctx = overlay.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 60, 40);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob()),
      }),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue(overlay),
    );
  };

  it('rolls cache state back when the viewfinder fails and retries like a cold start', async () => {
    stubFailingViewfinder();
    const key = grain.grainCacheKey(60, 40);
    const effect = { grain: 0.6, viewfinder: '/missing.jpg' };

    // A render whose viewfinder rejects must not leave its texture behind,
    // nor change the (empty) cache's state.
    await expect(render(flat(60, 40, 128), effect)).rejects.toThrow('HTTP 500');
    expect(grain.getGrainCacheKeys()).toEqual([]);
    expect(grain.grainCache.has(key)).toBe(false);

    // Another failed render still cannot pollute the cache.
    await expect(render(flat(60, 40, 128), effect)).rejects.toThrow('HTTP 500');
    expect(grain.getGrainCacheKeys()).toEqual([]);

    vi.unstubAllGlobals();
    // Re-apply the environment globals that unstubAllGlobals removed.
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('Image', undefined);
    vi.stubGlobal('OffscreenCanvas', Canvas);
    vi.stubGlobal('ImageBitmap', Image);
    stubViewfinder();

    // A successful render with the same grain size now builds and commits the
    // texture, and its pixels match a cold-start render in a fresh module.
    const retried = await render(flat(60, 40, 128), {
      grain: 0.6,
      viewfinder: '/frame.jpg',
    });
    expect(grain.getGrainCacheKeys()).toEqual([key]);

    vi.resetModules();
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('Image', undefined);
    vi.stubGlobal('OffscreenCanvas', Canvas);
    vi.stubGlobal('ImageBitmap', Image);
    stubViewfinder();
    const fresh = (await import('../src/index')).default;
    const cold = await fresh<OffscreenCanvas>(
      flat(60, 40, 128) as unknown as OffscreenCanvas,
      { grain: 0.6, viewfinder: '/frame.jpg' },
    ).then(res => {
      const canvas = res.getCanvas() as unknown as Canvas;
      return canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height).data;
    });

    expect(Buffer.from(retried).equals(Buffer.from(cold))).toBe(true);
  });

  it('does not change LRU order when a render fails after touching a texture', async () => {
    // Warm the cache with two committed sizes.
    await render(flat(60, 40, 128), { grain: 0.5 });
    await render(flat(80, 40, 128), { grain: 0.5 });
    const orderBefore = grain.getGrainCacheKeys();
    expect(orderBefore).toEqual([
      grain.grainCacheKey(60, 40),
      grain.grainCacheKey(80, 40),
    ]);

    stubFailingViewfinder();
    // Touching the oldest entry inside a render that later rejects must not
    // promote it in the committed LRU order.
    await expect(
      render(flat(60, 40, 128), { grain: 0.5, viewfinder: '/missing.jpg' }),
    ).rejects.toThrow('HTTP 500');
    expect(grain.getGrainCacheKeys()).toEqual(orderBefore);
  });

  it('renders identical pixels on a cache hit and a cache miss', async () => {
    const effect = {
      grain: 0.7,
      vignette: 0.3,
      lightLeak: { intensity: 0.5, edge: 'left' },
    };

    // Cold start: every size is a miss.
    const coldA = await render(flat(120, 80, 100), effect);
    const coldB = await render(flat(160, 90, 100), effect);

    // Second pass: every size is a hit.
    const hitA = await render(flat(120, 80, 100), effect);
    const hitB = await render(flat(160, 90, 100), effect);

    expect(Buffer.from(hitA).equals(Buffer.from(coldA))).toBe(true);
    expect(Buffer.from(hitB).equals(Buffer.from(coldB))).toBe(true);

    // After an explicit invalidation the rebuilt texture gives the same pixels.
    grain.invalidateGrainCache(grain.grainCacheKey(120, 80));
    const rebuilt = await render(flat(120, 80, 100), effect);
    expect(Buffer.from(rebuilt).equals(Buffer.from(coldA))).toBe(true);
  });
});
