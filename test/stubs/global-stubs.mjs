/**
 * Browser-global stubs so the library sources can run under plain Node.
 *
 * The production code targets AudioWorklet/Worker browser environments. These
 * minimal fakes stand in for the browser pieces the tests exercise; they do NOT
 * alter any library behaviour. Each fake records the interactions the tests
 * assert on (posted stop messages, disconnect/close/terminate calls, timers).
 */

/**
 * Minimal MessageEvent-like object delivered to onmessage / addEventListener.
 */
class FakeMessageEvent {
  /**
   * @param {unknown} data - The message payload.
   */
  constructor(data) {
    this.data = data
  }
}

/**
 * Stand-in for a Worker instance. It records every posted message and the
 * terminate() call instead of running a real worker thread.
 */
class FakeWorker {
  static instances = []

  constructor() {
    /** @type {Array<unknown>} */
    this.postedMessages = []
    /** @type {((ev: FakeMessageEvent) => void) | null} */
    this.onmessage = null
    this.terminateCount = 0
    this.terminated = false
    /** @type {Array<(ev: FakeMessageEvent) => void>} */
    this._listeners = []
    FakeWorker.instances.push(this)
  }

  /**
   * @param {unknown} message
   */
  postMessage(message) {
    this.postedMessages.push(message)
    // Simulate the real worker's asynchronous init handshake.
    if (message && message.type === 'init') {
      setImmediate(() => this.emit({ type: 'init-done' }))
    }
  }

  terminate() {
    this.terminateCount += 1
    this.terminated = true
  }

  /**
   * @param {string} type
   * @param {(ev: FakeMessageEvent) => void} listener
   */
  addEventListener(type, listener) {
    if (type === 'message') {
      this._listeners.push(listener)
    }
  }

  /**
   * @param {string} type
   * @param {(ev: FakeMessageEvent) => void} listener
   */
  removeEventListener(type, listener) {
    if (type === 'message') {
      this._listeners = this._listeners.filter(item => item !== listener)
    }
  }

  /**
   * Test helper: deliver a message as if it came from the worker thread.
   * @param {unknown} data
   */
  emit(data) {
    const event = new FakeMessageEvent(data)
    this.onmessage?.(event)
    for (const listener of [...this._listeners]) {
      listener(event)
    }
  }

  static reset() {
    FakeWorker.instances = []
  }
}

/**
 * Stand-in for the AudioWorkletNode message port.
 */
class FakeMessagePort {
  constructor() {
    /** @type {((ev: FakeMessageEvent) => void) | null} */
    this.onmessage = null
    /** @type {Array<unknown>} */
    this.postedMessages = []
    this.closeCount = 0
    this.closed = false
  }

  /**
   * @param {unknown} message
   */
  postMessage(message) {
    this.postedMessages.push(message)
  }

  close() {
    this.closeCount += 1
    this.closed = true
  }

  /**
   * Test helper: simulate the processor sending a message back to the node.
   * @param {unknown} data
   */
  emit(data) {
    this.onmessage?.(new FakeMessageEvent(data))
  }
}

/**
 * Minimal AudioWorkletNode fake built on the real EventTarget so the node's
 * addEventListener/dispatchEvent (used for StopEvent) behaves natively.
 */
class FakeAudioWorkletNode extends EventTarget {
  /**
   * @param {unknown} _context
   * @param {string} _name
   * @param {{ outputChannelCount: number[], processorOptions: unknown }} options
   */
  constructor(_context, _name, options) {
    super()
    this._options = options
    this.numberOfOutputs = 1
    this.port = new FakeMessagePort()
    this.disconnectCount = 0
    this.disconnected = false
    this.context = _context
  }

  disconnect() {
    this.disconnectCount += 1
    this.disconnected = true
  }

  connect() {
    this.numberOfOutputs = 1
  }
}

// window is referenced directly by the timed strategy (window.setInterval).
const windowRef = globalThis

globalThis.FakeMessageEvent = FakeMessageEvent
globalThis.FakeWorker = FakeWorker
globalThis.FakeMessagePort = FakeMessagePort
globalThis.FakeAudioWorkletNode = FakeAudioWorkletNode
globalThis.AudioWorkletNode = FakeAudioWorkletNode
globalThis.Worker = FakeWorker
globalThis.MessageEvent = FakeMessageEvent
globalThis.window = windowRef

export { FakeWorker, FakeMessageEvent, FakeAudioWorkletNode, FakeMessagePort }
