/**
 * Lifecycle tests for RScheduledSource and its subclasses.
 *
 * The component classes are driven directly through their React lifecycle
 * methods (no DOM needed), against the mock Web Audio API in mock-audio.js.
 *
 * Run with: npm test
 */

const { installGlobals, MockAudioContext } = require('./mock-audio.js');
installGlobals();

const ROscillator = require('../.test-build/audio-nodes/oscillator.js').default;
const RBufferSource = require('../.test-build/audio-nodes/buffer-source.js').default;
const RConstantSource = require('../.test-build/audio-nodes/constant-source.js').default;

let failures = 0;
let testCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    console.log(`ok ${testCount} - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok ${testCount} - ${name}`);
    console.error(`    ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'values differ'} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

// --- React lifecycle drivers -------------------------------------------------

function makeContext() {
  return {
    audio: new MockAudioContext(),
    nodes: new Map(),
    debug: false
  };
}

function mount(ComponentClass, props, context) {
  const instance = new ComponentClass(props);
  instance.context = context;
  instance.componentWillMount();
  instance.componentDidMount();
  return instance;
}

// mimics the React 16 update order: WillReceiveProps -> WillUpdate -> DidUpdate
function update(instance, nextProps) {
  const prevProps = instance.props;
  instance.componentWillReceiveProps(nextProps);
  instance.componentWillUpdate(nextProps, instance.state);
  instance.props = nextProps;
  instance.componentDidUpdate(prevProps, instance.state);
}

function unmount(instance) {
  instance.componentWillUnmount();
}

// --- tests -------------------------------------------------------------------

test('oscillator replays after stop with the latest props applied to the rebuilt node', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  const destination = () => context.audio.destination;
  const props = { identifier, destination, frequency: 440, type: 'square', start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  const node1 = osc.node;

  assertEqual(node1.startCalls.length, 1, 'node1 started once');
  assertEqual(node1.startCalls[0][0], 0, 'node1 started at t=0');
  assertEqual(node1.stopCalls.length, 1, 'node1 stop scheduled');
  assertEqual(node1.stopCalls[0][0], 1, 'node1 stops at t=1');
  assertEqual(node1.connections.length, 1, 'node1 connected once');
  assertEqual(node1.connections[0][0], context.audio.destination, 'node1 connected to the context destination');
  assertEqual(context.nodes.get(identifier), node1, 'registry points at node1');

  // param change while playing goes to the live node
  update(osc, Object.assign({}, props, { frequency: 880 }));
  assertEqual(node1.frequency.value, 880, 'frequency updated on the live node');

  // the source ends -> the browser drops it -> r-audio must rebuild it
  node1.fireEnded();

  const node2 = osc.node;
  assert(node2 !== node1, 'a fresh node was created after ended');
  assertEqual(context.audio.created.oscillator, 2, 'exactly two oscillators were created');
  assertEqual(context.nodes.get(identifier), node2, 'registry migrated to node2');
  assertEqual(node2.connections.length, 1, 'node2 reconnected');
  assertEqual(node2.connections[0][0], context.audio.destination, 'node2 connected to the current destination');
  assertEqual(node2.frequency.value, 880, 'rebuilt node received the *latest* frequency');
  assertEqual(node2.type, 'square', 'rebuilt node received the type');

  // replay: new start/stop props must be scheduled on the fresh node
  update(osc, Object.assign({}, props, { frequency: 880, start: 2, stop: 3 }));
  assertEqual(node2.startCalls.length, 1, 'node2 started for the replay');
  assertEqual(node2.startCalls[0][0], 2, 'node2 started at t=2');
  assertEqual(node2.stopCalls.length, 1, 'node2 stop scheduled');
  assertEqual(node2.stopCalls[0][0], 3, 'node2 stops at t=3');

  // the stopped node must never be started again
  assertEqual(node1.startCalls.length, 1, 'no second start() on the ended node');
});

test('param updates after ended go to the rebuilt node, never to the stopped one', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  const props = { identifier, destination: () => context.audio.destination, frequency: 220, start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  const node1 = osc.node;
  node1.fireEnded();
  const node2 = osc.node;

  const writesToNode1 = node1.frequency.calls.setValueAtTime.length;
  update(osc, Object.assign({}, props, { frequency: 330 }));

  assertEqual(node1.frequency.calls.setValueAtTime.length, writesToNode1, 'no setValueAtTime on the ended node');
  assertEqual(node2.frequency.value, 330, 'setValueAtTime applied to the rebuilt node');
});

test('periodicWave is reapplied to the rebuilt node', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  const wave1 = { id: 'wave1' };
  const wave2 = { id: 'wave2' };
  const props = { identifier, destination: () => context.audio.destination, periodicWave: wave1, start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  const node1 = osc.node;
  assertEqual(node1.periodicWaves.length, 1, 'periodicWave set on the initial node');
  assertEqual(node1.periodicWaves[0], wave1, 'initial periodicWave applied');

  update(osc, Object.assign({}, props, { periodicWave: wave2 }));
  assertEqual(node1.periodicWaves[1], wave2, 'periodicWave updated on the live node');

  node1.fireEnded();
  assertEqual(osc.node.periodicWaves.length, 1, 'periodicWave set on the rebuilt node');
  assertEqual(osc.node.periodicWaves[0], wave2, 'rebuilt node received the *latest* periodicWave');
});

test('unmount prevents the async ended callback from rebuilding the node or touching the registry', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  const props = { identifier, destination: () => context.audio.destination, start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  const node1 = osc.node;

  unmount(osc);
  assertEqual(context.nodes.has(identifier), false, 'registry entry removed on unmount');
  assertEqual(node1.listenerCount('ended'), 0, 'ended listener removed on unmount');

  // the browser may still deliver the ended event asynchronously;
  // dispatch it both through the node and directly through the handler
  node1.fireEnded();
  osc.onEnded({ target: node1 });

  assertEqual(context.audio.created.oscillator, 1, 'no new node created after unmount');
  assertEqual(context.nodes.size, 0, 'registry untouched after unmount');
});

test('unmount after a rebuild also stays clean', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  const props = { identifier, destination: () => context.audio.destination, start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  osc.node.fireEnded();
  const node2 = osc.node;
  assertEqual(context.nodes.get(identifier), node2, 'registry points at node2');

  unmount(osc);
  node2.fireEnded();

  assertEqual(context.audio.created.oscillator, 2, 'no third node created after unmount');
  assertEqual(context.nodes.size, 0, 'registry empty after unmount');
});

test('identifier change migrates the registry without leaving stale keys', () => {
  const context = makeContext();
  const idA = Symbol('osc-a');
  const idB = Symbol('osc-b');
  const props = { identifier: idA, destination: () => context.audio.destination, start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  const node1 = osc.node;
  assertEqual(context.nodes.get(idA), node1, 'registered under the initial identifier');

  update(osc, Object.assign({}, props, { identifier: idB }));
  assertEqual(context.nodes.has(idA), false, 'old identifier removed from the registry');
  assertEqual(context.nodes.get(idB), node1, 'registry migrated to the new identifier');

  // a rebuild after the identifier change registers under the *new* identifier
  node1.fireEnded();
  const node2 = osc.node;
  assertEqual(context.nodes.has(idA), false, 'old identifier still absent after rebuild');
  assertEqual(context.nodes.get(idB), node2, 'rebuilt node registered under the new identifier');

  unmount(osc);
  assertEqual(context.nodes.size, 0, 'registry empty after unmount');
});

test('stale ended events from replaced nodes are ignored', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  const props = { identifier, destination: () => context.audio.destination, start: 0, stop: 1 };

  const osc = mount(ROscillator, props, context);
  const node1 = osc.node;
  node1.fireEnded();
  const node2 = osc.node;

  // a late/duplicate event from the replaced node must not trigger another rebuild
  osc.onEnded({ target: node1 });
  assertEqual(osc.node, node2, 'stale ended event ignored');
  assertEqual(context.audio.created.oscillator, 2, 'no extra node created');
});

test('stop is never scheduled on a node that is not playing', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  // stop without start: nothing is playing, so stop() must not be called
  const props = { identifier, destination: () => context.audio.destination, stop: 1 };

  const osc = mount(ROscillator, props, context);
  assertEqual(osc.node.stopCalls.length, 0, 'stop() not called on an unstarted node');
  assertEqual(osc.node.startCalls.length, 0, 'start() not called');
});

test('buffer source replays after stop with the current buffer', () => {
  const context = makeContext();
  const identifier = Symbol('RBufferSource');
  const buffer = { id: 'buffer-1' };
  const props = { identifier, destination: () => context.audio.destination, buffer, start: 0, stop: 1 };

  const source = mount(RBufferSource, props, context);
  const node1 = source.node;

  assertEqual(node1.startCalls.length, 1, 'node1 started');
  assertEqual(node1.buffer, buffer, 'buffer applied to node1');

  node1.fireEnded();

  const node2 = source.node;
  assert(node2 !== node1, 'buffer source rebuilt after ended');
  assertEqual(context.audio.created.bufferSource, 2, 'exactly two buffer sources created');
  assertEqual(node2.buffer, buffer, 'rebuilt node received the current buffer');
  assertEqual(context.nodes.get(identifier), node2, 'registry migrated to node2');
  assertEqual(node2.connections.length, 1, 'node2 reconnected to the destination');

  // replay on the fresh node
  update(source, Object.assign({}, props, { start: 2, stop: 4 }));
  assertEqual(node2.startCalls.length, 1, 'node2 started for the replay');
  assertEqual(node2.startCalls[0][0], 2, 'node2 started at t=2');
  assertEqual(node1.startCalls.length, 1, 'no second start() on the ended node');
});

test('buffer source without a buffer does not start, starts once a buffer arrives', () => {
  const context = makeContext();
  const identifier = Symbol('RBufferSource');
  const props = { identifier, destination: () => context.audio.destination, start: 0 };

  const source = mount(RBufferSource, props, context);
  assertEqual(source.node.startCalls.length, 0, 'not started without a buffer');

  const buffer = { id: 'buffer-1' };
  update(source, Object.assign({}, props, { buffer }));
  assertEqual(source.node.startCalls.length, 1, 'started once the buffer arrived');
});

test('changing the buffer mid-playback rebuilds and reschedules the source', () => {
  const context = makeContext();
  const identifier = Symbol('RBufferSource');
  const buffer1 = { id: 'buffer-1' };
  const buffer2 = { id: 'buffer-2' };
  const props = { identifier, destination: () => context.audio.destination, buffer: buffer1, start: 0 };

  const source = mount(RBufferSource, props, context);
  const node1 = source.node;
  assertEqual(node1.startCalls.length, 1, 'node1 started');

  update(source, Object.assign({}, props, { buffer: buffer2 }));

  const node2 = source.node;
  assert(node2 !== node1, 'source rebuilt when the buffer changed mid-playback');
  assertEqual(node2.buffer, buffer2, 'new buffer applied to the rebuilt node');
  assertEqual(node2.startCalls.length, 1, 'rebuilt node rescheduled');
  assertEqual(node1.startCalls.length, 1, 'old node not started again');
  assertEqual(context.nodes.get(identifier), node2, 'registry points at the rebuilt node');
});

test('constant source rebuilds on ended with the current offset', () => {
  const context = makeContext();
  const identifier = Symbol('RConstantSource');
  const props = { identifier, destination: () => context.audio.destination, offset: 0.5, start: 0, stop: 1 };

  const source = mount(RConstantSource, props, context);
  const node1 = source.node;
  assertEqual(node1.offset.value, 0.5, 'offset applied to node1');

  update(source, Object.assign({}, props, { offset: 0.7 }));
  node1.fireEnded();

  const node2 = source.node;
  assert(node2 !== node1, 'constant source rebuilt after ended');
  assertEqual(node2.offset.value, 0.7, 'rebuilt node received the latest offset');
  assertEqual(context.nodes.get(identifier), node2, 'registry migrated to node2');
});

test('onEnded prop is called on ended, but not after unmount', () => {
  const context = makeContext();
  const identifier = Symbol('ROscillator');
  let endedCalls = 0;
  const props = {
    identifier,
    destination: () => context.audio.destination,
    start: 0,
    stop: 1,
    onEnded: () => endedCalls++
  };

  const osc = mount(ROscillator, props, context);
  osc.node.fireEnded();
  assertEqual(endedCalls, 1, 'onEnded prop called once');

  const node2 = osc.node;
  unmount(osc);
  node2.fireEnded();
  assertEqual(endedCalls, 1, 'onEnded prop not called after unmount');
});

// --- summary -----------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} of ${testCount} tests failed`);
  process.exit(1);
} else {
  console.log(`\nall ${testCount} tests passed`);
}
