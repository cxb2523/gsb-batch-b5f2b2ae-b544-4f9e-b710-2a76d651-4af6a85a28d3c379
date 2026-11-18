import test from "node:test";
import assert from "node:assert/strict";
import {
  installFakeBrowser,
  uninstallFakeBrowser,
  FakeAudio,
  FakeTimers
} from "./fake-web-audio.mjs";

installFakeBrowser();
const { AutoDjPlayer } = await import("../src/player.js");

function analysis(overrides = {}) {
  return {
    duration: 300,
    cueIn: 0,
    cueOut: 290,
    mixPoint: 240,
    entryPoint: 5,
    mixableIntro: 60,
    mixableOutro: 60,
    bpm: 120,
    energy: 0.5,
    phraseAnchor: 0,
    phraseInterval: 8, // 16 beats @120bpm
    beatInterval: 0.5,
    ...overrides
  };
}

function track(id, overrides = {}) {
  return {
    id,
    name: id,
    url: `memory://${id}.mp3`,
    analysis: analysis(overrides)
  };
}

// Build a player with two ready decks and a controllable "next" selector.
async function makePlayer({ next = null, logs = [] } = {}) {
  const player = new AutoDjPlayer({ onLog: (m) => logs.push(m) });
  await player.ensureAudio();
  const current = track("t1");
  player.currentTrack = current;
  player.decks[0].audio.src = current.url;
  player.decks[0].gain.gain.value = 1;
  player.decks[0].audio.duration = current.analysis.duration;
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) {
      player.commits = player.commits ?? [];
      player.commits.push(options.commitId);
      return next;
    }
    return options.peek ? next : next;
  };
  return { player, current };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

test.beforeEach(() => {
  FakeAudio.failingSrcs = [];
  globalThis.__fakeTimers?.reset();
});

test.after(() => uninstallFakeBrowser());

// ---------------------------------------------------------------------------
// Plan identity
// ---------------------------------------------------------------------------

test("planFor ignores a plan built for a different incoming track", async () => {
  const { player } = await makePlayer();
  const next = track("t2");
  player.plannedTransition = { toTrackId: "someone-else", durationSeconds: 3 };

  assert.equal(player.planFor(next), null, "stale plan must not match");

  player.plannedTransition = { toTrackId: "t2", durationSeconds: 3 };
  assert.equal(player.planFor(next)?.durationSeconds, 3, "matching plan is used");
});

test("planFor ignores a plan whose outgoing track no longer plays", async () => {
  const { player } = await makePlayer();
  const next = track("t2");
  player.plannedTransition = { fromTrackId: "old", toTrackId: "t2" };
  assert.equal(player.planFor(next), null);

  player.plannedTransition = { fromTrackId: "t1", toTrackId: "t2" };
  assert.notEqual(player.planFor(next), null);
});

test("planFor rejects consumed plans and plans with no identity", async () => {
  const { player } = await makePlayer();
  const next = track("t2");
  player.plannedTransition = { toTrackId: "t2", consumed: true };
  assert.equal(player.planFor(next), null);

  player.plannedTransition = { durationSeconds: 10 };
  assert.equal(player.planFor(next), null, "identity-less plan is not trusted");
});

test("planFor accepts track-like reference fields as identity", async () => {
  const { player } = await makePlayer();
  const next = track("t2");
  player.plannedTransition = { toTrack: { id: "t2" } };
  assert.notEqual(player.planFor(next), null);
});

// ---------------------------------------------------------------------------
// Automatic transition: plan applied once, then consumed
// ---------------------------------------------------------------------------

test("transitionNow applies a matching plan then consumes it", async () => {
  const { player } = await makePlayer();
  const next = track("t2", { entryPoint: 40, mixableIntro: 90, mixableOutro: 90 });
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return next;
  };
  player.plannedTransition = {
    fromTrackId: "t1",
    toTrackId: "t2",
    toEntryPoint: 12,
    fromMixPoint: 250,
    durationSeconds: 6,
    curve: "cut",
    beatmatch: false
  };

  await player.transitionNow();
  await flush();

  // Entry point from the plan, not the per-track entryPoint (40) or cue-in.
  assert.equal(player.decks[1].audio.currentTime, 12);
  assert.equal(player.committed, "t2");
  assert.equal(player.plannedTransition, null, "plan is consumed once applied");
  // beatmatch disabled by the plan: incoming rate stays native.
  assert.equal(player.decks[1].rate, 1);

  // Lifecycle: one pending auto-finish timer, armed with the plan's duration.
  assert.ok(player.transitionTimer);
  const timer = globalThis.__fakeTimers.timeouts.get(player.transitionTimer);
  assert.equal(timer.ms, 6000, "plan durationSeconds drives the fade length");
});

test("a consumed plan is not applied to the next pair", async () => {
  const { player } = await makePlayer();
  const second = track("t2", { entryPoint: 40, mixableIntro: 90, mixableOutro: 90 });
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return second;
  };
  const plan = {
    fromTrackId: "t1",
    toTrackId: "t2",
    toEntryPoint: 12,
    durationSeconds: 6,
    beatmatch: false,
    curve: "cut"
  };
  player.plannedTransition = plan;

  await player.transitionNow();
  await flush();
  // Finish the auto transition into t2.
  player.finalizeTransition(player.transitionSession);
  assert.equal(player.currentTrack?.id, "t2");

  // Simulate the frontend re-assigning its cached (now consumed) plan object,
  // which is exactly the leftover-plan bug.
  player.plannedTransition = plan;

  // Now t2 -> t3; the old plan targets t2 and must not be reused.
  const third = track("t3", { entryPoint: 30, mixableIntro: 90, mixableOutro: 90 });
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return third;
  };

  await player.transitionNow();
  await flush();

  assert.equal(player.planFor(third), null);
  // Falls back to the per-track entry point (30), not the plan's 12.
  assert.equal(player.decks[0].audio.currentTime, 30);
});

test("without a plan the layout matches the legacy per-track heuristics", async () => {
  const { player } = await makePlayer();
  const next = track("t2", {
    entryPoint: 5,
    phraseAnchor: 0,
    phraseInterval: 8,
    mixableIntro: 60,
    mixableOutro: 60
  });
  player.getNextTrack = () => next;
  player.plannedTransition = null;

  await player.transitionNow();
  await flush();

  // entryPoint (5) is preferred over the phrase-aligned cue-in (0) in radio-edit
  // mode, as before.
  assert.equal(player.decks[1].audio.currentTime, 5);
});

// ---------------------------------------------------------------------------
// Manual takeover of an automatic transition
// ---------------------------------------------------------------------------

async function startAutoTransition(player) {
  const next = track("t2", { mixableIntro: 90, mixableOutro: 90 });
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return next;
  };
  await player.transitionNow();
  await flush();
  return next;
}

test("manual takeover cancels the auto-finish timer so it cannot fire twice", async () => {
  const { player } = await makePlayer();
  await startAutoTransition(player);
  assert.equal(player.transitionSession.kind, "auto");
  const autoSession = player.transitionSession;

  // Capture the callback before the takeover cancels it, then replay it after
  // the takeover to prove the guarded callback is inert.
  const pending = globalThis.__fakeTimers.takeTimeouts();
  assert.equal(pending.length, 1, "auto path armed exactly one finish timer");

  player.setManualCrossfade(0.1); // register resting position
  player.setManualCrossfade(0.6); // take over

  assert.equal(player.transitionSession.kind, "manual");
  assert.equal(player.transitionTimer, null, "no raw timer left behind");
  assert.equal(player.manualTransition, true);
  assert.equal(player.currentTrack?.id, "t1", "still transitioning");

  for (const fire of pending) fire();
  assert.equal(player.currentTrack?.id, "t1", "replayed auto timer did nothing");
  assert.equal(player.isTransitioning, true);
  assert.equal(autoSession.state, "running");
});

test("manual takeover and finish calls finalize exactly once", async () => {
  const { player } = await makePlayer();
  await startAutoTransition(player);
  const pending = globalThis.__fakeTimers.takeTimeouts();
  const autoSession = player.transitionSession;

  player.setManualCrossfade(0.0);
  player.setManualCrossfade(0.6); // takeover + partial blend
  player.setManualCrossfade(1.0); // reach the far end -> finalize

  assert.equal(player.currentTrack?.id, "t2");
  assert.equal(player.isTransitioning, false);
  assert.equal(player.manualTransition, false);
  assert.equal(player.manualNext, null);
  assert.equal(player.transitionSession, null);
  assert.equal(autoSession.state, "done");

  // Replaying the cancelled auto-finish timer after the manual finalize must not
  // swap decks again or restart a transition.
  for (const fire of pending) fire();
  assert.equal(player.currentTrack?.id, "t2");
  assert.equal(player.isTransitioning, false);
  assert.equal(player.transitionSession, null);
  player.finalizeTransition(autoSession); // idempotent
  assert.equal(player.currentTrack?.id, "t2");
});

test("failed manual load restores both decks and all manual state", async () => {
  const { player } = await makePlayer();
  const next = track("t2");
  player.getNextTrack = () => next;
  FakeAudio.failingSrcs = ["t2.mp3"];

  player.setManualCrossfade(0.0); // resting position
  player.setManualCrossfade(0.5); // begin manual transition, play() rejects
  await flush();

  assert.equal(player.isTransitioning, false);
  assert.equal(player.manualTransition, false);
  assert.equal(player.manualLoading, false);
  assert.equal(player.manualNext, null);
  assert.equal(player.transitionSession, null);
  assert.equal(player.transitionTimer, null);

  const fromDeck = player.decks[0];
  const toDeck = player.decks[1];
  assert.equal(fromDeck.gain.gain.value, 1, "outgoing gain restored");
  assert.equal(toDeck.gain.gain.value, 0, "incoming silent");
  assert.equal(toDeck.audio.src, "", "incoming source cleared");
  assert.equal(toDeck.rate, 1);
  assert.equal(fromDeck.rate, 1);
  // No scheduled auto-finish timer survives the aborted transition.
  assert.equal(globalThis.__fakeTimers.pendingTimeoutCount, 0);
});

test("failed automatic load aborts cleanly without committing the queue", async () => {
  const { player } = await makePlayer();
  const next = track("t2");
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return next;
  };
  FakeAudio.failingSrcs = ["t2.mp3"];

  await player.transitionNow();
  await flush();

  assert.equal(player.isTransitioning, false);
  assert.equal(player.transitionSession, null);
  assert.equal(player.committed, undefined, "queue not committed");
  assert.equal(player.decks[0].gain.gain.value, 1);
});

test("a manual takeover while the auto incoming is still loading owns the blend", async () => {
  const { player } = await makePlayer();
  const next = track("t2", { mixableIntro: 90, mixableOutro: 90 });
  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return next;
  };
  // Hold the incoming deck's play() until released.
  const gate = FakeTimers.deferred();
  FakeAudio.pendingPlay.set(next.url, gate);

  const pendingTransition = player.transitionNow();
  await flush();
  assert.equal(player.transitionSession?.kind, "auto");
  assert.equal(player.transitionSession?.state, "loading");

  player.setManualCrossfade(0.0);
  player.setManualCrossfade(0.6); // takeover during load

  assert.equal(player.transitionSession.kind, "manual");
  assert.equal(player.manualTransition, true);
  assert.equal(player.manualLoading, false, "a takeover never blocks the fader");

  gate.resolve();
  await pendingTransition;
  await flush();

  // The auto path resumed after the load but must not arm a timer or schedule a
  // crossfade behind the manual blend; the session stays manual/running.
  assert.equal(player.transitionSession.kind, "manual");
  assert.equal(player.transitionSession.state, "running");
  assert.equal(player.transitionTimer, null);
  assert.equal(player.isTransitioning, true);
  assert.equal(player.committed, "t2");

  // The fader position captured during the load is applied once the deck plays.
  const [, inGain] = [Math.cos(0.3 * Math.PI), Math.sin(0.3 * Math.PI)];
  assert.ok(Math.abs(player.decks[1].gain.gain.value - inGain) < 1e-6);
  assert.ok(Math.abs(player.decks[0].gain.gain.value - Math.cos(0.3 * Math.PI)) < 1e-6);
});

test("a fresh plan for each pair is applied to its own pair only", async () => {
  const { player } = await makePlayer();
  const t2 = track("t2", { entryPoint: 40, mixableIntro: 90, mixableOutro: 90 });
  const t3 = track("t3", { entryPoint: 50, mixableIntro: 90, mixableOutro: 90 });

  player.getNextTrack = (from, options = {}) => {
    if (options.commitId) player.committed = options.commitId;
    return from?.id === "t1" ? t2 : t3;
  };

  // Pair 1 -> 2 with its own plan.
  player.plannedTransition = {
    fromTrackId: "t1",
    toTrackId: "t2",
    toEntryPoint: 12,
    durationSeconds: 5,
    beatmatch: false
  };
  await player.transitionNow();
  await flush();
  assert.equal(player.decks[1].audio.currentTime, 12);
  player.finalizeTransition(player.transitionSession);

  // Pair 2 -> 3 with its own plan (different entry).
  const plan23 = {
    fromTrackId: "t2",
    toTrackId: "t3",
    toEntryPoint: 22,
    durationSeconds: 7,
    beatmatch: false
  };
  player.plannedTransition = plan23;
  await player.transitionNow();
  await flush();

  assert.equal(player.currentTrack?.id, "t2");
  assert.equal(player.decks[0].audio.currentTime, 22, "pair-2 plan drives pair 2");
  assert.equal(player.plannedTransition, null);
  const timer = globalThis.__fakeTimers.timeouts.get(player.transitionTimer);
  assert.equal(timer.ms, 7000, "pair-2 duration applied");

  // A stale pair-1 plan object is never reused.
  player.finalizeTransition(player.transitionSession);
  player.plannedTransition = { fromTrackId: "t1", toTrackId: "t2", toEntryPoint: 12 };
  const t4 = track("t4", { entryPoint: 60 });
  player.getNextTrack = () => t4;
  await player.transitionNow();
  await flush();
  assert.equal(player.decks[1].audio.currentTime, 60, "no stale plan applied");
});

test("stop() clears the plan, manual state and any transition timer", async () => {
  const { player } = await makePlayer();
  await startAutoTransition(player);
  player.setManualCrossfade(0.1);
  player.setManualCrossfade(0.6); // takeover

  player.stop();

  assert.equal(player.plannedTransition, null);
  assert.equal(player.transitionSession, null);
  assert.equal(player.transitionTimer, null);
  assert.equal(player.isTransitioning, false);
  assert.equal(player.manualTransition, false);
  assert.equal(player.manualLoading, false);
  assert.equal(player.manualNext, null);
  assert.equal(player.currentTrack, null);
  for (const deck of player.decks) {
    assert.equal(deck.rate, 1);
    assert.equal(deck.audio.playbackRate, 1);
  }
});
