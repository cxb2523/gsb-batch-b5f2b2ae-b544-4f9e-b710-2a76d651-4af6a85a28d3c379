/**
 * Post-stop quiescence and timed-strategy timer tests.
 *
 * Acceptance: after stop completes, totalReadFrames must not grow and the timed
 * filling interval must be cleared (no further filler calls / writes).
 */
import './stubs/global-stubs.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TimedBufferWriteStrategy } from '../src/write-strategy/timed-strategy.ts'
import { createFillerFrameBufferContext } from '../src/filler-frame-buffer-context.ts'
import { OutputStreamNode } from '../src/output-stream-node.ts'
import { FrameBufferReader } from '@ain1084/audio-frame-buffer'
import { processorStops } from './helpers.mjs'

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

function makeConfig() {
  return createFillerFrameBufferContext({
    channelCount: 1,
    sampleRate: 8000,
    fillInterval: 5,
  })
}

/**
 * Filler that fully writes each offered segment and reports call counts.
 */
class CountingFiller {
  constructor() {
    this.calls = 0
  }

  fill(writer) {
    this.calls += 1
    writer.write(segment => segment.frameCount)
    return true
  }
}

test('after stop, totalReadFrames stays fixed and no timed fills continue', async () => {
  const intervals = new Map()
  let seq = 0
  globalThis.setInterval = (fn, ms) => {
    const id = ++seq
    intervals.set(id, { fn, ms })
    return id
  }
  const cleared = []
  globalThis.clearInterval = (id) => {
    cleared.push(id)
    intervals.delete(id)
  }

  try {
    const filler = new CountingFiller()
    const config = makeConfig()
    const strategy = new TimedBufferWriteStrategy(config, filler)
    // The node and the (processor stand-in) reader share the same buffer context.
    const node = await OutputStreamNode.create({}, config, strategy)
    const reader = new FrameBufferReader(config)

    const before = filler.calls // constructor performs one priming fill
    assert.ok(before >= 1)

    node.start()
    assert.equal(intervals.size, 1, 'start must arm exactly one filling interval')
    const timerId = [...intervals.keys()][0]

    // A couple of fills while running, then consume frames like the worklet would.
    intervals.get(timerId).fn()
    intervals.get(timerId).fn()
    const callsWhileRunning = filler.calls
    assert.ok(callsWhileRunning > before)
    const consumed = reader.read(segment => segment.frameCount)
    assert.ok(consumed > 0)
    const readBeforeStop = node.totalReadFrames
    assert.ok(readBeforeStop > 0n)

    // Stop and let convergence complete.
    const p = node.stop()
    processorStops(node)
    await p

    assert.equal(intervals.size, 0, 'filling interval must be cleared on stop')
    assert.deepEqual(cleared, [timerId])

    // No live timer can fire now; the node no longer reports a running stream.
    assert.equal(node.isStart, false)

    // Repeated stop is a no-op and the read counter remains frozen.
    await node.stop()
    await node.stop()
    assert.equal(node.totalReadFrames, readBeforeStop, 'totalReadFrames must not grow after stop')
    assert.equal(filler.calls, callsWhileRunning, 'no further filler calls after stop')
  }
  finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('timed filler returning false during an interval tick auto-stops and clears its timer once', async () => {
  const intervals = new Map()
  let seq = 0
  globalThis.setInterval = (fn, ms) => {
    const id = ++seq
    intervals.set(id, { fn, ms })
    return id
  }
  globalThis.clearInterval = (id) => {
    intervals.delete(id)
  }

  try {
    // Priming fill (constructor) succeeds, so onStart arms the interval;
    // the first interval tick then returns false to exhaust playback.
    const filler = {
      calls: 0,
      fill(writer) {
        this.calls += 1
        writer.write(segment => segment.frameCount)
        return this.calls === 1
      },
    }
    const config = makeConfig()
    const strategy = new TimedBufferWriteStrategy(config, filler)
    const node = await OutputStreamNode.create({}, config, strategy)

    node.start()
    assert.equal(intervals.size, 1, 'onStart arms the filling interval after a successful prime')
    const timerId = [...intervals.keys()][0]

    // Interval tick sees fill() === false -> node.stop(totalFrames) and timer cleanup.
    intervals.get(timerId).fn()
    assert.equal(node.port.postedMessages.length, 1, 'auto-stop dispatches one processor stop')
    assert.deepEqual(node.port.postedMessages[0].type, 'stop')

    // Converge via the processor confirmation; everything is torn down once.
    processorStops(node)
    await node.stop()
    assert.equal(intervals.size, 0)
    assert.equal(node.disconnectCount, 1)
    assert.equal(node.port.closeCount, 1)
    await node.stop() // idempotent
    assert.equal(node.disconnectCount, 1)
  }
  finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})
