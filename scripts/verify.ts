#!/usr/bin/env node
// Local, dependency-free verification script for the bunny-hop simulation.
//
// Run with any Node.js >= 22.6 that can type-strip TS (Node 22.18+/24 strip
// by default):
//
//   node scripts/verify.ts
//
// It prints a short playable run, then checks the three guarantees the task
// asks for and exits non-zero if any of them fails:
//
//   1. the same input produces the same result at 32/60/64/128/240/360 Hz;
//   2. pausing and resuming never produces a jump or replays paused time;
//   3. restart clears velocity, position and the accumulator.

import { strict as assert } from 'node:assert';

import { AIR_WISH_SPEED_CAP, BunnyHopSim, TICK_RATE, createSimulation } from '../src/index.ts';

const FAILS: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    FAILS.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message.split('\n')[0]}`);
  }
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

// ---------------------------------------------------------------------------
// 1. A short playable run, one hop chain with a strafe and a mouse swing.
// ---------------------------------------------------------------------------

console.log('== Sample run (2 s, 128 Hz, auto-hop on) ==');
{
  const sim = createSimulation({ autoHop: true });
  let lastReported = -1;
  for (let frame = 0; frame < 256; frame += 1) {
    const result = sim.frame(1 / 128, {
      forward: 1,
      side: frame % 2 === 0 ? 1 : -1, // alternate strafe
      jump: frame === 0,
      mouseDX: 1.25, // steady mouse sweep
    });
    for (const event of result.events) {
      const where = `(${fmt(event.position.x, 1)}, ${fmt(event.position.z, 1)})`;
      console.log(
        `  tick ${String(event.tick).padStart(4)}  ${event.type.padEnd(4)}` +
          `${event.auto ? ' (auto)' : '       '}  ` +
          `speed ${fmt(event.speed).padStart(7)} u/s at ${where}`,
      );
    }
    const grounded = sim.grounded ? 'ground' : 'air   ';
    const tick = Math.floor(sim.tickCount);
    if (tick !== lastReported && tick % 64 === 0) {
      lastReported = tick;
      console.log(
        `  ~${fmt(sim.simulatedTime, 2)}s  ${grounded}  ` +
          `speed ${fmt(sim.speed).padStart(7)}  yaw ${fmt(sim.viewYaw, 3)}`,
      );
    }
  }
  const state = sim.getState();
  console.log(
    `  final: ticks=${state.tickCount} speed=${fmt(state.speed)} ` +
      `jumpCount=${state.jumpCount} landingCount=${state.landingCount} ` +
      `airCap=${AIR_WISH_SPEED_CAP} u/s tickRate=${TICK_RATE}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Frame-rate independence
// ---------------------------------------------------------------------------

console.log('\n== Frame-rate independence ==');

interface RunOptions {
  forward?: number;
  side?: number;
  mousePxPerSecond?: number;
  autoHop?: boolean;
}

function runAt(fps: number, seconds: number, input: RunOptions, dtTicks?: number): BunnyHopSim {
  const sim = createSimulation({ autoHop: input.autoHop ?? true });
  if (dtTicks !== undefined) {
    // Exact tick-driven run used as the ground truth.
    for (let i = 0; i < dtTicks; i += 1) {
      sim.advanceTicks(1, {
        forward: input.forward,
        side: input.side,
        jump: i === 0,
        mouseDX: (input.mousePxPerSecond ?? 0) / TICK_RATE,
      });
    }
    return sim;
  }
  const frames = Math.round(fps * seconds);
  const delta = 1 / fps;
  const mousePerFrame = (input.mousePxPerSecond ?? 0) * delta;
  for (let frame = 0; frame < frames; frame += 1) {
    sim.frame(delta, {
      forward: input.forward,
      side: input.side,
      jump: frame === 0,
      mouseDX: mousePerFrame,
    });
  }
  return sim;
}

const RUN_SECONDS = 2;
const RUN_TICKS = RUN_SECONDS * TICK_RATE;
const INPUT: RunOptions = { forward: 1, side: 1, mousePxPerSecond: 160 };

let reference: BunnyHopSim | undefined;
for (const fps of [32, 60, 64, 128, 240, 360]) {
  check(`${fps} Hz matches the 128 Hz reference`, () => {
    const sim = runAt(fps, RUN_SECONDS, INPUT);
    if (!reference) reference = sim;
    const a = sim.getState();
    const b = reference.getState();
    assert.equal(a.tickCount, b.tickCount, `tick count ${a.tickCount} vs ${b.tickCount}`);
    assert.equal(a.jumpCount, b.jumpCount, 'jump count');
    assert.equal(a.landingCount, b.landingCount, 'landing count');
    assert.ok(Math.abs(a.speed - b.speed) < 1e-9, `speed ${a.speed} vs ${b.speed}`);
    assert.ok(Math.abs(a.position.x - b.position.x) < 1e-9, 'x position');
    assert.ok(Math.abs(a.position.z - b.position.z) < 1e-9, 'z position');
    assert.ok(Math.abs(a.yaw - b.yaw) < 1e-9, `yaw ${a.yaw} vs ${b.yaw}`);
  });
}

check('60 Hz and 240 Hz share one tick timeline', () => {
  const low = runAt(60, 1, INPUT);
  const high = runAt(240, 1, INPUT);
  assert.equal(low.getState().jumpCount, high.getState().jumpCount, 'jump count');
  assert.ok(Math.abs(low.getState().position.x - high.getState().position.x) < 1e-9);
});

// ---------------------------------------------------------------------------
// 3. Pause / resume
// ---------------------------------------------------------------------------

console.log('\n== Pause and resume ==');

check('paused time never accumulates', () => {
  const sim = new BunnyHopSim();
  sim.frame(1 / 128, { jump: true });
  const ticks = sim.tickCount;
  sim.pause();
  for (let i = 0; i < 120; i += 1) sim.frame(1 / 60, { jump: true, mouseDX: 50 });
  assert.equal(sim.tickCount, ticks, 'ticks advanced while paused');
  assert.equal(sim.getState().accumulator, 0, 'accumulator grew while paused');
});

check('resume neither replays paused time nor jumps', () => {
  const sim = new BunnyHopSim({ autoHop: false });
  sim.frame(1 / 128, { jump: true }); // airborne
  sim.frame(1 / 128, { jump: true });
  const before = sim.getState();
  sim.pause();
  sim.frame(30, { jump: true }); // half a minute of pause
  sim.resume();
  const result = sim.frame(1 / 128, { jump: true });
  assert.equal(result.ticks, 1, `resume ran ${result.ticks} ticks`);
  assert.equal(result.events.filter((e) => e.type === 'jump').length, 0, 'jump on resume');
  assert.equal(sim.tickCount, before.tickCount + 1);
});

check('release-then-press during the pause is not a new press', () => {
  const sim = new BunnyHopSim({ autoHop: false });
  sim.pause();
  sim.frame(0.2, { jump: false });
  sim.frame(0.2, { jump: true });
  sim.resume();
  const result = sim.frame(1 / 128, { jump: true });
  assert.equal(result.events.filter((e) => e.type === 'jump').length, 0);
  assert.equal(sim.grounded, true);
});

// ---------------------------------------------------------------------------
// 4. Restart
// ---------------------------------------------------------------------------

console.log('\n== Restart ==');

check('restart zeroes velocity, position and accumulator', () => {
  const sim = new BunnyHopSim({ spawn: { x: 2, y: 0, z: 5 } });
  for (let i = 0; i < 200; i += 1) sim.frame(1 / 128, { forward: 1, side: 1, mouseDX: 4, jump: i === 0 });
  assert.ok(sim.speed > 0, 'setup failed to build speed');
  sim.restart();
  const state = sim.getState();
  assert.deepEqual(state.position, { x: 2, y: 0, z: 5 }, 'position');
  assert.deepEqual(state.velocity, { x: 0, y: 0, z: 0 }, 'velocity');
  assert.equal(state.speed, 0, 'speed');
  assert.equal(state.tickCount, 0, 'tick count');
  assert.equal(state.accumulator, 0, 'accumulator');
  assert.equal(state.jumpCount, 0, 'jump count');
  assert.equal(state.landingCount, 0, 'landing count');
  assert.equal(state.grounded, true, 'grounded');
});

check('first frame after restart behaves like a fresh start', () => {
  const fresh = new BunnyHopSim();
  const restarted = new BunnyHopSim();
  for (let i = 0; i < 90; i += 1) restarted.frame(1 / 128, { forward: 1, mouseDX: 9 });
  restarted.restart();
  const a = fresh.frame(1 / 64, { forward: 1, mouseDX: 6, jump: true });
  const b = restarted.frame(1 / 64, { forward: 1, mouseDX: 6, jump: true });
  assert.equal(a.ticks, b.ticks);
  assert.deepEqual(b.state, a.state);
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log('');
if (FAILS.length > 0) {
  console.error(`FAILED ${FAILS.length} check(s):`);
  for (const name of FAILS) console.error(`  - ${name}`);
  process.exit(1);
}
console.log('All checks passed.');
