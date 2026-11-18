// Procedural cinematic score — Iron Man workshop vibe.
//   - Sub-bass drone (80 Hz foundation)
//   - Evolving pad (detuned saws + slow filter sweep = "orchestral")
//   - Synth arpeggio (Djawadi-style driving pulse at 110 BPM)
//   - Metallic percussion ticks
//   - Building intensity that peaks around 10s in
//   - Graceful tail-out after voice ends
//
// Zero audio assets — all generated live on the Web Audio graph.

import { audioBus } from './bus';

type Bed = {
  stop: (fadeMs?: number) => void;
  setLevel: (v: number) => void;
  swell: (targetLevel: number, durationMs: number) => void;
};

const BPM = 110;

export function playAmbientBed({ level = 0.22 }: { level?: number } = {}): Bed {
  const { ctx, master } = audioBus();
  const now = ctx.currentTime;

  // Every source we start (oscillators + noise buffers) and every node we
  // build, so stop() can fully release the graph — not just mute it.
  const stoppables: Array<OscillatorNode | AudioBufferSourceNode> = [];
  const nodes: AudioNode[] = [];
  const track = <T extends AudioNode>(n: T): T => { nodes.push(n); return n; };

  // Master bus
  const busGain = track(ctx.createGain());
  busGain.gain.setValueAtTime(0, now);
  busGain.gain.linearRampToValueAtTime(level, now + 1.4);
  busGain.connect(master);

  // Soft master filter — opens up as score builds
  const masterLP = track(ctx.createBiquadFilter());
  masterLP.type = 'lowpass';
  masterLP.frequency.value = 1200;
  masterLP.Q.value = 0.5;
  masterLP.frequency.linearRampToValueAtTime(4500, now + 10);
  masterLP.connect(busGain);

  // 1. SUB DRONE — foundation weight
  [55, 82.5].forEach((f, i) => {
    const osc = track(ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.value = f + (Math.random() - 0.5) * 0.2;
    const g = track(ctx.createGain());
    g.gain.value = i === 0 ? 0.5 : 0.3;
    osc.connect(g).connect(masterLP);
    osc.start();
    stoppables.push(osc);
  });

  // 2. PAD — detuned sawtooth stack, slow attack
  const padGain = track(ctx.createGain());
  padGain.gain.setValueAtTime(0, now);
  padGain.gain.linearRampToValueAtTime(0.15, now + 3.5);
  const padFilt = track(ctx.createBiquadFilter());
  padFilt.type = 'lowpass';
  padFilt.frequency.value = 800;
  padFilt.Q.value = 1.2;
  padFilt.frequency.linearRampToValueAtTime(2800, now + 10);
  padFilt.connect(padGain);
  padGain.connect(masterLP);

  // Stack: root + octave + fifth + third (A minor feel)
  [110, 165, 220, 261.6].forEach((f) => {
    for (let d = -1; d <= 1; d++) {
      const osc = track(ctx.createOscillator());
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = d * 7;
      const g = track(ctx.createGain());
      g.gain.value = 0.04;
      osc.connect(g).connect(padFilt);
      osc.start();
      stoppables.push(osc);
    }
  });

  // 3. ARPEGGIO — 16th-note driving pulse, kicks in at 2s
  const arpGain = track(ctx.createGain());
  arpGain.gain.setValueAtTime(0, now);
  arpGain.gain.linearRampToValueAtTime(0.18, now + 4);
  arpGain.connect(masterLP);

  const arpFilt = track(ctx.createBiquadFilter());
  arpFilt.type = 'bandpass';
  arpFilt.frequency.value = 1800;
  arpFilt.Q.value = 2.5;
  arpFilt.connect(arpGain);

  const noteSeq = [440, 523.25, 659.25, 523.25, 440, 523.25, 659.25, 783.99];
  const stepSec = 60 / BPM / 4;
  const arpStartTime = now + 2.0;
  const arpEndTime = now + 12.5;

  const scheduleArp = () => {
    let t = arpStartTime;
    let i = 0;
    while (t < arpEndTime) {
      const freq = noteSeq[i % noteSeq.length];
      const osc = track(ctx.createOscillator());
      osc.type = 'square';
      osc.frequency.value = freq;
      const g = track(ctx.createGain());
      const vel = 0.05 + (i % 4 === 0 ? 0.03 : 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + stepSec * 0.9);
      osc.connect(g).connect(arpFilt);
      osc.start(t);
      osc.stop(t + stepSec * 0.95);
      stoppables.push(osc);
      t += stepSec;
      i++;
    }
  };
  scheduleArp();

  // 4. METALLIC PERCUSSION — filtered noise hits on every beat
  const percGain = track(ctx.createGain());
  percGain.gain.value = 0.08;
  percGain.connect(masterLP);

  const schedulePerc = () => {
    const beatSec = 60 / BPM;
    const percStart = now + 3.0;
    const percEnd = now + 12.5;
    let t = percStart;
    let beat = 0;
    while (t < percEnd) {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < d.length; j++) {
        d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / d.length, 2.5);
      }
      const src = track(ctx.createBufferSource());
      src.buffer = buf;
      const bp = track(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = 2000 + Math.sin(beat * 0.3) * 600;
      bp.Q.value = 3;
      const g = track(ctx.createGain());
      g.gain.setValueAtTime(beat % 2 === 0 ? 0.5 : 0.25, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      src.connect(bp).connect(g).connect(percGain);
      src.start(t);
      stoppables.push(src);
      t += beatSec;
      beat++;
    }
  };
  schedulePerc();

  // 5. AIR SHIMMER — high noise bed
  const airBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const ad = airBuf.getChannelData(0);
  for (let i = 0; i < ad.length; i++) ad[i] = (Math.random() * 2 - 1) * 0.02;
  const air = track(ctx.createBufferSource());
  air.buffer = airBuf;
  air.loop = true;
  const airHp = track(ctx.createBiquadFilter());
  airHp.type = 'highpass';
  airHp.frequency.value = 5000;
  const airGain = track(ctx.createGain());
  airGain.gain.setValueAtTime(0, now);
  airGain.gain.linearRampToValueAtTime(0.4, now + 2);
  air.connect(airHp).connect(airGain).connect(busGain);
  air.start();
  stoppables.push(air);

  // ── Lifecycle ──────────────────────────────────────────────────────────
  // stop() must be a real teardown: fade the bus, then STOP every source
  // (oscillators AND noise buffers, including ones scheduled in the future)
  // and DISCONNECT every node so the graph is actually released.
  let stopped = false;

  const teardown = () => {
    for (const s of stoppables) { try { s.stop(); } catch {} }
    for (const n of stoppables) { try { n.disconnect(); } catch {} }
    for (const n of nodes) { try { n.disconnect(); } catch {} }
  };

  return {
    stop: (fadeMs = 1500) => {
      if (stopped) return;   // idempotent — safe on re-entrant wakes
      stopped = true;
      const t = ctx.currentTime;
      busGain.gain.cancelScheduledValues(t);
      busGain.gain.setValueAtTime(busGain.gain.value, t);
      busGain.gain.linearRampToValueAtTime(0.0001, t + fadeMs / 1000);
      setTimeout(teardown, fadeMs + 60);
    },
    setLevel: (v) => {
      if (stopped) return;   // a stopped bed must not ramp back up
      const t = ctx.currentTime;
      busGain.gain.cancelScheduledValues(t);
      busGain.gain.linearRampToValueAtTime(v, t + 0.3);
    },
    swell: (tgt, durMs) => {
      if (stopped) return;
      const t = ctx.currentTime;
      busGain.gain.cancelScheduledValues(t);
      busGain.gain.setValueAtTime(busGain.gain.value, t);
      busGain.gain.linearRampToValueAtTime(tgt, t + durMs / 1000);
    },
  };
}
