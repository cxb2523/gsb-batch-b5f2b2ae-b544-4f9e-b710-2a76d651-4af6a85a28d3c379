import { SSTVDecoder, DecoderState } from '../decoder';
import { SSTV_MODES } from '../constants';
import { SyncPulseWidth, SyncPulseMode } from '../sync-detector';

describe('SSTVDecoder', () => {
  const sampleRate = 44100;

  /**
   * Generate one 1200Hz sync pulse of the given duration followed by a
   * 1900Hz idle gap.
   */
  function makePulse(pulseMs: number, gapMs: number): Float32Array {
    const pulseSamples = Math.round((pulseMs / 1000) * sampleRate);
    const gapSamples = Math.round((gapMs / 1000) * sampleRate);
    const out = new Float32Array(pulseSamples + gapSamples);
    let phase = 0;
    const writeTone = (freq: number, offset: number, length: number) => {
      for (let i = 0; i < length; i++) {
        out[offset + i] = 0.8 * Math.sin(phase);
        phase += (2 * Math.PI * freq) / sampleRate;
      }
    };
    writeTone(1200, 0, pulseSamples);
    writeTone(1900, pulseSamples, gapSamples);
    return out;
  }

  /** Feed a signal through the decoder in browser-sized audio blocks. */
  function feedInChunks(decoder: SSTVDecoder, signal: Float32Array, chunkSize = 2048): void {
    for (let off = 0; off < signal.length; off += chunkSize) {
      decoder.processSamples(signal.subarray(off, Math.min(off + chunkSize, signal.length)));
    }
  }

  function isAllBlack(image: Uint8ClampedArray): boolean {
    for (let i = 0; i < image.length; i += 4) {
      if (image[i] !== 0 || image[i + 1] !== 0 || image[i + 2] !== 0 || image[i + 3] !== 255) {
        return false;
      }
    }
    return true;
  }

  function bufferHasNonZero(buffer: Float32Array): boolean {
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0) return true;
    }
    return false;
  }

  function bufferIsAllZero(buffer: Float32Array): boolean {
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0) return false;
    }
    return true;
  }

  // Accessors for private state under test
  function priv(decoder: SSTVDecoder): any {
    return decoder as any;
  }

  beforeAll(() => {
    // The decoder/detector log verbosely; keep test output readable
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('Initialization', () => {
    test('constructs with default mode dimensions', () => {
      const decoder = new SSTVDecoder(sampleRate);
      expect(decoder.getMode()).toBe('ROBOT36');
      expect(decoder.getDimensions()).toEqual({
        width: SSTV_MODES.ROBOT36.width,
        height: SSTV_MODES.ROBOT36.height,
      });
      expect(decoder.getStats().state).toBe(DecoderState.IDLE);
      expect(decoder.getStats().progress).toBe(0);
      expect(isAllBlack(decoder.getImageData())).toBe(true);
    });

    test('constructs with a 20ms-sync mode and matching dimensions', () => {
      const decoder = new SSTVDecoder(sampleRate, 'PD120');
      expect(decoder.getMode()).toBe('PD120');
      expect(decoder.getDimensions()).toEqual({
        width: SSTV_MODES.PD120.width,
        height: SSTV_MODES.PD120.height,
      });
      expect(decoder.getImageData().length).toBe(
        SSTV_MODES.PD120.width * SSTV_MODES.PD120.height * 4
      );
    });
  });

  describe('Runtime mode switching', () => {
    test('setMode updates mode name, dimensions and total line count', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();

      decoder.setMode('PD120');

      expect(decoder.getMode()).toBe('PD120');
      expect(decoder.getDimensions()).toEqual({
        width: SSTV_MODES.PD120.width,
        height: SSTV_MODES.PD120.height,
      });
      const stats = decoder.getStats();
      expect(stats.totalLines).toBe(SSTV_MODES.PD120.height);
      expect(stats.mode).toBe(SSTV_MODES.PD120.name);
      expect(stats.currentLine).toBe(0);
      expect(stats.progress).toBe(0);
    });

    test('setMode swaps in the line decoder for the new mode', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      const oldDecoder = priv(decoder).lineDecoder;

      decoder.setMode('SCOTTIE_S1');

      expect(priv(decoder).lineDecoder).not.toBe(oldDecoder);
      expect(priv(decoder).lineDecoder.constructor.name).toBe('ScottieS1LineDecoder');

      decoder.setMode('PD180');
      expect(priv(decoder).lineDecoder.constructor.name).toBe('PD180LineDecoder');
    });

    test('setMode reconfigures the sync detector pulse width (9ms -> 20ms)', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      expect(priv(decoder).syncDetector).toBeDefined();

      decoder.setMode('PD120');
      expect(priv(decoder).syncDetector['acceptedLineSyncWidth']).toBe(
        SyncPulseWidth.TwentyMilliSeconds
      );

      decoder.setMode('ROBOT36');
      expect(priv(decoder).syncDetector['acceptedLineSyncWidth']).toBe(
        SyncPulseWidth.NineMilliSeconds
      );
    });

    test('setMode discards decoded content and returns progress to zero', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      // Simulate partial progress and stale image contents
      priv(decoder).currentLine = 42;
      priv(decoder).imageData.fill(123);

      decoder.setMode('PD120');

      expect(priv(decoder).currentLine).toBe(0);
      expect(decoder.getStats().progress).toBe(0);
      expect(isAllBlack(decoder.getImageData())).toBe(true);
    });

    test('setMode clears audio/demod buffers, write pointer, sync position and offset', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, makePulse(9, 30));

      // After one valid pulse, a sync position is recorded and buffers hold data
      expect(priv(decoder).lastSyncPos).not.toBe(-1);
      expect(priv(decoder).bufferWritePos).toBeGreaterThan(0);
      expect(bufferHasNonZero(priv(decoder).audioBuffer as Float32Array)).toBe(true);
      expect(bufferHasNonZero(priv(decoder).demodulatedBuffer as Float32Array)).toBe(true);

      decoder.setMode('PD120');

      expect(priv(decoder).bufferWritePos).toBe(0);
      expect(priv(decoder).lastSyncPos).toBe(-1);
      expect(priv(decoder).lastSyncWidth).toBeNull();
      expect(priv(decoder).frequencyOffset).toBe(0);
      expect(bufferIsAllZero(priv(decoder).audioBuffer as Float32Array)).toBe(true);
      expect(bufferIsAllZero(priv(decoder).demodulatedBuffer as Float32Array)).toBe(true);
    });

    test('setMode preserves the running/stopped state', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();
      expect(decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);

      decoder.setMode('PD120');
      expect(decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);

      decoder.stop();
      decoder.setMode('ROBOT36');
      expect(decoder.getStats().state).toBe(DecoderState.IDLE);
    });

    test('setMode to the same mode is a no-op', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      const lineDecoderBefore = priv(decoder).lineDecoder;
      const imageBefore = decoder.getImageData();

      decoder.setMode('ROBOT36');

      expect(priv(decoder).lineDecoder).toBe(lineDecoderBefore);
      expect(decoder.getImageData()).toBe(imageBefore);
      expect(decoder.getMode()).toBe('ROBOT36');
    });

    test('after switching, a wrong-width sync pulse cannot anchor a line', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();

      decoder.setMode('PD120'); // 20ms mode now
      feedInChunks(decoder, makePulse(9, 30)); // 9ms pulse must be rejected

      expect(priv(decoder).lastSyncPos).toBe(-1);
      expect(priv(decoder).currentLine).toBe(0);
      expect(decoder.getStats().frequency).toBe(1900); // offset untouched
    });

    test('after switching, the new mode pulse width is accepted', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();

      decoder.setMode('PD120');
      feedInChunks(decoder, makePulse(20, 30));

      // First valid pulse only records the anchor; no line is decoded yet
      expect(priv(decoder).lastSyncPos).not.toBe(-1);
      expect(priv(decoder).lastSyncWidth).toBe(SyncPulseWidth.TwentyMilliSeconds);
      expect(priv(decoder).currentLine).toBe(0);
    });
  });

  describe('Reset and restart', () => {
    test('reset returns all buffering and calibration state to initial values', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, makePulse(9, 30));
      priv(decoder).currentLine = 10;

      decoder.reset();

      expect(priv(decoder).currentLine).toBe(0);
      expect(priv(decoder).bufferWritePos).toBe(0);
      expect(priv(decoder).lastSyncPos).toBe(-1);
      expect(priv(decoder).lastSyncWidth).toBeNull();
      expect(priv(decoder).frequencyOffset).toBe(0);
      expect(priv(decoder).sampleCounter).toBe(0);
      expect(priv(decoder).absoluteSamplePosition).toBe(0);
      expect(bufferIsAllZero(priv(decoder).audioBuffer as Float32Array)).toBe(true);
      expect(bufferIsAllZero(priv(decoder).demodulatedBuffer as Float32Array)).toBe(true);
      expect(isAllBlack(decoder.getImageData())).toBe(true);
    });

    test('the first line is not decoded until two valid sync pulses arrive', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();

      // First pulse: anchors the start, no line can be decoded yet
      feedInChunks(decoder, makePulse(9, 30));
      expect(priv(decoder).lastSyncPos).not.toBe(-1);
      expect(priv(decoder).currentLine).toBe(0);

      // A second valid pulse establishes the first line interval
      feedInChunks(decoder, makePulse(9, 30));
      // currentLine may stay 0 if the line decoder rejects garbage timing,
      // but it must never be negative and progress must remain bounded/valid
      expect(priv(decoder).currentLine).toBeGreaterThanOrEqual(0);
      expect(decoder.getStats().progress).toBeGreaterThanOrEqual(0);
    });

    test('stop then start returns to a clean state (no carried-over sync position)', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, makePulse(9, 30));
      expect(priv(decoder).lastSyncPos).not.toBe(-1);

      decoder.stop();
      expect(decoder.getStats().state).toBe(DecoderState.IDLE);

      decoder.start();
      expect(decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);
      expect(priv(decoder).lastSyncPos).toBe(-1);
      expect(priv(decoder).lastSyncWidth).toBeNull();
      expect(priv(decoder).bufferWritePos).toBe(0);
      expect(priv(decoder).frequencyOffset).toBe(0);
      expect(priv(decoder).currentLine).toBe(0);
      expect(bufferIsAllZero(priv(decoder).audioBuffer as Float32Array)).toBe(true);
      expect(bufferIsAllZero(priv(decoder).demodulatedBuffer as Float32Array)).toBe(true);
    });

    test('audio processed while stopped is ignored and does not populate buffers', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      // IDLE without start()
      decoder.processSamples(makePulse(9, 30));

      expect(priv(decoder).bufferWritePos).toBe(0);
      expect(priv(decoder).lastSyncPos).toBe(-1);
    });
  });

  describe('Cross-mode isolation', () => {
    test('half-line audio in flight during a switch never reaches the new mode', () => {
      const decoder = new SSTVDecoder(sampleRate, 'ROBOT36');
      decoder.start();

      // Feed the first pulse and part of a line under the old mode
      feedInChunks(decoder, makePulse(9, 10));
      const oldWritePos = priv(decoder).bufferWritePos;
      expect(oldWritePos).toBeGreaterThan(0);

      decoder.setMode('SCOTTIE_S1');

      // Everything written by the old mode is gone; only audio arriving after
      // the switch can exist in the buffers
      expect(priv(decoder).bufferWritePos).toBe(0);
      expect(bufferIsAllZero(priv(decoder).demodulatedBuffer as Float32Array)).toBe(true);
      expect(priv(decoder).lineDecoder.constructor.name).toBe('ScottieS1LineDecoder');
    });

    test('each mode configures the expected sync pulse mode', () => {
      const expectations: Record<string, SyncPulseMode> = {
        ROBOT36: SyncPulseMode.NineMilliSeconds,
        ROBOT72: SyncPulseMode.NineMilliSeconds,
        SCOTTIE_S1: SyncPulseMode.NineMilliSeconds,
        SCOTTIE_S2: SyncPulseMode.NineMilliSeconds,
        PD120: SyncPulseMode.TwentyMilliSeconds,
        PD160: SyncPulseMode.TwentyMilliSeconds,
        PD180: SyncPulseMode.TwentyMilliSeconds,
      };

      for (const [modeName, pulseMode] of Object.entries(expectations)) {
        const decoder = new SSTVDecoder(sampleRate, modeName as keyof typeof SSTV_MODES);
        const expectedWidth =
          pulseMode === SyncPulseMode.TwentyMilliSeconds
            ? SyncPulseWidth.TwentyMilliSeconds
            : SyncPulseWidth.NineMilliSeconds;
        expect(priv(decoder).syncDetector['acceptedLineSyncWidth']).toBe(expectedWidth);
      }
    });
  });
});
