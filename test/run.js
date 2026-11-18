/**
 * Locally runnable verification for the mixer/reverb rebuild chain.
 * Loads the relevant syngen sources into a vm with a mock Web Audio
 * implementation and asserts graph connectivity and parameter
 * preservation across rebuilds.
 *
 * Run with: npm test   (or: node test/run.js)
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const {createSandbox} = require('./mock-audio')

const root = path.join(__dirname, '..')

const files = [
  'src/syngen.js',
  'src/syngen/const.js',
  'src/syngen/fn.js',
  'src/syngen/tool/pubsub.js',
  'src/syngen/tool/vector3d.js',
  'src/syngen/loop.js',
  'src/syngen/performance.js',
  'src/syngen/buffer/impulse.js',
  'src/syngen/buffer/whiteNoise.js',
  'src/syngen/mixer.js',
  'src/syngen/mixer/reverb.js',
  'src/syngen/mixer/reverb/gainModel/base.js',
  'src/syngen/mixer/reverb/gainModel/bell.js',
  'src/syngen/mixer/reverb/gainModel/normalize.js',
  'src/syngen/mixer/reverb/send.js',
]

const source = files
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n') + '\nglobalThis.syngen = syngen\n'

const sandbox = createSandbox()
vm.createContext(sandbox)
vm.runInContext(source, sandbox, {filename: 'syngen.test-bundle.js'})

const syngen = sandbox.syngen,
  mixer = syngen.mixer,
  reverb = syngen.mixer.reverb

// Test utilities

let failures = 0

function test(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(`  ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function assertApprox(actual, expected, message, epsilon = 1e-9) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message} (expected ${expected}, got ${actual})`)
  }
}

function countConnections(from, to) {
  return from._outputs.filter((node) => node === to).length
}

function reachable(from, to) {
  const seen = new Set(),
    queue = [from]

  while (queue.length) {
    const node = queue.shift()

    if (node === to) {
      return true
    }

    if (seen.has(node)) {
      continue
    }

    seen.add(node)
    queue.push(...node._outputs)
  }

  return false
}

// Tests

test('main rebuild preserves filter frequencies, retargets param, keeps chain connected', () => {
  mixer.param.highpass.frequency.value = 120
  mixer.param.lowpass.frequency.value = 8000

  const oldHighpass = mixer.param.highpass.frequency,
    oldLowpass = mixer.param.lowpass.frequency

  mixer.rebuildFilters()

  assert(mixer.param.highpass.frequency.value === 120, 'main highpass frequency should be preserved')
  assert(mixer.param.lowpass.frequency.value === 8000, 'main lowpass frequency should be preserved')
  assert(mixer.param.highpass.frequency !== oldHighpass, 'main highpass param should point at the new filter')
  assert(mixer.param.lowpass.frequency !== oldLowpass, 'main lowpass param should point at the new filter')
  assert(reachable(mixer.input(), mixer.output()), 'main input should reach main output')
})

test('reverb rebuild (while active) preserves state and rebuilds the full chain', () => {
  reverb.param.highpass.frequency.value = 200
  reverb.param.lowpass.frequency.value = 6000

  const oldInput = reverb.input(),
    oldHighpass = reverb.param.highpass.frequency,
    oldLowpass = reverb.param.lowpass.frequency,
    oldDelay = reverb.param.delay

  reverb.rebuildFilters()

  assert(reverb.input() !== oldInput, 'reverb input should be a new node')
  assert(reverb.param.highpass.frequency.value === 200, 'reverb highpass frequency should be preserved')
  assert(reverb.param.lowpass.frequency.value === 6000, 'reverb lowpass frequency should be preserved')
  assert(reverb.param.highpass.frequency !== oldHighpass, 'reverb highpass param should point at the new filter')
  assert(reverb.param.lowpass.frequency !== oldLowpass, 'reverb lowpass param should point at the new filter')
  assert(reverb.param.delay !== oldDelay, 'reverb delay param should point at the new delay')
  assertApprox(reverb.param.delay.value, 1 / 64, 'reverb delay time should be preserved')
  assert(reachable(reverb.input(), reverb.output()), 'reverb input should reach reverb output through delay, filters, and convolver')
})

const send1 = reverb.send.create({x: 10})

test('existing send reconnects to the new reverb input after an active rebuild', () => {
  reverb.rebuildFilters()

  assert(countConnections(send1.send, reverb.input()) === 1, 'send bus should connect to the new reverb input exactly once')
  assert(send1.send._outputs.length === 1, 'send bus should have no stale or duplicate outputs')
  assert(countConnections(send1.delay, send1.send) === 1, 'send delay should feed its bus exactly once')
  assert(reachable(send1.input, reverb.output()), 'send input should reach the reverb output')
})

test('send delay time and gain keep tracking relative position after rebuild', () => {
  send1.update({x: 20, y: 0, z: 0})

  const expectedDelay = syngen.fn.clamp(20 / syngen.const.speedOfSound, syngen.const.zeroTime, 1),
    expectedGain = syngen.mixer.reverb.gainModel.bell.calculate(20)

  assertApprox(send1.delay.delayTime.value, expectedDelay, 'send delay time should follow distance')
  assertApprox(send1.send.gain.value, expectedGain, 'send gain should follow the gain model')
})

test('rebuild while inactive does not reconnect sends; reactivation restores them', () => {
  reverb.setActive(false)

  const inputBefore = reverb.input()

  reverb.rebuildFilters()

  assert(reverb.input() !== inputBefore, 'reverb input should be rebuilt while inactive')
  assert(countConnections(send1.send, reverb.input()) === 0, 'send bus should not connect to the new input while inactive')
  assert(!reachable(reverb.input(), reverb.output()), 'reverb input should stay disconnected from the chain while inactive')

  reverb.setActive(true)

  assert(countConnections(send1.send, reverb.input()) === 1, 'send bus should reconnect on reactivation')
  assert(send1.send._outputs.length === 1, 'send bus should have exactly one output after reactivation')
  assert(reachable(send1.input, reverb.output()), 'send should be audible again after reactivation')
})

test('rebuild while inactive via the main mixer keeps sends disconnected until reactivation', () => {
  reverb.setActive(false)

  mixer.rebuildFilters()

  assert(countConnections(send1.send, reverb.input()) === 0, 'send bus should not connect to the new input while inactive')

  reverb.setActive(true)

  assert(countConnections(send1.send, reverb.input()) === 1, 'send bus should reconnect on reactivation')
  assert(reachable(send1.input, reverb.output()), 'send should be audible again after reactivation')
})

const sendA = reverb.send.create({x: 5}),
  sendB = reverb.send.create({x: 15}),
  sendC = reverb.send.create({x: 30})

test('multiple sends all reconnect exactly once after rebuild', () => {
  mixer.rebuildFilters()

  for (const send of [send1, sendA, sendB, sendC]) {
    assert(countConnections(send.send, reverb.input()) === 1, 'each send bus should connect to the new input exactly once')
    assert(send.send._outputs.length === 1, 'each send bus should have no stale or duplicate outputs')
    assert(countConnections(send.delay, send.send) === 1, 'each send delay should feed its bus exactly once')
    assert(reachable(send.input, reverb.output()), 'each send should reach the reverb output')
  }
})

test('repeated rebuilds never stack connections', () => {
  reverb.rebuildFilters()
  reverb.rebuildFilters()
  reverb.rebuildFilters()

  for (const send of [send1, sendA, sendB, sendC]) {
    assert(send.send._outputs.length === 1, 'send bus should keep exactly one output across repeated rebuilds')
    assert(countConnections(send.send, reverb.input()) === 1, 'send bus should connect to the current input exactly once')
  }
})

test('destroyed send ignores rebuild and activation events', () => {
  const doomed = reverb.send.create({x: 3})

  assert(countConnections(doomed.send, reverb.input()) === 1, 'send should be connected before destroy')

  doomed.destroy()

  assert(doomed.send._outputs.length === 0, 'destroy should disconnect the send bus')

  reverb.rebuildFilters()
  assert(doomed.send._outputs.length === 0, 'destroyed send should not respond to rebuild')

  reverb.setActive(false)
  reverb.setActive(true)
  assert(doomed.send._outputs.length === 0, 'destroyed send should not respond to activation')

  doomed.update({x: 100})
  assert(doomed.send._outputs.length === 0, 'destroyed send should not reconnect on update')

  // Live sends are unaffected by the destroyed one
  assert(countConnections(send1.send, reverb.input()) === 1, 'live sends should remain connected')
  assert(reachable(send1.input, reverb.output()), 'live sends should remain audible')
})

test('sends created while inactive connect on next activation after rebuilds', () => {
  reverb.setActive(false)

  const quiet = reverb.send.create({x: 8})

  reverb.rebuildFilters()

  assert(countConnections(quiet.send, reverb.input()) === 0, 'inactive send should not be connected')

  reverb.setActive(true)

  assert(countConnections(quiet.send, reverb.input()) === 1, 'send should connect to the current input on activation')
  assert(quiet.send._outputs.length === 1, 'send should have exactly one output after activation')
  assert(reachable(quiet.input, reverb.output()), 'send should be audible after activation')

  quiet.destroy()
})

// Teardown and summary

for (const send of [send1, sendA, sendB, sendC]) {
  send.destroy()
}

if (failures) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
} else {
  console.log('\nAll tests passed')
}
