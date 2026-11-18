/**
 * Worker-side BufferFillWorker tests.
 *
 * Verifies that when the FrameBufferFiller returns false (playback exhausted),
 * the worker clears its filling interval timer so no further fills happen, and
 * posts a single stop message to the main thread.
 */
import './stubs/global-stubs.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BufferFillWorker } from '../src/write-strategy/worker/worker.ts'
import { createFillerFrameBufferContext } from '../src/filler-frame-buffer-context.ts'

// Minimal worker-global shims used by BufferFillWorker.
const posted = []
const timers = new Map()
let timerSeq = 0

globalThis.self = globalThis
globalThis.postMessage = (message) => {
  posted.push(message)
}
globalThis.setInterval = (fn, ms) => {
  const id = ++timerSeq
  timers.set(id, { fn, ms })
  return id
}
globalThis.clearInterval = (id) => {
  timers.delete(id)
}

/**
 * Filler whose first fill returns true once, then false forever.
 */
class ExhaustingFiller {
  constructor() {
    this.fillCount = 0
  }

  fill(writer) {
    this.fillCount += 1
    // Consume whatever capacity is offered without writing real samples.
    writer.write(segment => segment.frameCount)
    return this.fillCount === 1
  }
}

function makeConfig() {
  return createFillerFrameBufferContext({
    channelCount: 1,
    sampleRate: 8000,
    fillInterval: 5,
  })
}

test('filler returning false clears the interval and posts exactly one stop', async () => {
  posted.length = 0
  timers.clear()
  const worker = new BufferFillWorker(ExhaustingFiller)

  // init constructs the Context and performs the initial (constructor) fill.
  const config = makeConfig()
  await worker.handleMessage({ data: { type: 'init', config, fillerParams: {} } })
  assert.equal(posted[0].type, 'init-done')

  // start arms the interval timer.
  worker.handleMessage({ data: { type: 'start' } })
  assert.equal(timers.size, 1)
  const timerId = [...timers.keys()][0]

  // Fire the interval once: filler returns false -> stop posted and timer cleared.
  timers.get(timerId).fn()
  assert.equal(posted.filter(m => m.type === 'stop').length, 1)
  assert.equal(timers.size, 0, 'filling interval must be cleared when filler returns false')

  // Re-firing is impossible once cleared; simulate a manual stop message too.
  assert.doesNotThrow(() => worker.handleMessage({ data: { type: 'stop' } }))
  assert.equal(posted.filter(m => m.type === 'stop').length, 1)
})

test('handleMessage rejects unknown message types', async () => {
  const worker = new BufferFillWorker(ExhaustingFiller)
  // handleMessage is async, so an unknown type surfaces as a rejected promise.
  await assert.rejects(
    () => worker.handleMessage({ data: { type: 'bogus' } }),
    /Unknown message type/,
  )
})
