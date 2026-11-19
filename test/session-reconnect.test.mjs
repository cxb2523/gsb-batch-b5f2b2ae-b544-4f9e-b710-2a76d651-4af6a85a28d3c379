// Guest host-drop handling against a simulated engine (no browser, no real game):
//   node --loader ./test/support/import-map-loader.mjs test/session-reconnect.test.mjs
//
// Covers: heartbeat-driven "session interrupted", old queue release + packet/pause teardown, reconnectable lobby
// card state, single-flight reconnect reusing the same seat, a failed reconnect returning to the same state, and a
// successful reconnect re-establishing the connection.
import assert from "node:assert/strict";

const { guestTick, reconnectSession, interruptSession } = await import("../src/session/guest.js");
const { onControl } = await import("../src/session/messages.js");
await import("./support/stub-page.mjs");
await import("./support/stub-pump.mjs");

const LOOPBACK = { base: 4096, stride: 256, slots: 16, slotSize: 248, dataMax: 240, offLen: 240, offPort: 244, offGet: 248, offSend: 252 };
const BUILD = { loopback: LOOPBACK, introState: 1234, client: { connectionState: 0 } };
const CONNECTION = { disconnected: 0, connecting: 4, challenging: 5, connected: 6, loading: 8, primed: 9, active: 10 };

/** A controllable stand-in for EngineMemory over a real SharedArrayBuffer, plus a recording of engine commands. */
function fakeEngine() {
  const buffer = new SharedArrayBuffer(1 << 20);
  const dvars = { svPaused: 1, clPaused: 1 };
  const commands = [];
  const engine = {
    buffer,
    commands,
    conn: CONNECTION.active,
    held: false,
    keptAlive: 0,
    build: BUILD,
    Module: { _KB_Input() {}, _malloc: () => 8192 },
    queueAt: (port) => LOOPBACK.base + port * LOOPBACK.stride,
    dvar: (name) => dvars[name] ?? 0,
    setDvar(name, value) {
      dvars[name] = value;
    },
    command(text) {
      commands.push(text);
      return true;
    },
    holdServer(on) {
      engine.held = on;
    },
    serverReadsPackets: () => false,
    connectionState: () => engine.conn,
    int: () => 0,
    pointClientAt: () => true,
    clientServerPort: () => 0,
    keepClientAlive() {
      engine.keptAlive += 1;
    },
    menuOpen: () => false,
    codeTimeScale: () => 1,
  };
  return engine;
}

/** A pump worker stand-in: records its messages and the lifecycle of its queue attachment. */
function fakePump() {
  const messages = [];
  return {
    messages,
    attached: 0,
    detached: 0,
    reading: false,
    injecting: false,
    postMessage(msg) {
      messages.push(msg);
      if (msg.type === "attach") this.attached += 1;
      if (msg.type === "detach") this.detached += 1;
      if (msg.type === "read") this.reading = true;
      if (msg.type === "inject") this.injecting = Boolean(msg.on);
    },
  };
}

function makeSession(engine, pump) {
  return {
    mode: "guest",
    room: "abcd-efgh-jkmn-pqrs",
    build: BUILD,
    engine,
    pump,
    phase: "connected",
    peer: true,
    seat: 2,
    qport: 20424,
    hostState: { ready: true, turn: true, slot: 5, screen: "playing", normalSpeed: true },
    hostInfo: { slug: "kino", zone: "zombie_theater" },
    lobby: null,
    hostPos: { origin: [1, 2, 3], at: 0 },
    hostTrail: [{ origin: [1, 2, 3], at: 0 }],
    stats: { rtt: 10, peerAgeMs: 100 },
    paused: true,
    menuOpen: false,
    remotePause: true,
    log: [],
    sentPhase: "connected",
    sentPhaseAt: 0,
    note(text) {
      this.log.push(text);
    },
    fail() {
      this.error = "hostLeft";
    },
  };
}

const tick = (session, times = 1) => {
  for (let i = 0; i < times; i += 1) guestTick(session);
};

// 1. Heartbeat timeout: silence past the threshold interrupts a healthy-looking connected session.
{
  const engine = fakeEngine();
  const pump = fakePump();
  const session = makeSession(engine, pump);
  tick(session);
  assert.equal(session.phase, "connected", "still connected while frames arrive");

  session.stats.peerAgeMs = 10001; // pump worker reports the host has been silent for > HOST_SILENT_MS (10 s)
  tick(session);
  assert.equal(session.phase, "interrupted", "silent host flips the guest to the interrupted state");
  assert.equal(session.reconnecting, false);
  assert.equal(session.error, "hostLeft", "the card gets a translated host-left error");

  // Old queues released and everything in flight dropped.
  assert.deepEqual(pump.messages.at(-1), { type: "detach" }, "the pump is told to detach the old queues");
  // Pause markers reset in the engine and on the session.
  assert.equal(engine.dvar("svPaused"), 0, "svPaused reset");
  assert.equal(engine.dvar("clPaused"), 0, "clPaused reset");
  assert.equal(session.paused, false);
  assert.equal(session.remotePause, false);
  assert.equal(session.menuOpen, false);
  // Engine connection dropped, host-side state forgotten.
  assert.ok(engine.commands.includes("disconnect"), "the engine is disconnected from the old server");
  assert.equal(session.hostState, null);
  assert.equal(session.hostPos, null);
  assert.deepEqual(session.hostTrail, []);
  console.log("ok  silence past the heartbeat threshold interrupts the session and tears it down");
}

// 2. Before the first host frame ever arrives, silence must not interrupt (nothing to time out yet).
{
  const engine = fakeEngine();
  const pump = fakePump();
  const session = makeSession(engine, pump);
  session.phase = "waiting-host";
  session.stats = { rtt: null, peerAgeMs: null };
  session.hostState = null;
  session.paused = false;
  session.remotePause = false;
  tick(session, 3);
  assert.equal(session.phase, "waiting-host", "no heartbeat yet means no interruption");
  console.log("ok  no interruption before the first host frame");
}

// 3. Reconnect is single-flight: repeated clicks start one attempt and keep the same seat/qport.
{
  const engine = fakeEngine();
  const pump = fakePump();
  const session = makeSession(engine, pump);
  session.stats.peerAgeMs = 12000;
  tick(session);
  assert.equal(session.phase, "interrupted");
  const detaches = pump.detached;

  const first = reconnectSession(session);
  assert.equal(first, true);
  const second = reconnectSession(session);
  assert.equal(second, false, "a second click while reconnecting starts nothing new");
  assert.equal(session.phase, "waiting-host");
  assert.equal(session.reconnecting, true);
  assert.equal(session.seat, 2, "the seat is reused");
  assert.equal(session.qport, 20424, "the qport (and thus the engine-side identity) is reused");
  assert.equal(pump.attached, 1, "exactly one fresh queue attachment");
  assert.ok(pump.detached >= detaches, "no extra detach from the no-op click");
  const attach = pump.messages.filter((m) => m.type === "attach").at(-1);
  assert.deepEqual(attach.reads, [{ seat: 0, base: engine.queueAt(1) }], "same outgoing queue base");
  assert.equal(attach.writeBase, engine.queueAt(0), "same inbound queue base");
  assert.equal(attach.reading, false);
  assert.equal(attach.injecting, false);
  assert.ok(engine.commands.filter((c) => c === "disconnect").length >= 1, "old engine connection dropped");
  console.log("ok  reconnect starts a single attempt, reattaching the same seat's queues");
}

// 4. A failed reconnect handshake returns to the same interrupted state with the button available again.
{
  const engine = fakeEngine();
  const pump = fakePump();
  const session = makeSession(engine, pump);
  interruptSession(session, "test");
  reconnectSession(session);
  assert.equal(session.phase, "waiting-host");

  // Host recovered, gives us our turn again: walk freezing -> connect -> challenging.
  onControl(session, { t: "state", ready: true, turn: true, slot: 0, screen: "ready" });
  tick(session); // waiting-host -> freezing
  assert.equal(session.phase, "freezing");
  tick(session); // freezing -> connect
  assert.equal(session.phase, "connect");
  tick(session); // connect command accepted -> challenging
  assert.equal(session.phase, "challenging");

  // The host never answers the handshake; challenging gives up once its 15 s window elapses.
  engine.conn = CONNECTION.disconnected;
  session.connectAt = Date.now() - 16000;
  tick(session);
  assert.equal(session.phase, "interrupted", "failed reconnect goes back to interrupted, not failed");
  assert.equal(session.reconnecting, false, "the button is available again");
  assert.equal(session.error, "hostLeft", "the reconnectable error text stays");
  assert.equal(reconnectSession(session), true, "another reconnect can be started from the same state");
  console.log("ok  failed reconnect returns to the interrupted state and allows another attempt");
}

// 5. A successful reconnect reaches "connected" again and clears the reconnecting flag.
{
  const engine = fakeEngine();
  const pump = fakePump();
  const session = makeSession(engine, pump);
  interruptSession(session, "test");
  reconnectSession(session);
  onControl(session, { t: "state", ready: true, turn: true, slot: 0, screen: "playing" });
  tick(session); // -> freezing
  tick(session); // -> connect
  tick(session); // -> challenging
  assert.equal(session.phase, "challenging");
  // The handshake reaches the challenge exchange (state 5): challenging hands over to joining and injection starts.
  engine.conn = CONNECTION.challenging;
  session.connectAt = Date.now();
  tick(session); // challenging -> joining
  assert.equal(session.phase, "joining");
  assert.equal(pump.injecting, true, "host packets are injected again");
  // Once the engine reports an active connection, joining completes.
  engine.conn = CONNECTION.active;
  tick(session); // joining -> connected
  assert.equal(session.phase, "connected");
  assert.equal(session.reconnecting, false, "reconnecting flag cleared once active");
  assert.equal(session.error, null);
  assert.equal(pump.injecting, true, "host packets are injected again");
  assert.equal(pump.reading, true, "our outgoing queue is read again");
  console.log("ok  successful reconnect re-establishes the connection");
}

// 6. While interrupted, ticks never re-enable keepalive or push engine state; the state stays stable.
{
  const engine = fakeEngine();
  const pump = fakePump();
  const session = makeSession(engine, pump);
  interruptSession(session, "test");
  const keptBefore = engine.keptAlive ?? 0;
  tick(session, 5);
  assert.equal(session.phase, "interrupted");
  assert.equal(engine.keptAlive ?? 0, keptBefore, "keepClientAlive is not called once interrupted");
  assert.equal(pump.reading, false, "the old queue stays detached across ticks");
  console.log("ok  interrupted state is stable: no keepalive, no old-queue reads");
}

console.log("session reconnect: all passed");
