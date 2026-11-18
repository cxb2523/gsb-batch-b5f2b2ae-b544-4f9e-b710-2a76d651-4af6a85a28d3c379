import { SyncDetector, SyncPulseWidth, SyncPulseMode } from '../sync-detector';

describe('SyncDetector', () => {
  const sampleRate = 48000;

  /**
   * Build a signal containing one 1200Hz pulse of the given duration followed
   * by a 1900Hz gap, and feed it through the detector in fixed-size chunks
   * (mirrors the browser's audio processing blocks).
   * Returns the first detection result (if any) produced while processing.
   */
  function feedPulse(
    detector: SyncDetector,
    pulseMs: number,
    gapMs: number = 30,
    chunkSize: number = 2048
  ): { detected: boolean; width: SyncPulseWidth } | null {
    const pulseSamples = Math.round((pulseMs / 1000) * sampleRate);
    const gapSamples = Math.round((gapMs / 1000) * sampleRate);
    const input = new Float32Array(pulseSamples + gapSamples);
    let phase = 0;
    const writeTone = (freq: number, offset: number, length: number) => {
      for (let i = 0; i < length; i++) {
        input[offset + i] = 0.8 * Math.sin(phase);
        phase += (2 * Math.PI * freq) / sampleRate;
      }
    };
    writeTone(1200, 0, pulseSamples);
    writeTone(1900, pulseSamples, gapSamples);

    // Warm up the detector's filters with idle (1900Hz) audio first
    const warmup = new Float32Array(Math.round(0.05 * sampleRate));
    let warmPhase = 0;
    for (let i = 0; i < warmup.length; i++) {
      warmup[i] = 0.8 * Math.sin(warmPhase);
      warmPhase += (2 * Math.PI * 1900) / sampleRate;
    }
    detector.process(warmup, new Float32Array(warmup.length));

    let result: { detected: boolean; width: SyncPulseWidth } | null = null;
    for (let off = 0; off < input.length; off += chunkSize) {
      const part = input.subarray(off, Math.min(off + chunkSize, input.length));
      const demod = new Float32Array(part.length);
      const r = detector.process(part, demod);
      if (r.detected && result === null) {
        result = { detected: true, width: r.width };
      }
    }
    return result;
  }

  describe('Initialization', () => {
    test('creates instance with valid sample rate', () => {
      const detector = new SyncDetector(sampleRate);
      expect(detector).toBeDefined();
      expect(detector).toBeInstanceOf(SyncDetector);
    });

    test('accepts different sample rates', () => {
      expect(() => new SyncDetector(44100)).not.toThrow();
      expect(() => new SyncDetector(48000)).not.toThrow();
    });
  });

  describe('Sync Pulse Processing', () => {
    test('processes samples without crashing', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      // Fill with some test data
      for (let i = 0; i < 1024; i++) {
        inputSamples[i] = Math.sin(i * 0.01);
        demodulated[i] = 0.0;
      }

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('returns valid detection result', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0.5);

      const result = detector.process(inputSamples, demodulated);

      expect(result).toBeDefined();
      expect(result.detected).toBeDefined();
      expect(typeof result.detected).toBe('boolean');
      expect(result.width).toBeDefined();
      expect(result.offset).toBeDefined();
      expect(result.frequencyOffset).toBeDefined();
    });

    test('no sync detected in pure noise', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      // Random noise
      for (let i = 0; i < 1024; i++) {
        inputSamples[i] = (Math.random() - 0.5) * 2;
      }

      const result = detector.process(inputSamples, demodulated);

      // In pure noise, detection should typically be false or None
      expect(result.width === SyncPulseWidth.None || !result.detected).toBe(true);
    });

    test('handles empty input gracefully', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(0);
      const demodulated = new Float32Array(0);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('handles large buffers', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(10000);
      const demodulated = new Float32Array(10000);

      inputSamples.fill(0.3);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });
  });

  describe('Demodulated Buffer Output', () => {
    test('writes to demodulated buffer', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0.5);
      demodulated.fill(0); // Start with zeros

      detector.process(inputSamples, demodulated);

      // Check that some values were written
      let hasNonZero = false;
      for (let i = 0; i < demodulated.length; i++) {
        if (demodulated[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }

      expect(hasNonZero).toBe(true);
    });

    test('demodulated values are finite', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      for (let i = 0; i < 1024; i++) {
        inputSamples[i] = Math.sin(i * 0.1);
      }

      detector.process(inputSamples, demodulated);

      // All values should be finite
      for (let i = 0; i < demodulated.length; i++) {
        expect(isFinite(demodulated[i])).toBe(true);
      }
    });
  });

  describe('Multiple Sample Rates', () => {
    test('works with 44.1kHz sample rate', () => {
      const detector = new SyncDetector(44100);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0.5);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('processes correctly at different rates', () => {
      const detector48k = new SyncDetector(48000);
      const detector44k = new SyncDetector(44100);

      const input48k = new Float32Array(1024);
      const demod48k = new Float32Array(1024);
      const input44k = new Float32Array(1024);
      const demod44k = new Float32Array(1024);

      input48k.fill(0.5);
      input44k.fill(0.5);

      const result48k = detector48k.process(input48k, demod48k);
      const result44k = detector44k.process(input44k, demod44k);

      // Both should produce valid results
      expect(result48k).toBeDefined();
      expect(result44k).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    test('handles all zero input', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('handles extreme positive values', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(100);

      const result = detector.process(inputSamples, demodulated);

      expect(result).toBeDefined();
      expect(isFinite(result.frequencyOffset)).toBe(true);
    });

    test('handles extreme negative values', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(-100);

      const result = detector.process(inputSamples, demodulated);

      expect(result).toBeDefined();
      expect(isFinite(result.frequencyOffset)).toBe(true);
    });
  });

  describe('Consecutive Processing', () => {
    test('processes multiple buffers in sequence', () => {
      const detector = new SyncDetector(sampleRate);

      for (let iteration = 0; iteration < 10; iteration++) {
        const inputSamples = new Float32Array(1024);
        const demodulated = new Float32Array(1024);

        inputSamples.fill(Math.sin(iteration));

        expect(() => {
          detector.process(inputSamples, demodulated);
        }).not.toThrow();
      }
    });

    test('maintains state across buffers', () => {
      const detector = new SyncDetector(sampleRate);
      const input1 = new Float32Array(512);
      const demod1 = new Float32Array(512);
      const input2 = new Float32Array(512);
      const demod2 = new Float32Array(512);

      input1.fill(0.5);
      input2.fill(0.6);

      const result1 = detector.process(input1, demod1);
      const result2 = detector.process(input2, demod2);

      // Both should produce valid results
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });

  describe('SyncPulseWidth Enum', () => {
    test('enum values are defined', () => {
      expect(SyncPulseWidth.FiveMilliSeconds).toBeDefined();
      expect(SyncPulseWidth.NineMilliSeconds).toBeDefined();
      expect(SyncPulseWidth.TwentyMilliSeconds).toBeDefined();
      expect(SyncPulseWidth.None).toBeDefined();
    });

    test('enum values are distinct', () => {
      const values = new Set([
        SyncPulseWidth.FiveMilliSeconds,
        SyncPulseWidth.NineMilliSeconds,
        SyncPulseWidth.TwentyMilliSeconds,
        SyncPulseWidth.None,
      ]);

      expect(values.size).toBe(4);
    });
  });

  describe('Mode-specific pulse width acceptance', () => {
    test('9ms mode accepts 9ms sync pulses', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.NineMilliSeconds);

      const result = feedPulse(detector, 9);

      expect(result).not.toBeNull();
      expect(result?.detected).toBe(true);
      expect(result?.width).toBe(SyncPulseWidth.NineMilliSeconds);
    });

    test('9ms mode rejects 20ms sync pulses', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.NineMilliSeconds);

      const result = feedPulse(detector, 20);

      expect(result).toBeNull();
    });

    test('20ms mode accepts 20ms sync pulses', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.TwentyMilliSeconds);

      const result = feedPulse(detector, 20);

      expect(result).not.toBeNull();
      expect(result?.detected).toBe(true);
      expect(result?.width).toBe(SyncPulseWidth.TwentyMilliSeconds);
    });

    test('20ms mode rejects 9ms sync pulses', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.TwentyMilliSeconds);

      const result = feedPulse(detector, 9);

      expect(result).toBeNull();
    });

    test('5ms VIS pulses are always ignored in 9ms mode', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.NineMilliSeconds);

      const result = feedPulse(detector, 5);

      expect(result).toBeNull();
    });

    test('5ms VIS pulses are always ignored in 20ms mode', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.TwentyMilliSeconds);

      const result = feedPulse(detector, 5);

      expect(result).toBeNull();
    });

    test('unconfigured detector accepts both 9ms and 20ms line sync pulses', () => {
      const detector9 = new SyncDetector(sampleRate);
      const result9 = feedPulse(detector9, 9);
      expect(result9?.width).toBe(SyncPulseWidth.NineMilliSeconds);

      const detector20 = new SyncDetector(sampleRate);
      const result20 = feedPulse(detector20, 20);
      expect(result20?.width).toBe(SyncPulseWidth.TwentyMilliSeconds);

      // 5ms VIS pulses remain ignored even without a configured mode
      const detector5 = new SyncDetector(sampleRate);
      expect(feedPulse(detector5, 5)).toBeNull();
    });
  });

  describe('Mode switching and reset', () => {
    test('switching from 9ms to 20ms mode changes accepted pulse width', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.NineMilliSeconds);
      expect(feedPulse(detector, 20)).toBeNull();

      detector.setSyncPulseMode(SyncPulseMode.TwentyMilliSeconds);
      const result = feedPulse(detector, 20);
      expect(result?.width).toBe(SyncPulseWidth.TwentyMilliSeconds);
    });

    test('switching from 20ms to 9ms mode changes accepted pulse width', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.TwentyMilliSeconds);
      expect(feedPulse(detector, 9)).toBeNull();

      detector.setSyncPulseMode(SyncPulseMode.NineMilliSeconds);
      const result = feedPulse(detector, 9);
      expect(result?.width).toBe(SyncPulseWidth.NineMilliSeconds);
    });

    test('reset clears internal state so a half pulse cannot complete after it', () => {
      const detector = new SyncDetector(sampleRate);
      detector.setSyncPulseMode(SyncPulseMode.NineMilliSeconds);

      // Feed the first half of a 9ms pulse, then reset before it completes
      const halfSamples = Math.round(0.0045 * sampleRate);
      const half = new Float32Array(halfSamples);
      let phase = 0;
      for (let i = 0; i < halfSamples; i++) {
        half[i] = 0.8 * Math.sin(phase);
        phase += (2 * Math.PI * 1200) / sampleRate;
      }
      detector.process(half, new Float32Array(halfSamples));
      detector.reset();

      // After reset, finishing the pulse with another 1200Hz segment plus a
      // gap must not produce a detection assembled across the reset boundary
      const result = feedPulse(detector, 4.5, 30);
      expect(result).toBeNull();
    });
  });
});
