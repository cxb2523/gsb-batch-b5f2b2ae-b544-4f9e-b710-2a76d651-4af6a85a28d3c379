/**
 * room-membership.test.js
 *
 * Integration tests for the room-ownership / spectator-registration
 * invariants that the socket handler must keep consistent across every
 * membership transition:
 *
 *   join as player, spectate, unspectate, leave, disconnect, reconnect,
 *   and a spectator disconnecting.
 *
 * The rules under test
 * ────────────────────
 *   1. A user belongs to at most one room at a time, in at most one role —
 *      player and spectator are mutually exclusive.
 *   2. Switching rooms always clears the user's spectator registration in
 *      the old room (no ghost watchers).
 *   3. A reconnecting player is restored as a PLAYER and their pending
 *      disconnect auto-skip timer is cancelled.
 *   4. A spectator leaving or disconnecting only touches the spectator
 *      list — player connection flags and turn timers are untouched.
 *   5. Spectators broadcasting game:action get a game:error and nothing
 *      mutates.
 *   6. The spectator list is broadcast to everyone in the room and is never
 *      persisted, while hidden-information filtering (player) and the
 *      spectator full-state bypass both keep working.
 *
 * Scenarios mirror the acceptance brief:
 *   • player disconnect → reconnect
 *   • spectator join → disconnect
 *   • spectator switching to another game
 *   • spectator attempting a game action
 */

'use strict';

let _seq = 0;

const { startServer, stopServer } = require('./helpers/server');
const { connectSocket, disconnectSocket, waitFor, emitAck } = require('./helpers/socket');
const socketHandler = require('../../src/socket-handler');

let server;

beforeAll(async () => {
  server = await startServer();
}, 15_000);
afterAll(async () => {
  await stopServer(server);
}, 10_000);

beforeEach(() => {
  _seq += 1;
  const db = require('../../src/database');
  db.db.exec('DELETE FROM game_players; DELETE FROM games; DELETE FROM users;');
});

let _openSockets = [];
afterEach(async () => {
  await Promise.all(_openSockets.map(disconnectSocket));
  _openSockets = [];
});

async function register(username, password = 'pass1234') {
  const res = await server.api
    .post('/api/auth/register')
    .send({ username: `${username}-${_seq}`, password })
    .expect(201);
  return res.body; // { token, user: { id, username } }
}

async function connect(token) {
  const s = await connectSocket(server.url, token);
  _openSockets.push(s);
  return s;
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * Consume every event of `eventName` already buffered or arriving within
 * `ms`.  Socket.io has no "peek", so negative assertions first drain the
 * events a known earlier action produced, then watch for new ones.
 */
function drainEvents(socket, eventName, ms = 60) {
  return new Promise((resolve) => {
    const seen = [];
    const onEvent = (payload) => seen.push(payload);
    socket.on(eventName, onEvent);
    setTimeout(() => {
      socket.off(eventName, onEvent);
      resolve(seen);
    }, ms);
  });
}

/** Resolve if no `eventName` arrives within ms; reject if one does. */
async function expectNoEvent(socket, eventName, ms = 150) {
  const seen = await drainEvents(socket, eventName, ms);
  if (seen.length > 0) {
    throw new Error(`Unexpected '${eventName}' event: ${JSON.stringify(seen[0])}`);
  }
}

/** Emit a game:action and resolve once the emitter sees its own game:update. */
async function dropPiece(socket, column) {
  const upd = waitFor(socket, 'game:update');
  socket.emit('game:action', { action: 'dropPiece', column });
  return upd;
}

/**
 * Bootstrap a started, in-progress Connect Four game with two players in
 * the socket room. Connect Four has no hidden information, which keeps the
 * membership assertions focused on room state rather than filtering.
 */
async function setupConnectFour(tag) {
  const alice = await register(`${tag}-alice`);
  const bob = await register(`${tag}-bob`);

  const { body } = await server.api
    .post('/api/games')
    .set(authed(alice.token))
    .send({ name: `${tag}-game`, gameType: 'connect-four' })
    .expect(201);
  const gameId = body.gameId;

  await server.api.post(`/api/games/${gameId}/join`).set(authed(alice.token)).expect(200);
  await server.api.post(`/api/games/${gameId}/join`).set(authed(bob.token)).expect(200);

  const aliceSock = await connect(alice.token);
  const bobSock = await connect(bob.token);
  await emitAck(aliceSock, 'join_game', gameId);
  await emitAck(bobSock, 'join_game', gameId);

  const aliceStart = waitFor(aliceSock, 'game:update');
  const bobStart = waitFor(bobSock, 'game:update');
  aliceSock.emit('game:start');
  await aliceStart;
  await bobStart;

  return { gameId, alice, bob, aliceSock, bobSock };
}

/** REST spectator list for a game. */
async function spectatorList(gameId, token) {
  const res = await server.api
    .get(`/api/games/${gameId}/spectators`)
    .set(authed(token))
    .expect(200);
  return res.body.spectators;
}

const spectatorUserIds = (list) => list.map((s) => s.userId);

// ═══════════════════════════════════════════════════════════════════════════
//  1. Player disconnect → reconnect: player identity restored, timer cancelled
// ═══════════════════════════════════════════════════════════════════════════

describe('player disconnect and reconnect', () => {
  test('disconnecting mid-turn arms the auto-skip timer and marks the player offline', async () => {
    const { gameId, bob, aliceSock, bobSock } = await setupConnectFour('p1');

    // Alice (players[0]) moves first, so the turn passes to Bob.
    await dropPiece(aliceSock, 0);
    await waitFor(bobSock, 'game:update'); // Bob receives Alice's move

    // The disconnect notice is broadcast to the REMAINING socket (Alice).
    const aliceNotice = waitFor(aliceSock, 'game:update');
    const aliceWarning = waitFor(aliceSock, 'game:turn_warning');
    await disconnectSocket(bobSock);
    _openSockets = _openSockets.filter((s) => s !== bobSock);

    const disconnectUpdate = await aliceNotice;
    expect(disconnectUpdate.events.some((e) => e.type === 'PLAYER_DISCONNECTED')).toBe(true);
    const bobPlayer = disconnectUpdate.state.players.find((p) => p.userId === bob.user.id);
    expect(bobPlayer.connected).toBe(false);

    // It's Bob's turn (Connect Four never blocks the timer) — countdown armed.
    await aliceWarning;
    expect(socketHandler.hasPendingTurnTimeout(gameId, bob.user.id)).toBe(true);
  });

  test('reconnecting restores player identity, clears the timer, and the player can act', async () => {
    const { gameId, bob, aliceSock, bobSock } = await setupConnectFour('p2');

    await dropPiece(aliceSock, 0);
    await waitFor(bobSock, 'game:update'); // drain Alice's move for Bob

    // Both notices are emitted by the same disconnect handler — install the
    // listeners before disconnecting so the turn_warning can't be missed.
    const aliceDisconnect = waitFor(aliceSock, 'game:update');
    const aliceWarning = waitFor(aliceSock, 'game:turn_warning');
    await disconnectSocket(bobSock);
    _openSockets = _openSockets.filter((s) => s !== bobSock);
    await aliceDisconnect; // PLAYER_DISCONNECTED
    await aliceWarning;
    expect(socketHandler.hasPendingTurnTimeout(gameId, bob.user.id)).toBe(true);

    // ── reconnect with a fresh socket and rejoin the same room ──────────────
    const bobSock2 = await connect(bob.token);
    const reconnectState = waitFor(bobSock2, 'game:state');
    const aliceReconnectNotice = waitFor(aliceSock, 'game:update');
    await emitAck(bobSock2, 'join_game', gameId);

    const { state } = await reconnectState;
    const rejoined = state.players.find((p) => p.userId === bob.user.id);
    expect(rejoined.connected).toBe(true);

    // Restored as a PLAYER: not on the spectator list, and the state carries
    // player action decorations rather than the spectator view (a spectator
    // receives neither validActions nor actionDescriptors).
    expect((state.spectators || []).some((s) => s.userId === bob.user.id)).toBe(false);
    expect(Array.isArray(state.validActions)).toBe(true);
    // It's Bob's turn, so the player view surfaces his available moves.
    expect(state.validActions.length).toBeGreaterThan(0);

    // Pending auto-skip timer cancelled on rejoin.
    expect(socketHandler.hasPendingTurnTimeout(gameId, bob.user.id)).toBe(false);

    // Alice's room-wide update shows Bob connected again and not spectating.
    const aliceView = await aliceReconnectNotice;
    const alicesBob = aliceView.state.players.find((p) => p.userId === bob.user.id);
    expect(alicesBob.connected).toBe(true);
    expect(aliceView.state.spectators.map((s) => s.userId)).not.toContain(bob.user.id);

    // Bob is a fully operational player again — his move is accepted and
    // broadcast. (It's still Bob's turn because the timer never fired.)
    const bobMove = waitFor(bobSock2, 'game:update');
    const aliceSeesMove = waitFor(aliceSock, 'game:update');
    bobSock2.emit('game:action', { action: 'dropPiece', column: 4 });
    const moveUpdate = await bobMove;
    await aliceSeesMove;
    expect(moveUpdate.state.board[5][4]).toBe(bob.user.id);
  });

  test('rejoin as a player purges any spectator registration held by an earlier socket', async () => {
    // Reproduces the bug from the brief: the user spectated a room on an old
    // socket whose registration outlived it, then reconnects as a player.
    // Without the global sweep, rejoin would keep treating them as a
    // spectator and reject their actions.
    const { gameId, aliceSock } = await setupConnectFour('p3');
    const dave = await register('p3-dave');

    const daveSock = await connect(dave.token);
    await emitAck(daveSock, 'spectate', gameId);
    await drainEvents(aliceSock, 'game:update');
    expect(spectatorUserIds(await spectatorList(gameId, dave.token))).toContain(dave.user.id);

    // Old socket drops; a new one spectates the same room.
    await disconnectSocket(daveSock);
    _openSockets = _openSockets.filter((s) => s !== daveSock);
    await new Promise((r) => setTimeout(r, 50));
    expect(await spectatorList(gameId, dave.token)).toEqual([]);

    const daveSock2 = await connect(dave.token);
    await emitAck(daveSock2, 'spectate', gameId);
    await drainEvents(aliceSock, 'game:update');
    expect(spectatorUserIds(await spectatorList(gameId, dave.token))).toContain(dave.user.id);

    await disconnectSocket(daveSock2);
    _openSockets = _openSockets.filter((s) => s !== daveSock2);
    await new Promise((r) => setTimeout(r, 50));
    expect(await spectatorList(gameId, dave.token)).toEqual([]);

    // Reconnect as a PLAYER — even if a stale spectator entry had survived,
    // the join path must purge it before restoring player identity.
    const daveSock3 = await connect(dave.token);
    const joinState = waitFor(daveSock3, 'game:state');
    await emitAck(daveSock3, 'join_game', gameId);
    const { state } = await joinState;

    expect((state.spectators || []).map((s) => s.userId)).not.toContain(dave.user.id);
    expect(Array.isArray(state.validActions)).toBe(true);
    expect(await spectatorList(gameId, dave.token)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Spectator join → disconnect: only the spectator list is touched
// ═══════════════════════════════════════════════════════════════════════════

describe('spectator join and disconnect', () => {
  test('joining broadcasts the spectator list to the whole room', async () => {
    const { gameId, alice, aliceSock } = await setupConnectFour('s1');
    const carol = await register('s1-carol');
    const carolSock = await connect(carol.token);

    const aliceUpdate = waitFor(aliceSock, 'game:update');
    const carolState = waitFor(carolSock, 'game:state');
    await emitAck(carolSock, 'spectate', gameId);

    const roomUpdate = await aliceUpdate;
    expect(roomUpdate.state.spectators).toHaveLength(1);
    expect(roomUpdate.state.spectators[0].userId).toBe(carol.user.id);
    expect(roomUpdate.events.some((e) => e.type === 'SPECTATOR_JOINED')).toBe(true);

    const carolView = await carolState;
    expect(carolView.state.spectators[0].userId).toBe(carol.user.id);
    // Spectator view has no player action decorations.
    expect(carolView.state.validActions).toBeUndefined();
    expect(carolView.state.actionDescriptors).toBeUndefined();

    // Runtime only — the persisted REST game state carries no spectators key.
    const rest = await server.api.get(`/api/games/${gameId}`).set(authed(alice.token)).expect(200);
    expect(rest.body.state.spectators).toBeUndefined();
  });

  test('spectator disconnect removes them from the list without touching player state or timers', async () => {
    const { gameId, alice, bob, aliceSock, bobSock } = await setupConnectFour('s2');
    const carol = await register('s2-carol');
    const carolSock = await connect(carol.token);
    await emitAck(carolSock, 'spectate', gameId);
    await drainEvents(aliceSock, 'game:update'); // SPECTATOR_JOINED broadcast

    // No PLAYER_DISCONNECTED update may be emitted for a spectator leaving.
    const noPlayerUpdate = expectNoEvent(aliceSock, 'game:update');
    await disconnectSocket(carolSock);
    _openSockets = _openSockets.filter((s) => s !== carolSock);
    await noPlayerUpdate;

    // Spectator list cleared via REST (the runtime map, not persisted state).
    expect(await spectatorList(gameId, alice.token)).toEqual([]);

    // Both players remain connected — the spectator's disconnect never
    // reached setPlayerConnected.
    const rest = await server.api.get(`/api/games/${gameId}`).set(authed(alice.token)).expect(200);
    for (const id of [alice.user.id, bob.user.id]) {
      const p = rest.body.state.players.find((pl) => pl.userId === id);
      expect(p.connected).toBe(true);
    }

    // No turn timer exists for either player.
    expect(socketHandler.hasPendingTurnTimeout(gameId, alice.user.id)).toBe(false);
    expect(socketHandler.hasPendingTurnTimeout(gameId, bob.user.id)).toBe(false);

    // Room is still playable — Alice (first player) can still move.
    const upd = await dropPiece(aliceSock, 1);
    expect(upd.state.status).toBe('playing');
    await waitFor(bobSock, 'game:update');
  });

  test('unspectate leaves the room and removes the registration silently', async () => {
    const { gameId, aliceSock } = await setupConnectFour('s3');
    const carol = await register('s3-carol');
    const carolSock = await connect(carol.token);
    await emitAck(carolSock, 'spectate', gameId);
    await drainEvents(aliceSock, 'game:update'); // SPECTATOR_JOINED broadcast

    const noUpdate = expectNoEvent(aliceSock, 'game:update');
    carolSock.emit('unspectate');
    await noUpdate;
    expect(await spectatorList(gameId, carol.token)).toEqual([]);

    // The spectator no longer receives room traffic: an Alice move is not
    // delivered to Carol's socket.
    const noMove = expectNoEvent(carolSock, 'game:update');
    await dropPiece(aliceSock, 2);
    await noMove;
  });

  test('spectator leave_game only clears the spectator list', async () => {
    const { gameId, alice, aliceSock } = await setupConnectFour('s4');
    const carol = await register('s4-carol');
    const carolSock = await connect(carol.token);
    await emitAck(carolSock, 'spectate', gameId);
    await drainEvents(aliceSock, 'game:update');

    const noUpdate = expectNoEvent(aliceSock, 'game:update');
    carolSock.emit('leave_game');
    await noUpdate;

    expect(await spectatorList(gameId, carol.token)).toEqual([]);
    expect(socketHandler.hasPendingTurnTimeout(gameId, alice.user.id)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. Spectator switching to another game: old room's list is cleaned
// ═══════════════════════════════════════════════════════════════════════════

describe('spectator switching rooms', () => {
  test('spectating a second game removes the user from the first room', async () => {
    const gameA = await setupConnectFour('a');
    const gameB = await setupConnectFour('b');
    const erin = await register('switch-erin');
    const erinSock = await connect(erin.token);

    // Spectate game A and consume the join broadcasts on both rooms.
    await emitAck(erinSock, 'spectate', gameA.gameId);
    await drainEvents(gameA.aliceSock, 'game:update');
    expect(spectatorUserIds(await spectatorList(gameA.gameId, erin.token))).toContain(erin.user.id);
    expect(await spectatorList(gameB.gameId, erin.token)).toEqual([]);

    // Switch to game B on the same socket.
    await emitAck(erinSock, 'spectate', gameB.gameId);
    await drainEvents(gameB.aliceSock, 'game:update');

    expect(await spectatorList(gameA.gameId, erin.token)).toEqual([]);
    const inB = await spectatorList(gameB.gameId, erin.token);
    expect(spectatorUserIds(inB)).toEqual([erin.user.id]);

    // Erin only receives traffic from game B now.
    const noTrafficInA = expectNoEvent(erinSock, 'game:update');
    await dropPiece(gameA.aliceSock, 0);
    await waitFor(gameA.bobSock, 'game:update');
    await noTrafficInA;

    // Chat from Erin is tagged spectator and only lands in game B.
    const bChat = waitFor(gameB.aliceSock, 'chat:message');
    const aNoChat = expectNoEvent(gameA.aliceSock, 'chat:message');
    erinSock.emit('chat:message', { text: 'watching B now' });
    const msg = await bChat;
    expect(msg.senderRole).toBe('spectator');
    expect(msg.username).toBe(erin.user.username);
    await aNoChat;
  });

  test('a spectator registration left on an old socket cannot survive a new spectate', async () => {
    const gameA = await setupConnectFour('c');
    const erin = await register('stale-erin');

    const erinSock1 = await connect(erin.token);
    await emitAck(erinSock1, 'spectate', gameA.gameId);
    await drainEvents(gameA.aliceSock, 'game:update');
    // First socket dies; reconnect on a fresh one and spectate the same room.
    await disconnectSocket(erinSock1);
    _openSockets = _openSockets.filter((s) => s !== erinSock1);
    await new Promise((r) => setTimeout(r, 50));

    const erinSock2 = await connect(erin.token);
    await emitAck(erinSock2, 'spectate', gameA.gameId);

    // Exactly one entry, not a duplicated ghost entry.
    const list = await spectatorList(gameA.gameId, erin.token);
    expect(list).toHaveLength(1);
    expect(list[0].userId).toBe(erin.user.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Spectators cannot take game actions
// ═══════════════════════════════════════════════════════════════════════════

describe('spectator action gating', () => {
  test('a game:action from a spectator is rejected and does not mutate the game', async () => {
    const { gameId, alice, aliceSock, bobSock } = await setupConnectFour('g1');
    const carol = await register('g1-carol');
    const carolSock = await connect(carol.token);
    await emitAck(carolSock, 'spectate', gameId);
    await drainEvents(aliceSock, 'game:update');
    await drainEvents(bobSock, 'game:update');

    const before = (
      await server.api.get(`/api/games/${gameId}`).set(authed(alice.token)).expect(200)
    ).body.state.board;

    const errorP = waitFor(carolSock, 'game:error');
    // Alice's turn — Carol tries to steal it.
    carolSock.emit('game:action', { action: 'dropPiece', column: 3 });
    const err = await errorP;
    expect(err.message).toMatch(/spectators cannot take actions/i);

    // No game:update broadcast for the rejected action, board unchanged.
    await expectNoEvent(aliceSock, 'game:update');
    await expectNoEvent(bobSock, 'game:update');
    const after = (
      await server.api.get(`/api/games/${gameId}`).set(authed(alice.token)).expect(200)
    ).body.state.board;
    expect(after).toEqual(before);

    // A real player's subsequent action still works.
    const upd = await dropPiece(aliceSock, 3);
    expect(upd.state.board[5][3]).toBe(alice.user.id);
    await waitFor(bobSock, 'game:update');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. Filtering invariants still hold after the membership rework
// ═══════════════════════════════════════════════════════════════════════════

describe('hidden-information filtering vs spectator visibility', () => {
  // Non-overlapping Battleship layouts (mirrors spectator.test.js).
  const ALICE_SHIPS = [
    { shipId: 'carrier', origin: { x: 0, y: 0 }, orientation: 'horizontal' },
    { shipId: 'battleship', origin: { x: 0, y: 2 }, orientation: 'horizontal' },
    { shipId: 'cruiser', origin: { x: 0, y: 4 }, orientation: 'horizontal' },
    { shipId: 'submarine', origin: { x: 0, y: 6 }, orientation: 'horizontal' },
    { shipId: 'destroyer', origin: { x: 0, y: 8 }, orientation: 'horizontal' },
  ];
  const BOB_SHIPS = [
    { shipId: 'carrier', origin: { x: 9, y: 0 }, orientation: 'vertical' },
    { shipId: 'battleship', origin: { x: 7, y: 0 }, orientation: 'vertical' },
    { shipId: 'cruiser', origin: { x: 5, y: 5 }, orientation: 'vertical' },
    { shipId: 'submarine', origin: { x: 3, y: 5 }, orientation: 'vertical' },
    { shipId: 'destroyer', origin: { x: 7, y: 5 }, orientation: 'vertical' },
  ];

  async function setupBattleship(tag) {
    const alice = await register(`${tag}-alice`);
    const bob = await register(`${tag}-bob`);
    const { body } = await server.api
      .post('/api/games')
      .set(authed(alice.token))
      .send({ name: `${tag}-bs`, gameType: 'battleship' })
      .expect(201);
    const gameId = body.gameId;
    await server.api.post(`/api/games/${gameId}/join`).set(authed(alice.token)).expect(200);
    await server.api.post(`/api/games/${gameId}/join`).set(authed(bob.token)).expect(200);

    const aliceSock = await connect(alice.token);
    const bobSock = await connect(bob.token);
    await emitAck(aliceSock, 'join_game', gameId);
    await emitAck(bobSock, 'join_game', gameId);

    const aStart = waitFor(aliceSock, 'game:update');
    const bStart = waitFor(bobSock, 'game:update');
    aliceSock.emit('game:start');
    await aStart;
    await bStart;

    async function act(socket, payload) {
      const upd = waitFor(socket, 'game:update');
      socket.emit('game:action', payload);
      return upd;
    }
    for (const s of ALICE_SHIPS) await act(aliceSock, { action: 'placeShip', ...s });
    for (const s of BOB_SHIPS) await act(bobSock, { action: 'placeShip', ...s });
    await act(aliceSock, { action: 'commitPlacement' });
    await act(bobSock, { action: 'commitPlacement' });

    return { gameId, alice, bob, aliceSock, bobSock };
  }

  test('a spectator switching rooms keeps full visibility while players stay filtered', async () => {
    const first = await setupBattleship('f1');
    const second = await setupBattleship('f2');
    const carol = await register('f1-carol');
    const carolSock = await connect(carol.token);

    // Spectate the first Battleship game, then switch to the second.  The
    // old room must drop Carol and the new room gives her full state.
    await emitAck(carolSock, 'spectate', first.gameId);
    expect(await spectatorList(first.gameId, carol.token)).toHaveLength(1);

    const secondStateP = waitFor(carolSock, 'game:state');
    await emitAck(carolSock, 'spectate', second.gameId);
    const { state: carolView } = await secondStateP;

    // Spectator bypass: BOTH players' ships present in the new room.
    expect(carolView.players).toHaveLength(2);
    for (const p of carolView.players) expect(p.ships).toHaveLength(5);

    // The first room no longer lists Carol and its players stay filtered.
    expect(await spectatorList(first.gameId, carol.token)).toEqual([]);
    const aliceRest = await server.api
      .get(`/api/games/${first.gameId}`)
      .set(authed(first.alice.token))
      .expect(200);
    const opponent = aliceRest.body.state.players.find((p) => p.userId === first.bob.user.id);
    expect('ships' in opponent).toBe(false);
  });
});
