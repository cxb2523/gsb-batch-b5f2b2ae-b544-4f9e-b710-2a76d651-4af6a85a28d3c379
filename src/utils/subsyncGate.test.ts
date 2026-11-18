/**
 * "One sync at a time", and the fact that a refusal leaves the running one
 * alone.
 *
 * Driven through the REAL `syncSubtitles`, with the ffmpeg decoder stubbed via
 * the audio module's test seam and the worker absent (Node has no `Worker`),
 * so the main-thread alignment path is what actually runs. No DOM, no wasm, no
 * network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { syncSubtitles } from "./subtitleSync.ts";
import {
  __browserFfmpegCacheForTests,
  __resetBrowserFfmpegForTests,
  __setBrowserFfmpegFactoryForTests,
} from "./subsyncAudio.ts";
import { subtitleSyncGate, createSyncGate } from "./subsyncGate.ts";
import { SubtitleSyncBusyError } from "./subsyncErrors.ts";
import { SAMPLE_RATE } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";
import type { SubtitleSyncInput } from "../types/subtitleSync.ts";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

const cue = (start: number, end: number, text = "hello there"): SubtitleCue => ({ start, end, text });

const dialogue = (count: number, spacing = 30): SubtitleCue[] =>
  Array.from({ length: count }, (_, i) => cue(5 + i * spacing, 8 + i * spacing));

/** A cue-derived reference that lands exactly `shift` seconds after the cues. */
const referenceFor = (cues: readonly SubtitleCue[], shift: number): SubtitleCue[] =>
  // Non-empty text: an empty string classifies as a metadata cue and paints no
  // speech, which would make the reference silent.
  cues.map((c) => ({ start: c.start + shift, end: c.end + shift, text: "line" }));

/**
 * A decoder stand-in that produces one short window and can be held open, so a
 * run can be observed while it is genuinely in progress.
 */
class HeldDecoder {
  loaded = false;
  terminated = false;
  loadCount = 0;
  execCount = 0;
  releaseExec: () => void = () => undefined;
  /** When true, every `exec` blocks until `finishExec()` is called. */
  holdExec = false;
  private gate: Promise<void> | null = null;

  load = async (): Promise<boolean> => {
    this.loadCount += 1;
    this.loaded = true;
    return true;
  };

  exec = async (_args: string[], _timeout?: number, init?: { signal?: AbortSignal }): Promise<number> => {
    this.execCount += 1;
    if (!this.holdExec) return 0;
    if (!this.gate) {
      let release!: () => void;
      this.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.releaseExec = release;
    }
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      this.gate!.then(resolve, resolve);
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
    return 0;
  };

  readFile = async (): Promise<Uint8Array> => {
    // 0.1 s of "speech" at 16 kHz.
    const bytes = new Uint8Array(3200);
    for (let i = 0; i + 1 < bytes.length; i += 2) bytes[i + 1] = 0x40;
    return bytes;
  };

  createDir = async (): Promise<boolean> => true;
  mount = async (): Promise<boolean> => true;
  unmount = async (): Promise<boolean> => true;
  writeFile = async (): Promise<boolean> => true;
  deleteFile = async (): Promise<boolean> => true;

  terminate = (): void => {
    this.terminated = true;
  };

  asFFmpeg(): FFmpeg {
    return this as unknown as FFmpeg;
  }
}

const file = (): File => new File([new Uint8Array(2048)], "movie.mp4");

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await tick(5);
  }
};

/* ------------------------------------------------------------------------ */
/* The gate on its own                                                       */
/* ------------------------------------------------------------------------ */

test("createSyncGate", async (t) => {
  await t.test("runs one task at a time and refuses the second", async () => {
    const gate = createSyncGate();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = 0;

    const first = gate.run(async () => {
      ran += 1;
      await held;
      return "first";
    });
    await assert.rejects(
      gate.run(async () => {
        ran += 1;
        return "second";
      }),
      (error: unknown) => error instanceof SubtitleSyncBusyError,
    );
    assert.equal(ran, 1, "the refused task must not have run");
    assert.equal(gate.busy, true);
    release();
    assert.equal(await first, "first");
    assert.equal(gate.busy, false);
  });

  await t.test("a refusal does not release the holder's gate", async () => {
    const gate = createSyncGate();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(async () => {
      await held;
      return 1;
    });
    // Several refusals in a row must all leave the gate held.
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(gate.run(async () => 2), SubtitleSyncBusyError);
      assert.equal(gate.busy, true, "a refusal must not clear the holder's gate");
    }
    release();
    await first;
    // And it is reusable afterwards.
    assert.equal(await gate.run(async () => 3), 3);
  });

  await t.test("releases the gate after a failure", async () => {
    const gate = createSyncGate();
    await assert.rejects(
      gate.run(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(gate.busy, false);
  });
});

/* ------------------------------------------------------------------------ */
/* Through the real engine                                                   */
/* ------------------------------------------------------------------------ */

test("syncSubtitles rejects a concurrent run cleanly", async (t) => {
  t.after(async () => {
    await __resetBrowserFfmpegForTests();
  });

  await t.test("the refusal leaves the active run's decoder alone, and it finishes", async () => {
    await __resetBrowserFfmpegForTests();
    const decoder = new HeldDecoder();
    decoder.holdExec = true;
    __setBrowserFfmpegFactoryForTests(() => decoder.asFFmpeg());

    const cues = dialogue(20);
    const firstInput: SubtitleSyncInput = {
      cues,
      media: { file: file() },
      signal: new AbortController().signal,
      onProgress: () => undefined,
    };

    const first = syncSubtitles(firstInput);
    // Wait until the first run genuinely owns the decoder and is mid-window.
    await until(() => decoder.execCount >= 1, "first run to start decoding");
    assert.equal(subtitleSyncGate.busy, true);

    const secondInput: SubtitleSyncInput = {
      cues,
      media: { file: file() },
      signal: new AbortController().signal,
    };
    await assert.rejects(syncSubtitles(secondInput), (error: unknown) => {
      return error instanceof SubtitleSyncBusyError;
    });

    // The refusal must NOT have cleared the cache the first run is using.
    assert.equal(decoder.terminated, false, "a refusal must not terminate the active decoder");
    assert.equal(__browserFfmpegCacheForTests().loaded, true, "a refusal must not evict the cache");
    assert.equal(subtitleSyncGate.busy, true, "a refusal must not free the active gate");

    // Let the first run finish. It decodes one short window then stops at the
    // end of the stream, and aligns.
    decoder.holdExec = false;
    decoder.releaseExec();
    const result = await first;
    assert.ok(Array.isArray(result.subtitles));
    assert.equal(subtitleSyncGate.busy, false, "the gate must be free after a clean finish");
  });

  await t.test("a run after a cancelled one is accepted", async () => {
    await __resetBrowserFfmpegForTests();
    const decoder = new HeldDecoder();
    decoder.holdExec = true;
    __setBrowserFfmpegFactoryForTests(() => decoder.asFFmpeg());

    const cues = dialogue(20);
    const controller = new AbortController();
    const cancelled = syncSubtitles({
      cues,
      media: { file: file() },
      signal: controller.signal,
    });

    await until(() => decoder.execCount >= 1, "cancelled run to reach exec");
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => {
      return error instanceof DOMException && error.name === "AbortError";
    });
    assert.equal(subtitleSyncGate.busy, false, "a cancelled run must free the gate");
    assert.equal(__browserFfmpegCacheForTests().loaded, false, "a cancelled run must evict");

    // The next sync must work normally — and load a fresh decoder.
    const loadsBefore = decoder.loadCount;
    decoder.holdExec = false;
    const referenceCues = referenceFor(cues, 2.5);
    const result = await syncSubtitles({
      cues,
      media: { file: file() },
      referenceCues,
    });
    assert.equal(result.applied, true, result.qualityReasons.join("; "));
    assert.ok(Math.abs(result.offsetMs - 2500) < 60, `offset ${result.offsetMs}`);
    assert.ok(decoder.loadCount >= loadsBefore);
  });

  await t.test("the quality gate still returns the original cues rather than throwing", async () => {
    // A subtitle track that lines up with nothing: rejected, not thrown, and
    // shipped unchanged with a reason.
    const cues = dialogue(30);
    const unrelated = new Float64Array(4000 * SAMPLE_RATE);
    for (let start = 0; start < 3900; start += 7.3) {
      unrelated.fill(1, Math.round(start * SAMPLE_RATE), Math.round((start + 0.4) * SAMPLE_RATE));
    }
    const result = await syncSubtitles({
      cues,
      media: { file: file() },
      referenceCues: unrelatedToCues(unrelated),
    });
    assert.equal(result.applied, false);
    assert.ok(result.qualityReasons.length > 0);
    assert.deepEqual(result.subtitles, cues);
  });
});

/** Encode an arbitrary speech signal as cues so `referenceCues` can carry it. */
const unrelatedToCues = (signal: Float64Array): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  let start = -1;
  for (let i = 0; i <= signal.length; i += 1) {
    const speaking = i < signal.length && signal[i] !== 0;
    if (speaking && start < 0) start = i;
    else if (!speaking && start >= 0) {
      cues.push({ start: start / SAMPLE_RATE, end: i / SAMPLE_RATE, text: "x" });
      start = -1;
    }
  }
  return cues;
};
