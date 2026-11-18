import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

const { PreviewMountController, MAX_RETRIES, MIN_HOST_EDGE } =
  await vite.ssrLoadModule(
    '/src/lib/volume/three-preview/mount-controller.ts',
  );
const threePreviewModule = await vite.ssrLoadModule(
  '/src/lib/volume/three-preview/index.ts',
);

/**
 * Yields a macrotask so every pending promise reaction (including async
 * factory rejections and the controller's `.catch` chain) drains fully.
 */
function settlePromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeScheduler() {
  const frames = [];
  const timers = new Map();
  let frameHandle = 1;
  let timerHandle = 1;
  let observerCount = 0;
  const observers = [];

  return {
    frames,
    timers,
    observers,
    stats() {
      return { observerCount };
    },
    flushFrames() {
      const pending = frames.splice(0);
      for (const entry of pending) entry.callback();
    },
    runTimer(handle) {
      const entry = timers.get(handle);
      if (!entry) return false;
      timers.delete(handle);
      entry.callback();
      return true;
    },
    scheduler: {
      requestFrame(callback) {
        const handle = frameHandle++;
        frames.push({ handle, callback });
        return handle;
      },
      cancelFrame(handle) {
        const index = frames.findIndex((entry) => entry.handle === handle);
        if (index >= 0) frames.splice(index, 1);
      },
      setTimeout(callback, delayMs) {
        const handle = timerHandle++;
        timers.set(handle, { callback, delayMs });
        return handle;
      },
      clearTimeout(handle) {
        timers.delete(handle);
      },
      createResizeObserver(callback) {
        observerCount += 1;
        const observer = {
          connected: false,
          callback,
          observe() {
            this.connected = true;
          },
          disconnect() {
            this.connected = false;
          },
        };
        observers.push(observer);
        return observer;
      },
    },
  };
}

function createHost(width, height) {
  return { clientWidth: width, clientHeight: height };
}

/** Minimal element stub for module-level abort tests that never reach WebGL. */
function createFakeElement() {
  return {
    children: [],
    clientWidth: 200,
    clientHeight: 200,
    style: {},
    appendChild(node) {
      this.children.push(node);
      node.parentElement = this;
      return node;
    },
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node.parentElement = null;
      return node;
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
  };
}

function createFakeInstance() {
  const calls = { dispose: 0 };
  return {
    calls,
    instance: {
      dispose() {
        calls.dispose += 1;
      },
      focusCursor() {},
      setPlanesVisible() {},
      resetView() {},
      rotateView() {},
      zoomView() {},
    },
  };
}

function createDeferredFactory() {
  const calls = [];
  let current;
  const factory = (host, targetVolume, options) => {
    const entry = {
      host,
      volume: targetVolume,
      signal: options.signal,
      resolve: undefined,
      reject: undefined,
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    calls.push(entry);
    current = entry;
    return entry.promise;
  };
  return {
    calls,
    factory,
    get current() {
      return current;
    },
  };
}

const volume = {
  dimensions: [4, 4, 4],
  sourceDimensions: [4, 4, 4],
  origin: [0, 0, 0],
  spacing: [1, 1, 1],
  voxels: new Uint8Array(64),
  scalarRange: [0, 255],
  downsampled: false,
  cropped: false,
  threshold: 128,
};

test('mounts once after the first frame when the host already has size', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 120);
  const { instance, calls } = createFakeInstance();
  const factoryCalls = [];
  const states = [];
  const instances = [];

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: (targetHost, targetVolume) => {
      factoryCalls.push({ targetHost, targetVolume });
      return Promise.resolve(instance);
    },
    onStateChange: (state) => states.push(state),
    onInstance: (value) => instances.push(value),
  });

  controller.start();
  controller.start(); // idempotent: must not schedule a second frame
  assert.equal(harness.frames.length, 1);

  harness.flushFrames();
  await settlePromises();

  assert.equal(factoryCalls.length, 1);
  assert.equal(controller.getState(), 'ready');
  assert.deepEqual(states, ['creating', 'ready']);
  assert.deepEqual(instances, [instance]);

  controller.abort();
  assert.equal(calls.dispose, 1);
  assert.deepEqual(instances, [instance, null]);
});

test('waits for size without consuming retries and mounts on resize', async () => {
  const harness = createFakeScheduler();
  const host = createHost(0, 0);
  const { instance } = createFakeInstance();
  const factoryCalls = [];

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: () => {
      factoryCalls.push('create');
      return Promise.resolve(instance);
    },
  });

  controller.start();
  harness.flushFrames();
  assert.equal(controller.getState(), 'waiting-size');
  assert.equal(harness.observers[0].connected, true);
  assert.equal(factoryCalls.length, 0);

  // Repeated resize ticks while still hidden must stay idle.
  harness.observers[0].callback();
  harness.observers[0].callback();
  assert.equal(factoryCalls.length, 0);

  host.clientWidth = MIN_HOST_EDGE;
  host.clientHeight = MIN_HOST_EDGE + 8;
  harness.observers[0].callback();
  await settlePromises();

  assert.equal(factoryCalls.length, 1);
  assert.equal(controller.getState(), 'ready');
  // The size observer is disconnected once a preview is live.
  assert.equal(harness.observers[0].connected, false);

  controller.abort();
});

test('abort while creation is in flight disposes the late instance and stays silent', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  const deferred = createDeferredFactory();
  const states = [];
  const instances = [];

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: deferred.factory,
    onStateChange: (state) => states.push(state),
    onInstance: (value) => instances.push(value),
  });

  controller.start();
  harness.flushFrames();
  assert.equal(controller.getState(), 'creating');
  assert.equal(deferred.calls.length, 1);

  controller.abort();
  assert.equal(deferred.current.signal.aborted, true);

  const late = createFakeInstance();
  deferred.current.resolve(late.instance);
  await settlePromises();

  assert.equal(late.calls.dispose, 1);
  assert.deepEqual(instances, []);
  assert.ok(!states.includes('ready'));
  assert.equal(controller.getState(), 'aborted');

  // Everything after abort is a no-op.
  harness.observers[0]?.callback();
  assert.equal(deferred.calls.length, 1);
});

test('abort before the first frame never creates a preview', () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  const factoryCalls = [];

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: () => {
      factoryCalls.push('create');
      return Promise.resolve(createFakeInstance().instance);
    },
  });

  controller.start();
  controller.abort();
  harness.flushFrames();

  assert.equal(factoryCalls.length, 0);
  assert.equal(controller.getState(), 'aborted');
});

test('retries failed creation with backoff and surfaces error after the limit', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  const states = [];
  let attempts = 0;
  const factory = async () => {
    attempts += 1;
    throw new Error('webgl unavailable');
  };

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: factory,
    onStateChange: (state) => states.push(state),
  });

  controller.start();
  harness.flushFrames();

  let guard = 0;
  while (controller.getState() !== 'error' && guard < 30) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    await settlePromises();
    if (controller.getState() === 'retry-wait') {
      const handles = [...harness.timers.keys()];
      assert.equal(handles.length, 1);
      assert.ok(harness.runTimer(handles[0]));
      harness.flushFrames();
    }
  }

  assert.equal(controller.getState(), 'error');
  assert.equal(attempts, MAX_RETRIES + 1);
  assert.equal(states[states.length - 1], 'error');
  // Observer must be disconnected once the controller settles into error.
  assert.equal(harness.observers.at(-1)?.connected, false);

  // A settled controller cannot be revived by stray ticks.
  harness.observers.at(-1)?.callback();
  assert.equal(controller.getState(), 'error');
});

test('shrinking the host during retry backoff pauses attempts until visible again', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  let failures = 0;
  const factory = async () => {
    failures += 1;
    throw new Error('boom');
  };

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: factory,
  });

  controller.start();
  harness.flushFrames();
  await settlePromises();
  assert.equal(controller.getState(), 'retry-wait');
  const attemptsAtBackoff = failures;

  // Host collapses while the backoff timer is pending.
  host.clientWidth = 0;
  host.clientHeight = 0;
  harness.observers[0].callback();
  assert.equal(controller.getState(), 'waiting-size');
  assert.equal(harness.timers.size, 0);
  assert.equal(failures, attemptsAtBackoff);

  // The host comes back; the resize re-arms creation without a new timer.
  host.clientWidth = 200;
  host.clientHeight = 200;
  harness.observers[0].callback();
  await settlePromises();
  assert.equal(failures, attemptsAtBackoff + 1);

  controller.abort();
});

test('abort cancels pending retry timers and disconnects observers', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: async () => {
      throw new Error('boom');
    },
  });

  controller.start();
  harness.flushFrames();
  await settlePromises();
  assert.equal(controller.getState(), 'retry-wait');
  assert.equal(harness.timers.size, 1);

  controller.abort();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers[0].connected, false);
  assert.equal(controller.getState(), 'aborted');
});

test('abort errors from the preview factory are not treated as failures', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  const states = [];
  const abortError = Object.assign(new Error('aborted'), {
    name: 'AbortError',
  });

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: async () => {
      throw abortError;
    },
    onStateChange: (state) => states.push(state),
  });

  controller.start();
  harness.flushFrames();
  await settlePromises();

  assert.ok(!states.includes('error'));
  assert.ok(!states.includes('retry-wait'));
});

test('recovers after transient failures and publishes only the successful instance', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  const { instance, calls } = createFakeInstance();
  let failures = 0;
  const instances = [];

  const controller = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: async () => {
      if (failures < 2) {
        failures += 1;
        throw new Error('transient');
      }
      return instance;
    },
    onInstance: (value) => instances.push(value),
  });

  controller.start();
  harness.flushFrames();

  let guard = 0;
  while (controller.getState() !== 'ready' && guard < 30) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    await settlePromises();
    if (controller.getState() === 'retry-wait') {
      const handles = [...harness.timers.keys()];
      assert.equal(handles.length, 1);
      assert.ok(harness.runTimer(handles[0]));
      harness.flushFrames();
    }
  }

  assert.equal(controller.getState(), 'ready');
  assert.equal(failures, 2);
  assert.deepEqual(instances, [instance]);
  assert.equal(calls.dispose, 0);

  controller.abort();
  assert.equal(calls.dispose, 1);
});

test('a new controller after an error restarts the attempt counter from zero', async () => {
  const harness = createFakeScheduler();
  const host = createHost(200, 200);
  let firstAttempts = 0;

  const first = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: async () => {
      firstAttempts += 1;
      throw new Error('permanent');
    },
  });
  first.start();
  harness.flushFrames();

  let guard = 0;
  while (first.getState() !== 'error' && guard < 30) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    await settlePromises();
    if (first.getState() === 'retry-wait') {
      const handles = [...harness.timers.keys()];
      assert.ok(harness.runTimer(handles[0]));
      harness.flushFrames();
    }
  }
  assert.equal(first.getState(), 'error');
  assert.equal(firstAttempts, MAX_RETRIES + 1);

  // Simulate the next volume switch: a brand new controller with a healthy
  // factory must succeed on its first attempt.
  const { instance } = createFakeInstance();
  let secondAttempts = 0;
  const second = new PreviewMountController({
    host,
    volume,
    scheduler: harness.scheduler,
    createPreview: async () => {
      secondAttempts += 1;
      return instance;
    },
  });
  second.start();
  harness.flushFrames();
  await settlePromises();

  assert.equal(second.getState(), 'ready');
  assert.equal(secondAttempts, 1);
  second.abort();
});

test('createThreePreview rejects with AbortError when the signal is already aborted', async () => {
  const host = createFakeElement();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      threePreviewModule.createThreePreview(host, volume, {
        signal: controller.signal,
      }),
    (error) => error.name === 'AbortError',
  );
});

test('abort while module imports are in flight rejects without a canvas', async () => {
  const host = createFakeElement();
  const controller = new AbortController();
  const promise = threePreviewModule.createThreePreview(host, volume, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(promise, (error) => error.name === 'AbortError');
  assert.equal(host.children.length, 0);
});

test.after(() => vite.close());
