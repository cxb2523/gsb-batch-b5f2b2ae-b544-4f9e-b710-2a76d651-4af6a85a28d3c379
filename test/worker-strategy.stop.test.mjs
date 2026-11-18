/**
 * WorkerBufferWriteStrategy stop-convergence tests.
 *
 * Covers requirement (3): onStopped terminates the worker and clears internal
 * context, and a filler-driven automatic stop racing with an external stop()
 * neither terminates the worker twice nor leaves a timer/worker behind.
 */
import './stubs/global-stubs.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorker } from './stubs/global-stubs.mjs'
import { WorkerBufferWriteStrategy } from '../src/write-strategy/worker-strategy.ts'
import { createFillerFrameBufferContext } from '../src/filler-frame-buffer-context.ts'
import { makeBufferContext, processorStops, nextMicrotask } from './helpers.mjs'
import { OutputStreamNode } from '../src/output-stream-node.ts'

function makeFillerConfig() {
  return createFillerFrameBufferContext({
    channelCount: 2,
    sampleRate: 48000,
    fillInterval: 10,
  })
}

async function makeWorkerNode() {
  FakeWorker.reset()
  const bufferContext = makeBufferContext()
  const config = makeFillerConfig()
  const strategy = new WorkerBufferWriteStrategy(config, FakeWorker, { note: 'params' })
  const node = await OutputStreamNode.create({}, bufferContext, strategy)
  const worker = FakeWorker.instances[0]
  assert.ok(worker instanceof FakeWorker)
  return { node, strategy, worker }
}

test('onInit spawns a worker and exchanges the init handshake', async () => {
  const { worker } = await makeWorkerNode()
  assert.equal(worker.postedMessages[0].type, 'init')
})

test('ready stop: worker is terminated exactly once and context is cleared', async () => {
  const { node, worker } = await makeWorkerNode()
  await node.stop()
  assert.equal(worker.terminated, true)
  assert.equal(worker.terminateCount, 1)
  assert.equal(worker.onmessage, null)
  assert.equal(node.port.closed, true)

  // Repeated stop must not terminate again and must not throw.
  await assert.doesNotReject(() => node.stop())
  await node.stop()
  assert.equal(worker.terminateCount, 1)
})

test('started + two stop calls: worker terminated once and no error', async () => {
  const { node, worker } = await makeWorkerNode()
  node.start()
  assert.equal(worker.postedMessages.at(-1).type, 'start')

  const p1 = node.stop(10n)
  const p2 = node.stop(10n)
  assert.equal(p1, p2)
  // Worker is torn down only when the processor confirms stop (finalizeStopped).
  processorStops(node)
  await p1

  assert.equal(worker.terminateCount, 1)
  await assert.doesNotReject(() => node.stop())
  assert.equal(worker.terminateCount, 1)
})

test('filler returns false (worker auto-stop) then external stop(): single termination, no error', async () => {
  const { node, worker } = await makeWorkerNode()
  node.start()

  // Worker posts its 'stop' message because its filler returned false.
  worker.emit({ type: 'stop', stopFrames: 128n })
  await nextMicrotask()

  // The auto-stop moved the node to stopping and posted exactly one processor stop.
  assert.equal(node.port.postedMessages.length, 1)
  assert.deepEqual(node.port.postedMessages[0], { type: 'stop', framePosition: 128n })

  // External stop while the processor stop confirmation is still in flight.
  const external = node.stop()
  const again = node.stop()
  assert.equal(external, again)
  assert.equal(node.port.postedMessages.length, 1) // still only one dispatch

  processorStops(node)
  await external

  assert.equal(worker.terminated, true)
  assert.equal(worker.terminateCount, 1)
  // Further stops remain safe.
  await node.stop()
  assert.equal(worker.terminateCount, 1)
})

test('worker auto-stop and an immediate external stop before processor confirmation converge once', async () => {
  const { node, worker } = await makeWorkerNode()
  node.start()
  worker.emit({ type: 'stop', stopFrames: 0n })
  // No await between auto-stop and external stop.
  const p = node.stop()
  processorStops(node)
  await p
  assert.equal(worker.terminateCount, 1)
  assert.equal(node.disconnectCount, 1)
  assert.equal(node.port.closeCount, 1)
})

test('a stray worker stop message after convergence cannot dispatch another processor stop', async () => {
  const { node, worker } = await makeWorkerNode()
  node.start()
  const p = node.stop()
  processorStops(node)
  await p
  assert.equal(worker.terminated, true)
  assert.equal(node.port.postedMessages.length, 1)

  // After termination the strategy detached onmessage; even if a stray event is
  // force-delivered, the node must not post another processor stop message.
  assert.equal(worker.onmessage, null)
  worker.emit({ type: 'stop', stopFrames: 999n })
  assert.equal(node.port.postedMessages.length, 1)
  assert.equal(node.disconnectCount, 1)
})

test('strategy.onStopped is idempotent when invoked directly and repeatedly', async () => {
  FakeWorker.reset()
  const config = makeFillerConfig()
  const strategy = new WorkerBufferWriteStrategy(config, FakeWorker, {})
  const bufferContext = makeBufferContext()
  const node = await OutputStreamNode.create({}, bufferContext, strategy)
  const worker = FakeWorker.instances[0]

  // Drive through a normal stop so the strategy's context exists and is torn down.
  node.start()
  const p = node.stop()
  processorStops(node)
  await p
  assert.equal(worker.terminateCount, 1)

  // Calling onStopped again directly must be a no-op rather than throw.
  assert.doesNotThrow(() => strategy.onStopped())
  assert.doesNotThrow(() => strategy.onStopped())
  assert.equal(worker.terminateCount, 1)
})
