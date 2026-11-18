/**
 * A minimal mock of the Web Audio API (and related browser globals)
 * so syngen's mixer and reverb modules can be exercised in Node.
 *
 * Nodes record their outgoing connections in `_outputs`, which tests
 * use to assert graph connectivity. Like the real API, connecting the
 * same pair of nodes twice results in a single connection.
 */
'use strict'

class MockAudioParam {
  constructor(value = 0) {
    this.value = value
  }

  cancelScheduledValues() {
    return this
  }

  exponentialRampToValueAtTime(value) {
    this.value = value
    return this
  }

  linearRampToValueAtTime(value) {
    this.value = value
    return this
  }

  setTargetAtTime(value) {
    this.value = value
    return this
  }

  setValueAtTime(value) {
    this.value = value
    return this
  }
}

class MockAudioNode {
  constructor(context, type) {
    this.context = context
    this.type = type
    this._outputs = []
  }

  connect(destination) {
    if (!this._outputs.includes(destination)) {
      this._outputs.push(destination)
    }

    return destination
  }

  disconnect(destination) {
    if (destination === undefined) {
      this._outputs = []
    } else {
      this._outputs = this._outputs.filter((node) => node !== destination)
    }
  }
}

class MockAudioBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
    this._data = []

    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      this._data.push(new Float32Array(length))
    }
  }

  getChannelData(channel) {
    return this._data[channel]
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0
    this.sampleRate = 44100
    this.destination = new MockAudioNode(this, 'destination')
  }

  createBiquadFilter() {
    const node = new MockAudioNode(this, 'biquadFilter')
    node.frequency = new MockAudioParam(350)
    node.gain = new MockAudioParam(0)
    node.Q = new MockAudioParam(1)
    node.type = 'lowpass'
    return node
  }

  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(channels, length, sampleRate)
  }

  createConvolver() {
    const node = new MockAudioNode(this, 'convolver')
    node.buffer = null
    return node
  }

  createDelay() {
    const node = new MockAudioNode(this, 'delay')
    node.delayTime = new MockAudioParam(0)
    return node
  }

  createDynamicsCompressor() {
    const node = new MockAudioNode(this, 'dynamicsCompressor')
    node.attack = new MockAudioParam(0.003)
    node.knee = new MockAudioParam(30)
    node.ratio = new MockAudioParam(12)
    node.release = new MockAudioParam(0.25)
    node.threshold = new MockAudioParam(-24)
    return node
  }

  createGain() {
    const node = new MockAudioNode(this, 'gain')
    node.gain = new MockAudioParam(1)
    return node
  }
}

/**
 * Returns a sandbox object suitable for `vm.createContext()` that
 * provides every browser global the loaded syngen modules touch.
 */
function createSandbox() {
  const sandbox = {
    AudioBuffer: MockAudioBuffer,
    AudioContext: MockAudioContext,
    console,
    document: {
      addEventListener: () => {},
      hidden: false,
    },
    performance,
    // The main loop is never started in tests; these exist so modules can load
    cancelAnimationFrame: clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 16),
    setTimeout,
    clearTimeout,
  }

  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window = sandbox

  return sandbox
}

module.exports = {
  createSandbox,
  MockAudioBuffer,
  MockAudioContext,
  MockAudioNode,
  MockAudioParam,
}
