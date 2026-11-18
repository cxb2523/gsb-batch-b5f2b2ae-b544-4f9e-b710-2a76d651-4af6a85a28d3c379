/**
 * The decoder's lifetime and the cancellation path, exercised offline.
 *
 * `subsyncAudio.ts` is browser-only by nature (Worker, WebAssembly), but the
 * two things that were actually broken about it are not: the cache's reaction
 * to a failed/cancelled run, and the release-versus-load race. Both are driven
 * here through the injectable decoder factory and a local HTTP server, so they
 * run under `npm test` with no network and no wasm.
 *
 * Nothing here touches the real CDN or a real ffmpeg: the factory replaces the
 * loader entirely, and the URL tests serve their own bytes on 127.0.0.1.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import {
  extractReferenceAudio,
  loadBrowserFfmpeg,
  releaseBrowserFfmpeg,
  __browserFfmpegCacheForTests,
  __resetBrowserFfmpegForTests,
  __setBrowserFfmpegFactoryForTests,
} from "./subsyncAudio.ts";
import { SubtitleSyncBusyError } from "./subsyncErrors.ts";

/* ------------------------------------------------------------------------ */
/* A controllable stand-in for ffmpeg.wasm                                   */
/* ------------------------------------------------------------------------ */

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Every deferred here may be abandoned by a test that returns early.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

interface FakeOptions {
  /** When set, `load` waits on this before resolving. */
  loadGate?: Promise<void>;
  /** When set, each `exec` waits on this before returning its code. */
  execGate?: Promise<void>;
  /** Exit code returned by `exec` once its gate resolves. */
  execCode?: number;
  /** Bytes returned by `readFile` (an even number of bytes = whole Int16s). */
  pcmBytes?: number;
}

class FakeFFmpeg {
  loaded = false;
  terminated = false;
  loadCount = 0;
  execCount = 0;
  mountCount = 0;
  unmountCount = 0;
  windows: Int16Array[] = [];
  readonly options: FakeOptions;
  private readonly pending: Array<() => void> = [];

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  load = async (_config: unknown, init?: { signal?: AbortSignal }): Promise<boolean> => {
    this.loadCount += 1;
    if (this.options.loadGate) {
      await Promise.race([
        this.options.loadGate,
        new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      ]);
    }
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    this.loaded = true;
    return true;
  };

  exec = async (_args: string[], _timeout?: number, init?: { signal?: AbortSignal }): Promise<number> => {
    this.execCount += 1;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      // Registered so terminate()/abort can settle a hung command, exactly as
      // the real wrapper's `#rejects` table does.
      this.pending.push(() => finish(() => reject(new Error("called FFmpeg.terminate()"))));
      init?.signal?.addEventListener(
        "abort",
        () => finish(() => reject(new DOMException("aborted", "AbortError"))),
        { once: true },
      );
      if (this.options.execGate) {
        this.options.execGate.then(() => finish(resolve), () => finish(resolve));
      } else {
        finish(resolve);
      }
    });
    return this.options.execCode ?? 0;
  };

  readFile = async (): Promise<Uint8Array> => {
    const size = this.options.pcmBytes ?? 3200; // 0.1 s at 16 kHz
    const bytes = new Uint8Array(size);
    // A constant, non-zero sample so a real VAD would see "speech".
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      bytes[i] = 0x00;
      bytes[i + 1] = 0x40;
    }
    return bytes;
  };

  createDir = async (): Promise<boolean> => true;
  mount = async (): Promise<boolean> => {
    this.mountCount += 1;
    return true;
  };
  unmount = async (): Promise<boolean> => {
    this.unmountCount += 1;
    return true;
  };
  writeFile = async (): Promise<boolean> => true;
  deleteFile = async (): Promise<boolean> => true;

  terminate = (): void => {
    this.terminated = true;
    for (const reject of this.pending.splice(0)) reject();
  };

  asFFmpeg(): FFmpeg {
    return this as unknown as FFmpeg;
  }
}

const install = (options: FakeOptions = {}): { fake: FakeFFmpeg; loads: () => number } => {
  let loads = 0;
  const fake = new FakeFFmpeg(options);
  __setBrowserFfmpegFactoryForTests(() => {
    loads += 1;
    return fake.asFFmpeg();
  });
  return { fake, loads: () => loads };
};

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, or fail. Avoids brittle fixed sleeps. */
const until = async (predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await tick(5);
  }
};

const audio = async (): Promise<void> => {
  await __resetBrowserFfmpegForTests();
};

/** A one-window source that needs no real file: a tiny URL on localhost. */
const withSlowServer = async <T>(
  body: (url: string, close: () => Promise<void>) => Promise<T>,
  options: { chunkBytes?: number; chunkDelayMs?: number; totalBytes?: number } = {},
): Promise<T> => {
  const chunkBytes = options.chunkBytes ?? 1024;
  const chunkDelayMs = options.chunkDelayMs ?? 20;
  const totalBytes = options.totalBytes ?? 1024 * 1024;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const server: Server = createServer((request, response) => {
    response.writeHead(206, { "content-type": "video/mp4" });
    let sent = 0;
    const write = () => {
      if (closed) return;
      if (sent >= totalBytes) {
        response.end();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      response.write(Buffer.alloc(size, 0x2a));
      timer = setTimeout(write, chunkDelayMs);
    };
    write();
    request.on("close", () => {
      if (timer) clearTimeout(timer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    return await body(`http://127.0.0.1:${port}/movie.mp4`, close);
  } finally {
    await close();
  }
};

/* ------------------------------------------------------------------------ */
/* Load / release lifecycle                                                  */
/* ------------------------------------------------------------------------ */

test("decoder cache", async (t) => {
  t.after(audio);

  await t.test("reuses one instance across clean loads", async () => {
    await audio();
    const { loads } = install();
    const first = await loadBrowserFfmpeg();
    const second = await loadBrowserFfmpeg();
    assert.equal(first, second);
    assert.equal(loads(), 1, "a second load must reuse the cached instance");
    assert.equal(__browserFfmpegCacheForTests().loaded, true);
  });

  await t.test("shares one in-flight load between concurrent callers", async () => {
    await audio();
    const gate = deferred();
    const { loads } = install({ loadGate: gate.promise });
    const a = loadBrowserFfmpeg();
    const b = loadBrowserFfmpeg();
    gate.resolve();
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first, second);
    assert.equal(loads(), 1, "concurrent callers must not spawn two decoders");
  });

  await t.test("release during a load waits for it, then terminates it", async () => {
    await audio();
    const gate = deferred();
    const { fake } = install();
    // Replace the factory's load gate with a per-case one so the shared `fake`
    // object is what the loader actually uses.
    fake.options.loadGate = gate.promise;
    const loading = loadBrowserFfmpeg();
    // Give the load a moment to actually begin.
    await until(() => fake.loadCount === 1, "load to start");

    const releasing = releaseBrowserFfmpeg();
    // The load must NOT be able to commit into a slot that is being released.
    gate.resolve();
    await releasing;

    await assert.rejects(loading, (error: unknown) => {
      return error instanceof DOMException && error.name === "AbortError";
    });
    assert.equal(fake.terminated, true, "the orphaned instance must be terminated");
    assert.equal(__browserFfmpegCacheForTests().loaded, false);
  });

  await t.test("a load that finishes after release cannot resurrect the cache", async () => {
    await audio();
    const gate = deferred();
    const { fake } = install();
    fake.options.loadGate = gate.promise;
    const loading = loadBrowserFfmpeg();
    await until(() => fake.loadCount === 1, "load to start");

    const releasing = releaseBrowserFfmpeg();
    gate.resolve();
    await releasing;
    await assert.rejects(loading, (error: unknown) => {
      return error instanceof DOMException && error.name === "AbortError";
    });
    assert.equal(__browserFfmpegCacheForTests().loaded, false, "stale promise installed an instance");
    assert.equal(fake.terminated, true);

    // And a subsequent load starts from scratch.
    const again = install();
    const instance = await loadBrowserFfmpeg();
    assert.equal(again.loads(), 1, "the next load must create a fresh decoder");
    assert.equal(__browserFfmpegCacheForTests().loaded, true);
    assert.ok(instance);
  });

  await t.test("release is safe when idle", async () => {
    await audio();
    await releaseBrowserFfmpeg();
    await releaseBrowserFfmpeg();
    assert.equal(__browserFfmpegCacheForTests().loaded, false);
  });
});

/* ------------------------------------------------------------------------ */
/* Extraction: cancellation and cache hygiene                                */
/* ------------------------------------------------------------------------ */

test("extractReferenceAudio cancellation", async (t) => {
  t.after(audio);

  await t.test("aborts an in-flight URL download and reports AbortError", async () => {
    await audio();
    const { fake } = install();
    await withSlowServer(
      async (url) => {
        const controller = new AbortController();
        const windows: Int16Array[] = [];
        let progressAfterAbort = 0;
        let abortRequested = false;

        const extraction = extractReferenceAudio({
          url,
          signal: controller.signal,
          windowSeconds: 1,
          onWindow: (pcm) => {
            windows.push(new Int16Array(pcm));
          },
          onProgress: ({ downloadedBytes }) => {
            if (abortRequested) {
              progressAfterAbort += 1;
            } else if (downloadedBytes !== undefined && downloadedBytes > 0) {
              abortRequested = true;
              controller.abort();
            }
          },
        });

        await assert.rejects(extraction, (error: unknown) => {
          return error instanceof DOMException && error.name === "AbortError";
        });
        assert.equal(abortRequested, true, "the download must actually have started");
        assert.equal(windows.length, 0, "no window may be delivered after an abort");
        assert.equal(progressAfterAbort, 0, "no progress may be delivered after an abort");
        assert.equal(__browserFfmpegCacheForTests().loaded, false, "decoder cache must be cleared");
        assert.equal(fake.terminated, true);
      },
      { chunkBytes: 4096, chunkDelayMs: 15, totalBytes: 8 * 1024 * 1024 },
    );
  });

  await t.test("aborts while exec is pending: no window, no progress, decoder retired", async () => {
    await audio();
    const gate = deferred();
    const { fake } = install({ execGate: gate.promise });
    const controller = new AbortController();
    const windows: Int16Array[] = [];
    let progressAfterAbort = 0;
    let aborted = false;

    const file = new File([new Uint8Array(1024)], "movie.mp4");
    const extraction = extractReferenceAudio({
      file,
      signal: controller.signal,
      windowSeconds: 1,
      onWindow: (pcm) => windows.push(new Int16Array(pcm)),
      onProgress: () => {
        if (aborted) progressAfterAbort += 1;
      },
    });

    await until(() => fake.execCount === 1, "exec to start");
    aborted = true;
    controller.abort();
    gate.resolve();

    await assert.rejects(extraction, (error: unknown) => {
      return error instanceof DOMException && error.name === "AbortError";
    });
    assert.equal(windows.length, 0, "the pending window must not be delivered");
    assert.equal(progressAfterAbort, 0, "no progress after an abort");
    assert.equal(__browserFfmpegCacheForTests().loaded, false, "decoder cache must be cleared");
  });

  await t.test("a failed run clears the cache; the next run loads a fresh decoder", async () => {
    await audio();
    const first = install({ execCode: 1 }); // non-zero on the very first window
    const controller = new AbortController();

    const file = new File([new Uint8Array(1024)], "movie.mp4");
    await assert.rejects(
      extractReferenceAudio({
        file,
        signal: controller.signal,
        windowSeconds: 1,
        onWindow: () => undefined,
      }),
      /Could not read any audio/,
    );
    assert.equal(__browserFfmpegCacheForTests().loaded, false, "a failed run must evict the decoder");
    assert.equal(first.fake.terminated, true);

    const second = install();
    await extractReferenceAudio({
      file: new File([new Uint8Array(1024)], "movie.mp4"),
      windowSeconds: 1,
      onWindow: () => undefined,
    });
    assert.equal(second.loads(), 1, "the next run must load a NEW decoder");
  });

  await t.test("a clean run leaves the decoder cached for reuse", async () => {
    await audio();
    const { loads } = install();
    const file = new File([new Uint8Array(1024)], "movie.mp4");

    await extractReferenceAudio({ file, windowSeconds: 1, onWindow: () => undefined });
    assert.equal(__browserFfmpegCacheForTests().loaded, true, "a clean run must keep the decoder");
    assert.equal(loads(), 1);

    await extractReferenceAudio({ file, windowSeconds: 1, onWindow: () => undefined });
    assert.equal(loads(), 1, "the cached decoder must be reused");
  });

  await t.test("refuses a concurrent extraction without disturbing the running one", async () => {
    await audio();
    const gate = deferred();
    const { fake } = install({ execGate: gate.promise });
    const file = new File([new Uint8Array(1024)], "movie.mp4");

    const first = extractReferenceAudio({
      file,
      windowSeconds: 1,
      onWindow: () => undefined,
    });
    await until(() => fake.execCount === 1, "first exec");

    // Refused synchronously, and it must not release the decoder the first run
    // is using.
    await assert.rejects(
      extractReferenceAudio({
        file,
        windowSeconds: 1,
        onWindow: () => undefined,
      }),
      (error: unknown) => error instanceof SubtitleSyncBusyError,
    );
    assert.equal(fake.terminated, false, "the refusal must not terminate the active decoder");
    assert.equal(__browserFfmpegCacheForTests().loaded, true);

    gate.resolve();
    await first; // the first run must still complete normally
    assert.equal(__browserFfmpegCacheForTests().loaded, true);
  });
});
