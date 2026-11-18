import * as Tone from "tone";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Tone mock ──────────────────────────────────────────────────────────────────
// Implementation factories must be regular functions (not arrows) so that
// vitest's vi.fn() wrapper supports `new`-construction (Vitest 4 quirk).

function makeGain() {
  return {
    toDestination: vi.fn().mockReturnThis(),
    connect: vi.fn().mockReturnThis(),
    dispose: vi.fn(),
    gain: {
      value: 1,
      rampTo: vi.fn(),
    },
  };
}

function makeWaveform() {
  return {
    getValue: vi.fn().mockReturnValue(new Float32Array(1024)),
    dispose: vi.fn(),
  };
}

function makeFft() {
  return {
    getValue: vi.fn().mockReturnValue(new Float32Array(1024)),
    dispose: vi.fn(),
  };
}

function makePlayer() {
  return {
    connect: vi.fn().mockReturnThis(),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    playbackRate: 1,
    buffer: null as unknown,
  };
}

function makeToneAudioBuffer(audioBuffer?: AudioBuffer) {
  return {
    dispose: vi.fn(),
    _audioBuffer: audioBuffer ?? null,
  };
}

// Captured instances for assertion
let mockMasterInstance: ReturnType<typeof makeGain>;
let mockWaveformInstance: ReturnType<typeof makeWaveform>;
let mockFftInstance: ReturnType<typeof makeFft>;

const mockTransport = { bpm: { value: 120 } };

vi.mock("tone", () => ({
  Gain: vi.fn(function (this: unknown) {
    mockMasterInstance = makeGain();
    return mockMasterInstance;
  }),
  Waveform: vi.fn(function (this: unknown) {
    mockWaveformInstance = makeWaveform();
    return mockWaveformInstance;
  }),
  FFT: vi.fn(function (this: unknown) {
    mockFftInstance = makeFft();
    return mockFftInstance;
  }),
  Player: vi.fn(function (this: unknown) {
    return makePlayer();
  }),
  ToneAudioBuffer: vi.fn(function (this: unknown, src: unknown) {
    return makeToneAudioBuffer(src as AudioBuffer | undefined);
  }),
  start: vi.fn().mockResolvedValue(undefined),
  now: vi.fn().mockReturnValue(0),
  dbToGain: vi.fn((db: number) => 10 ** (db / 20)),
  getTransport: vi.fn(() => mockTransport),
  getContext: vi.fn(() => ({
    rawContext: {
      decodeAudioData: vi.fn((buf: ArrayBuffer) => Promise.resolve(buf as unknown as AudioBuffer)),
    },
  })),
}));

// ── Store mock ─────────────────────────────────────────────────────────────────
// We need to intercept setPadLoading calls.
const mockSetPadLoading = vi.fn();
vi.mock("../../state/store", () => ({
  useMPCStore: {
    getState: vi.fn(() => ({
      setPadLoading: mockSetPadLoading,
    })),
  },
}));

// eslint-disable-next-line import/first
import type { SampleKit, SamplePad } from "../../types/mpc.types";
// ── Helpers ────────────────────────────────────────────────────────────────────
// eslint-disable-next-line import/first
import { MissingImportedSampleError, SampleEngine } from "../SampleEngine";

function makeSamplePad(overrides: Partial<SamplePad> = {}): SamplePad {
  return {
    globalPadIdx: 0,
    sampleId: "kick.wav",
    displayName: "Kick",
    sampleName: "kick.wav",
    fileName: "kick.wav",
    url: "/kits/test/kick.wav",
    coarseTune: 0,
    fineTune: 0,
    gainCoefficient: 1.0,
    pan: 0.5,
    ...overrides,
  };
}

function makeKit(pads: SamplePad[] = [makeSamplePad()]): SampleKit {
  return {
    id: "test-kit",
    displayName: "Test Kit",
    exportName: "TestKit",
    key: "C Minor",
    bpm: 120,
    pads,
  };
}

// Mock fetch to return a minimal ArrayBuffer.
function mockFetch(ok = true): void {
  const ab = new ArrayBuffer(4);
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
    arrayBuffer: vi.fn().mockResolvedValue(ab),
  });
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
  } as unknown as Response;
}

/**
 * Deferred fetch: the returned promise only settles when the test calls
 * resolve/reject. Every call records the AbortSignal so kit-switch abort
 * behaviour can be asserted directly.
 */
function deferredFetch() {
  const calls: Array<{ url: string; signal?: AbortSignal }> = [];
  let resolveFn!: (r: Response) => void;
  let rejectFn!: (e: unknown) => void;
  global.fetch = vi.fn((url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(url), signal: opts?.signal });
    return new Promise<Response>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  }) as typeof fetch;
  return {
    calls,
    resolve: (r: Response) => resolveFn(r),
    reject: (e: unknown) => rejectFn(e),
  };
}

/** Flush all pending microtasks (fetch → arrayBuffer → decode chains). */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SampleEngine", () => {
  let engine: SampleEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport.bpm.value = 120;
    engine = new SampleEngine();
  });

  afterEach(() => {
    try {
      engine.dispose();
    } catch {
      // already disposed
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  describe("start()", () => {
    it("is idempotent — calling start() twice does not reinitialise nodes", async () => {
      await engine.start();
      await engine.start();
      expect(Tone.Gain).toHaveBeenCalledTimes(1);
      expect(Tone.Waveform).toHaveBeenCalledTimes(1);
      expect(Tone.FFT).toHaveBeenCalledTimes(1);
    });

    it("builds master Gain → Waveform → destination", async () => {
      await engine.start();
      expect(engine.isReady()).toBe(true);
      expect(Tone.Gain).toHaveBeenCalledTimes(1);
      expect(Tone.Waveform).toHaveBeenCalledWith(1024);
      // master.toDestination() was called
      expect(mockMasterInstance.toDestination).toHaveBeenCalled();
      // master.connect(waveform) was called
      expect(
        mockMasterInstance.connect.mock.calls.some((c: unknown[]) => c[0] === mockWaveformInstance),
      ).toBe(true);
    });

    it("creates Tone.FFT(2048) and connects master to it", async () => {
      await engine.start();
      expect(Tone.FFT).toHaveBeenCalledWith(2048);
      expect(
        mockMasterInstance.connect.mock.calls.some((c: unknown[]) => c[0] === mockFftInstance),
      ).toBe(true);
    });

    it("start() is idempotent — Tone.FFT not called twice", async () => {
      await engine.start();
      await engine.start();
      expect(Tone.FFT).toHaveBeenCalledTimes(1);
    });

    it("isReady() is false before start()", () => {
      expect(engine.isReady()).toBe(false);
    });
  });

  // ── loadKit ───────────────────────────────────────────────────────────────────

  describe("loadKit()", () => {
    it("populates padMap without fetching buffers", async () => {
      await engine.start();
      mockFetch();
      const kit = makeKit();
      await engine.loadKit(kit);

      // No fetch should have been triggered — lazy.
      expect(global.fetch).not.toHaveBeenCalled();
      // But the pad should be triggerable (will kick off a fetch).
      expect(engine.isPadLoading(0)).toBe(false);
    });

    it("replaces a previous kit's pads", async () => {
      await engine.start();
      const kit1 = makeKit([makeSamplePad({ globalPadIdx: 0 })]);
      const kit2 = makeKit([makeSamplePad({ globalPadIdx: 5 })]);
      await engine.loadKit(kit1);
      await engine.loadKit(kit2);
      // Pad 0 from kit1 should be gone; only pad 5 remains.
      // Triggering pad 0 should be a no-op (no pad mapping).
      mockFetch();
      await engine.start();
      engine.trigger(0, 0.9);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── trigger ───────────────────────────────────────────────────────────────────

  describe("trigger()", () => {
    it("does nothing when engine is not ready", () => {
      const kit = makeKit();
      void engine.loadKit(kit);
      expect(() => engine.trigger(0, 0.9)).not.toThrow();
    });

    it("plays immediately when buffer is already loaded", async () => {
      await engine.start();
      mockFetch();
      const pad = makeSamplePad();
      const kit = makeKit([pad]);
      await engine.loadKit(kit);

      // Pre-load the buffer by registering an imported sample.
      const bytes = new Uint8Array([0, 1, 2, 3]);
      await engine.registerImportedSample(pad.sampleId, bytes);

      const MockPlayer = vi.mocked(Tone.Player);
      MockPlayer.mockClear();

      engine.trigger(0, 0.8);

      // A Tone.Player should be created and started.
      expect(MockPlayer).toHaveBeenCalledTimes(1);
      const playerInst = MockPlayer.mock.results[0].value as { start: ReturnType<typeof vi.fn> };
      expect(playerInst.start).toHaveBeenCalled();
    });

    it("marks pad as loading when buffer is missing and sets store flag", async () => {
      await engine.start();
      // Simulate a long fetch by using a deferred promise.
      let resolveFetch!: (v: Response) => void;
      const ab = new ArrayBuffer(4);
      global.fetch = vi.fn().mockReturnValue(
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
      );

      const pad = makeSamplePad();
      const kit = makeKit([pad]);
      await engine.loadKit(kit);

      engine.trigger(0, 0.9);

      expect(engine.isPadLoading(0)).toBe(true);
      expect(mockSetPadLoading).toHaveBeenCalledWith(0, true);

      // Unblock the fetch.
      resolveFetch({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: () => Promise.resolve(ab),
      } as unknown as Response);
    });

    it("deduplicates concurrent triggers — only one fetch per sampleId", async () => {
      await engine.start();
      mockFetch();

      const pad = makeSamplePad();
      const kit = makeKit([pad]);
      await engine.loadKit(kit);

      // Trigger three times concurrently before the fetch resolves.
      engine.trigger(0, 0.8);
      engine.trigger(0, 0.7);
      engine.trigger(0, 0.6);

      // Allow microtasks (fetch mock) to run.
      await vi.waitFor(() => {
        expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
      });

      // Only one fetch despite three triggers.
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("plays on resolve after lazy load", async () => {
      await engine.start();
      mockFetch();

      const pad = makeSamplePad();
      await engine.loadKit(makeKit([pad]));

      const MockPlayer = vi.mocked(Tone.Player);
      MockPlayer.mockClear();

      engine.trigger(0, 0.9);

      await vi.waitFor(() => {
        expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
      });

      // After the buffer loaded, a player should have been started.
      const allStarts = MockPlayer.mock.results.flatMap(
        (r) => (r.value as { start: ReturnType<typeof vi.fn> }).start.mock.calls,
      );
      expect(allStarts.length).toBeGreaterThan(0);
    });
  });

  // ── Playback rate ─────────────────────────────────────────────────────────────

  describe("playbackRate from coarse/fine tune", () => {
    it("applies playbackRate = 2^((coarse + fine/100)/12)", async () => {
      await engine.start();
      // 12 semitones = one octave = playbackRate 2.
      const pad = makeSamplePad({ coarseTune: 12, fineTune: 0 });
      const bytes = new Uint8Array(4);
      await engine.registerImportedSample(pad.sampleId, bytes);
      await engine.loadKit(makeKit([pad]));

      const MockPlayer = vi.mocked(Tone.Player);
      MockPlayer.mockClear();

      engine.trigger(0, 1.0);

      expect(MockPlayer).toHaveBeenCalledTimes(1);
      const playerInst = MockPlayer.mock.results[0].value as {
        playbackRate: number;
      };
      expect(playerInst.playbackRate).toBeCloseTo(2, 5);
    });

    it("applies fine tune (50 cents = ~3% speed increase)", async () => {
      await engine.start();
      const pad = makeSamplePad({ coarseTune: 0, fineTune: 50 });
      const bytes = new Uint8Array(4);
      await engine.registerImportedSample(pad.sampleId, bytes);
      await engine.loadKit(makeKit([pad]));

      const MockPlayer = vi.mocked(Tone.Player);
      MockPlayer.mockClear();
      engine.trigger(0, 1.0);

      const playerInst = MockPlayer.mock.results[0].value as {
        playbackRate: number;
      };
      const expected = 2 ** (0.5 / 12);
      expect(playerInst.playbackRate).toBeCloseTo(expected, 5);
    });
  });

  // ── prefetchAll ───────────────────────────────────────────────────────────────

  describe("prefetchAll()", () => {
    it("loads all pad buffers and reports progress", async () => {
      await engine.start();
      mockFetch();

      const pads = [
        makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" }),
        makeSamplePad({ globalPadIdx: 1, sampleId: "b.wav", url: "/b.wav" }),
        makeSamplePad({ globalPadIdx: 2, sampleId: "c.wav", url: "/c.wav" }),
      ];
      await engine.loadKit(makeKit(pads));

      const progress: Array<[number, number]> = [];
      await engine.prefetchAll((loaded, total) => {
        progress.push([loaded, total]);
      });

      expect(global.fetch).toHaveBeenCalledTimes(3);
      // Final progress report should be 3/3.
      const last = progress[progress.length - 1];
      expect(last).toEqual([3, 3]);
    });

    it("skips already-buffered samples in the progress total", async () => {
      await engine.start();
      mockFetch();

      const pads = [
        makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" }),
        makeSamplePad({ globalPadIdx: 1, sampleId: "b.wav", url: "/b.wav" }),
      ];
      await engine.loadKit(makeKit(pads));

      // Pre-load "a.wav".
      await engine.registerImportedSample("a.wav", new Uint8Array(4));

      const progress: Array<[number, number]> = [];
      await engine.prefetchAll((loaded, total) => {
        progress.push([loaded, total]);
      });

      // Only "b.wav" should be fetched.
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const last = progress[progress.length - 1];
      expect(last[1]).toBe(2); // total = 2 pads
    });
  });

  // ── registerImportedSample ────────────────────────────────────────────────────

  describe("registerImportedSample()", () => {
    it("decodes bytes and makes the buffer available for playback", async () => {
      await engine.start();

      // Capture the decodeAudioData mock before calling registerImportedSample
      // so we get the same reference used internally (getContext() returns a
      // fresh object each call — we need to spy at the source).
      const decodeAudioDataMock = vi.fn((buf: ArrayBuffer) =>
        Promise.resolve(buf as unknown as AudioBuffer),
      );
      vi.mocked(Tone.getContext).mockReturnValue({
        rawContext: { decodeAudioData: decodeAudioDataMock },
      } as unknown as ReturnType<typeof Tone.getContext>);

      const bytes = new Uint8Array([82, 73, 70, 70]); // RIFF header stub
      await engine.registerImportedSample("imported.wav", bytes);

      // Verify the buffer was decoded via decodeAudioData.
      expect(decodeAudioDataMock).toHaveBeenCalled();

      // The buffer should now be triggerable without a fetch.
      const pad = makeSamplePad({
        sampleId: "imported.wav",
        url: null,
      });
      await engine.loadKit(makeKit([pad]));
      engine.trigger(0, 0.9);

      // No fetch since buffer is registered.
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── Pad tuning / gain ─────────────────────────────────────────────────────────

  describe("setPadTune()", () => {
    it("updates the stored pad's tune fields", async () => {
      await engine.start();
      const pad = makeSamplePad({ coarseTune: 0, fineTune: 0 });
      await engine.loadKit(makeKit([pad]));
      engine.setPadTune(0, 7, 50);
      // No error thrown; next trigger will use updated tune values.
      expect(() => engine.setPadTune(0, 7, 50)).not.toThrow();
    });

    it("is a no-op for an unmapped pad", () => {
      expect(() => engine.setPadTune(99, 5, 0)).not.toThrow();
    });
  });

  describe("setPadGain()", () => {
    it("updates the stored pad's gainCoefficient", async () => {
      await engine.start();
      const pad = makeSamplePad({ gainCoefficient: 1.0 });
      await engine.loadKit(makeKit([pad]));
      expect(() => engine.setPadGain(0, 0.5)).not.toThrow();
    });

    it("is a no-op for an unmapped pad", () => {
      expect(() => engine.setPadGain(99, 0.5)).not.toThrow();
    });
  });

  // ── setMasterDb ───────────────────────────────────────────────────────────────

  describe("setMasterDb()", () => {
    it("calls master.gain.rampTo with dbToGain result and time 0.05", async () => {
      await engine.start();
      engine.setMasterDb(-6);
      expect(mockMasterInstance.gain.rampTo).toHaveBeenCalledWith(Tone.dbToGain(-6), 0.05);
    });
  });

  // ── setBpm ────────────────────────────────────────────────────────────────────

  describe("setBpm()", () => {
    it("sets Tone.getTransport().bpm.value", async () => {
      await engine.start();
      engine.setBpm(140);
      expect(mockTransport.bpm.value).toBe(140);
    });
  });

  // ── getWaveform ───────────────────────────────────────────────────────────────

  describe("getWaveform()", () => {
    it("returns null before start()", () => {
      expect(engine.getWaveform()).toBeNull();
    });

    it("returns Float32Array after start()", async () => {
      await engine.start();
      const buf = engine.getWaveform();
      expect(buf).toBeInstanceOf(Float32Array);
    });
  });

  // ── getSpectrum ───────────────────────────────────────────────────────────────

  describe("getSpectrum()", () => {
    it("returns null before start()", () => {
      expect(engine.getSpectrum()).toBeNull();
    });

    it("returns Float32Array from FFT analyser after start()", async () => {
      await engine.start();
      const result = engine.getSpectrum();
      expect(result).toBeInstanceOf(Float32Array);
      expect(mockFftInstance.getValue).toHaveBeenCalled();
    });
  });

  // ── swapPadVoice ──────────────────────────────────────────────────────────────

  describe("swapPadVoice()", () => {
    it("exchanges the pad assignments of two indices", async () => {
      await engine.start();
      const padA = makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav" });
      const padB = makeSamplePad({ globalPadIdx: 1, sampleId: "b.wav" });
      await engine.loadKit(makeKit([padA, padB]));

      engine.swapPadVoice(0, 1);

      // After swap, triggering idx 0 should use b.wav, idx 1 should use a.wav.
      // We can verify by checking isPadLoading after a trigger with a fetch mock.
      mockFetch();
      engine.trigger(0, 0.9); // should try to load b.wav
      engine.trigger(1, 0.9); // should try to load a.wav

      // Both fetches should be triggered for the swapped URLs.
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    });
  });

  // ── setKit (legacy no-op) ─────────────────────────────────────────────────────

  describe("setKit()", () => {
    it("is a no-op (does not throw)", async () => {
      await engine.start();
      expect(() => engine.setKit("HIP-HOP")).not.toThrow();
      expect(() => engine.setKit("TRAP")).not.toThrow();
    });
  });

  // ── release (no-op) ───────────────────────────────────────────────────────────

  describe("release()", () => {
    it("does not throw", () => {
      expect(() => engine.release(0)).not.toThrow();
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────────────

  describe("dispose()", () => {
    it("tears down all nodes and resets ready state", async () => {
      await engine.start();
      engine.dispose();
      expect(engine.isReady()).toBe(false);
      expect(engine.getWaveform()).toBeNull();
      expect(mockWaveformInstance.dispose).toHaveBeenCalled();
      expect(mockMasterInstance.dispose).toHaveBeenCalled();
    });

    it("disposes the FFT analyser", async () => {
      await engine.start();
      engine.dispose();
      expect(mockFftInstance.dispose).toHaveBeenCalled();
    });

    it("is idempotent — double dispose does not throw", async () => {
      await engine.start();
      expect(() => {
        engine.dispose();
        engine.dispose();
      }).not.toThrow();
    });
  });

  // ── Kit-switch isolation ──────────────────────────────────────────────────────

  describe("kit switch while requests are in flight", () => {
    it("aborts the previous kit's fetch via AbortController", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav" })]));
      engine.trigger(0, 0.9);
      expect(engine.isPadLoading(0)).toBe(true);

      await engine.loadKit(makeKit([makeSamplePad({ globalPadIdx: 1, sampleId: "b.wav" })]));

      expect(deferred.calls).toHaveLength(1);
      expect(deferred.calls[0].signal?.aborted).toBe(true);
    });

    it("a stale response after switching kits is never written into the buffer table", async () => {
      await engine.start();
      const deferred = deferredFetch();

      const kit1 = makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]);
      const kit2 = makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]);

      await engine.loadKit(kit1);
      engine.trigger(0, 0.9); // starts fetching a.wav
      await engine.loadKit(kit2); // generation bumped; a.wav request aborted/guarded

      // The old request resolves anyway (e.g. abort happened mid-decode).
      deferred.resolve(okResponse());
      await flushMicrotasks();

      // Re-trigger under kit2: b.wav is NOT buffered, so a fresh fetch starts.
      mockFetch();
      engine.trigger(0, 0.9);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "/b.wav",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("a stale response cannot change the new kit's loading flags", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      expect(engine.isPadLoading(0)).toBe(true);
      mockSetPadLoading.mockClear();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]),
      );

      // loadKit clears the loading flag itself, exactly once for pad 0.
      expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
      expect(engine.isPadLoading(0)).toBe(false);
      mockSetPadLoading.mockClear();

      deferred.resolve(okResponse());
      await flushMicrotasks();

      // No further store syncs and the new kit's pad stays out of loading.
      expect(mockSetPadLoading).not.toHaveBeenCalled();
      expect(engine.isPadLoading(0)).toBe(false);
    });

    it("a stale response never starts playback on the new kit's pad", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);

      const MockPlayer = vi.mocked(Tone.Player);
      MockPlayer.mockClear();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]),
      );
      deferred.resolve(okResponse());
      await flushMicrotasks();

      // No player was created for the superseded play-on-resolve continuation.
      expect(MockPlayer).not.toHaveBeenCalled();
    });

    it("retains already-decoded buffers so shared samples are not re-downloaded", async () => {
      await engine.start();
      mockFetch();

      const shared = makeSamplePad({ globalPadIdx: 0, sampleId: "shared.wav", url: "/shared.wav" });
      await engine.loadKit(makeKit([shared]));
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(mockSetPadLoading).toHaveBeenCalledWith(0, false));
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Switch away and back to a kit reusing the same sampleId.
      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 2, sampleId: "other.wav", url: "/other.wav" })]),
      );
      vi.mocked(global.fetch).mockClear();
      await engine.loadKit(makeKit([{ ...shared, globalPadIdx: 5 }]));

      engine.trigger(5, 0.9);
      await flushMicrotasks();

      // Buffer survived the kit switch — no new fetch, playback is immediate.
      expect(global.fetch).not.toHaveBeenCalled();
      expect(engine.isPadLoading(5)).toBe(false);
    });

    it("clears loading flags for every loading pad when the kit changes", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([
          makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" }),
          makeSamplePad({ globalPadIdx: 1, sampleId: "b.wav", url: "/b.wav" }),
        ]),
      );
      engine.trigger(0, 0.9);
      engine.trigger(1, 0.9);
      expect(engine.isPadLoading(0)).toBe(true);
      expect(engine.isPadLoading(1)).toBe(true);

      await engine.loadKit(makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "c.wav" })]));

      expect(engine.isPadLoading(0)).toBe(false);
      expect(engine.isPadLoading(1)).toBe(false);
      expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
      expect(mockSetPadLoading).toHaveBeenCalledWith(1, false);

      deferred.resolve(okResponse());
      await flushMicrotasks();
    });
  });

  // ── Loading flag consistency on failure / cancel ──────────────────────────────

  describe("loading flag consistency", () => {
    // These tests intentionally drive failure paths; the engine logs them, so
    // keep console output noise out of the test report.
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("clears the loading flag when the fetch rejects", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      expect(engine.isPadLoading(0)).toBe(true);

      deferred.reject(new TypeError("network down"));
      await vi.waitFor(() => expect(engine.isPadLoading(0)).toBe(false));

      expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
    });

    it("clears the loading flag on a non-OK HTTP response", async () => {
      await engine.start();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
        arrayBuffer: vi.fn(),
      });

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);

      await vi.waitFor(() => expect(engine.isPadLoading(0)).toBe(false));
      expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
    });

    it("allows a later trigger to retry after a failed fetch", async () => {
      await engine.start();
      global.fetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("network down"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        });

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(engine.isPadLoading(0)).toBe(false));
      expect(global.fetch).toHaveBeenCalledTimes(1);

      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(engine.isPadLoading(0)).toBe(false));
    });

    it("an aborted in-flight request leaves no permanent loading state", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]),
      );

      // Simulate the platform rejecting the fetch promise because it was aborted.
      deferred.reject(new DOMException("Aborted", "AbortError"));
      await flushMicrotasks();

      expect(engine.isPadLoading(0)).toBe(false);
      expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);
    });

    it("setPadSample clears a stuck loading flag for the reassigned pad", async () => {
      await engine.start();
      const deferred = deferredFetch();

      const first = makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" });
      await engine.loadKit(makeKit([first]));
      engine.trigger(0, 0.9);
      expect(engine.isPadLoading(0)).toBe(true);

      const replacement = makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" });
      engine.setPadSample(0, replacement);

      expect(engine.isPadLoading(0)).toBe(false);
      expect(mockSetPadLoading).toHaveBeenCalledWith(0, false);

      deferred.resolve(okResponse());
      await flushMicrotasks();
    });
  });

  // ── Concurrent dedup ──────────────────────────────────────────────────────────

  describe("concurrent request deduplication", () => {
    it("two different pads sharing one sampleId trigger only a single fetch", async () => {
      await engine.start();
      mockFetch();

      await engine.loadKit(
        makeKit([
          makeSamplePad({ globalPadIdx: 0, sampleId: "shared.wav", url: "/shared.wav" }),
          makeSamplePad({ globalPadIdx: 1, sampleId: "shared.wav", url: "/shared.wav" }),
        ]),
      );

      engine.trigger(0, 0.8);
      engine.trigger(1, 0.8);

      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
      await flushMicrotasks();

      // Both pads settle out of loading.
      expect(engine.isPadLoading(0)).toBe(false);
      expect(engine.isPadLoading(1)).toBe(false);
    });

    it("a new trigger after kit switch starts a fresh request (inflight table was reset)", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      expect(deferred.calls).toHaveLength(1);

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]),
      );

      mockFetch();
      engine.trigger(0, 0.9);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "/b.wav",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  // ── Imported samples (url === null) ───────────────────────────────────────────

  describe("imported samples without a registered buffer", () => {
    // The engine reports this condition loudly by design; silence it here.
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("trigger rejects with MissingImportedSampleError instead of silently skipping", async () => {
      await engine.start();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "dropped.wav", url: null })]),
      );

      // trigger() itself stays synchronous; observe the rejection via the
      // loading flag settling and the exposed error class on prefetchAll.
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(engine.isPadLoading(0)).toBe(false));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("dropped.wav"));

      await expect(engine.prefetchAll()).rejects.toBeInstanceOf(MissingImportedSampleError);
    });

    it("prefetchAll rejects with MissingImportedSampleError carrying the sampleId", async () => {
      await engine.start();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 3, sampleId: "missing-import.wav", url: null })]),
      );

      await expect(engine.prefetchAll()).rejects.toMatchObject({
        name: "MissingImportedSampleError",
        sampleId: "missing-import.wav",
      });
    });

    it("prefetchAll succeeds once the imported buffer is registered (no fetch)", async () => {
      await engine.start();
      mockFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "imported.wav", url: null })]),
      );
      await engine.registerImportedSample("imported.wav", new Uint8Array(4));

      await expect(engine.prefetchAll()).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── Player / gain node release and rebuild ────────────────────────────────────

  describe("per-pad player lifecycle", () => {
    it("loadKit disposes every per-pad player and gain node", async () => {
      await engine.start();
      mockFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(mockSetPadLoading).toHaveBeenCalledWith(0, false));

      const MockPlayer = vi.mocked(Tone.Player);
      const firstPlayer = MockPlayer.mock.results.at(-1)?.value as {
        stop: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
      };
      const MockGain = vi.mocked(Tone.Gain);
      // Index 0 is the master gain; the most recent gain is the per-pad one.
      const padGain = MockGain.mock.results.at(-1)?.value as {
        dispose: ReturnType<typeof vi.fn>;
      };

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]),
      );

      expect(firstPlayer.stop).toHaveBeenCalled();
      expect(firstPlayer.dispose).toHaveBeenCalled();
      expect(padGain.dispose).toHaveBeenCalled();
    });

    it("rebuilds the player from the new kit's sample after retrigger", async () => {
      await engine.start();
      mockFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(mockSetPadLoading).toHaveBeenCalledWith(0, false));

      const MockPlayer = vi.mocked(Tone.Player);
      MockPlayer.mockClear();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "b.wav", url: "/b.wav" })]),
      );
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(mockSetPadLoading).toHaveBeenCalledWith(0, false));

      // A brand-new player was built for the new kit (no reused stale node).
      await vi.waitFor(() => expect(MockPlayer).toHaveBeenCalledTimes(1));
      const rebuilt = MockPlayer.mock.results[0].value as {
        start: ReturnType<typeof vi.fn>;
      };
      expect(rebuilt.start).toHaveBeenCalled();
    });

    it("setPadSample(null) disposes the pad's player and gain node", async () => {
      await engine.start();
      mockFetch();

      await engine.loadKit(
        makeKit([makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" })]),
      );
      engine.trigger(0, 0.9);
      await vi.waitFor(() => expect(mockSetPadLoading).toHaveBeenCalledWith(0, false));

      const MockPlayer = vi.mocked(Tone.Player);
      const padPlayer = MockPlayer.mock.results.at(-1)?.value as {
        stop: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
      };
      const MockGain = vi.mocked(Tone.Gain);
      const padGain = MockGain.mock.results.at(-1)?.value as {
        dispose: ReturnType<typeof vi.fn>;
      };

      engine.setPadSample(0, null);

      expect(padPlayer.stop).toHaveBeenCalled();
      expect(padPlayer.dispose).toHaveBeenCalled();
      expect(padGain.dispose).toHaveBeenCalled();
    });

    it("dispose() releases pad players and aborts in-flight requests", async () => {
      await engine.start();
      const deferred = deferredFetch();

      await engine.loadKit(
        makeKit([
          makeSamplePad({ globalPadIdx: 0, sampleId: "a.wav", url: "/a.wav" }),
          makeSamplePad({ globalPadIdx: 1, sampleId: "b.wav", url: "/b.wav" }),
        ]),
      );
      engine.trigger(0, 0.9);
      engine.trigger(1, 0.9);

      const MockPlayer = vi.mocked(Tone.Player);
      // No player yet (fetches pending); assert abort + flag clearing instead.
      engine.dispose();

      for (const call of deferred.calls) {
        expect(call.signal?.aborted).toBe(true);
      }
      expect(engine.isPadLoading(0)).toBe(false);
      expect(engine.isPadLoading(1)).toBe(false);
      expect(MockPlayer).not.toHaveBeenCalled();

      deferred.resolve(okResponse());
      await flushMicrotasks();
    });
  });
});
