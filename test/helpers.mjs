/**
 * Shared helpers for the local stop-convergence tests.
 */
import { createFrameBufferContext } from '@ain1084/audio-frame-buffer'
import { OutputStreamNode } from '../src/output-stream-node.ts'

/**
 * Build a real shared frame-buffer context (SharedArrayBuffer backed).
 * @param {number} [channelCount=2]
 * @param {number} [frameCount=1024]
 */
export function makeBufferContext(channelCount = 2, frameCount = 1024) {
  return createFrameBufferContext({ channelCount, frameCount })
}

/**
 * A strategy that records every lifecycle call.
 */
export class RecordingStrategy {
  constructor({ onStartResult = true } = {}) {
    this.onStartResult = onStartResult
    this.onInitCount = 0
    this.onStartCount = 0
    this.onStoppedCount = 0
    /** @type {string[]} ordered trace of teardown-relevant calls */
    this.order = []
  }

  async onInit() {
    this.onInitCount += 1
    return true
  }

  onStart() {
    this.onStartCount += 1
    return this.onStartResult
  }

  onStopped() {
    this.onStoppedCount += 1
    this.order.push('onStopped')
  }
}

/**
 * Create an OutputStreamNode wired to a recording strategy.
 * @param {object} [opts]
 */
export async function makeNode(opts = {}) {
  const context = makeBufferContext()
  const strategy = new RecordingStrategy(opts)
  const node = await OutputStreamNode.create({}, context, strategy)
  return { node, strategy, context }
}

/**
 * Simulate the AudioWorkletProcessor confirming it has stopped.
 * @param {import('../src/output-stream-node.ts').OutputStreamNode} node
 * @param {bigint} [totalProcessedFrames=0n]
 */
export function processorStops(node, totalProcessedFrames = 0n) {
  node.port.emit({ type: 'stop', totalProcessedFrames })
}

export const nextMicrotask = () => new Promise(resolve => setImmediate(resolve))
