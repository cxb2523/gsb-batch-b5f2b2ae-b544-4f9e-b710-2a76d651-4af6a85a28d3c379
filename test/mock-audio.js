/**
 * Minimal mock of the Web Audio API, sufficient to exercise the
 * RScheduledSource lifecycle (instantiate -> schedule -> ended -> rebuild)
 * outside of a browser.
 *
 * The mocks record every call so tests can assert that e.g. `start` is never
 * called on a stopped node and that rebuilt nodes receive the current props.
 */

class MockAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.calls = {
      setValueAtTime: [],
      linearRampToValueAtTime: [],
      exponentialRampToValueAtTime: []
    };
  }

  setValueAtTime(value, time) {
    this.value = value;
    this.calls.setValueAtTime.push([ value, time ]);
  }

  linearRampToValueAtTime(value, time) {
    this.value = value;
    this.calls.linearRampToValueAtTime.push([ value, time ]);
  }

  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this.calls.exponentialRampToValueAtTime.push([ value, time ]);
  }
}

class MockAudioNode {
  constructor(context) {
    this.context = context;
    this.connections = [];
    this.disconnectCount = 0;
    this._listeners = {};
  }

  connect(...args) {
    this.connections.push(args);
  }

  disconnect() {
    this.disconnectCount++;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }

  removeEventListener(type, fn) {
    const listeners = this._listeners[type];
    if (listeners) this._listeners[type] = listeners.filter(f => f !== fn);
  }

  listenerCount(type) {
    return (this._listeners[type] || []).length;
  }

  dispatchEvent(event) {
    (this._listeners[event.type] || []).slice().forEach(fn => fn(event));
  }

  // test helper: simulate the browser firing `ended` on this node
  fireEnded() {
    this.dispatchEvent({ type: 'ended', target: this });
  }
}

// A scheduled source is single-use: start() may only be called once,
// mimicking the real InvalidStateError.
class MockScheduledSourceNode extends MockAudioNode {
  constructor(context) {
    super(context);
    this._started = false;
    this.startCalls = [];
    this.stopCalls = [];
  }

  start(...args) {
    if (this._started) {
      throw new Error('InvalidStateError: start() called more than once on the same node');
    }
    this._started = true;
    this.startCalls.push(args);
  }

  stop(...args) {
    this.stopCalls.push(args);
  }
}

class MockOscillatorNode extends MockScheduledSourceNode {
  constructor(context) {
    super(context);
    this.frequency = new MockAudioParam(440);
    this.detune = new MockAudioParam(0);
    this.type = 'sine';
    this.periodicWaves = [];
  }

  setPeriodicWave(wave) {
    this.periodicWaves.push(wave);
  }
}

class MockBufferSourceNode extends MockScheduledSourceNode {
  constructor(context) {
    super(context);
    this.buffer = null;
    this.detune = new MockAudioParam(0);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new MockAudioParam(1);
  }
}

class MockConstantSourceNode extends MockScheduledSourceNode {
  constructor(context) {
    super(context);
    this.offset = new MockAudioParam(1);
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = new MockAudioNode(this);
    this.created = { oscillator: 0, bufferSource: 0, constantSource: 0 };
  }

  createOscillator() {
    this.created.oscillator++;
    return new MockOscillatorNode(this);
  }

  createBufferSource() {
    this.created.bufferSource++;
    return new MockBufferSourceNode(this);
  }

  createConstantSource() {
    this.created.constantSource++;
    return new MockConstantSourceNode(this);
  }
}

// The r-audio source modules read `window.AudioContext` and the global
// `AudioParam` at module load / runtime, so install the mocks as globals
// *before* requiring any of the compiled modules.
function installGlobals() {
  global.window = { AudioContext: MockAudioContext };
  global.AudioContext = MockAudioContext;
  global.AudioParam = MockAudioParam;
}

module.exports = {
  installGlobals,
  MockAudioContext,
  MockAudioNode,
  MockAudioParam,
  MockOscillatorNode,
  MockBufferSourceNode,
  MockConstantSourceNode
};
