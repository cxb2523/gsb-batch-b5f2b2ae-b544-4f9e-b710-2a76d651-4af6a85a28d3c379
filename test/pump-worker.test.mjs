// Pump worker behavior against simulated engine queues in shared memory (no relay, no real engine):
//   node test/pump-worker.test.mjs
//
// Covers: heartbeat bookkeeping (stats.peerAgeMs), and the "detach" lifecycle used when a guest's host drops - old
// queues stop being read/injected, in-flight packets are dropped, and a fresh "attach" (the host reopening the room)
// arms new readers over the same seat's queues without reading the old block.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const LOOPBACK = { base: 4096, stride: 256, slots: 16, slotSize: 248, dataMax: 240, offLen: 240, offPort: 244, offGet: 248, offSend: 252 };

// Minimal wire helpers; only the batch header shape matters for the queue tests.
const protocolSource = `
export const MAX_BINARY_BYTES = 65536;
export function parseControl(text) { try { return JSON.parse(text); } catch { return null; } }
export function relaySocketUrl(relay, room, role) { return relay + "/" + room + "/" + role; }
function readBatch(kind, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4 || bytes[1] !== kind) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2, true);
  const items = [];
  let at = 4;
  for (let i = 0; i < count; i += 1) {
    let seat = 0;
    if (kind === 2) seat = bytes[at++];
    const length = view.getUint16(at, true);
    at += 2;
    items.push({ seat, packet: bytes.subarray(at, at + length) });
    at += length;
  }
  return items;
}
export const decodePackets = (data) => readBatch(1, data)?.map((i) => i.packet) ?? null;
export const decodeSeatPackets = (data) => readBatch(2, data);
export function encodePackets() { return new Uint8Array([1, 1, 0, 0]); }
export function encodeSeatPackets() { return new Uint8Array([1, 2, 0, 0]); }
`;

const queuesSource = readFileSync(new URL("../src/net/queues.js", import.meta.url), "utf8");
let workerSource = readFileSync(new URL("../src/net/pump-worker.js", import.meta.url), "utf8");
// Test-only inspection hook: expose the worker's module state and a single pump() call without touching production
// exports. Appended after the real source, it closes over the same module scope.
workerSource += `\nexport function __testState() { return state; }\nexport function __testPump() { return pump(); }\n`;

let nowMs = 1000;
const openedSockets = [];
const sandbox = {
  console,
  performance: { now: () => nowMs },
  setTimeout,
  clearTimeout,
  Promise,
  Int32Array,
  Uint8Array,
  Uint16Array,
  DataView,
  SharedArrayBuffer,
  ArrayBuffer,
  Atomics,
  JSON,
  Math,
  WebSocket: class {
    constructor(url) {
      this.url = url;
      this.readyState = 1; // OPEN, so flush() actually sends
      this.sentFrames = [];
      openedSockets.push(this);
    }
    send(frame) {
      this.sentFrames.push(frame);
    }
    close() {}
  },
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);
const posted = [];
sandbox.self = { postMessage: (message) => posted.push(message) };

async function loadModule(source, url, imports) {
  const mod = new vm.SourceTextModule(source, { context, url });
  await mod.link((specifier) => imports[specifier]);
  await mod.evaluate();
  return mod;
}
const protocol = await loadModule(protocolSource, "test://protocol.js", {});
const queues = await loadModule(queuesSource, "test://queues.js", {});
const worker = await loadModule(workerSource, "test://worker.js", {
  "../../relay/src/protocol.js": protocol,
  "./queues.js": queues,
});
const { __testState, __testPump } = worker.namespace;

const onmessage = sandbox.self.onmessage;
assert.equal(typeof onmessage, "function", "the worker registers its message handler");
const send = (message) => {
  try {
    onmessage.call(sandbox.self, { data: message });
  } catch (error) {
    throw new Error(`worker failed handling ${message.type}`, { cause: error });
  }
};
const queueBase = (port) => LOOPBACK.base + port * LOOPBACK.stride;
const lastStats = () => posted.filter((m) => m.type === "stats").at(-1);

// 1. Heartbeat: peerAgeMs is null before the first frame and the measured silence afterwards.
{
  send({ type: "connect", relay: "ws://relay", room: "room", role: "guest", guestId: "gid" });
  const ws = openedSockets.at(-1);
  assert.ok(ws, "a WebSocket was opened");

  // The stats path runs once a second inside loop(); drive the same computation by emitting a stats message through
  // the worker's own loop via a short real wait is unnecessary - verify the state field directly after frames arrive.
  assert.equal(__testState().lastPeerAt, 0, "no heartbeat before the first host frame");

  nowMs = 10000;
  ws.onmessage({ data: JSON.stringify({ t: "peer", present: true }) });
  assert.equal(__testState().lastPeerAt, 10000, "an inbound control frame marks the heartbeat");

  nowMs = 13000;
  ws.onmessage({ data: new Uint8Array([1, 1, 0, 0]).buffer }); // empty guest batch
  assert.equal(__testState().lastPeerAt, 13000, "an inbound binary frame marks the heartbeat");

  // Replicate the loop's stats emission math against the same clock the worker uses.
  const peerAgeNow = () => (__testState().lastPeerAt ? nowMs - __testState().lastPeerAt : null);
  nowMs = 23500; // 10.5 s of silence after the last frame
  assert.ok(peerAgeNow() > 10000, "the silence the guest interrupts on is measurable from the heartbeat clock");

  // And prove the real stats message carries the field: let the worker's loop emit one (it posts every 1000 ms).
  const emitted = await waitFor(() => lastStats()?.stats.peerAgeMs != null);
  assert.ok(emitted, "stats messages include peerAgeMs");
  assert.ok(lastStats().stats.peerAgeMs > 10000);
  console.log("ok  worker tracks host silence in stats.peerAgeMs");
}

// 2. Detach: old queues stop being read/injected and queued packets are dropped.
{
  // Stop the background loop so the queue contents stay deterministic; every pump from here on is an explicit call.
  __testState().closed = true;
  const buffer = new SharedArrayBuffer(1 << 20);
  const outBase = queueBase(1); // guest's client outgoing queue (reader seat 0)
  const inBase = queueBase(0); // guest's client incoming queue (writer)
  send({
    type: "attach",
    buffer,
    loopback: LOOPBACK,
    reads: [{ seat: 0, base: outBase }],
    writeBase: inBase,
    ports: { 0: 0 },
    reading: true,
    injecting: true,
  });

  // A host frame arrives (onBinary pumps it straight into the engine's inbound queue, as in production), and the
  // engine itself stages a packet in its outgoing queue.
  openedSockets.at(-1).onmessage({ data: batch(2, [{ seat: 1, packet: Uint8Array.from([9, 8, 7]) }]) });
  writeEnginePacket(new Int32Array(buffer), LOOPBACK, outBase, Uint8Array.from([1, 2, 3, 4]), 0);

  const state = __testState();
  assert.equal(state.readers.length, 1, "sanity: a reader is attached before detach");
  assert.ok(state.writer, "sanity: a writer is attached before detach");

  send({ type: "detach" });
  assert.ok(Array.isArray(state.readers) && state.readers.length === 0, "detach removes every queue reader");
  assert.equal(state.writer, null, "detach removes the queue writer");
  assert.equal(state.reading, false, "the old outgoing queue is no longer read");
  assert.equal(state.injecting, false, "the old incoming queue is no longer injected");
  assert.equal(state.inbox.length, 0, "packets waiting for the old queue are dropped");
  assert.equal(state.outbox.length, 0, "packets waiting for the relay are dropped");

  // Stage another engine packet after detach: with the reader gone, a pump must never pick it up.
  writeEnginePacket(new Int32Array(buffer), LOOPBACK, outBase, Uint8Array.from([5, 6, 7]), 0);
  __testPump();
  assert.equal(state.outbox.length, 0, "no packets leave for the dead session");
  console.log("ok  detach releases the old queues and clears in-flight packets");
}

// 3. A fresh attach (host reopened the room) arms new queues; the old memory block is never read again.
{
  const oldBuffer = new SharedArrayBuffer(1 << 20);
  const newBuffer = new SharedArrayBuffer(1 << 20);
  const state = __testState();

  send({
    type: "attach",
    buffer: oldBuffer,
    loopback: LOOPBACK,
    reads: [{ seat: 0, base: queueBase(1) }],
    writeBase: queueBase(0),
    ports: { 0: 0 },
    reading: false,
    injecting: false,
  });
  const oldReader = state.readers[0].queue;
  assert.equal(state.readers.length, 1);

  // Re-host: the new engine instance owns a fresh memory block; the worker swaps to it entirely.
  send({
    type: "attach",
    buffer: newBuffer,
    loopback: LOOPBACK,
    reads: [{ seat: 0, base: queueBase(1) }],
    writeBase: queueBase(0),
    ports: { 0: 0 },
    reading: false,
    injecting: false,
  });
  assert.equal(state.readers.length, 1, "exactly one reader after re-attach");
  assert.notEqual(state.readers[0].queue, oldReader, "the old reader is replaced, not reused");
  assert.notEqual(state.readers[0].queue.u8.buffer, oldBuffer, "the new reader backs the new engine memory");
  assert.equal(state.readers[0].queue.u8.buffer, newBuffer);

  // Stage a packet in each block and poll through the worker's CURRENT reader: it must see only the new block's
  // packet, proving the abandoned engine memory is never consulted again. (The reader's cursor was synced at attach,
  // so packets staged now are the first ones it can poll.)
  writeEnginePacket(new Int32Array(oldBuffer), LOOPBACK, queueBase(1), Uint8Array.from([255, 254, 253]), 0);
  writeEnginePacket(new Int32Array(newBuffer), LOOPBACK, queueBase(1), Uint8Array.from([10, 20]), 0);
  const currentReader = state.readers[0].queue;
  const polled = currentReader.poll([]);
  assert.equal(polled.length, 1, "the re-attached reader polls one packet");
  assert.deepEqual(Array.from(polled[0]), [10, 20], "it reads the new engine block, never the old one");
  assert.equal(currentReader.u8.buffer, newBuffer);
  console.log("ok  re-attach arms new queues and never reads the old block");
}

console.log("pump worker: all passed");

// --- helpers -----------------------------------------------------------------------------------------
function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = () => (check() ? resolve(true) : Date.now() - started > timeoutMs ? resolve(false) : setTimeout(poll, 10));
    poll();
  });
}

function batch(kind, items) {
  const size = 4 + items.reduce((n, it) => n + (kind === 2 ? 1 : 0) + 2 + it.packet.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = kind;
  view.setUint16(2, items.length, true);
  let at = 4;
  for (const { seat, packet } of items) {
    if (kind === 2) out[at++] = seat;
    view.setUint16(at, packet.byteLength, true);
    out.set(packet, at + 2);
    at += 2 + packet.byteLength;
  }
  return out.buffer;
}

function writeEnginePacket(i32, lb, base, bytes, port) {
  i32[(base + lb.offLen) >> 2] = bytes.byteLength;
  new Uint8Array(i32.buffer).set(bytes, base);
  i32[(base + lb.offPort) >> 2] = port;
  Atomics.add(i32, (base + lb.offSend) >> 2, 1);
}
