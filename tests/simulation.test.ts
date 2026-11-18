import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { AIR_WISH_SPEED_CAP, BunnyHopSim, TICK_RATE, createSimulation } from '../src/index.ts';

/** Run one simulation frame by frame at `fps` for `seconds`, with per-frame input. */
function runAtFps(
  fps: number,
  seconds: number,
  input: { forward?: number; side?: number; jump?: boolean; mousePxPerSecond?: number },
  options: Parameters<typeof createSimulation>[0] = {},
) {
  const sim = createSimulation(options);
  const frames = Math.round(fps * seconds);
  const delta = 1 / fps;
  const mousePerFrame = (input.mousePxPerSecond ?? 0) * delta;
  const events: { type: string; tick: number; auto: boolean }[] = [];
  for (let i = 0; i < frames; i += 1) {
    const result = sim.frame(delta, {
      forward: input.forward,
      side: input.side,
      jump: input.jump,
      mouseDX: mousePerFrame,
    });
    for (const e of result.events) events.push({ type: e.type, tick: e.tick, auto: e.auto });
  }
  return { sim, state: sim.getState(), events };
}

describe('fixed-step simulation', () => {
  it('runs on a 1/128 s tick', () => {
    const sim = new BunnyHopSim();
    assert.equal(sim.tickSeconds, 1 / 128);
    assert.equal(TICK_RATE, 128);
  });

  it('turns accumulated frame time into an integer number of ticks', () => {
    const sim = new BunnyHopSim();
    const r1 = sim.frame(1 / 64, {});
    assert.equal(r1.ticks, 2);
    const r2 = sim.frame(1 / 256, {});
    assert.equal(r2.ticks, 0);
    const r3 = sim.frame(1 / 256, {});
    assert.equal(r3.ticks, 1);
    assert.equal(sim.tickCount, 3);
  });

  it('does not lose a tick to floating point drift when frames sum to 1 s', () => {
    const sim = new BunnyHopSim();
    for (let i = 0; i < 60; i += 1) sim.frame(1 / 60, {});
    // 60 * 1/60 s in binary is a hair under 1 s; the epsilon keeps the tick.
    assert.equal(sim.tickCount, 128);
    assert.ok(Math.abs(sim.getState().accumulator) < 1e-9);
  });

  it('splits frame mouse motion evenly across the ticks it drives', () => {
    const sim = new BunnyHopSim({ mouseSensitivity: 1 });
    sim.frame(4 / 128, { mouseDX: 40 });
    // 4 ticks, 40 px => 10 px (0.010 rad) per tick.
    assert.ok(Math.abs(sim.viewYaw - 40) < 1e-12);
    assert.equal(sim.tickCount, 4);
  });

  it('buffers mouse motion on zero-tick frames instead of dropping it', () => {
    const sim = new BunnyHopSim({ mouseSensitivity: 1 });
    sim.frame(1 / 256, { mouseDX: 7 });
    assert.equal(sim.tickCount, 0);
    assert.equal(sim.viewYaw, 0);
    sim.frame(1 / 256, { mouseDX: 0 });
    assert.equal(sim.tickCount, 1);
    assert.ok(Math.abs(sim.viewYaw - 7) < 1e-12);
  });

  it('latches a jump press that lands on a zero-tick frame', () => {
    // At 256 Hz every other frame runs no tick; a quick tap must still jump.
    const sim = new BunnyHopSim({ autoHop: false });
    const first = sim.frame(1 / 256, { jump: true });
    assert.equal(first.ticks, 0);
    const second = sim.frame(1 / 256, { jump: false }); // key already released
    assert.equal(second.ticks, 1);
    assert.equal(second.events.filter((e) => e.type === 'jump').length, 1);
    assert.equal(sim.grounded, false);
  });
});

describe('frame-rate independence', () => {
  const input = { forward: 1, side: 1, jump: true, mousePxPerSecond: 128 };

  it('gives bit-identical results at 32, 64, 128 and 256 Hz', () => {
    const reference = runAtFps(128, 2, input);
    for (const fps of [32, 64, 256]) {
      const run = runAtFps(fps, 2, input);
      assert.equal(run.sim.tickCount, reference.sim.tickCount, `tickCount at ${fps} Hz`);
      assert.ok(
        Math.abs(run.state.position.x - reference.state.position.x) < 1e-12,
        `x at ${fps} Hz`,
      );
      assert.ok(
        Math.abs(run.state.position.z - reference.state.position.z) < 1e-12,
        `z at ${fps} Hz`,
      );
      assert.ok(
        Math.abs(run.state.speed - reference.state.speed) < 1e-12,
        `speed at ${fps} Hz`,
      );
      assert.ok(Math.abs(run.state.yaw - reference.state.yaw) < 1e-12, `yaw at ${fps} Hz`);
      assert.deepEqual(
        run.events.map((e) => [e.type, e.tick]),
        reference.events.map((e) => [e.type, e.tick]),
        `event timeline at ${fps} Hz`,
      );
    }
  });

  it('does not let a high-refresh machine move any faster (60 vs 240 Hz)', () => {
    const low = runAtFps(60, 3, input);
    const high = runAtFps(240, 3, input);
    // Accumulator drift may shift the tick count by one; the physics must not.
    assert.ok(Math.abs(low.sim.tickCount - high.sim.tickCount) <= 1);
    assert.ok(
      Math.abs(low.state.speed - high.state.speed) / Math.max(1, low.state.speed) < 1e-9,
      `speed ${low.state.speed} vs ${high.state.speed}`,
    );
    assert.ok(Math.abs(low.state.position.x - high.state.position.x) < 1e-6);
    assert.ok(Math.abs(low.state.position.z - high.state.position.z) < 1e-6);
  });

  it('turns at the same rate per second on every refresh rate', () => {
    const a = runAtFps(64, 1, { mousePxPerSecond: 640 }, { mouseSensitivity: 0.01 });
    const b = runAtFps(256, 1, { mousePxPerSecond: 640 }, { mouseSensitivity: 0.01 });
    const fullTurn = Math.PI * 2;
    // Yaw is wrapped into (-PI, PI]; compare on the circle.
    const diff = Math.abs(a.state.yaw - b.state.yaw) % fullTurn;
    assert.ok(Math.min(diff, fullTurn - diff) < 1e-9);
  });
});

describe('auto-hop', () => {
  it('re-jumps exactly on the landing tick and nowhere else', () => {
    const sim = new BunnyHopSim({ autoHop: true });
    const events: { type: string; tick: number; auto: boolean }[] = [];
    // One manual take-off, then nothing but air time for 4 s.
    for (let i = 0; i < 512; i += 1) {
      const r = sim.frame(1 / 128, { forward: 1, jump: i === 0 });
      for (const e of r.events) events.push({ type: e.type, tick: e.tick, auto: e.auto });
    }

    const jumps = events.filter((e) => e.type === 'jump');
    const lands = events.filter((e) => e.type === 'land');
    assert.ok(jumps.length >= 4, `expected several hops, got ${jumps.length}`);
    assert.equal(jumps[0].auto, false, 'the first jump came from the key');
    assert.ok(jumps.slice(1).every((j) => j.auto), 'every jump after the first must be auto');

    // Every jump after the take-off shares its tick with a landing, and each
    // landing is immediately followed by exactly one auto jump on that tick.
    const landTicks = new Set(lands.map((l) => l.tick));
    for (const jump of jumps.slice(1)) {
      assert.ok(landTicks.has(jump.tick), `auto jump at tick ${jump.tick} had no landing`);
    }
    assert.equal(jumps.length, lands.length + 1, 'one take-off, then one hop per landing');

    // Exactly one auto jump per landing tick, never two.
    const autoPerTick = new Map<number, number>();
    for (const j of jumps.filter((j) => j.auto)) {
      autoPerTick.set(j.tick, (autoPerTick.get(j.tick) ?? 0) + 1);
    }
    for (const [tick, count] of autoPerTick) {
      assert.equal(count, 1, `tick ${tick} produced ${count} auto jumps`);
    }
  });

  it('cannot trigger repeatedly while airborne', () => {
    const sim = new BunnyHopSim({ autoHop: true });
    const jumps: number[] = [];
    for (let i = 0; i < 512; i += 1) {
      for (const e of sim.frame(1 / 128, { jump: i === 0 }).events) {
        if (e.type === 'jump') jumps.push(e.tick);
      }
    }
    assert.ok(jumps.length >= 3);
    // Airborne ticks between jump n and the next landing must be free of jumps.
    let lastJump = jumps[0];
    for (const tick of jumps.slice(1)) {
      const airTicks = tick - lastJump;
      assert.ok(airTicks > 60, `next jump only ${airTicks} ticks after the last; expected a full arc`);
      lastJump = tick;
    }
  });

  it('does not re-jump while the jump key is held in the air (auto-hop off)', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    let jumps = 0;
    for (let i = 0; i < 512; i += 1) {
      // Hold jump for the entire 4 s.
      const r = sim.frame(1 / 128, { jump: true });
      jumps += r.events.filter((e) => e.type === 'jump').length;
    }
    assert.equal(jumps, 1, 'holding jump must yield exactly one take-off');
  });

  it('fires once per press, not once per airborne tick (auto-hop off)', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    const jumps: number[] = [];
    for (let i = 0; i < 512; i += 1) {
      // Tap once every 32 frames.
      const jump = i % 32 === 0;
      for (const e of sim.frame(1 / 128, { jump }).events) {
        if (e.type === 'jump') jumps.push(e.tick);
      }
    }
    // Taps while airborne are remembered only as an edge, never queued.
    for (let i = 1; i < jumps.length; i += 1) {
      assert.ok(jumps[i] - jumps[i - 1] > 1);
    }
    assert.ok(jumps.length <= 17);
  });

  it('catches a landing that happens mid-frame, even across many ticks', () => {
    const sim = new BunnyHopSim({ autoHop: true });
    // Take off on tick 1.
    const takeoff = sim.frame(1 / 128, { jump: true });
    assert.equal(takeoff.events.filter((e) => e.type === 'jump').length, 1);

    // One huge frame spanning the whole arc; the landing and the auto-hop
    // both have to happen inside it.
    const huge = sim.frame(1.0, {});
    assert.ok(huge.ticks >= 100);
    const types = huge.events.map((e) => e.type);
    assert.ok(types.includes('land'), 'landing inside the big frame was missed');
    assert.ok(types.includes('jump'), 'auto-hop inside the big frame was missed');
    assert.equal(huge.events.filter((e) => e.type === 'jump').length,
      huge.events.filter((e) => e.type === 'land').length,
      'each landing inside the frame must get exactly one auto-hop');
  });

  it('does not auto-hop when the option is disabled', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    let jumps = 0;
    let lands = 0;
    for (let i = 0; i < 512; i += 1) {
      for (const e of sim.frame(1 / 128, {}).events) {
        if (e.type === 'jump') jumps += 1;
        if (e.type === 'land') lands += 1;
      }
    }
    // No initial jump was requested, so nothing ever leaves the ground.
    assert.equal(jumps, 0);
    assert.equal(lands, 0);
    assert.equal(sim.grounded, true);
  });
});

describe('pause and resume', () => {
  it('does not accumulate time while paused', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    sim.frame(1 / 128, { jump: true });
    const before = sim.tickCount;
    sim.pause();

    for (let i = 0; i < 100; i += 1) {
      const r = sim.frame(1 / 60, { jump: true, mouseDX: 100 });
      assert.equal(r.ticks, 0);
    }
    assert.equal(sim.tickCount, before);
    const state = sim.getState();
    assert.equal(state.accumulator, 0);
    assert.equal(state.pendingMouseYaw, 0);
    assert.equal(state.paused, true);
  });

  it('does not replay paused wall-clock time after resuming', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    sim.pause();
    sim.frame(10, {}); // ten seconds of paused time
    sim.resume();
    const r = sim.frame(1 / 128, {});
    assert.equal(r.ticks, 1, 'resume must start from zero, not catch up 10 s');
    assert.equal(sim.tickCount, 1);
  });

  it('does not produce a jump on resume', () => {
    const sim = new BunnyHopSim({ autoHop: true });
    let jumps = 0;
    // Take off, then hover in the air for a while.
    for (let i = 0; i < 40; i += 1) {
      const r = sim.frame(1 / 128, { jump: true });
      jumps += r.events.filter((e) => e.type === 'jump').length;
    }
    assert.equal(jumps, 1);
    sim.pause();
    sim.frame(5, { jump: true }); // ignored entirely while paused
    sim.resume();
    const resumeResult = sim.frame(1 / 128, { jump: true });
    assert.equal(resumeResult.ticks, 1);
    // The key was already down before the pause, so no fresh press edge.
    assert.equal(resumeResult.events.filter((e) => e.type === 'jump').length, 0);
    const afterResume = sim.frame(1 / 128, { jump: true });
    assert.equal(afterResume.events.filter((e) => e.type === 'jump').length, 0);
    assert.equal(sim.grounded, false);
  });

  it('ignores a release-and-repress that happens entirely during the pause', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    sim.pause();
    // Released and pressed again while paused: must not count as a press.
    sim.frame(0.5, { jump: false });
    sim.frame(0.5, { jump: true });
    sim.resume();
    const r = sim.frame(1 / 128, { jump: true });
    assert.equal(r.ticks, 1);
    assert.equal(r.events.filter((e) => e.type === 'jump').length, 0);
    assert.equal(sim.grounded, true);
  });

  it('pause mid-air then resume does not add a jump', () => {
    const sim = new BunnyHopSim({ autoHop: true });
    sim.frame(1 / 128, { jump: true }); // take off
    sim.advanceTicks(40, {});
    assert.equal(sim.grounded, false);
    const jumpsBefore = sim.getState().jumpCount;
    sim.pause();
    sim.frame(5, { mouseDX: 999 });
    sim.resume();
    // Resume with no jump key and let the arc finish; auto-hop itself is
    // legitimate, so count only pre-landing jump changes.
    const r = sim.frame(1 / 128, {});
    assert.equal(r.ticks, 1);
    assert.ok(sim.getState().jumpCount >= jumpsBefore);
    assert.equal(sim.getState().jumpCount, jumpsBefore);
  });

  it('discards a press latched on the very frame before the pause', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    // Force the press onto a zero-tick frame, then pause before it runs.
    sim.frame(1 / 256, { jump: true });
    sim.pause();
    sim.resume();
    const r = sim.frame(1 / 256, { jump: false });
    assert.equal(r.events.filter((e) => e.type === 'jump').length, 0);
    assert.equal(sim.grounded, true);
  });

  it('is a no-op to pause twice, and togglePause round-trips', () => {
    const sim = new BunnyHopSim();
    sim.pause();
    sim.pause();
    assert.equal(sim.paused, true);
    assert.equal(sim.togglePause(), false);
    assert.equal(sim.paused, false);
  });
});

describe('restart', () => {
  it('clears position, velocity, counters and the accumulator', () => {
    const sim = new BunnyHopSim({ spawn: { x: 4, y: 0, z: -2 }, autoHop: true });
    for (let i = 0; i < 300; i += 1) {
      sim.frame(1 / 128, { forward: 1, side: 1, mouseDX: 3, jump: i === 0 });
    }
    const dirty = sim.getState();
    assert.ok(dirty.speed > 0);
    assert.ok(dirty.tickCount > 0);
    assert.ok(dirty.jumpCount > 0);

    sim.restart();
    const clean = sim.getState();
    assert.deepEqual(clean.position, { x: 4, y: 0, z: -2 });
    assert.deepEqual(clean.velocity, { x: 0, y: 0, z: 0 });
    assert.equal(clean.speed, 0);
    assert.equal(clean.verticalSpeed, 0);
    assert.equal(clean.yaw, 0);
    assert.equal(clean.tickCount, 0);
    assert.equal(clean.simulatedTime, 0);
    assert.equal(clean.accumulator, 0);
    assert.equal(clean.pendingMouseYaw, 0);
    assert.equal(clean.jumpCount, 0);
    assert.equal(clean.landingCount, 0);
    assert.equal(clean.lastJumpTick, -1);
    assert.equal(clean.lastLandingTick, -1);
    assert.equal(clean.grounded, true);
  });

  it('restart also works while paused and clears paused time', () => {
    const sim = new BunnyHopSim();
    sim.frame(1 / 64, { forward: 1 });
    sim.pause();
    sim.frame(3, {});
    sim.restart();
    assert.equal(sim.tickCount, 0);
    assert.equal(sim.getState().accumulator, 0);
    sim.resume();
    assert.equal(sim.frame(1 / 128, {}).ticks, 1);
  });
});

describe('physics', () => {
  it('caps the airborne wish speed at 30 u/s per tick', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    // Get airborne with no horizontal speed.
    sim.frame(1 / 128, { jump: true });
    assert.equal(sim.grounded, false);
    assert.ok(sim.speed < 1e-9);

    // Full forward input, but the gain is bounded by airAccelerate * 30 * dt.
    const before = sim.velocity;
    sim.frame(1 / 128, { forward: 1 });
    const after = sim.velocity;
    const gain = Math.hypot(after.x - before.x, after.z - before.z);
    const maxGain = 10 * AIR_WISH_SPEED_CAP * (1 / 128);
    assert.ok(gain <= maxGain + 1e-9, `air gain ${gain} exceeded the 30 u/s cap (${maxGain})`);
    assert.ok(gain > 0, 'air acceleration should still work');
  });

  it('applies friction and settles back to rest on the ground', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    sim.advanceTicks(1, { jump: true });
    sim.advanceTicks(120, {}); // land and settle
    assert.equal(sim.grounded, true);
    sim.advanceTicks(64, { forward: 1 });
    assert.ok(sim.speed > 100);
    const startSpeed = sim.speed;
    sim.advanceTicks(128, {});
    assert.ok(sim.speed < startSpeed);
    assert.ok(sim.speed < 5, `friction should settle the body, speed=${sim.speed}`);
  });

  it('returns to the ground state after an arc', () => {
    const sim = new BunnyHopSim({ autoHop: false });
    assert.equal(sim.grounded, true);
    sim.frame(1 / 128, { jump: true });
    assert.equal(sim.grounded, false);
    assert.ok(sim.verticalSpeed > 0);
    // One full arc is ~86 ticks at g=800, h=45.
    let landedAt = -1;
    for (let i = 0; i < 200; i += 1) {
      if (sim.frame(1 / 128, {}).events.some((e) => e.type === 'land')) {
        landedAt = sim.tickCount;
        break;
      }
    }
    assert.ok(landedAt > 60 && landedAt < 120, `unexpected landing tick ${landedAt}`);
    assert.equal(sim.grounded, true);
    assert.equal(sim.verticalSpeed, 0);
  });

  it('exposes observable state after every frame', () => {
    const sim = new BunnyHopSim();
    const r = sim.frame(1 / 64, { forward: 1, side: 1, mouseDX: 5, jump: true });
    assert.equal(r.ticks, 2);
    assert.equal(typeof r.state.grounded, 'boolean');
    assert.equal(typeof r.state.speed, 'number');
    assert.equal(typeof r.state.tickCount, 'number');
    assert.equal(r.state.tickCount, 2);
    assert.deepEqual(r.state, sim.getState());
  });

  it('rejects invalid frame deltas', () => {
    const sim = new BunnyHopSim();
    assert.throws(() => sim.frame(-1, {}), RangeError);
    assert.throws(() => sim.frame(Number.NaN, {}), TypeError);
  });

  it('clamps runaway frame time when maxFrameSeconds is configured', () => {
    const sim = new BunnyHopSim({ maxFrameSeconds: 0.25, mouseSensitivity: 1 });
    const r = sim.frame(10, { mouseDX: 1000 });
    assert.equal(r.ticks, 32); // 0.25 s at 128 Hz
    // Mouse input is clamped by the same ratio, so turning matches time:
    // 1000 px * (0.25 / 10) = 25 rad.
    assert.ok(Math.abs(sim.viewYaw - 25) < 1e-9, `yaw=${sim.viewYaw}`);
  });
});
