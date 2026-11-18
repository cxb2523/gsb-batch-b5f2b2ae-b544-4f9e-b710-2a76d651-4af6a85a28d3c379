// Convergence tests for the Helios simulation clock (src/pages/solarSim.js).
// Run: node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSolarSim, DEFAULT_SPEED } from '../src/pages/solarSim.js'
import { msFromDays } from '../src/data/astro.js'

const NOW = Date.UTC(2026, 10, 19) // fixed epoch for determinism
const FRAME = 1 / 60

/* Ticks until the fast-forward lands; fails if it never does. */
function runToArrival(ctrl, maxFrames = 100000) {
  for (let i = 0; i < maxFrames; i++) {
    const arrived = ctrl.tick(FRAME)
    if (arrived) return arrived
  }
  throw new Error('fast-forward never arrived')
}

/* Invariants that must hold after every operation, in any order. */
function assertConverged(sim) {
  assert.equal(sim.seeking, sim.target != null, 'seeking ⟺ target set')
  if (sim.seeking) assert.ok(sim.pending, 'a seek always has its pending eclipse')
  if (sim.eclipse) assert.equal(sim.seeking, false, 'no card while seeking')
  if (!sim.seeking) assert.equal(sim.pending, null, 'no orphan pending result')
}

test('fast-forward lands exactly on the eclipse, stops the clock, shows one card', () => {
  const ctrl = createSolarSim(NOW)
  const sought = ctrl.predict()
  assert.ok(sought)
  const arrived = runToArrival(ctrl)
  assert.equal(arrived, sought, 'the card is the eclipse that was predicted')
  assert.equal(ctrl.sim.t, sought.t, 'clock stops exactly on the target')
  assert.equal(ctrl.sim.speed, 0, 'speed zeroed on arrival')
  assert.equal(ctrl.sim.eclipse, sought)
  assertConverged(ctrl.sim)
  // further ticks keep the clock parked at the eclipse instant
  ctrl.tick(FRAME)
  assert.equal(ctrl.sim.t, sought.t)
})

test('re-triggering predict mid-seek is ignored — target never swaps', () => {
  const ctrl = createSolarSim(NOW)
  const first = ctrl.predict()
  const target = ctrl.sim.target
  for (let i = 0; i < 50; i++) {
    ctrl.tick(FRAME)
    assert.equal(ctrl.predict(), null, 're-entry is a no-op')
    assert.equal(ctrl.sim.target, target, 'target unchanged')
    assert.equal(ctrl.sim.pending, first, 'pending unchanged')
  }
  assertConverged(ctrl.sim)
})

test('manual speed mid-seek cancels the fast-forward and never shows the stale card', () => {
  const ctrl = createSolarSim(NOW)
  ctrl.predict()
  for (let i = 0; i < 30; i++) ctrl.tick(FRAME)
  ctrl.setSpeed(30)
  assert.equal(ctrl.sim.target, null)
  assert.equal(ctrl.sim.pending, null)
  assert.equal(ctrl.sim.seeking, false)
  assert.equal(ctrl.sim.eclipse, null)
  // tick well past where the target would have been: no arrival, no card
  const t0 = ctrl.sim.t
  for (let i = 0; i < 60 * 60; i++) assert.equal(ctrl.tick(FRAME), null)
  assert.ok(ctrl.sim.t > t0, 'manual speed drives the clock')
  assert.equal(ctrl.sim.eclipse, null)
  assertConverged(ctrl.sim)
})

test('pause (speed 0) mid-seek also cancels', () => {
  const ctrl = createSolarSim(NOW)
  ctrl.predict()
  ctrl.tick(FRAME)
  ctrl.setSpeed(0)
  const t = ctrl.sim.t
  for (let i = 0; i < 120; i++) assert.equal(ctrl.tick(FRAME), null)
  assert.equal(ctrl.sim.t, t, 'paused clock does not drift')
  assertConverged(ctrl.sim)
})

test('after arrival, predict finds the *next* eclipse', () => {
  const ctrl = createSolarSim(NOW)
  const first = ctrl.predict()
  runToArrival(ctrl)
  const second = ctrl.predict()
  assert.ok(second, 'predict works again after arrival')
  assert.ok(second.t > first.t, 'it is a later eclipse')
  const arrived = runToArrival(ctrl)
  assert.equal(arrived, second)
  assertConverged(ctrl.sim)
})

test('dispose releases target, pending and seeking', () => {
  const ctrl = createSolarSim(NOW)
  ctrl.predict()
  ctrl.tick(FRAME)
  ctrl.dispose()
  assert.equal(ctrl.sim.target, null)
  assert.equal(ctrl.sim.pending, null)
  assert.equal(ctrl.sim.seeking, false)
  // a disposed sim ticks as a plain paused clock with no arrival
  assert.equal(ctrl.tick(FRAME), null)
  assertConverged(ctrl.sim)
})

test('a fresh sim starts at the real current time at default speed, no card', () => {
  const ctrl = createSolarSim(NOW)
  assert.equal(ctrl.sim.t * 86400000 + msFromDays(0), NOW + 0) // epoch sanity
  assert.ok(Math.abs(msFromDays(ctrl.sim.t) - NOW) < 1)
  assert.equal(ctrl.sim.speed, DEFAULT_SPEED)
  assert.equal(ctrl.sim.eclipse, null)
  assertConverged(ctrl.sim)
})

test('random operation sequences always converge', () => {
  let seed = 42
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let trial = 0; trial < 20; trial++) {
    const ctrl = createSolarSim(NOW)
    let arrivals = 0
    for (let op = 0; op < 2000; op++) {
      const r = rand()
      if (r < 0.1) ctrl.predict()
      else if (r < 0.2) ctrl.setSpeed([0, 1, 7, 30, 182][Math.floor(rand() * 5)])
      else if (ctrl.tick(FRAME)) arrivals++
      assertConverged(ctrl.sim)
    }
    assert.ok(arrivals <= 1 || ctrl.sim.eclipse, 'every arrival showed its card')
  }
})
