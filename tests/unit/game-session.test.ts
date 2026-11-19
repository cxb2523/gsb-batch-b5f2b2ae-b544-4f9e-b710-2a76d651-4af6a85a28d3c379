import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_GAME_SESSION_KEY,
  ACTIVE_GAME_SESSION_VERSION,
  type ActiveGameSession,
  clearActiveGameSession,
  getDailySessionExpiresAt,
  readActiveGameSession,
  writeActiveGameSession,
} from '../../src/components/game/game-session';

interface MemoryStorage {
  getItem(key: string): string | null;
  has(key: string): boolean;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function createMemoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    has: (key) => entries.has(key),
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

function createEmptyBoard(): ActiveGameSession['board'] {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function createSession(
  overrides: Partial<ActiveGameSession> = {}
): ActiveGameSession {
  return {
    board: createEmptyBoard(),
    challengeComplete: false,
    combo: 0,
    dailyDate: '2026-11-19',
    elapsedSeconds: 12,
    gameOver: false,
    generation: 1,
    mode: 'daily',
    movesWithoutClear: 0,
    pieces: [
      { cells: [[0, 0]], color: 'yellow', id: 'p0', key: 'single' },
      { cells: [[0, 0]], color: 'blue', id: 'p1', key: 'single' },
      { cells: [[0, 0]], color: 'red', id: 'p2', key: 'single' },
    ],
    roundId: 'round-test-1',
    score: 42,
    seed: 7,
    version: ACTIVE_GAME_SESSION_VERSION,
    ...overrides,
  };
}

function store(storage: MemoryStorage, session: unknown) {
  storage.setItem(ACTIVE_GAME_SESSION_KEY, JSON.stringify(session));
}

describe('active game session', () => {
  it('keeps a daily round resumable after midnight on the same night', () => {
    const storage = createMemoryStorage();
    store(storage, createSession({ dailyDate: '2026-11-19' }));

    const lookup = readActiveGameSession('2026-11-20', {
      now: new Date(2026, 10, 20, 0, 5),
      storage,
    });

    assert.equal(lookup.status, 'active');
    if (lookup.status !== 'active') return;
    // The round keeps the date it started with, so the board and piece
    // sequence stay identical after midnight.
    assert.equal(lookup.session.dailyDate, '2026-11-19');
    assert.equal(lookup.session.score, 42);
    assert.equal(storage.has(ACTIVE_GAME_SESSION_KEY), true);
  });

  it('still resumes at the last second of the following day', () => {
    const storage = createMemoryStorage();
    store(storage, createSession({ dailyDate: '2026-11-19' }));

    const lookup = readActiveGameSession('2026-11-20', {
      now: new Date(2026, 10, 20, 23, 59, 59),
      storage,
    });

    assert.equal(lookup.status, 'active');
  });

  it('reports and clears a daily save once the grace window has passed', () => {
    const storage = createMemoryStorage();
    store(storage, createSession({ dailyDate: '2026-11-19' }));

    const lookup = readActiveGameSession('2026-11-21', {
      now: new Date(2026, 10, 21, 0, 0),
      storage,
    });

    assert.equal(lookup.status, 'expired');
    if (lookup.status !== 'expired') return;
    assert.equal(lookup.session.dailyDate, '2026-11-19');
    assert.equal(lookup.session.score, 42);
    assert.equal(storage.has(ACTIVE_GAME_SESSION_KEY), false);
  });

  it('never expires classic rounds', () => {
    const storage = createMemoryStorage();
    store(
      storage,
      createSession({ dailyDate: null, mode: 'classic', roundId: 'classic-1' })
    );

    const lookup = readActiveGameSession('2027-03-01', {
      now: new Date(2027, 2, 1, 12, 0),
      storage,
    });

    assert.equal(lookup.status, 'active');
  });

  it('rejects a daily save without a start date', () => {
    const storage = createMemoryStorage();
    store(storage, createSession({ dailyDate: null }));

    const lookup = readActiveGameSession('2026-11-19', {
      now: new Date(2026, 10, 19, 12, 0),
      storage,
    });

    // A daily round must always carry the date it started on.
    assert.equal(lookup.status, 'invalid');
    assert.equal(storage.has(ACTIVE_GAME_SESSION_KEY), false);
  });

  it('clears corrupted saves instead of leaving them behind', () => {
    const storage = createMemoryStorage();
    storage.setItem(ACTIVE_GAME_SESSION_KEY, '{not-json');

    const lookup = readActiveGameSession('2026-11-19', { storage });

    assert.equal(lookup.status, 'invalid');
    assert.equal(storage.has(ACTIVE_GAME_SESSION_KEY), false);
  });

  it('rejects structurally invalid saves', () => {
    const storage = createMemoryStorage();
    store(storage, { ...createSession(), score: -1 });

    const lookup = readActiveGameSession('2026-11-19', { storage });

    assert.equal(lookup.status, 'invalid');
    assert.equal(storage.has(ACTIVE_GAME_SESSION_KEY), false);
  });

  it('upgrades a version 4 save with a round id', () => {
    const storage = createMemoryStorage();
    const legacy = { ...createSession(), roundId: undefined, version: 4 };
    store(storage, legacy);

    const lookup = readActiveGameSession('2026-11-19', {
      now: new Date(2026, 10, 19, 9, 0),
      storage,
    });

    assert.equal(lookup.status, 'active');
    if (lookup.status !== 'active') return;
    assert.equal(lookup.session.version, ACTIVE_GAME_SESSION_VERSION);
    assert.ok(lookup.session.roundId.length > 0);

    const persisted = JSON.parse(
      storage.getItem(ACTIVE_GAME_SESSION_KEY) ?? '{}'
    ) as ActiveGameSession;
    assert.equal(persisted.version, ACTIVE_GAME_SESSION_VERSION);
    assert.equal(persisted.roundId, lookup.session.roundId);
  });

  it('round-trips writes and honours explicit clearing', () => {
    const storage = createMemoryStorage();
    writeActiveGameSession(createSession(), storage);
    assert.equal(
      readActiveGameSession('2026-11-19', { storage }).status,
      'active'
    );

    clearActiveGameSession(storage);
    assert.equal(
      readActiveGameSession('2026-11-19', { storage }).status,
      'empty'
    );
  });

  it('degrades to an empty lookup without storage access', () => {
    assert.equal(
      readActiveGameSession('2026-11-19', { storage: null }).status,
      'empty'
    );
  });

  it('computes the expiry as the start of the day after next', () => {
    const expiresAt = getDailySessionExpiresAt('2026-11-19');
    assert.equal(expiresAt, new Date(2026, 10, 21, 0, 0).getTime());
    assert.equal(getDailySessionExpiresAt('not-a-date'), null);
  });
});
