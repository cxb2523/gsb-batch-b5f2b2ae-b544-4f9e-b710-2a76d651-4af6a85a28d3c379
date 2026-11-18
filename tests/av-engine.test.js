import test from 'node:test';
import assert from 'node:assert/strict';
import { AVEngine } from '../av-engine.js';
import { idleState } from '../shared.js';

test('stopping A/V during acquisition releases a late stream without starting an encoder', async () => {
  const originalChannel = globalThis.BroadcastChannel, originalRecorder = globalThis.MediaRecorder;
  globalThis.BroadcastChannel = class {
    postMessage(message) { if (message.type === 'STOP') queueMicrotask(() => this.onmessage({ data: { type: 'RELEASED' } })); }
    close() {}
  };
  globalThis.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { throw new Error('Must not encode canceled acquisition'); } };
  try {
    let resolveStream, stopped = 0;
    const engine = new AVEngine({ mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } });
    const pending = engine.start({ streamId: 'fresh', tabId: 8, tabTitle: 'test', sessionId: 'one', delay: 30, viewerTabId: 9, region: 'tab' });
    await engine.stop();
    resolveStream({ getTracks: () => [{ stop() { stopped++; } }] });
    await pending;
    assert.equal(stopped, 1);
    assert.equal(engine.snapshot().active, false);
    assert.equal(engine.session, null);
  } finally { globalThis.BroadcastChannel = originalChannel; globalThis.MediaRecorder = originalRecorder; }
});

test('Stop waits for cleanup already started by an error or viewer closure', async () => {
  const oldChannel = globalThis.BroadcastChannel, oldRecorder = globalThis.MediaRecorder;
  let channel;
  globalThis.BroadcastChannel = class { constructor() { channel = this; } postMessage() {} close() {} };
  globalThis.MediaRecorder = class { static isTypeSupported() { return true; } };
  try {
    const engine = new AVEngine({ mediaDevices: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
    const starting = engine.start({ streamId: 'fresh', sessionId: 'one', delay: 30, region: 'tab' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.session, null);
    let finished = false;
    const stopping = engine.stop().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    channel.onmessage({ data: { type: 'RELEASED' } });
    await starting; await stopping;
    assert.equal(finished, true);
    assert.equal(engine.snapshot().phase, 'idle');
  } finally { globalThis.BroadcastChannel = oldChannel; globalThis.MediaRecorder = oldRecorder; }
});

test('STOP racing viewer CLOSED releases the session exactly once', async () => {
  const engine = new AVEngine({ mediaDevices: {} });
  let tracks = 0, contexts = 0, croppers = 0, encoderStops = 0, channelCloses = 0;
  let stopListener;
  const session = { listeners: [], timer: null,
    stream: { getTracks: () => [{ stop() { tracks++; } }] },
    recorder: { state: 'recording',
      addEventListener(type, cb) { stopListener = cb; },
      stop() { encoderStops++; this.state = 'stopping'; queueMicrotask(() => stopListener?.()); } },
    cropper: { async close() { croppers++; } },
    audioSource: { disconnect() {} },
    audioDestination: { stream: { getTracks: () => [{ stop() { tracks++; } }] } },
    context: { async close() { contexts++; } },
    channel: { postMessage(message) { if (message.type === 'STOP') queueMicrotask(() => session.released?.()); },
      close() { channelCloses++; } } };
  engine.session = session;
  engine.state = { ...idleState(), active: true, mode: 'av' };
  const stopping = engine.stop();
  const closed = engine.fail(session, 'interrupted', '延迟播放页已关闭，采集已释放，网页恢复原声。');
  await Promise.all([stopping, closed]);
  assert.equal(encoderStops, 1);
  assert.equal(croppers, 1);
  assert.equal(tracks, 2);
  assert.equal(contexts, 1);
  assert.equal(channelCloses, 1);
  await engine.release(session); // Re-entry after the race is a no-op.
  assert.equal(contexts, 1);
  assert.equal(channelCloses, 1);
});

test('release resolves only after encoder stop, cropper close, track stop and AudioContext close', async () => {
  const engine = new AVEngine({ mediaDevices: {} });
  let stopListener, resolveCrop, resolveContext, tracksStopped = false;
  const session = { listeners: [], timer: null,
    stream: { getTracks: () => [{ stop() { tracksStopped = true; } }] },
    recorder: { state: 'recording', addEventListener(type, cb) { stopListener = cb; }, stop() {} },
    cropper: { close: () => new Promise(resolve => { resolveCrop = resolve; }) },
    audioSource: { disconnect() {} },
    audioDestination: { stream: { getTracks: () => [] } },
    context: { close: () => new Promise(resolve => { resolveContext = resolve; }) },
    channel: { postMessage(message) { if (message.type === 'STOP') queueMicrotask(() => session.released?.()); }, close() {} } };
  engine.session = session;
  engine.state = { ...idleState(), active: true, mode: 'av' };
  let done = false;
  const stopping = engine.stop().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false); // Cropper still open.
  resolveCrop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracksStopped, true); // Tracks stop once the cropper closed.
  assert.equal(done, false); // Encoder stop event still pending.
  stopListener();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false); // AudioContext still open.
  resolveContext();
  await stopping;
  assert.equal(done, true);
});

test('crop geometry updates only its session; losing the player releases capture instead of showing the page', async () => {
  let received, stopped = 0, closed = 0;
  const engine = new AVEngine({ mediaDevices: {} });
  const session = { listeners: [], stream: { getTracks: () => [{ stop() { stopped++; } }] },
    cropper: { setGeometry(value) { received = value; }, async close() { closed++; } },
    channel: { postMessage() { queueMicrotask(() => session.released?.()); }, close() {} } };
  engine.session = session;
  engine.state = { ...idleState(), active: true, mode: 'av', sessionId: 'current' };
  const geometry = { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, sourceWidth: 1920, sourceHeight: 1080 };
  await engine.setRegion({ sessionId: 'old', geometry });
  assert.equal(received, undefined);
  await engine.setRegion({ sessionId: 'current', geometry });
  assert.equal(received, geometry); assert.equal(engine.state.sourceWidth, 1920);
  await engine.setRegion({ sessionId: 'current', error: '播放器未完整显示' });
  assert.equal(engine.state.phase, 'interrupted'); assert.equal(engine.state.active, false);
  assert.equal(stopped, 1); assert.equal(closed, 1);
});
