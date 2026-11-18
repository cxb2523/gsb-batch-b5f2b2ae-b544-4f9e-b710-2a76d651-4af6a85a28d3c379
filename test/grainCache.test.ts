import { describe, expect, it, vi } from 'vitest';

import { GrainTextureCache } from '../src/grainCache';

/**
 * The cache itself never touches canvas APIs — it only stores references — so
 * plain objects stand in for textures here. That makes the eviction and
 * transaction mechanics testable independently of a canvas/OffscreenCanvas
 * environment.
 */
type FakeTexture = { id: string };
const texture = (id: string): FakeTexture => ({ id });

describe('GrainTextureCache', () => {
  it('reuses the entry for a key and only builds on a miss', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    const buildA = vi.fn(() => texture('A'));
    const buildB = vi.fn(() => texture('B'));

    const a1 = cache.acquire('a', buildA);
    const a2 = cache.acquire('a', buildA);
    const b1 = cache.acquire('b', buildB);
    const a3 = cache.acquire('a', buildA);

    expect(buildA).toHaveBeenCalledTimes(1);
    expect(buildB).toHaveBeenCalledTimes(1);
    expect(a1).toBe(a2);
    expect(a2).toBe(a3);
    expect(b1).toEqual(texture('B'));
    expect(cache.keys()).toEqual(['b', 'a']);
  });

  it('evicts the least recently used entry past the capacity limit', () => {
    const cache = new GrainTextureCache<FakeTexture>(2);

    cache.acquire('a', () => texture('A'));
    cache.acquire('b', () => texture('B'));
    // 'a' was just used, so adding 'c' must evict 'b', not 'a'.
    cache.acquire('a', () => texture('A'));
    cache.acquire('c', () => texture('C'));

    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.keys()).toEqual(['a', 'c']);
  });

  it('rebuilds an evicted entry through the builder', () => {
    const cache = new GrainTextureCache<FakeTexture>(1);
    const build = vi.fn(() => texture('rebuilt'));

    const first = cache.acquire('a', build);
    cache.acquire('b', () => texture('B'));
    expect(cache.has('a')).toBe(false);

    const rebuilt = cache.acquire('a', build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toEqual(texture('rebuilt'));
  });

  it('holds new entries pending until the transaction commits', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    const tx = cache.begin();

    cache.acquire('a', () => texture('A'));
    expect(cache.has('a')).toBe(true);
    expect(cache.keys()).toEqual([]);
    expect(cache.size).toBe(0);

    cache.commit(tx);
    expect(cache.keys()).toEqual(['a']);
    expect(cache.size).toBe(1);
  });

  it('rolls a failed transaction back without touching committed state', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    cache.acquire('a', () => texture('A'));
    cache.acquire('b', () => texture('B'));

    const tx = cache.begin();
    // Touched entries only change recency on commit, new entries stay pending.
    cache.acquire('a', () => texture('A'));
    cache.acquire('c', () => texture('C'));
    cache.rollback(tx);

    expect(cache.keys()).toEqual(['a', 'b']);
    expect(cache.has('c')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('updates LRU recency only when the transaction commits', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    cache.acquire('a', () => texture('A'));
    cache.acquire('b', () => texture('B'));

    const rolledBack = cache.begin();
    cache.acquire('a', () => texture('A'));
    cache.rollback(rolledBack);
    expect(cache.keys()).toEqual(['a', 'b']);

    const committed = cache.begin();
    cache.acquire('a', () => texture('A'));
    cache.commit(committed);
    expect(cache.keys()).toEqual(['b', 'a']);
  });

  it('evicts only on commit, after pending entries become visible', () => {
    const cache = new GrainTextureCache<FakeTexture>(2);
    cache.acquire('a', () => texture('A'));
    cache.acquire('b', () => texture('B'));

    const tx = cache.begin();
    cache.acquire('c', () => texture('C'));
    // Still full from the outside while the render is running.
    expect(cache.keys()).toEqual(['a', 'b']);
    cache.commit(tx);

    expect(cache.keys()).toEqual(['b', 'c']);
    expect(cache.has('a')).toBe(false);
  });

  it('keeps interleaved transactions independent', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    cache.acquire('a', () => texture('A'));

    const tx1 = cache.begin();
    cache.acquire('b', () => texture('B'));
    // A second render starts while the first one is waiting on its viewfinder.
    const tx2 = cache.begin();
    cache.acquire('c', () => texture('C'));
    cache.rollback(tx2);
    cache.commit(tx1);

    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(false);
    expect(cache.keys()).toEqual(['a', 'b']);
  });

  it('shares pending textures between transactions but discards them on rollback', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    const build = vi.fn(() => texture('shared'));

    const tx1 = cache.begin();
    const fromFirst = cache.acquire('a', build);
    const tx2 = cache.begin();
    const fromSecond = cache.acquire('a', build);
    expect(fromFirst).toBe(fromSecond);
    expect(build).toHaveBeenCalledTimes(1);

    cache.rollback(tx1);
    cache.rollback(tx2);
    expect(cache.has('a')).toBe(false);
  });

  it('invalidates a single entry or the whole cache', () => {
    const cache = new GrainTextureCache<FakeTexture>(4);
    cache.acquire('a', () => texture('A'));
    cache.acquire('b', () => texture('B'));

    cache.invalidate('a');
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('rejects an invalid capacity and mismatched transaction calls', () => {
    expect(() => new GrainTextureCache(0)).toThrow('positive integer');
    const cache = new GrainTextureCache<FakeTexture>(2);
    const tx = cache.begin();
    cache.commit(tx);
    expect(() => cache.rollback(tx)).toThrow('matching begin');
  });
});
