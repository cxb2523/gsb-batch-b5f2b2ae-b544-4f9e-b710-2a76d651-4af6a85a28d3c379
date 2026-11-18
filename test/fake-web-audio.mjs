// Minimal fake browser surface for running src/player.js under `node --test`.
// It implements just enough of AudioContext / HTMLAudioElement / timers for the
// transition lifecycle to be exercised deterministically. No real audio.

export class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  cancelScheduledValues(at) {
    this.events.push(["cancel", at]);
  }
  cancelAndHoldAtTime(at) {
    this.events.push(["hold", at]);
  }
  setValueAtTime(value, at) {
    this.value = value;
    this.events.push(["set", value, at]);
  }
  linearRampToValueAtTime(value, at) {
    this.value = value;
    this.events.push(["ramp", value, at]);
  }
  setValueCurveAtTime(curve, at, duration) {
    this.value = curve[curve.length - 1];
    this.events.push(["curve", at, duration]);
  }
}

class FakeNode {
  constructor() {
    this.connected = [];
  }
  connect(target) {
    this.connected.push(target);
    return target;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeParam(1);
  }
}

class FakeFilter extends FakeNode {
  constructor() {
    super();
    this.type = "peaking";
    this.frequency = new FakeParam(0);
    this.Q = new FakeParam(0);
    this.gain = new FakeParam(0);
  }
}

class FakeAnalyser extends FakeNode {
  constructor() {
    super();
    this.fftSize = 512;
    this.frequencyBinCount = 256;
  }
  getByteFrequencyData() {}
}

export class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.error = null;
    this.paused = true;
    this.src = "";
    this.currentTime = 0;
    this.duration = 300;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.crossOrigin = "";
    this.preload = "";
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  emit(type) {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
  pause() {
    this.paused = true;
  }
  play() {
    const failing = FakeAudio.failFor(this.src);
    if (failing) return Promise.reject(new Error("fake media error"));
    const gate = FakeAudio.pendingPlay.get(this.src);
    if (gate) {
      FakeAudio.pendingPlay.delete(this.src);
      return gate.promise.then(() => {
        this.paused = false;
      });
    }
    this.paused = false;
    return Promise.resolve();
  }
}

// Test hook: reject play() for matching src substrings.
FakeAudio.failingSrcs = [];
FakeAudio.failFor = (src) => FakeAudio.failingSrcs.some((part) => String(src).includes(part));
// Test hook: make play() for a matching src wait on a deferred.
FakeAudio.pendingPlay = new Map();

export class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.destination = new FakeNode();
    this.t = 0;
  }
  get currentTime() {
    return this.t;
  }
  async resume() {}
  createGain() {
    return new FakeGain();
  }
  createBiquadFilter() {
    return new FakeFilter();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createDynamicsCompressor() {
    const node = new FakeNode();
    node.threshold = new FakeParam(-24);
    node.knee = new FakeParam(30);
    node.ratio = new FakeParam(12);
    node.attack = new FakeParam(0.003);
    node.release = new FakeParam(0.25);
    return node;
  }
  createMediaElementSource() {
    return new FakeNode();
  }
}

// Deterministic timer surface. Callbacks are queued by id and fired by hand.
export class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
  }
  // Public setTimeout for tests that need a raw deferred.
  static deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timeouts.set(id, { fn, ms });
    return id;
  }
  clearTimeout(id) {
    this.timeouts.delete(id);
  }
  setInterval(fn, ms) {
    const id = this.nextId++;
    this.intervals.set(id, { fn, ms });
    return id;
  }
  clearInterval(id) {
    this.intervals.delete(id);
  }
  fireAllTimeouts() {
    const entries = [...this.timeouts.entries()];
    this.timeouts.clear();
    for (const [, entry] of entries) entry.fn();
  }
  fireAllIntervals() {
    for (const entry of this.intervals.values()) entry.fn();
  }
  // A play() promise that resolves only when the test releases it, to model a
  // slow deck load.
  static deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  // Snapshot and remove pending timeout callbacks (so a test can replay a timer
  // that production code already cancelled).
  takeTimeouts() {
    const entries = [...this.timeouts.values()].map((entry) => entry.fn);
    this.timeouts.clear();
    return entries;
  }
  get pendingTimeoutCount() {
    return this.timeouts.size;
  }
  reset() {
    this.timeouts.clear();
    this.intervals.clear();
  }
}

// Install the fakes as globals; returns the timer harness.
export function installFakeBrowser() {
  const timers = new FakeTimers();
  globalThis.__fakeTimers = timers;
  globalThis.window = {
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (id) => timers.clearTimeout(id),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (id) => timers.clearInterval(id)
  };
  globalThis.Audio = FakeAudio;
  globalThis.AudioContext = FakeAudioContext;
  return timers;
}

export function uninstallFakeBrowser() {
  delete globalThis.window;
  delete globalThis.Audio;
  delete globalThis.AudioContext;
  delete globalThis.__fakeTimers;
}
