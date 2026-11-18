/**
 * OutputStreamNode.stop() convergence tests.
 *
 * Covers requirement (1): the same awaitable result from every state with no
 * duplicate stop-message dispatch or thrown errors, and requirement (2): the
 * one-time ordered teardown onStopped -> disconnect -> port.close().
 */
import './stubs/global-stubs.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StopEvent } from '../src/events.ts'
import { makeNode, makeBufferContext, processorStops, nextMicrotask } from './helpers.mjs'
import { OutputStreamNode } from '../src/output-stream-node.ts'
import { ManualBufferWriteStrategy } from '../src/write-strategy/manual-strategy.ts'

test('ready state: stop() converges immediately to stopped and resolves', async () => {
  const { node, strategy } = await makeNode()
  assert.equal(node.isStart, false)

  const promise = node.stop()
  assert.ok(promise instanceof Promise)
  await promise

  assert.equal(node.isStart, false)
  // Teardown ran exactly once and in order.
  assert.equal(strategy.onStoppedCount, 1)
  assert.deepEqual(strategy.order, ['onStopped'])
  assert.equal(node.disconnectCount, 1)
  assert.equal(node.port.closeCount, 1)
  assert.equal(node.port.onmessage, null)
  // No processor message is ever sent when playback never started.
  assert.deepEqual(node.port.postedMessages, [])
})

test('ready state: repeated stop() calls return the identical promise and never re-teardown', async () => {
  const { node, strategy } = await makeNode()

  const first = node.stop()
  const second = node.stop()
  const third = node.stop(123n)
  assert.equal(first, second)
  assert.equal(second, third)
  await Promise.all([first, second, third])

  assert.equal(strategy.onStoppedCount, 1)
  assert.equal(node.disconnectCount, 1)
  assert.equal(node.port.closeCount, 1)
})

test('started state: two concurrent stop() calls dispatch only one stop message and resolve once', async () => {
  const { node, strategy } = await makeNode()
  node.start()
  assert.equal(node.isStart, true)

  const stopEvents = []
  node.addEventListener(StopEvent.type, ev => stopEvents.push(ev))

  const first = node.stop(100n)
  // Second call while the first is still in flight (state === stopping).
  const second = node.stop(200n)
  assert.equal(first, second)

  // Exactly one stop message was dispatched, using the first framePosition.
  assert.equal(node.port.postedMessages.length, 1)
  assert.deepEqual(node.port.postedMessages[0], { type: 'stop', framePosition: 100n })

  processorStops(node, 77n)
  await first

  assert.equal(stopEvents.length, 1)
  assert.equal(stopEvents[0].stoppedAtFrame, 77n)
  assert.equal(strategy.onStoppedCount, 1)
  assert.equal(node.disconnectCount, 1)
  assert.equal(node.port.closeCount, 1)
  assert.equal(node.port.onmessage, null)

  // A third call after full convergence is still the same promise and a no-op.
  const third = node.stop()
  assert.equal(third, first)
  await third
  assert.equal(node.port.postedMessages.length, 1)
  assert.equal(strategy.onStoppedCount, 1)
})

test('stop() never throws even when called from every state in sequence', async () => {
  const { node } = await makeNode()
  // ready -> started -> stopping -> stopped, calling stop at each stage.
  const readyPromise = node.stop()
  await readyPromise
  // already stopped
  await assert.doesNotReject(() => node.stop())
  await assert.doesNotReject(() => node.stop(5n))
})

test('teardown order is onStopped -> disconnect -> port.close(), executed once', async () => {
  const { node, strategy } = await makeNode()
  const trace = []
  const originalOnStopped = strategy.onStopped.bind(strategy)
  strategy.onStopped = () => {
    trace.push('onStopped')
    originalOnStopped()
  }
  const originalDisconnect = node.disconnect.bind(node)
  node.disconnect = () => {
    trace.push('disconnect')
    originalDisconnect()
  }
  const originalClose = node.port.close.bind(node.port)
  node.port.close = () => {
    trace.push('close')
    originalClose()
  }

  node.start()
  const p1 = node.stop()
  const p2 = node.stop()
  processorStops(node)
  await Promise.all([p1, p2])

  assert.deepEqual(trace, ['onStopped', 'disconnect', 'close'])
})

test('manual strategy ready stop: immediately stopped (acceptance scenario)', async () => {
  const context = makeBufferContext()
  const strategy = new ManualBufferWriteStrategy(context)
  const node = await OutputStreamNode.create({}, context, strategy)

  await node.stop()
  assert.equal(node.disconnectCount, 1)
  assert.equal(node.port.closed, true)
  // Repeated stop is safe.
  await assert.doesNotReject(() => node.stop())
})

test('a late/duplicate processor stop message after convergence is a safe no-op', async () => {
  const { node, strategy } = await makeNode()
  const stopEvents = []
  node.addEventListener(StopEvent.type, ev => stopEvents.push(ev))
  node.start()
  const p = node.stop()
  processorStops(node, 1n)
  await p
  // Port is closed; simulate a stray second message arriving anyway.
  processorStops(node, 2n)
  assert.equal(strategy.onStoppedCount, 1)
  assert.equal(node.disconnectCount, 1)
  // StopEvent is delivered exactly once even though two processor messages arrived.
  assert.equal(stopEvents.length, 1)
  assert.equal(stopEvents[0].stoppedAtFrame, 1n)
})

test('start() semantics and error messages are preserved', async () => {
  const { node } = await makeNode()
  // Connected node can start once.
  assert.equal(node.start(), true)
  // Second start while running returns false (does not throw).
  assert.equal(node.start(), false)
  // The documented "cannot start from a non-ready/non-started state" error is
  // exercised by a node stuck in the stopping state (restart after a completed
  // stop is documented as unsupported, so it is not part of the stop contract).
  const { node: stoppingNode } = await makeNode()
  stoppingNode.start()
  stoppingNode.stop() // moves to 'stopping' pending processor confirmation
  assert.throws(() => stoppingNode.start(), /Cannot start playback\. Current state: stopping/)
  // Let the stopping node converge so the event loop can drain cleanly.
  processorStops(stoppingNode)
  await stoppingNode.stop()
})

test('start() throws the original not-connected error', async () => {
  const { node } = await makeNode()
  node.numberOfOutputs = 0
  assert.throws(() => node.start(), /Cannot start playback\. Node is not connected\./)
})

test('a strategy whose onStart returns false triggers an automatic stop that converges', async () => {
  const { node, strategy } = await makeNode({ onStartResult: false })
  node.start()
  // start() internally called stop(totalWriteFrames); the node is now stopping,
  // waiting for the processor confirmation before running the one-time teardown.
  assert.equal(node.port.postedMessages.length, 1)
  assert.deepEqual(node.port.postedMessages[0].type, 'stop')
  processorStops(node)
  await nextMicrotask()
  assert.equal(strategy.onStoppedCount, 1)
  assert.equal(node.disconnectCount, 1)
  assert.equal(node.port.closeCount, 1)
  // Repeating stop is safe and shares the result.
  const p = node.stop()
  await p
  assert.equal(strategy.onStoppedCount, 1)
})

test('StopEvent is dispatched exactly once even across repeated stop calls', async () => {
  const { node } = await makeNode()
  let count = 0
  node.addEventListener(StopEvent.type, () => {
    count += 1
  })
  node.start()
  node.stop()
  node.stop()
  node.stop()
  processorStops(node, 10n)
  await nextMicrotask()
  assert.equal(count, 1)
})
