// FSKCore state isolation / TX↔RX reuse tests (Node.js)
//
// These tests cover the real-world WebAudio pattern: a single long-lived
// FSKCore instance is used for modulation and demodulation over and over
// (`FSKProcessor` does exactly this). Every reception must yield only the
// user bytes of the frame just received - no preamble, no SFD, no leftovers
// from the previous frame - both with whole-buffer and chunked streaming
// input, and both with and without an explicit reset between frames.
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

const CHUNK_SIZE = 128; // AudioWorklet render quantum

interface Harness {
  core: FSKCore;
  eodCount: number;
}

function createHarness(overrides: Partial<FSKConfig> = {}): Harness {
  const core = new FSKCore();
  core.configure({ ...DEFAULT_FSK_CONFIG, ...overrides } as FSKConfig);
  const harness: Harness = { core, eodCount: 0 };
  core.on('eod', () => { harness.eodCount++; });
  return harness;
}

/** Feed samples in fixed-size chunks, collecting every byte the core emits. */
async function demodulateChunked(
  core: FSKCore,
  signal: Float32Array,
  chunkSize = CHUNK_SIZE
): Promise<number[]> {
  const bytes: number[] = [];
  for (let offset = 0; offset < signal.length; offset += chunkSize) {
    const chunk = signal.subarray(offset, Math.min(offset + chunkSize, signal.length));
    bytes.push(...(await core.demodulateData(chunk)));
  }
  return bytes;
}

function concat(...signals: Float32Array[]): Float32Array {
  const total = signals.reduce((sum, s) => sum + s.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const signal of signals) {
    result.set(signal, offset);
    offset += signal.length;
  }
  return result;
}

const silence = (length: number) => new Float32Array(length);

const hex = (bytes: Iterable<number>) =>
  Array.from(bytes).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');

describe('FSKCore TX/RX state isolation', () => {
  let harness: Harness;
  let core: FSKCore;

  beforeEach(() => {
    harness = createHarness();
    core = harness.core;
  });

  describe('Same instance: modulateData followed by demodulateData', () => {
    test('receives exactly the transmitted frame when fed as one buffer', async () => {
      const payload = new Uint8Array([0x41, 0x42]); // "AB"

      // Same instance sends, then immediately receives - no reset in between.
      const signal = await core.modulateData(payload);
      const result = await core.demodulateData(signal);

      expect(Array.from(result)).toEqual(Array.from(payload));
    });

    test.each([32, 64, 128, 256, 4096, Number.MAX_SAFE_INTEGER])(
      'receives exactly the transmitted frame when streamed in %i-sample chunks',
      async (chunkSize) => {
        const payload = new TextEncoder().encode('Hello');
        const signal = await core.modulateData(payload);

        const bytes = await demodulateChunked(core, signal, chunkSize);

        expect(bytes).toEqual(Array.from(payload));
        expect(core.getStatus().syncDetections).toBe(1);
      }
    );

    test('repeated send→receive→send→receive cycles stay independent', async () => {
      const frames = [
        new Uint8Array([0x41, 0x42]),
        new Uint8Array([0x43, 0x44, 0x45]),
        new Uint8Array([0x30]),
        new Uint8Array([0xff, 0x00, 0x7e]),
      ];

      for (const frame of frames) {
        const signal = await core.modulateData(frame);
        const received = await demodulateChunked(core, signal);

        expect(received).toEqual(Array.from(frame));
      }
    });

    test('modulation does not touch demodulator state', async () => {
      const before = core.getStatus();

      // Produce something that would have dirtied shared filter/phase state
      // if modulation and demodulation shared machinery.
      await core.modulateData(new Uint8Array([0x41, 0x42, 0x43]));

      expect(core.getStatus()).toEqual(before);
    });

    test('demodulation does not mutate the caller-provided buffer', async () => {
      const payload = new Uint8Array([0x41, 0x42]);
      const signal = await core.modulateData(payload);
      const pristine = Float32Array.from(signal);

      // AGC used to run in place on the caller's array; the buffer must now
      // survive demodulation bit-for-bit so it can be replayed.
      await core.demodulateData(signal);

      expect(Array.from(signal)).toEqual(Array.from(pristine));

      // Replaying the very same buffer must yield the same bytes again.
      const replay = await core.demodulateData(signal);
      expect(Array.from(replay)).toEqual(Array.from(payload));
    });
  });

  describe('Consecutive frames without an explicit reset', () => {
    test('two frames in a single stream decode independently (whole buffer)', async () => {
      const first = new Uint8Array([0x41, 0x42]);
      const second = new Uint8Array([0x43, 0x44]);

      const signal = concat(await core.modulateData(first), await core.modulateData(second));
      const result = await core.demodulateData(signal);

      expect(Array.from(result)).toEqual([...Array.from(first), ...Array.from(second)]);
      expect(harness.eodCount).toBe(2); // one end-of-data per frame
    });

    test('two frames in a single stream decode independently (128-sample chunks)', async () => {
      const first = new Uint8Array([0x41, 0x42, 0x43]);
      const second = new Uint8Array([0x44, 0x45]);

      const signal = concat(await core.modulateData(first), await core.modulateData(second));
      const result = await demodulateChunked(core, signal);

      expect(result).toEqual([...Array.from(first), ...Array.from(second)]);
      expect(core.getStatus().frameStarted).toBe(false);
    });

    test('frames carrying preamble/SFD-like payloads are not confused with the sync pattern', async () => {
      const cases: Array<[number[], number[]]> = [
        [[0x55, 0x55], [0x7e, 0x7e]],
        [[0x00], [0xff]],
        [[0x55, 0x7e, 0x55], [0x7e, 0x55, 0x7e]],
      ];

      for (const [a, b] of cases) {
        const signal = concat(
          await core.modulateData(new Uint8Array(a)),
          await core.modulateData(new Uint8Array(b))
        );
        const result = await demodulateChunked(core, signal);

        expect(hex(result)).toBe(hex([...a, ...b]));
      }
    });
  });

  describe('Frame end (eod) and re-synchronisation', () => {
    test('a frame followed by silence and a new frame re-synchronises', async () => {
      const first = new Uint8Array([0x41, 0x42]);
      const second = new Uint8Array([0x43, 0x44]);

      const signal = concat(
        await core.modulateData(first),
        silence(4800), // 100 ms of silence: clearly beyond the EOD timer
        await core.modulateData(second)
      );

      const result = await demodulateChunked(core, signal);

      expect(result).toEqual([...Array.from(first), ...Array.from(second)]);
      expect(harness.eodCount).toBe(2);
    });

    test('a long silent stretch reports end-of-data only once', async () => {
      await demodulateChunked(core, await core.modulateData(new Uint8Array([0x41])));
      const afterFrame = harness.eodCount;
      expect(afterFrame).toBe(1);

      await demodulateChunked(core, silence(48000)); // one second of silence

      expect(harness.eodCount).toBe(afterFrame);
    });

    test('receives a new frame after end-of-data even at a different amplitude', async () => {
      // Loud frame first: a lingering AGC gain would starve the quiet frame.
      const loud = await core.modulateData(new Uint8Array([0xff, 0xff]));
      expect(await demodulateChunked(core, loud)).toEqual([0xff, 0xff]);

      const quietPayload = new Uint8Array([0x41, 0x42]);
      const quiet = (await core.modulateData(quietPayload)).map(v => v * 0.02) as Float32Array;

      expect(await demodulateChunked(core, quiet)).toEqual(Array.from(quietPayload));
    });

    test('a new frame after silence does not inherit the previous frame tail', async () => {
      const first = new Uint8Array([0xde, 0xad]);
      const second = new Uint8Array([0xbe, 0xef]);

      await demodulateChunked(core, await core.modulateData(first));
      await demodulateChunked(core, silence(9600));
      const result = await demodulateChunked(core, await core.modulateData(second));

      // Exactly the second frame, nothing of the first.
      expect(result).toEqual(Array.from(second));
    });
  });

  describe('reset() and configure() leave no residue', () => {
    test('reset() during a partial frame yields a clean slate', async () => {
      const signal = await core.modulateData(new Uint8Array([0x41, 0x42]));

      // Stop mid-frame so bit sync / byte assembly hold partial state.
      await core.demodulateData(signal.subarray(0, Math.floor(signal.length * 0.6)));
      expect(core.getStatus().globalSampleCounter).toBeGreaterThan(0);

      core.reset();

      const status = core.getStatus();
      expect(status.frameStarted).toBe(false);
      expect(status.globalSampleCounter).toBe(0);
      expect(status.receivedBitsLength).toBe(0);
      expect(status.byteBufferLength).toBe(0);
      expect(status.syncDetections).toBe(0);
      expect(status.demodulationCalls).toBe(0);
      expect(status.totalSamplesProcessed).toBe(0);
      expect(status.silenceThreshold).toBe(0.01); // back to the pristine value

      // A frame received right after the reset decodes normally.
      const next = new Uint8Array([0x43, 0x44]);
      expect(await demodulateChunked(core, await core.modulateData(next))).toEqual(Array.from(next));
    });

    test('configure() resets frame synchronisation and byte assembly', async () => {
      const signal = await core.modulateData(new Uint8Array([0x41, 0x42]));
      await core.demodulateData(signal.subarray(0, Math.floor(signal.length * 0.6)));

      core.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);

      const status = core.getStatus();
      expect(status.frameStarted).toBe(false);
      expect(status.receivedBitsLength).toBe(0);
      expect(status.byteBufferLength).toBe(0);
      expect(status.silenceThreshold).toBe(0.01);

      const next = new Uint8Array([0x45, 0x46]);
      expect(await demodulateChunked(core, await core.modulateData(next))).toEqual(Array.from(next));
    });

    test('configure() applied between frames keeps each frame decodable', async () => {
      const baudRates = [1200, 300, 600, 1200];

      for (const baudRate of baudRates) {
        core.configure({ ...DEFAULT_FSK_CONFIG, baudRate } as FSKConfig);
        const payload = new Uint8Array([0x41, 0x42, 0x43]);
        const received = await demodulateChunked(core, await core.modulateData(payload));
        expect(received).toEqual(Array.from(payload));
      }
    });
  });
});
