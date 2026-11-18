import * as Tone from "tone";
import { useMPCStore } from "../state/store";
import type {
  AudioEngineLike,
  KitName,
  KnobName,
  PadIndex,
  SampleId,
  SampleKit,
  SamplePad,
} from "../types/mpc.types";

/** Slim wrapper around a Tone.Player for one-shot drum hits. */
type PadPlayer = {
  player: Tone.Player;
  gainNode: Tone.Gain;
};

const PREFETCH_CONCURRENCY = 6;

/**
 * Thrown when a pad references an imported sample (`url === null`) whose
 * decoded buffer was never registered via `registerImportedSample()`.
 * Imported samples have no URL to fetch, so failing loudly (instead of
 * silently skipping) lets callers surface a precise error to the user.
 */
export class MissingImportedSampleError extends Error {
  constructor(public readonly sampleId: SampleId) {
    super(
      `SampleEngine: imported sample "${sampleId}" has no registered buffer ` +
        "(call registerImportedSample() before triggering this pad).",
    );
    this.name = "MissingImportedSampleError";
  }
}

/**
 * A single in-flight fetch/decode request for one `sampleId`.
 *
 * - `promise` resolves to the decoded ToneAudioBuffer.
 * - `controller` aborts the underlying `fetch` when the request is invalidated
 *   by a kit switch or engine disposal.
 * - `generation` records the kit generation that started the request, so a
 *   response arriving after a kit switch can never mutate current state.
 */
type InflightRequest = {
  promise: Promise<Tone.ToneAudioBuffer>;
  controller: AbortController;
  generation: number;
};

/**
 * SampleEngine — sample-based playback engine implementing `AudioEngineLike`.
 *
 * Audio graph:
 *   per-pad Tone.Player → per-pad Tone.Gain (velocity + gainCoefficient)
 *     → master Tone.Gain → Tone.Waveform(1024) + Tone.FFT(1024) → destination
 *
 * Design principles:
 * - Lazy buffer load: buffers are only fetched on first `trigger` for that pad.
 * - Inflight deduplication: concurrent triggers on the same unloaded pad share
 *   a single fetch Promise; the buffer is stored once and used by all.
 * - Kit-generation isolation: every `loadKit()` (and `dispose()`) bumps a
 *   monotonic generation and aborts all in-flight requests. Async continuations
 *   only mutate engine/store state while their captured generation is current,
 *   so a slow response from a previous kit can never write into the buffer
 *   table, flip the new kit's loading flags, or play on the wrong pad.
 * - Buffer reuse across kits: decoded buffers are keyed by `sampleId` and
 *   survive kit switches — a sample used by the new kit is never re-downloaded,
 *   and buffers still referenced by a pad are never released early.
 * - StrictMode / HMR safety: `start()` is idempotent; `dispose()` is thorough.
 * - Per-pad Tone.Player: created on demand at first trigger, released on kit
 *   switch / pad reassignment / disposal and rebuilt from the current sample.
 */
export class SampleEngine implements AudioEngineLike {
  private master: Tone.Gain | null = null;
  private waveform: Tone.Waveform | null = null;
  private fft: Tone.FFT | null = null;
  private ready = false;

  /** Decoded audio buffers keyed by SampleId. Retained across kit switches. */
  private buffers = new Map<SampleId, Tone.ToneAudioBuffer>();

  /**
   * In-flight fetch promises keyed by SampleId.
   * Ensures concurrent triggers on the same unloaded pad share a single fetch.
   * Each entry carries an AbortController and the generation that started it.
   */
  private inflight = new Map<SampleId, InflightRequest>();

  /** Current kit pad assignments (globalPadIdx → SamplePad). */
  private padMap = new Map<PadIndex, SamplePad>();

  /** Per-pad Tone.Player + gain nodes (created lazily on first trigger). */
  private padPlayers = new Map<PadIndex, PadPlayer>();

  /** Set of pad indices whose buffers are currently being fetched/decoded. */
  private loading = new Set<PadIndex>();

  /**
   * Monotonic kit-generation counter. Bumped on every `loadKit()` and on
   * `dispose()`. Any async continuation captured under an older generation is
   * stale and must not mutate `buffers`, `loading`, the store, or playback.
   */
  private generation = 0;

  async start(): Promise<void> {
    if (this.ready) return;
    await Tone.start();
    this.master = new Tone.Gain(Tone.dbToGain(-6)).toDestination();
    this.waveform = new Tone.Waveform(1024);
    this.master.connect(this.waveform);
    this.fft = new Tone.FFT(2048);
    this.master.connect(this.fft);
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Load a SampleKit, fully replacing the previously loaded kit.
   *
   * Lazy — no buffers are fetched here. Kit-switch guarantees:
   * 1. All in-flight requests from the previous kit are aborted; any response
   *    that still resolves is generation-guarded and cannot touch state.
   * 2. Every per-pad player/gain node is released, so the old kit's voices do
   *    not leak into the new kit (rebuilt lazily from the new sample).
   * 3. Loading flags (engine + store UI) are cleared — no pad can stay stuck
   *    in "loading" because of a request owned by the previous kit.
   * 4. Decoded buffers in `buffers` are intentionally retained so shared
   *    samples are not re-downloaded or released.
   */
  async loadKit(kit: SampleKit): Promise<void> {
    // Invalidate every async continuation started under the previous kit.
    this.generation += 1;
    this.abortAllInflight();

    // Release all per-pad playback nodes — the new kit rebuilds them lazily
    // against its own samples.
    this.disposeAllPadPlayers();

    // Clear loading flags and mirror the reset to the store so pad UIs stop
    // showing spinners for requests that no longer belong to this engine.
    for (const idx of this.loading) {
      useMPCStore.getState().setPadLoading(idx, false);
    }
    this.loading.clear();

    this.padMap.clear();
    for (const pad of kit.pads) {
      this.padMap.set(pad.globalPadIdx, { ...pad });
    }
  }

  setPadSample(idx: PadIndex, pad: SamplePad | null): void {
    if (pad === null) {
      this.padMap.delete(idx);
    } else {
      this.padMap.set(idx, { ...pad });
    }

    // The pad's sample assignment changed: its existing player is bound to the
    // old buffer, and any in-flight load for the old assignment is now
    // irrelevant to this slot. Release the node and clear the loading flag;
    // the next trigger rebuilds the player from the current sample.
    this.disposePadPlayer(idx);
    if (this.loading.delete(idx)) {
      useMPCStore.getState().setPadLoading(idx, false);
    }
  }

  setPadTune(idx: PadIndex, coarseTune: number, fineTune: number): void {
    const existing = this.padMap.get(idx);
    if (!existing) return;
    this.padMap.set(idx, { ...existing, coarseTune, fineTune });
    const pp = this.padPlayers.get(idx);
    if (pp) {
      pp.player.playbackRate = this.computePlaybackRate(coarseTune, fineTune);
    }
  }

  setPadGain(idx: PadIndex, gainCoefficient: number): void {
    const existing = this.padMap.get(idx);
    if (!existing) return;
    this.padMap.set(idx, { ...existing, gainCoefficient });
    const pp = this.padPlayers.get(idx);
    if (pp) {
      pp.gainNode.gain.value = gainCoefficient;
    }
  }

  setPadTrim(idx: PadIndex, startFrames: number, endFrames: number): void {
    const existing = this.padMap.get(idx);
    if (!existing) return;
    this.padMap.set(idx, { ...existing, sampleStart: startFrames, sampleEnd: endFrames });
  }

  isPadLoading(idx: PadIndex): boolean {
    return this.loading.has(idx);
  }

  /**
   * Trigger pad at `idx` (GlobalPadIdx, 0..127) with `velocity` in [0,1].
   *
   * - If the buffer is already loaded: play immediately.
   * - If not yet loaded: mark pad as loading, kick off the fetch, and
   *   play-on-resolve so the first tap still produces sound (with ~network delay).
   * - Concurrent triggers while loading share the same inflight promise (deduped).
   *
   * The resolve/reject continuations capture the current generation and the
   * pad's sampleId. After a kit switch, pad reassignment, or disposal they are
   * stale and cannot flip loading flags, write buffers, or start playback.
   */
  trigger(idx: PadIndex, velocity: number, time?: number): void {
    if (!this.ready || !this.master) return;
    const pad = this.padMap.get(idx);
    if (!pad) return;

    const clampedVelocity = Math.max(0.01, Math.min(1, velocity));
    const buf = this.buffers.get(pad.sampleId);

    if (buf) {
      // Buffer ready — play synchronously.
      try {
        this.playBuffer(idx, pad, buf, clampedVelocity, time);
      } catch (e) {
        console.warn("SampleEngine trigger error", e);
      }
      return;
    }

    const requestGeneration = this.generation;
    const requestSampleId = pad.sampleId;

    // Buffer not yet loaded. The flag is only pushed to the store on a real
    // false→true transition, keeping UI state consistent with this.loading.
    if (!this.loading.has(idx)) {
      this.loading.add(idx);
      useMPCStore.getState().setPadLoading(idx, true);
    }

    this.ensureBuffer(pad)
      .then((loadedBuf) => {
        // Stale after kit switch / disposal, or the pad was reassigned to a
        // different sample while the request was in flight — do not touch the
        // loading flag and do not play. The current generation owns this slot.
        if (
          requestGeneration !== this.generation ||
          this.padMap.get(idx)?.sampleId !== requestSampleId
        ) {
          return;
        }
        if (!this.loading.delete(idx)) return;
        useMPCStore.getState().setPadLoading(idx, false);
        // Play-on-resolve: use Tone.now() since the scheduled time may be stale.
        try {
          this.playBuffer(idx, pad, loadedBuf, clampedVelocity, undefined);
        } catch (e) {
          console.warn("SampleEngine play-on-resolve error", e);
        }
      })
      .catch((err) => {
        if (requestGeneration !== this.generation) {
          // Superseded by a kit switch / disposal — the failure is owned by a
          // previous generation and must not alter current UI state.
          return;
        }
        // Any failure of a still-current request (network error, bad HTTP
        // status, decode failure, cancellation) must release the loading flag
        // so the pad never stays stuck in "loading".
        if (this.loading.delete(idx)) {
          useMPCStore.getState().setPadLoading(idx, false);
        }
        console.warn(`SampleEngine: failed to load sample "${requestSampleId}"`, err);
      });
  }

  release(_idx: PadIndex): void {
    // One-shot samples — no sustained release needed. API completeness only.
  }

  stopAll(): void {
    for (const [, pp] of this.padPlayers) {
      try {
        pp.player.stop();
      } catch {
        // ignore — player may already be stopped or disposed
      }
    }
  }

  /**
   * Eagerly fetch and decode all sample URLs in the currently loaded kit.
   * Uses a sliding window of `PREFETCH_CONCURRENCY` concurrent fetches.
   * Already-buffered samples (including registered imports) are skipped.
   * An imported pad (`url === null`) without a registered buffer rejects with
   * {@link MissingImportedSampleError} rather than being silently skipped.
   */
  async prefetchAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const pads = [...this.padMap.values()];

    // Pads that still need work: anything without a decoded buffer. Imported
    // pads (url === null) cannot be fetched and reject explicitly below.
    const toFetch = pads.filter((p) => !this.buffers.has(p.sampleId));

    const total = pads.length;
    let loaded = total - toFetch.length; // already-buffered count

    if (toFetch.length === 0) {
      onProgress?.(total, total);
      return;
    }

    // Sliding-window concurrency.
    let queueIdx = 0;

    const runOne = async (pad: SamplePad): Promise<void> => {
      await this.ensureBuffer(pad);
      loaded += 1;
      onProgress?.(loaded, total);
    };

    async function worker(): Promise<void> {
      while (queueIdx < toFetch.length) {
        const pad = toFetch[queueIdx++];
        await runOne(pad);
      }
    }

    const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, toFetch.length) }, () =>
      worker(),
    );
    await Promise.all(workers);
  }

  /**
   * Decode raw WAV bytes and register them under `sampleId` for immediate
   * playback. Called after the user drag-drops a `.wav` file.
   * Re-registering the same id disposes the previous buffer first.
   */
  async registerImportedSample(sampleId: SampleId, bytes: Uint8Array): Promise<void> {
    // Copy the bytes into a fresh ArrayBuffer to avoid detached-buffer issues.
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audioCtx = Tone.getContext().rawContext as AudioContext;
    const decoded = await audioCtx.decodeAudioData(copy as ArrayBuffer);
    const buf = new Tone.ToneAudioBuffer(decoded);

    const previous = this.buffers.get(sampleId);
    if (previous) {
      try {
        previous.dispose();
      } catch {
        // ignore — best-effort replacement
      }
    }
    this.buffers.set(sampleId, buf);
  }

  getWaveform(): Float32Array | null {
    if (!this.waveform) return null;
    return this.waveform.getValue() as Float32Array;
  }

  getSpectrum(): Float32Array | null {
    if (!this.fft) return null;
    return this.fft.getValue() as Float32Array;
  }

  getPadChannelData(idx: PadIndex): Float32Array | null {
    const pad = this.padMap.get(idx);
    if (!pad) return null;
    const buf = this.buffers.get(pad.sampleId);
    if (!buf) return null;
    try {
      const audioBuffer = buf.get();
      if (!audioBuffer) return null;
      return audioBuffer.getChannelData(0);
    } catch {
      return null;
    }
  }

  setMasterDb(db: number): void {
    if (this.master) this.master.gain.rampTo(Tone.dbToGain(db), 0.05);
  }

  setBpm(bpm: number): void {
    Tone.getTransport().bpm.value = bpm;
  }

  setKnob(name: KnobName, v: number): void {
    // mainVol maps to master volume; k1/k2/k3 are reserved for future FX.
    if (name === "mainVol") this.setMasterDb(-40 + v * 46);
  }

  /** @deprecated Synth kits retired; this is a no-op on SampleEngine. */
  setKit(_kit: KitName): void {
    // no-op — kits are now sample-based, loaded via loadKit(SampleKit).
  }

  /**
   * Swap the sample assignments of two pads. Replicates the legacy
   * `swapPadVoice` behaviour but operates on the sample padMap.
   */
  swapPadVoice(idxA: PadIndex, idxB: PadIndex): void {
    const a = this.padMap.get(idxA);
    const b = this.padMap.get(idxB);
    if (a) {
      this.padMap.set(idxB, a);
    } else {
      this.padMap.delete(idxB);
    }
    if (b) {
      this.padMap.set(idxA, b);
    } else {
      this.padMap.delete(idxA);
    }
    const ppA = this.padPlayers.get(idxA);
    const ppB = this.padPlayers.get(idxB);
    if (ppA) {
      this.padPlayers.set(idxB, ppA);
    } else {
      this.padPlayers.delete(idxB);
    }
    if (ppB) {
      this.padPlayers.set(idxA, ppB);
    } else {
      this.padPlayers.delete(idxA);
    }

    // Any in-flight load is keyed to the pre-swap assignment; clear the flags
    // so the swapped slots cannot stay stuck in loading. The next trigger
    // resolves the (possibly shared, deduped) buffer against the new pad.
    for (const idx of [idxA, idxB]) {
      if (this.loading.delete(idx)) {
        useMPCStore.getState().setPadLoading(idx, false);
      }
    }
  }

  dispose(): void {
    // Invalidate every in-flight continuation before tearing nodes down.
    this.generation += 1;
    this.abortAllInflight();

    this.disposeAllPadPlayers();

    for (const [, buf] of this.buffers) {
      try {
        buf.dispose();
      } catch {
        // ignore
      }
    }
    this.buffers.clear();
    this.inflight.clear();
    this.padMap.clear();

    for (const idx of this.loading) {
      useMPCStore.getState().setPadLoading(idx, false);
    }
    this.loading.clear();

    try {
      this.waveform?.dispose();
    } catch {
      // ignore
    }
    this.waveform = null;
    try {
      this.fft?.dispose();
    } catch {
      // ignore
    }
    this.fft = null;
    try {
      this.master?.dispose();
    } catch {
      // ignore
    }
    this.master = null;
    this.ready = false;
  }

  /**
   * Ensure a buffer is available for the given pad. Returns the buffer once
   * decoded. Uses the `inflight` map to deduplicate concurrent fetches for
   * the same `sampleId`.
   *
   * The fetch is tagged with the generation that started it. Once the network
   * response arrives it is only committed to the buffer table when that
   * generation is still current, guaranteeing a previous kit's response can
   * never land here; the request is aborted outright on kit switch/disposal.
   */
  private ensureBuffer(pad: SamplePad): Promise<Tone.ToneAudioBuffer> {
    const existing = this.buffers.get(pad.sampleId);
    if (existing) return Promise.resolve(existing);

    const inFlight = this.inflight.get(pad.sampleId);
    if (inFlight) return inFlight.promise;

    if (pad.url === null) {
      // Imported sample — must have been registered via registerImportedSample.
      // There is no URL to fall back to, so reject with an explicit error.
      const error = new MissingImportedSampleError(pad.sampleId);
      console.error(error.message);
      return Promise.reject(error);
    }

    const controller = new AbortController();
    const startedGeneration = this.generation;
    const fetchPromise: Promise<Tone.ToneAudioBuffer> = fetch(pad.url, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`SampleEngine: HTTP ${res.status} fetching "${pad.url}"`);
        }
        return res.arrayBuffer();
      })
      .then((arrayBuf) => {
        // The kit may have switched (or the engine been disposed) while the
        // network round-trip was in flight. Never decode into / write the
        // shared buffer table on behalf of a stale generation.
        if (startedGeneration !== this.generation) {
          throw new DOMException(
            `SampleEngine: request for "${pad.sampleId}" superseded by a kit switch`,
            "AbortError",
          );
        }
        const audioCtx = Tone.getContext().rawContext as AudioContext;
        return audioCtx.decodeAudioData(arrayBuf);
      })
      .then((audioBuffer) => {
        if (startedGeneration !== this.generation) {
          throw new DOMException(
            `SampleEngine: request for "${pad.sampleId}" superseded by a kit switch`,
            "AbortError",
          );
        }
        const toneBuf = new Tone.ToneAudioBuffer(audioBuffer);
        this.buffers.set(pad.sampleId, toneBuf);
        this.removeInflight(pad.sampleId, controller);
        return toneBuf;
      })
      .catch((err) => {
        this.removeInflight(pad.sampleId, controller);
        throw err;
      });

    this.inflight.set(pad.sampleId, {
      promise: fetchPromise,
      controller,
      generation: startedGeneration,
    });
    return fetchPromise;
  }

  /** Abort and forget every in-flight request (kit switch / disposal). */
  private abortAllInflight(): void {
    for (const [, entry] of this.inflight) {
      try {
        entry.controller.abort();
      } catch {
        // ignore — already aborted
      }
    }
    this.inflight.clear();
  }

  /** Remove an inflight entry only if it is still the same request instance. */
  private removeInflight(sampleId: SampleId, controller: AbortController): void {
    const current = this.inflight.get(sampleId);
    if (current?.controller === controller) {
      this.inflight.delete(sampleId);
    }
  }

  /** Stop and dispose one pad's Player + Gain pair. */
  private disposePadPlayer(idx: PadIndex): void {
    const pp = this.padPlayers.get(idx);
    if (!pp) return;
    try {
      pp.player.stop();
      pp.player.dispose();
      pp.gainNode.dispose();
    } catch {
      // ignore — may already be disposed
    }
    this.padPlayers.delete(idx);
  }

  /** Stop and dispose every per-pad Player + Gain pair. */
  private disposeAllPadPlayers(): void {
    for (const idx of [...this.padPlayers.keys()]) {
      this.disposePadPlayer(idx);
    }
  }

  /**
   * Compute `playbackRate = 2^((coarseTune + fineTune / 100) / 12)`.
   */
  private computePlaybackRate(coarseTune: number, fineTune: number): number {
    return 2 ** ((coarseTune + fineTune / 100) / 12);
  }

  /**
   * Play a decoded buffer on the given pad, applying per-pad tune and gain.
   * Creates or reuses a per-pad Tone.Player + Tone.Gain node pair.
   */
  private playBuffer(
    idx: PadIndex,
    pad: SamplePad,
    buf: Tone.ToneAudioBuffer,
    velocity: number,
    time: number | undefined,
  ): void {
    if (!this.master) return;

    let pp = this.padPlayers.get(idx);

    if (!pp) {
      const gainNode = new Tone.Gain(pad.gainCoefficient * velocity).connect(this.master);
      const player = new Tone.Player(buf).connect(gainNode);
      player.playbackRate = this.computePlaybackRate(pad.coarseTune, pad.fineTune);
      pp = { player, gainNode };
      this.padPlayers.set(idx, pp);
    } else {
      // Retrigger: update the buffer in case it changed (setPadSample),
      // and update playback parameters.
      pp.player.buffer = buf;
      pp.player.playbackRate = this.computePlaybackRate(pad.coarseTune, pad.fineTune);
      pp.gainNode.gain.value = pad.gainCoefficient * velocity;
    }

    const playTime = time ?? Tone.now();

    const { sampleStart, sampleEnd } = pad;
    if (sampleStart !== undefined && sampleEnd !== undefined) {
      const audioBuffer = buf.get();
      if (audioBuffer && audioBuffer.sampleRate > 0) {
        const sr = audioBuffer.sampleRate;
        const offsetSec = sampleStart / sr;
        const durationSec = Math.max(0, sampleEnd - sampleStart) / sr;
        pp.player.start(playTime, offsetSec, durationSec);
        return;
      }
    }

    pp.player.start(playTime);
  }
}
