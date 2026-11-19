// A guest: loads the same map in its own engine, then parks its local server and connects its client to the host's
// server instead. The pump worker forwards the client's packets to the host and writes the host's replies back.
import { CONNECTION, SLOT } from "../engine/builds.js";
import { EngineMemory, NORMAL_SPEED } from "../engine/memory.js";
import { applyGameSettings, BASE, currentGuns, currentHorde, currentSlug, devmapZone, go, insertBeforeDevmap, latestView, MAP_NAMES, screen as pageScreen } from "../game/page.js";
import { send } from "../net/pump.js";
import { introduce } from "./messages.js";
import { validSeat } from "./session.js";

const HOST_GONE_MS = 10000;
// Packet-level heartbeat: the host's pump sends pings every 2 s and game frames far more often. Nothing at all for
// this long means the host's page (or the connection to it) is gone, even if the relay has not announced the leave.
const HOST_SILENT_MS = 10000;
const STATE_REPEAT_MS = 2000;
const SPAWN_JUMP = 400; // a view jump this large means we (re)spawned
const NEAR_HOST = 300;
const HOST_POS_MAX_AGE_MS = 6000;
const SPAWN_CHECK_MS = 2000;
const SPAWN_TRIES = 2;
const EYE_HEIGHT = 62;
// Players are solid to each other: a guest put exactly where the host stands is stuck inside them, unable to move.
// Guests go to a spot the host walked over recently, clear of the host but still close.
const SPOT_MIN = 48;
const SPOT_MAX = 250;
const SPOT_MAX_DZ = 40;
const SPOT_STEP = 16;

/** Each seat has its own qport range, so guests never collide with each other or with the host (7). */
export const guestQport = (seat) => 1000 + 10000 * (seat - 1) + 1 + Math.floor(Math.random() * 9999);

/** Opens the host's map on this page if it is not the one already open. */
export function followHostMap(session) {
  const info = session.hostInfo;
  if (!info?.slug || session.engine) return;
  const guns = info.guns === "cs" ? "cs" : "classic";
  if (currentSlug() === info.slug && currentHorde() === Boolean(info.horde) && currentGuns() === guns) return;
  session.phase = "following";
  go(`${BASE}${info.slug}?coop=join&coopRoom=${session.room}&mode=single&guns=${guns}${info.horde ? "&horde=1" : ""}${session.relayParam}`);
}

/** Called right before the engine starts: waits for the host's map details and copies its game settings. */
export async function prepareGuest(session, Module, args) {
  const info = await until(() => (session.hostInfo?.zone ? session.hostInfo : null), 30000);
  if (!info) throw new Error("hostNoAnswer");
  if (info.hash && info.hash !== session.hash) throw new Error("versionMismatch");
  const zone = devmapZone(args);
  if (zone !== info.zone) throw new Error(`hostPlaying:${MAP_NAMES[info.slug] ?? info.zone}`);
  if (Array.isArray(info.gameArgs)) applyGameSettings(args, info.gameArgs);
  // The client side of vel.gg's co-op rules, as its multiplayer page starts a friend (minus its own transport).
  insertBeforeDevmap(args, ["+set", "kisak_web_coop", "1", "+set", "kisak_coop_players", "1"]);

  const engine = new EngineMemory(Module, session.build);
  if (!engine.mailboxesIdle()) throw new Error("unexpectedMemory");
  session.engine = engine;
  session.zone = zone;
  session.pump.postMessage({
    type: "attach",
    buffer: engine.buffer,
    loopback: session.build.loopback,
    reads: [{ seat: 0, base: engine.queueAt(1) }], // our client's outgoing packets, for the host
    writeBase: engine.queueAt(0), // the host's packets, for our client
    ports: { 0: 0 },
    reading: false,
    injecting: false,
  });
  session.phase = "loading";
}

function until(check, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const value = check();
      if (value || Date.now() - started > timeoutMs) resolve(value ?? null);
      else setTimeout(poll, 100);
    };
    poll();
  });
}

export function guestTick(session) {
  const screen = pageScreen();
  const engine = session.engine;
  if (screen === "error" && !["ended", "failed", "interrupted"].includes(session.phase)) {
    session.phase = "ended";
    session.note("engine stopped");
  }
  // While our server is parked, our client would otherwise time out on it. Never keep a dead session alive: once the
  // host is gone the client must be allowed to notice and the card must show the reconnectable state.
  if (engine && ["freezing", "connect"].includes(session.phase)) engine.keepClientAlive();
  if (engine && ["challenging", "joining"].includes(session.phase)) {
    if (engine.dvar("clPaused")) engine.setDvar("clPaused", 0);
    if (engine.dvar("svPaused")) engine.setDvar("svPaused", 0);
  }
  if (session.peer && (session.phase !== session.sentPhase || Date.now() - (session.sentPhaseAt ?? 0) > STATE_REPEAT_MS)) introduce(session);
  if (!session.peer) session.sentPhase = null;

  // The packet heartbeat decides "session interrupted" for every in-game/connecting phase, before the step runs.
  if (engine && SESSION_PHASES.has(session.phase) && hostWentSilent(session)) interruptSession(session);

  const step = STEPS[session.phase];
  if (step) step(session, engine, screen);
}

/** Phases in which the host is expected to keep sending frames; a silent host there means the session is over. */
const SESSION_PHASES = new Set(["waiting-host", "freezing", "connect", "challenging", "joining", "connected"]);

/**
 * True once we have heard from the host at least once and then received nothing (not even its 2 s pings) past the
 * threshold. The pump worker measures the silence itself, so a half-open socket the relay never reports still counts.
 */
function hostWentSilent(session) {
  const age = session.stats?.peerAgeMs;
  return age != null && age > HOST_SILENT_MS;
}

/**
 * A host that left or went silent: tear the broken session down to a reconnectable lobby state.
 * - stop reading our client's old outgoing queue and forget every packet still queued in the pump (old queue dead);
 * - drop the engine connection and every pause marker, so the game cannot stay frozen on the host's old pause;
 * - keep seat, guest id and relay: when the host reopens the room we take the same seat again.
 */
export function interruptSession(session, why = "host silent") {
  if (session.phase === "interrupted") return;
  session.phase = "interrupted";
  session.reconnecting = false;
  session.fail("hostLeft");
  session.note(`session interrupted: ${why}`);
  // Release the old loopback queues and the pump's in-flight packets; control messages stay reachable through the
  // worker's socket, but no engine queue is read or written until reconnect reattaches them.
  session.pump?.postMessage({ type: "detach" });
  const engine = session.engine;
  if (engine) {
    engine.command("disconnect");
    // Reset the pause state the host used to own: nothing must remain paused from the old session.
    if (engine.dvar("svPaused")) engine.setDvar("svPaused", 0);
    if (engine.dvar("clPaused")) engine.setDvar("clPaused", 0);
  }
  session.paused = false;
  session.menuOpen = false;
  session.remotePause = false;
  // Forget everything the old host told us; a recovered host re-sends its info and state.
  session.hostState = null;
  session.hostPos = null;
  session.hostTrail = [];
  session.connectWaitAt = null;
  session.connectAt = 0;
  session.introReleased = false;
}

/**
 * Card "Reconnect": one attempt at a time. Reattaches the pump's queues, drops the old engine connection and walks
 * the normal join flow again from "waiting-host". A later failure returns to the same interrupted state.
 */
export function reconnectSession(session) {
  if (session.phase !== "interrupted" || session.reconnecting) return false;
  const engine = session.engine;
  if (!engine || !session.pump) return false;
  session.reconnecting = true;
  session.error = null;
  session.note("reconnecting to the host");
  // Reattach the same engine queues with a clean slate; the old queues are re-armed, but any stale contents were
  // dropped by "detach" and "read" skips what the engine wrote meanwhile.
  session.pump.postMessage({
    type: "attach",
    buffer: engine.buffer,
    loopback: session.build.loopback,
    reads: [{ seat: 0, base: engine.queueAt(1) }],
    writeBase: engine.queueAt(0),
    ports: { 0: 0 },
    reading: false,
    injecting: false,
  });
  engine.command("disconnect");
  if (engine.dvar("svPaused")) engine.setDvar("svPaused", 0);
  if (engine.dvar("clPaused")) engine.setDvar("clPaused", 0);
  session.paused = false;
  session.menuOpen = false;
  session.remotePause = false;
  session.connectWaitAt = null;
  session.connectAt = 0;
  session.hostState = null;
  session.phase = "waiting-host";
  introduce(session);
  return true;
}

const STEPS = {
  loading(session, engine, screen) {
    if (screen === "ready" || screen === "playing") session.phase = "waiting-host";
  },

  "waiting-host"(session, engine) {
    // Parking our server starts our client's timeout clock, so only do it once the host says it is our turn.
    if (session.peer && session.hostState?.ready && session.hostState.turn && validSeat(session.seat)) {
      engine.holdServer(true);
      session.heldAt = Date.now();
      session.phase = "freezing";
      session.note("parking the local server");
    }
  },

  freezing(session, engine) {
    if (engine.serverReadsPackets() && Date.now() - session.heldAt <= 5000) return;
    if (engine.serverReadsPackets()) session.note("local server still reading after 5 s, going on");
    engine.setDvar("svPaused", 0);
    session.pump.postMessage({ type: "read", dropUntilConnect: true });
    session.pump.postMessage({ type: "inject", on: false, clearInbox: true });
    session.phase = "connect";
  },

  connect(session, engine) {
    if (!session.introReleased && engine.int(session.build.introState) === 1) {
      session.introReleased = true;
      engine.Module._KB_Input?.(7, 1, 0);
    }
    // After a reload our old slot may still be on the host's server; give the host a moment to free it.
    session.connectWaitAt ??= Date.now();
    if ((session.hostState?.slot ?? 0) >= SLOT.connected && Date.now() - session.connectWaitAt < 20000) return;
    session.qport ??= guestQport(session.seat);
    if (engine.command(`setqport ${session.qport};connect LOCALHOST`)) {
      session.joinedLate = session.hostState?.screen === "playing";
      session.connectAt = Date.now();
      session.phase = "challenging";
      session.note("connect sent");
    }
  },

  challenging(session, engine) {
    const state = engine.connectionState();
    if (state >= CONNECTION.connecting && state <= CONNECTION.challenging && engine.pointClientAt(0) && engine.clientServerPort() === 0) {
      session.pump.postMessage({ type: "inject", on: true });
      session.phase = "joining";
      session.note("handshake started, passing the host's packets in");
    } else if (Date.now() - session.connectAt > 15000) {
      joinAttemptFailed(session, "connectFailed");
    }
  },

  joining(session, engine) {
    if (engine.clientServerPort() !== 0) engine.pointClientAt(0);
    if (engine.connectionState() === CONNECTION.active) {
      session.reconnecting = false;
      session.phase = "connected";
      session.lastViewOrigin = null;
      session.spawn ??= { tries: 0, sentAt: 0 };
      session.note("connected to the host");
    } else if (Date.now() - session.connectAt > 90000) {
      joinAttemptFailed(session, "notLetIn");
    }
  },

  connected(session, engine, screen) {
    if (engine.connectionState() < CONNECTION.challenging) {
      interruptSession(session, "the engine dropped the connection");
    } else if (!session.peer && session.hostLeftAt && Date.now() - session.hostLeftAt > HOST_GONE_MS) {
      interruptSession(session, "the host left the room");
    } else {
      syncGuestPause(session, engine, screen);
      // The host may keep the lobby open for minutes; a slow moment there must not time us out. If the host really
      // leaves, the packet heartbeat above interrupts the session even before the relay announces it.
      if (session.hostState?.screen !== "playing") engine.keepClientAlive();
      stayNearHost(session);
      restoreSpeed(session, engine);
    }
  },
};

/** A failed handshake: a reconnect attempt returns to the reconnectable state; the first join shows its error. */
function joinAttemptFailed(session, key) {
  if (session.reconnecting) {
    session.reconnecting = false;
    interruptSession(session, `reconnect failed (${key})`);
  } else {
    session.fail(key);
    session.phase = "failed";
  }
}

const SLOW_AFTER_HOST_MS = 1500;

/**
 * Game over slows every client down (the server's "X" command lerps the code time scale to 0.1) and hides the HUD
 * (hud_missionFailed). The restart that follows puts both back where the server runs, so only on the host: a guest
 * would stay in slow motion, which also caps its frame rate at 320 x 0.1 = 32 fps. Once the host is back at normal
 * speed and we still are not a moment later, do what the restart did there.
 */
function restoreSpeed(session, engine) {
  if (!session.hostState?.normalSpeed || engine.codeTimeScale() >= NORMAL_SPEED) {
    session.slowSince = null;
    return;
  }
  session.slowSince ??= Date.now();
  if (Date.now() - session.slowSince < SLOW_AFTER_HOST_MS || !engine.command("set hud_missionFailed 0")) return;
  engine.setCodeTimeScale(1);
  session.slowSince = null;
  session.note("back to normal speed after the host's restart");
}

/** Opening our menu pauses everyone; someone else's menu pauses us. */
function syncGuestPause(session, engine, screen) {
  const menuOpen = engine.menuOpen() && screen === "playing";
  if (menuOpen !== session.menuOpen) {
    session.menuOpen = menuOpen;
    if (session.peer) send(session, { t: "pause", on: menuOpen });
  }
  const paused = menuOpen || (session.peer && Boolean(session.remotePause));
  if (paused) {
    if (!session.paused) session.note(menuOpen ? "paused" : "paused by another player");
    if (!engine.dvar("svPaused")) engine.setDvar("svPaused", 1);
    if (!engine.dvar("clPaused")) engine.setDvar("clPaused", 1);
    engine.keepClientAlive();
  } else {
    if (session.paused) {
      engine.keepClientAlive();
      session.note("resumed");
    }
    if (engine.dvar("svPaused")) engine.setDvar("svPaused", 0);
    if (engine.dvar("clPaused")) engine.setDvar("clPaused", 0);
  }
  session.paused = paused;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Some maps spawn guests far from everyone; after each spawn, move next to the host if that happened. */
function stayNearHost(session) {
  if (session.hostState?.screen !== "playing") return;
  const view = latestView();
  if (view && view.ms !== session.lastViewMs) {
    const previous = session.lastViewOrigin;
    session.lastViewMs = view.ms;
    session.lastViewOrigin = view.origin;
    if (!previous || distance(previous, view.origin) > SPAWN_JUMP) session.spawn ??= { tries: 0, sentAt: 0 };
  }
  const pending = session.spawn;
  if (!pending || session.paused) return;
  const host = session.hostPos;
  const mine = session.lastViewOrigin;
  if (!host || Date.now() - host.at > HOST_POS_MAX_AGE_MS || !mine) return;
  if (pending.sentAt && Date.now() - pending.sentAt < SPAWN_CHECK_MS) return;
  if (distance(host.origin, mine) <= NEAR_HOST) {
    session.spawn = null;
  } else if (pending.tries >= SPAWN_TRIES) {
    session.spawn = null;
    session.note("could not get next to the host");
  } else if (moveToHost(session, pending.tries ? "spawn, retry" : "spawn")) {
    pending.sentAt = Date.now();
    pending.tries += 1;
  }
}

/**
 * A recent point of the host's trail near the host but not on top of them; null until the host has walked a bit.
 * Host positions arrive spaced out, so the path between two of them is filled in (the host walked it). Points are
 * picked at least SPOT_MIN apart and each seat takes its own, so guests do not land inside each other either.
 */
function spotNearHost(session) {
  const host = session.hostPos.origin;
  const trail = session.hostTrail ?? [];
  const flat = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const spots = [];
  const consider = (p) => {
    const d = flat(p, host);
    if (d >= SPOT_MIN && d <= SPOT_MAX && Math.abs(p[2] - host[2]) <= SPOT_MAX_DZ && spots.every((s) => flat(s, p) >= SPOT_MIN)) spots.push(p);
  };
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const to = trail[i].origin;
    consider(to);
    const from = trail[i - 1]?.origin;
    if (!from) continue;
    const steps = Math.floor(flat(from, to) / SPOT_STEP);
    for (let k = 1; k < steps; k += 1) consider(to.map((v, j) => v + ((from[j] - v) * k) / steps));
  }
  return spots.length ? spots[Math.min((session.seat ?? 1) - 1, spots.length - 1)] : null;
}

/** Teleports our player next to the host (also the card's "Go to the host" button). */
export function moveToHost(session, why) {
  const engine = session.engine;
  const host = session.hostPos;
  if (!engine || session.phase !== "connected" || !host) return false;
  if (Date.now() - (session.movedAt ?? 0) < 1000) return false;
  const spot = spotNearHost(session);
  if (!spot) return false;
  const target = [spot[0], spot[1], spot[2] + EYE_HEIGHT];
  if (!engine.command(`setviewpos ${target.map((v) => v.toFixed(1)).join(" ")}`)) return false;
  session.movedAt = Date.now();
  session.note(`moved next to the host (${why})`);
  return true;
}
