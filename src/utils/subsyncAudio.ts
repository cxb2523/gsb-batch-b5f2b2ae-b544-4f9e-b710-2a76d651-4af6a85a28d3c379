/**
 * Getting reference audio out of a movie, in a browser, without melting it.
 *
 * The browser cannot demux Matroska, MPEG-TS or AVI — the containers this app
 * spends its life on — so a real FFmpeg is needed even here. ffmpeg.wasm is
 * that FFmpeg, loaded ONLY when the user actually asks for an automatic sync;
 * nothing below is touched, and no wasm is fetched, until then.
 *
 * ─── Why this is not simply "decode the file" ───────────────────────────────
 * A 2-hour film is several GB, and the obvious approaches all fall over:
 *
 *   - `decodeAudioData` needs the whole compressed file in memory AND returns
 *     the whole decoded PCM — for a feature film that is well over a gigabyte
 *     of Float32, before any analysis starts.
 *   - `ffmpeg.writeFile` copies the entire file into the wasm heap, which is
 *     both a full read and a second copy of it.
 *
 * Instead:
 *
 *   1. The `File` is MOUNTED (WORKERFS), not copied. ffmpeg then reads it
 *      lazily through the browser's own file handle, so a seek to the 90-minute
 *      mark reads the bytes around the 90-minute mark and nothing else.
 *   2. Audio is pulled in fixed WINDOWS (`-ss T -t N`, input-side, so the seek
 *      is cheap), mono, at a VAD-suitable rate, with the video stream never
 *      touched — `-vn` — so no frame is ever decoded.
 *   3. Each window is handed to the caller and then deleted from the wasm FS
 *      immediately, so peak memory is one window (~10 MB) rather than a film.
 *
 * The caller turns each window into ~N×100 speech samples and drops the PCM;
 * see subsyncVad.ts. Net memory for a 3-hour film is about 8 MB of signal.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ─── Cancellation and the decoder's lifetime ────────────────────────────────
 * A run can be cancelled at any point — while the core downloads, while a URL
 * prefix is being pulled, or between/inside window decodes. `signal` is wired
 * all the way down:
 *
 *   - the core download and the media-prefix download are fetches given the
 *     signal, so aborting closes their bodies;
 *   - `ffmpeg.exec`/`readFile` are given the signal, so their promises reject
 *     promptly instead of waiting for a 100-second window to finish;
 *   - and because a wasm command keeps running after its JS promise rejects,
 *     aborting also RETIRES the decoder (see releaseBrowserFfmpeg) so the
 *     worker is actually torn down rather than left crunching.
 *
 * After an abort no further window or progress reaches the caller: every
 * callback is gated on the internal signal, and the loop re-checks it after
 * each await.
 *
 * One run at a time. A second `extractReferenceAudio` started while the first
 * is still going is refused with `SubtitleSyncBusyError` rather than being
 * allowed to mount over the first one; the refusal is synchronous and touches
 * no shared state, so it cannot poison the run that owns the decoder or the
 * one that follows it.
 *
 * The decoder is a page-level singleton, reused across successful runs. Any
 * failure — cancellation included — drops it, so the next run loads a fresh
 * instance instead of reusing one that was terminated or left half-loaded.
 * Releasing is serialised against an in-flight load (see the slot logic) so a
 * load can neither land after its release nor be resurrected by a stale
 * promise.
 *
/**
 * Browser-only by nature (Worker, WebAssembly, File). The cache/lifecycle and
 * cancellation logic is injectable so that `node --test` can exercise it
 * offline — see subsyncAudioLifecycle.test.ts — and the sync gate it refuses
 * through is covered in subsyncGate.test.ts.
 */

import type { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { SubtitleSyncBusyError } from "./subsyncErrors.ts";

/**
 * Sample rate handed to the detector.
 *
 * ffsubsync asks ffmpeg for 48 kHz. We ask for 16 kHz, which is a third of the
 * bytes to move out of wasm for output that is identical: the detector reduces
 * every 10 ms window to a single mean-square number, and that number does not
 * care how finely the window was sampled. 16 kHz is also what every VAD worth
 * the name is designed around. The native engine uses the same rate, so the
 * two produce the same signal from the same audio.
 */
export const EXTRACT_SAMPLE_RATE = 16000;

/**
 * Seconds of audio per ffmpeg invocation.
 *
 * 100 s is ~3.2 MB of PCM — small enough to hold twice (wasm side and ours)
 * without strain, large enough that a 2-hour film costs ~72 invocations rather
 * than hundreds, each of which pays a container-open cost.
 *
 * The number is not free to change. The detector has no state between blocks,
 * so a run of speech crossing a boundary becomes two shorter runs, and one that
 * ends up under the 0.2 s minimum is discarded. Blocking at 100 s is what
 * ffsubsync's own read loop does, and what the native path does, so the same
 * audio produces the same signal whichever engine sees it.
 */
export const EXTRACT_WINDOW_SECONDS = 100;

/**
 * Hard cap on bytes pulled for a URL-based extraction.
 *
 * With a `File` there is no cap and no need for one — it is mounted and read
 * in place. A URL has to be fetched, and fetched bytes are held: there is no
 * lazy random access to a remote stream from inside wasm. So this path is for
 * getting a usable answer out of the FRONT of a film, not for analysing all of
 * it, and 192 MB is roughly fifteen minutes of a decent encode.
 */
export const URL_FETCH_BYTE_CAP = 192 * 1024 * 1024;

/**
 * Where the ~32 MB wasm core comes from.
 *
 * Self-hosted first: dropping the ESM build's `ffmpeg-core.js` /
 * `ffmpeg-core.wasm` into `public/ffmpeg/` makes this work offline and under a
 * strict CSP, with no change to any code. Otherwise the pinned CDN build,
 * fetched on first use. `VITE_FFMPEG_CORE_URL` overrides both.
 *
 * The version is pinned deliberately: ffmpeg.wasm's JS wrapper and its core
 * are a matched pair, and letting the core float would eventually load one the
 * wrapper cannot talk to.
 */
const CORE_VERSION = "0.12.9";
/**
 * The ESM core, NOT the UMD one the ffmpeg.wasm README shows.
 *
 * Vite bundles ffmpeg.wasm's own class worker as a MODULE worker, and a module
 * worker has no `importScripts` — which is the only way the UMD build can be
 * loaded. ffmpeg.wasm's fallback path handles this by dynamically importing the
 * core instead and reading its default export, which only the ESM build has.
 * Point this at `/umd/` and the load fails with a bare "failed to import
 * ffmpeg-core.js" that says nothing about why.
 */
const CDN_CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const SELF_HOSTED_CORE_BASE = "/ffmpeg";

/**
 * SHA-256 of the pinned CDN build, checked before the code is run.
 *
 * The core is a script and a WebAssembly module fetched from a third party and
 * then EXECUTED. A pinned version number says which bytes were meant; it does
 * not say the bytes arrived. `<script integrity>` cannot help here — the core
 * is loaded from inside a worker, not from a tag — so the check is done by
 * hand, and a mismatch is fatal rather than a warning.
 *
 * Only the CDN is checked. A self-hosted core is served by the same origin as
 * the app, and `VITE_FFMPEG_CORE_URL` is a deliberate choice by whoever built
 * it; hashing either would just mean this list needed updating to use them.
 *
 * To move to a new core: bump CORE_VERSION and replace these with
 *   curl -sL <url> | openssl dgst -sha256 -binary | openssl base64 -A
 */
const CDN_CORE_HASHES: Record<string, string> = {
  "ffmpeg-core.js": "Z6SPEWRfhUOfP95PIRkELBazdLkQIGt6eiTzQuKNyuM=",
  "ffmpeg-core.wasm": "n1eUelvVMNjwDFs/LLKjSS+qfl2CMxU0LWqGVtCmt7c=",
};

const coreBaseUrl = (): string => {
  // Typed locally: `import.meta.env` comes from vite/client, and the test
  // project (tsconfig.test.json) compiles src/utils without it.
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const override = env?.VITE_FFMPEG_CORE_URL;
  return typeof override === "string" && override ? override.replace(/\/+$/, "") : "";
};

export class AudioExtractionUnavailableError extends Error {
  /**
   * `cause` is folded into the message rather than passed to `Error`: this
   * project compiles against the ES2020 lib, where the two-argument Error
   * constructor does not exist. The detail is worth keeping — it is what
   * distinguishes "no network" from "this browser refused the mount" in the
   * debug log — so it rides along in the text.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    const detail =
      options?.cause instanceof Error
        ? options.cause.message
        : options?.cause === undefined
          ? ""
          : String(options.cause);
    super(detail ? `${message} (${detail})` : message);
    this.name = "AudioExtractionUnavailableError";
  }
}

const abortError = (message = "Subtitle sync was cancelled"): DOMException =>
  new DOMException(message, "AbortError");

/** `DOMException` in every engine we target; the name check also survives
 *  cross-realm errors and the plain Errors some shims throw. */
const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

/**
 * Race a promise against a caller's abort, without cancelling the work itself.
 *
 * Used when a call JOINS another caller's in-flight load: the joiner must be
 * able to give up on its own signal, but must not tear down a load that
 * belongs to someone else. A `signal` of undefined just returns the promise.
 */
const raceWithSignal = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const toBase64 = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
};

/* ------------------------------------------------------------------------ */
/* Decoder lifecycle                                                         */
/* ------------------------------------------------------------------------ */

/**
 * One decoder slot: the loaded instance, or the promise that is loading it.
 *
 * `generation` is the release token. Every slot gets a fresh, monotonically
 * increasing one, and a load may only COMMIT (install its instance) while its
 * own generation is still the current one. Release bumps the counter before it
 * awaits anything, so a load that was in flight can only ever observe a
 * mismatch and tear itself down. That is what makes "released while loading"
 * and "load landed after release" impossible, in either ordering.
 */
interface DecoderSlot {
  generation: number;
  instance: FFmpeg | null;
  loading: Promise<FFmpeg> | null;
  /** Aborts the in-flight load's network traffic when the slot is released. */
  controller: AbortController;
  /** Blob URLs created for this core, revoked when the slot dies. */
  coreUrls: string[];
}

let slot: DecoderSlot | null = null;
let generationCounter = 0;

/**
 * Test seam: build the decoder without touching wasm, the network or a Worker.
 *
 * Production never sets this; `null` means the real loader below runs. Exposed
 * so `subsyncAudioLifecycle.test.ts` can drive cancellation, concurrency and
 * cache eviction under `node --test`.
 */
type DecoderFactory = () => FFmpeg;
let decoderFactory: DecoderFactory | null = null;

const revokeCoreUrls = (entry: DecoderSlot): void => {
  for (const url of entry.coreUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* a URL that was never created, or already revoked */
    }
  }
  entry.coreUrls.length = 0;
};

/**
 * Fetch one piece of the core, check it if it came from the CDN, and hand back
 * a blob URL.
 *
 * Fetched by hand rather than through `@ffmpeg/util`'s `toBlobURL` because the
 * signal has to reach the network request: cancelling during the ~32 MB core
 * download is one of the moments this feature is expected to be cancellable.
 */
const fetchCorePart = async (
  url: string,
  mimeType: string,
  verify: boolean,
  signal: AbortSignal | undefined,
  onProgress: (fraction: number) => void,
  onObjectUrl: (url: string) => void,
): Promise<string> => {
  const expected = CDN_CORE_HASHES[url.slice(url.lastIndexOf("/") + 1)];
  const response = await fetch(url, { cache: "force-cache", signal });
  if (!response.ok) {
    throw new AudioExtractionUnavailableError(
      `Could not download the audio decoder (HTTP ${response.status}).`,
    );
  }

  // Typed as an ArrayBuffer-backed view (not ArrayBufferLike): digest() and
  // Blob accept only the former, and a SharedArrayBuffer is never involved.
  let bytes: Uint8Array<ArrayBuffer>;
  if (response.body) {
    // Read incrementally so progress is real and an abort stops promptly.
    const reader = response.body.getReader();
    const total = Number(response.headers.get("content-length")) || 0;
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) onProgress(Math.min(1, received / total));
    }
    bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  onProgress(1);

  // A plain-http LAN address is not a secure context, so `crypto.subtle` may
  // be absent there. Verification is then skipped rather than failing the
  // feature — the same tradeoff the old toBlobURL fallback made.
  if (verify && expected && globalThis.crypto?.subtle) {
    const actual = toBase64(await crypto.subtle.digest("SHA-256", bytes));
    if (actual !== expected) {
      throw new AudioExtractionUnavailableError(
        "The audio decoder downloaded from the CDN did not match its expected checksum, so it was not run.",
      );
    }
  }

  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  onObjectUrl(objectUrl);
  return objectUrl;
};

/**
 * True when a self-hosted core is really present.
 *
 * A 200 is NOT enough to conclude that. This app is a single-page app behind a
 * catch-all fallback — the Vite dev server, the Cloudflare Worker's asset
 * handler and the Tauri relay all answer an unknown path with `index.html` and
 * a 200. Trusting the status alone therefore "finds" a core that is really the
 * app's own HTML, and ffmpeg.wasm fails at load with an opaque
 * `Unexpected token '<'`.
 *
 * The content type settles it: every host that serves a real .wasm labels it
 * `application/wasm`, and no fallback ever will.
 */
const selfHostedCoreAvailable = async (signal?: AbortSignal): Promise<boolean> => {
  try {
    const response = await fetch(`${SELF_HOSTED_CORE_BASE}/ffmpeg-core.wasm`, {
      method: "HEAD",
      signal,
    });
    if (!response.ok) return false;
    return (response.headers.get("content-type") ?? "").toLowerCase().includes("wasm");
  } catch {
    return false;
  }
};

/** Load the real ffmpeg.wasm instance. The slot owner terminates it on abort. */
const createRealDecoder = async (
  entry: DecoderSlot,
  signal: AbortSignal | undefined,
  onProgress?: (fraction: number) => void,
): Promise<FFmpeg> => {
  let FFmpegCtor: typeof FFmpeg;
  try {
    // Dynamic so the wrapper is a separate chunk the app never loads unless
    // an automatic sync is actually requested.
    const ffmpegModule = await import("@ffmpeg/ffmpeg");
    FFmpegCtor = ffmpegModule.FFmpeg;
  } catch (error) {
    throw new AudioExtractionUnavailableError("Could not load the in-browser audio decoder.", {
      cause: error,
    });
  }

  const override = coreBaseUrl();
  const base = override || ((await selfHostedCoreAvailable(signal)) ? SELF_HOSTED_CORE_BASE : CDN_CORE_BASE);
  const verify = base === CDN_CORE_BASE;
  const ffmpeg = new FFmpegCtor();

  try {
    const [coreURL, wasmURL] = await Promise.all([
      fetchCorePart(
        `${base}/ffmpeg-core.js`,
        "text/javascript",
        verify,
        signal,
        (fraction) => onProgress?.(fraction * 0.5),
        (url) => entry.coreUrls.push(url),
      ),
      fetchCorePart(
        `${base}/ffmpeg-core.wasm`,
        "application/wasm",
        verify,
        signal,
        (fraction) => onProgress?.(0.5 + fraction * 0.5),
        (url) => entry.coreUrls.push(url),
      ),
    ]);
    throwIfAborted(signal);
    await ffmpeg.load({ coreURL, wasmURL }, { signal });
    return ffmpeg;
  } catch (error) {
    // The worker may already exist (load spawns it before the core arrives);
    // terminating is the only way to stop it if we are backing out.
    try {
      ffmpeg.terminate();
    } catch {
      /* never started */
    }
    if (isAbortError(error) || signal?.aborted) throw abortError();
    if (error instanceof AudioExtractionUnavailableError) throw error;
    throw new AudioExtractionUnavailableError(
      base === CDN_CORE_BASE
        ? "Could not download the in-browser audio decoder. Check your connection, or connect the desktop app to sync without it."
        : "Could not start the in-browser audio decoder.",
      { cause: error },
    );
  }
};

/**
 * Load ffmpeg.wasm once per page, and reuse it while it is healthy.
 *
 * Concurrent callers share the one in-flight load rather than spawning two
 * workers. A load that is released (or superseded) while in flight never
 * commits: it terminates its own instance and rejects with an AbortError, so
 * no orphaned wasm heap is left behind and no stale promise can resurrect a
 * decoder that `releaseBrowserFfmpeg` has already retired.
 */
export const loadBrowserFfmpeg = async (
  onProgress?: (fraction: number) => void,
  options?: { signal?: AbortSignal },
): Promise<FFmpeg> => {
  const outerSignal = options?.signal;
  throwIfAborted(outerSignal);

  if (slot) {
    if (slot.instance) return slot.instance;
    if (slot.loading) {
      // A caller that shares someone else's in-flight load must still honour
      // ITS OWN abort: its promise rejects with AbortError without cancelling
      // the shared load (that belongs to the caller who started it).
      return raceWithSignal(slot.loading, outerSignal);
    }
  }

  const entry: DecoderSlot = {
    generation: (generationCounter += 1),
    instance: null,
    loading: null,
    controller: new AbortController(),
    coreUrls: [],
  };
  slot = entry;

  // The caller's signal and this slot's own (release) signal, combined without
  // depending on `AbortSignal.any`, which older WebViews do not have.
  const onOuterAbort = () => entry.controller.abort();
  if (outerSignal?.aborted) entry.controller.abort();
  else outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const promise = (async (): Promise<FFmpeg> => {
    let ffmpeg: FFmpeg | null = null;
    try {
      if (decoderFactory) {
        // Test seam: the fake owns its own (possibly slow) `load`, so the
        // cancellation and release races can be driven deterministically.
        ffmpeg = decoderFactory();
        await ffmpeg.load({}, { signal: entry.controller.signal });
      } else {
        ffmpeg = await createRealDecoder(entry, entry.controller.signal, onProgress);
      }
    } catch (error) {
      // A load that fails leaves a spawned worker behind (the real loader
      // spawns it before the core arrives). Tear it down here too, so the
      // "failed load = no decoder" rule holds for the injected loader as well.
      if (ffmpeg) {
        try {
          ffmpeg.terminate();
        } catch {
          /* never started */
        }
      }
      if (slot === entry) slot = null;
      revokeCoreUrls(entry);
      // The catch path exits via the `finally`, so undo the outer listener
      // here — a load that failed or was released has nothing left to abort.
      outerSignal?.removeEventListener("abort", onOuterAbort);
      if (isAbortError(error) || entry.controller.signal.aborted || outerSignal?.aborted) {
        throw abortError();
      }
      if (error instanceof AudioExtractionUnavailableError) throw error;
      throw new AudioExtractionUnavailableError("Could not load the in-browser audio decoder.", {
        cause: error,
      });
    } finally {
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }

    // COMMIT CHECK — the release protocol in one line. If the slot was
    // released (or replaced) while this load ran, the instance belongs to
    // nobody: tear it down ourselves instead of installing it.
    // (`ffmpeg` cannot be null here: the try block either assigned it or threw.)
    const instance = ffmpeg as FFmpeg;
    if (slot !== entry || entry.generation !== generationCounter) {
      try {
        instance.terminate();
      } catch {
        /* never started */
      }
      revokeCoreUrls(entry);
      throw abortError();
    }

    entry.instance = instance;
    entry.loading = null;
    return instance;
  })();

  entry.loading = promise;
  return promise;
};

/**
 * Retire the decoder and free its wasm heap. Safe to call when idle.
 *
 * Serialised against an in-flight load by construction: the slot is detached
 * and the generation bumped BEFORE anything is awaited, which both invalidates
 * a load that is still running and prevents a later load from committing into
 * the slot this call is about to tear down. Only then does it wait for the
 * pending load (so the caller knows the release is complete) and terminate
 * whatever instance actually exists.
 */
export const releaseBrowserFfmpeg = async (): Promise<void> => {
  const current = slot;
  if (!current) return;
  slot = null;
  generationCounter += 1;

  // Stop the core download and the worker's load, so awaiting is prompt.
  current.controller.abort();

  if (current.loading) {
    try {
      await current.loading;
    } catch {
      /* cancelled or failed: it produced nothing worth keeping */
    }
  }

  const instance = current.instance;
  current.instance = null;
  if (instance) {
    try {
      instance.terminate();
    } catch {
      /* already gone */
    }
  }
  revokeCoreUrls(current);
};

/** Test-only: the current cache state, for assertions. */
export const __browserFfmpegCacheForTests = (): {
  loaded: boolean;
  loading: boolean;
  generation: number;
} => ({
  loaded: Boolean(slot?.instance),
  loading: Boolean(slot?.loading),
  generation: generationCounter,
});

/** Test-only: replace the real wasm loader, or pass null to restore it. */
export const __setBrowserFfmpegFactoryForTests = (factory: DecoderFactory | null): void => {
  decoderFactory = factory;
};

/** Test-only: drop all module state between cases. */
export const __resetBrowserFfmpegForTests = async (): Promise<void> => {
  await releaseBrowserFfmpeg();
  decoderFactory = null;
  slot = null;
  generationCounter += 1;
};

/* ------------------------------------------------------------------------ */
/* Extraction                                                                */
/* ------------------------------------------------------------------------ */

export interface ExtractAudioOptions {
  /** The dropped file. Mounted, never copied. Preferred over `url`. */
  file?: File;
  /** A fetchable media URL. Downloaded in full, so only for modest sources. */
  url?: string;
  sampleRate?: number;
  windowSeconds?: number;
  /** Skip the media before this point. */
  startSeconds?: number;
  /** Stop after this much audio; undefined reads to the end. */
  maxDurationSeconds?: number | null;
  /** Total duration when known, so progress can be a fraction rather than a count. */
  durationSec?: number;
  /** Override the URL prefix cap. Ignored for a `file`, which has no cap. */
  urlByteCap?: number;
  signal?: AbortSignal;
  /** Called per window with mono 16-bit PCM. The buffer is reused — copy it. */
  onWindow: (pcm: Int16Array, windowStartSeconds: number) => void | Promise<void>;
  onProgress?: (info: {
    processedSeconds: number;
    totalSeconds?: number;
    /** 0..1 while the wasm core itself is downloading. */
    loadingDecoder?: number;
    /** Bytes pulled so far, on the URL path only. */
    downloadedBytes?: number;
  }) => void;
}

const INPUT_NAME = "subsync-input";
const OUTPUT_NAME = "subsync-window.pcm";
const MOUNT_POINT = "/subsync";
/** `FFFSType.WORKERFS`, as a literal so the enum need not be imported at
 *  runtime (its value is the string the worker compares against). */
const WORKERFS = "WORKERFS";

/**
 * There is one wasm instance, and it has one filesystem.
 *
 * Two extractions at once would mount over each other, read each other's
 * output file and leave the mount point in whatever state the loser unwound
 * to. The UI serializes runs for its own reasons, but this makes the module
 * safe on its own terms.
 *
 * Ownership is a token, not a boolean: the loser must never clear a flag that
 * belongs to the run it was refused by. The token is released only by the
 * owner, in one place, after cleanup.
 */
let extractionOwner: symbol | null = null;

/**
 * Fetch a bounded prefix of a URL.
 *
 * Range-requested first, and — because a server may ignore Range, and the app's
 * own relay streams rather than seeks — the body is also read incrementally and
 * ABORTED at the cap. Either way nothing larger than `cap` is ever held.
 *
 * The signal is checked per chunk as well as wired into `fetch`, so an abort
 * re-thrown from here is an AbortError rather than a raw stream failure.
 */
const fetchBoundedPrefix = async (
  url: string,
  cap: number,
  signal: AbortSignal | undefined,
  onBytes?: (received: number) => void,
): Promise<Uint8Array> => {
  throwIfAborted(signal);
  const controller = new AbortController();
  const stopOuter = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", stopOuter, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { range: `bytes=0-${cap - 1}` },
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw abortError();
      throw error;
    }
    if (!response.ok && response.status !== 206) {
      throw new AudioExtractionUnavailableError(
        `Could not read this video (HTTP ${response.status}).`,
      );
    }
    if (!response.body) {
      throwIfAborted(signal);
      return new Uint8Array(await response.arrayBuffer());
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        received += value.byteLength;
        onBytes?.(received);
        if (received >= cap) {
          // Stop the transfer rather than draining a multi-gigabyte body.
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw abortError();
      }
      throw error;
    }
    throwIfAborted(signal);
    const out = new Uint8Array(Math.min(received, cap));
    let at = 0;
    for (const chunk of chunks) {
      if (at >= out.length) break;
      const take = Math.min(chunk.byteLength, out.length - at);
      out.set(chunk.subarray(0, take), at);
      at += take;
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", stopOuter);
  }
};

/** `-ss` wants a duration; ffsubsync writes them as H:MM:SS, so we do too. */
const asTimestamp = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const fraction = Math.max(0, seconds - whole);
  const base = `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return fraction > 0 ? `${base}.${Math.round(fraction * 1000).toString().padStart(3, "0")}` : base;
};

/**
 * Decode the reference audio, one window at a time.
 *
 * The ffmpeg arguments mirror ffsubsync's `_build_ffmpeg_args` — including
 * `-af aresample=async=1`, which is load-bearing rather than decorative: a
 * stream with dropped or duplicated samples would otherwise make byte position
 * drift away from wall-clock time, and since the entire method is "which
 * 10 ms window was this", every offset would come out wrong by that drift.
 *
 * Cancellable at every await: the signal reaches the network, the decoder
 * load, and each ffmpeg call; aborting also retires the decoder so the wasm
 * worker stops rather than finishing the window in the background. Any error
 * or cancellation evicts the decoder; a clean finish leaves it cached.
 */
export const extractReferenceAudio = async (options: ExtractAudioOptions): Promise<number> => {
  const sampleRate = options.sampleRate ?? EXTRACT_SAMPLE_RATE;
  const windowSeconds = options.windowSeconds ?? EXTRACT_WINDOW_SECONDS;
  const startSeconds = options.startSeconds ?? 0;
  const maxDurationSeconds = options.maxDurationSeconds ?? null;

  // Refused before ANY shared state is touched — in particular before the
  // decoder is consulted and before the existing run's signal or mount is
  // disturbed. The caller of the rejected run simply gets an error.
  if (extractionOwner) {
    throw new SubtitleSyncBusyError("Another subtitle sync is already reading this video.");
  }
  throwIfAborted(options.signal);

  const owner = Symbol("subsync-extraction");
  extractionOwner = owner;

  // Internal signal: the caller's abort and our own teardown both feed it.
  const run = new AbortController();
  const signal = run.signal;

  // Release is idempotent; the first caller (an abort listener, or the
  // failure path below) starts it, everyone else awaits the same promise.
  let releasing: Promise<void> | null = null;
  const retireDecoder = (): Promise<void> => {
    if (!releasing) releasing = releaseBrowserFfmpeg();
    run.abort();
    return releasing;
  };
  const onCallerAbort = () => {
    void retireDecoder();
  };
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let ffmpeg: FFmpeg | null = null;
  let mounted = false;
  let wrote = false;
  let processedSeconds = 0;
  let windowsWithAudio = 0;
  let failure: unknown;
  let failed = false;

  try {
    ffmpeg = await loadBrowserFfmpeg(
      (fraction) => {
        if (signal.aborted) return;
        options.onProgress?.({ processedSeconds: 0, loadingDecoder: fraction });
      },
      { signal },
    );
    throwIfAborted(signal);

    let inputPath: string;

    if (options.file) {
      // WORKERFS reads through the File handle, so the multi-GB body never
      // enters the wasm heap. If the runtime refuses the mount we do NOT fall
      // back to writeFile — that would quietly turn a memory-safe path into an
      // out-of-memory crash on exactly the large files this exists for.
      try {
        await ffmpeg.createDir(MOUNT_POINT);
      } catch {
        /* already there from an earlier run */
      }
      throwIfAborted(signal);
      try {
        // The enum's runtime value is the string the worker checks; passing
        // the literal (cast only) keeps @ffmpeg out of any statically-loaded
        // chunk while staying type-checked.
        await ffmpeg.mount(WORKERFS as unknown as FFFSType, { files: [options.file] }, MOUNT_POINT);
        mounted = true;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw abortError();
        throw new AudioExtractionUnavailableError(
          "This browser cannot read the video file without loading all of it into memory, which is unsafe for a file this size.",
          { cause: error },
        );
      }
      inputPath = `${MOUNT_POINT}/${options.file.name}`;
    } else if (options.url) {
      // A BOUNDED prefix, never the whole thing: unlike a File, a URL cannot be
      // read lazily from inside wasm, so whatever is fetched is held. See
      // URL_FETCH_BYTE_CAP.
      const prefix = await fetchBoundedPrefix(
        options.url,
        options.urlByteCap ?? URL_FETCH_BYTE_CAP,
        signal,
        (received) => {
          if (signal.aborted) return;
          options.onProgress?.({ processedSeconds: 0, downloadedBytes: received });
        },
      );
      throwIfAborted(signal);
      await ffmpeg.writeFile(INPUT_NAME, prefix, { signal });
      wrote = true;
      inputPath = INPUT_NAME;
    } else {
      throw new AudioExtractionUnavailableError("No video file or URL to read audio from.");
    }

    const totalSeconds =
      maxDurationSeconds !== null
        ? maxDurationSeconds
        : options.durationSec
          ? Math.max(0, options.durationSec - startSeconds)
          : undefined;

    for (let offset = 0; ; offset += windowSeconds) {
      throwIfAborted(signal);
      if (maxDurationSeconds !== null && offset >= maxDurationSeconds) break;
      if (totalSeconds !== undefined && offset >= totalSeconds) break;

      const remaining =
        maxDurationSeconds !== null ? Math.min(windowSeconds, maxDurationSeconds - offset) : windowSeconds;

      // `-ss` and `-t` BEFORE `-i` so the seek happens on the input and the
      // demuxer stops reading at the end of the window, rather than decoding
      // the whole file and discarding most of it.
      const args = [
        "-ss",
        asTimestamp(startSeconds + offset),
        "-t",
        asTimestamp(remaining),
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vn",
        "-f",
        "s16le",
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-af",
        "aresample=async=1",
        "-ar",
        String(sampleRate),
        OUTPUT_NAME,
      ];

      // The signal makes the waiting promise reject the moment the user
      // cancels; terminating the decoder (in the abort listener) is what stops
      // the wasm command itself.
      const code = await ffmpeg.exec(args, -1, { signal });
      throwIfAborted(signal);
      if (code !== 0) {
        if (windowsWithAudio === 0) {
          throw new AudioExtractionUnavailableError(
            "Could not read any audio from this video.",
          );
        }
        // A non-zero code at the tail is how ffmpeg reports "seek past the
        // end", which is exactly how we discover the duration when nobody
        // told us one.
        break;
      }

      let data: Uint8Array;
      try {
        data = (await ffmpeg.readFile(OUTPUT_NAME, "binary", { signal })) as Uint8Array;
      } finally {
        // Delete before doing anything with the bytes: the window's copy in
        // the wasm heap is dead weight from here on.
        await ffmpeg.deleteFile(OUTPUT_NAME).catch(() => undefined);
      }
      throwIfAborted(signal);
      if (data.byteLength === 0) break;

      // Int16 view over the same bytes — no copy. `byteOffset` matters: the
      // emscripten heap hands back a subarray, not a fresh buffer.
      const usable = data.byteLength - (data.byteLength % 2);
      const pcm = new Int16Array(data.buffer, data.byteOffset, usable / 2);
      await options.onWindow(pcm, startSeconds + offset);
      // A cancel can land while the caller is processing the window. Nothing
      // further — no progress, no next window — may be delivered after that.
      throwIfAborted(signal);
      windowsWithAudio += 1;

      const windowSecondsRead = pcm.length / sampleRate;
      processedSeconds += windowSecondsRead;
      options.onProgress?.({ processedSeconds, totalSeconds });

      // Short window = end of stream (or the end of a truncated prefix).
      // Compared against the request rather than the nominal window so a final
      // partial window still counts.
      if (windowSecondsRead < remaining - 0.5) break;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  // Cleanup runs on the normal path too. Every step is best-effort: after a
  // cancel the decoder may already be gone, and a failed unmount must not
  // mask the real outcome. Wrapped so a release that races this cleanup (both
  // call terminate/unmount) cannot escape as an unhandled rejection.
  if (ffmpeg) {
    if (mounted) await ffmpeg.unmount(MOUNT_POINT).catch(() => undefined);
    if (wrote) await ffmpeg.deleteFile(INPUT_NAME).catch(() => undefined);
    await ffmpeg.deleteFile(OUTPUT_NAME).catch(() => undefined);
  }

  const aborted =
    signal.aborted ||
    options.signal?.aborted === true ||
    (failed && isAbortError(failure));

  // Any failure or cancellation retires the decoder: it may be terminated,
  // mid-command, or half-initialised, and the next sync must load a fresh
  // instance rather than inherit that. A clean run leaves the cache alone.
  if (failed || aborted) {
    await (releasing ?? releaseBrowserFfmpeg()).catch(() => undefined);
    releasing = null;
  }

  options.signal?.removeEventListener("abort", onCallerAbort);
  if (extractionOwner === owner) extractionOwner = null;

  // A cancel that landed while cleanup was running is still a cancel: the
  // listener above (or the caller's own flag) has retired the decoder, so
  // reporting success here would hand back a run the user already stopped.
  if (aborted || signal.aborted || options.signal?.aborted === true) throw abortError();
  if (failed) throw failure;
  if (windowsWithAudio === 0) {
    throw new AudioExtractionUnavailableError("This video has no audio track to listen to.");
  }
  return processedSeconds;
};
