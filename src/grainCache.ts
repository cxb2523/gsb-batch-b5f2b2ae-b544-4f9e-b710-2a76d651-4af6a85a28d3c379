import type { TCanvas } from './types';

/**
 * Record of one render's interaction with the cache. Newly built textures are
 * held in `GrainTextureCache.pending` (not visible to LRU eviction) until the
 * render commits; `touched` remembers which committed entries were used, so
 * their recency is only updated on a successful render.
 */
type GrainTransaction = {
  touched: string[];
  created: string[];
};

/**
 * Size-keyed LRU cache of film-grain textures.
 *
 * A texture is expensive to generate (two full-canvas pixel passes) but only
 * depends on its size and a fixed seed, so it can be shared across renders.
 * The cache holds at most `limit` sizes and evicts the least recently used one
 * once the limit is exceeded; an evicted size is simply rebuilt on demand,
 * pixel-identically to the first build.
 *
 * Renders run inside a transaction (`begin`/`commit`/`rollback`): a texture
 * built or touched by a render that is later rejected (e.g. its viewfinder
 * image failed to load) never pollutes the committed cache, so the next
 * successful render behaves exactly like a cold start.
 *
 * The cache only stores canvas references and uses standard `Map` semantics,
 * so it works identically in a browser window and in a Web Worker
 * (OffscreenCanvas).
 */
export class GrainTextureCache<C extends TCanvas = TCanvas> {
  /** Committed textures in LRU order (first = least recently used). */
  private readonly entries = new Map<string, C>();
  /** Textures built by an open transaction, not committed yet. */
  private readonly pending = new Map<string, C>();
  /** Open transactions; the top one owns acquisitions of the running render. */
  private readonly transactions: GrainTransaction[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `GrainTextureCache limit must be a positive integer, got ${limit}`,
      );
    }
  }

  /** Number of committed textures. Pending textures are not counted. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether a texture for `key` is committed or pending. */
  has(key: string): boolean {
    return this.entries.has(key) || this.pending.has(key);
  }

  /** Committed keys in LRU order, least recently used first. */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /** The committed texture for `key`, without changing recency. */
  peek(key: string): C | undefined {
    return this.entries.get(key);
  }

  /**
   * Opens a render transaction. Returns an opaque handle that must be passed
   * to `commit` or `rollback`. Transactions of interleaved renders (the
   * viewfinder load suspends a render in the meantime) are tracked
   * independently.
   */
  begin(): GrainTransaction {
    const transaction: GrainTransaction = { touched: [], created: [] };
    this.transactions.push(transaction);
    return transaction;
  }

  /**
   * Returns the texture for `key`, building it with `build` on a miss.
   * Inside a transaction, misses stay pending until `commit` and hits only
   * record recency (the committed order is unchanged until commit). Without an
   * open transaction the result is committed immediately.
   */
  acquire(key: string, build: () => C): C {
    const transaction = this.transactions[this.transactions.length - 1];

    if (transaction) {
      const pendingTexture = this.pending.get(key);
      if (pendingTexture) return pendingTexture;

      const committed = this.entries.get(key);
      if (committed) {
        if (!transaction.touched.includes(key)) {
          transaction.touched.push(key);
        }
        return committed;
      }

      const texture = build();
      this.pending.set(key, texture);
      transaction.created.push(key);
      return texture;
    }

    const cached = this.entries.get(key);
    if (cached) {
      // Re-insert to mark the entry as most recently used.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const texture = build();
    this.entries.set(key, texture);
    this.evict();
    return texture;
  }

  /**
   * Publishes everything the render built or touched. Pending textures enter
   * the cache, touched entries move to the most-recently-used end, and entries
   * over the capacity are evicted.
   */
  commit(transaction: GrainTransaction): void {
    const index = this.transactions.indexOf(transaction);
    if (index === -1) {
      throw new Error('GrainTextureCache: commit() without a matching begin()');
    }
    this.transactions.splice(index, 1);

    for (const key of transaction.created) {
      const texture = this.pending.get(key);
      if (texture) {
        this.pending.delete(key);
        this.entries.set(key, texture);
      }
    }
    for (const key of transaction.touched) {
      const texture = this.entries.get(key);
      if (texture) {
        this.entries.delete(key);
        this.entries.set(key, texture);
      }
    }
    this.evict();
  }

  /**
   * Discards every texture the failed render built and leaves the committed
   * cache (including LRU order) exactly as it was before the render.
   */
  rollback(transaction: GrainTransaction): void {
    const index = this.transactions.indexOf(transaction);
    if (index === -1) {
      throw new Error(
        'GrainTextureCache: rollback() without a matching begin()',
      );
    }
    this.transactions.splice(index, 1);

    for (const key of transaction.created) {
      this.pending.delete(key);
    }
  }

  /**
   * Explicitly invalidates a texture so the next render rebuilds it. Without a
   * key the whole cache (including pending textures) is cleared.
   */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      this.pending.clear();
      return;
    }
    this.entries.delete(key);
    this.pending.delete(key);
  }

  /** Clears the cache entirely. */
  clear(): void {
    this.invalidate();
  }

  private evict(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
