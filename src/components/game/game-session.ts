import type { GameBlockColor, GamePiece } from '@/components/game/game-engine';
import { createRoundId } from '@/components/game/game-round-id';
import { type GameMode, isGameMode } from '@/components/game/game-storage';

export interface ActiveGameSession {
  board: Array<Array<GameBlockColor | null>>;
  challengeComplete: boolean;
  combo: number;
  /**
   * The daily challenge date is fixed when the round starts. It deliberately
   * survives a date change so a game that started before midnight can be
   * resumed after midnight with the original board and piece sequence.
   */
  dailyDate: string | null;
  elapsedSeconds: number;
  gameOver: boolean;
  generation: number;
  mode: GameMode;
  movesWithoutClear: number;
  pieces: Array<GamePiece | null>;
  /** Stable identity for a single round so settlement can be made idempotent. */
  roundId: string;
  score: number;
  seed: number;
  version: 5;
}

/** Shape written by the previous release, before round ids were persisted. */
interface LegacyActiveGameSession
  extends Omit<ActiveGameSession, 'roundId' | 'version'> {
  version: 4;
  roundId?: string;
}

export const ACTIVE_GAME_SESSION_KEY = 'block-blast-active-game';
export const ACTIVE_GAME_SESSION_VERSION = 5;
const LEGACY_GAME_SESSION_VERSION = 4;

interface GameSessionStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type ActiveGameSessionLookup =
  | { status: 'empty' }
  | { status: 'active'; session: ActiveGameSession }
  | { status: 'expired'; session: ActiveGameSession }
  | { status: 'invalid' };

const BLOCK_COLORS = new Set<GameBlockColor>([
  'blue',
  'cyan',
  'green',
  'orange',
  'purple',
  'red',
  'yellow',
]);

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isBlockColor(value: unknown): value is GameBlockColor {
  return typeof value === 'string' && BLOCK_COLORS.has(value as GameBlockColor);
}

function isBoard(value: unknown): value is ActiveGameSession['board'] {
  return (
    Array.isArray(value) &&
    value.length === 8 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 8 &&
        row.every((cell) => cell === null || isBlockColor(cell))
    )
  );
}

function isPiece(value: unknown): value is GamePiece | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const piece = value as Partial<GamePiece>;
  return (
    typeof piece.id === 'string' &&
    typeof piece.key === 'string' &&
    isBlockColor(piece.color) &&
    Array.isArray(piece.cells) &&
    piece.cells.length > 0 &&
    piece.cells.every(
      (cell) =>
        Array.isArray(cell) &&
        cell.length === 2 &&
        cell.every((coordinate) => isNonNegativeInteger(coordinate))
    )
  );
}

function parseDateKeyStart(dateKey: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day);
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  ) {
    return null;
  }
  return start;
}

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && parseDateKeyStart(value) !== null;
}

/**
 * A daily save stays resumable through the end of the day after the date it
 * was started on. That covers a round begun at 23:59 and continued (or
 * refreshed) after midnight, while stale saves from older days are expired.
 */
export function getDailySessionExpiresAt(dailyDate: string): number | null {
  const start = parseDateKeyStart(dailyDate);
  if (!start) return null;
  return new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 2
  ).getTime();
}

type StoredGameSession = ActiveGameSession | LegacyActiveGameSession;

function isStoredGameSession(value: unknown): value is StoredGameSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<StoredGameSession> & { version?: unknown };
  const versionIsKnown =
    session.version === ACTIVE_GAME_SESSION_VERSION ||
    session.version === LEGACY_GAME_SESSION_VERSION;
  const legacyRoundIdValid =
    session.roundId === undefined ||
    (typeof session.roundId === 'string' && session.roundId.length > 0);
  const roundIdValid =
    session.version === LEGACY_GAME_SESSION_VERSION
      ? legacyRoundIdValid
      : typeof session.roundId === 'string' && session.roundId.length > 0;
  return (
    versionIsKnown &&
    roundIdValid &&
    isGameMode(session.mode) &&
    (session.mode === 'daily'
      ? isDateKey(session.dailyDate)
      : session.dailyDate === null) &&
    isBoard(session.board) &&
    Array.isArray(session.pieces) &&
    session.pieces.length === 3 &&
    session.pieces.every(isPiece) &&
    isNonNegativeInteger(session.score) &&
    isNonNegativeInteger(session.combo) &&
    isNonNegativeInteger(session.movesWithoutClear) &&
    isNonNegativeInteger(session.elapsedSeconds) &&
    isNonNegativeInteger(session.generation) &&
    isNonNegativeInteger(session.seed) &&
    typeof session.gameOver === 'boolean' &&
    typeof session.challengeComplete === 'boolean'
  );
}

function normalizeSession(session: StoredGameSession): ActiveGameSession {
  if (session.version === ACTIVE_GAME_SESSION_VERSION) return session;
  return {
    ...session,
    // Version 4 did not persist a round id; a fresh one keeps settlement
    // idempotent for the rest of this round.
    roundId:
      typeof session.roundId === 'string' && session.roundId.length > 0
        ? session.roundId
        : createRoundId(),
    version: ACTIVE_GAME_SESSION_VERSION,
  };
}

function isDailySessionExpired(
  session: ActiveGameSession,
  currentDailyDate: string,
  now: Date
) {
  if (session.mode !== 'daily' || session.dailyDate === null) return false;
  // A round started today is always resumable, even if the clock is slightly
  // ahead of the stored date.
  if (session.dailyDate === currentDailyDate) return false;
  const expiresAt = getDailySessionExpiresAt(session.dailyDate);
  if (expiresAt === null) return true;
  return now.getTime() >= expiresAt;
}

function expireSession(storage: GameSessionStorage) {
  try {
    storage.removeItem(ACTIVE_GAME_SESSION_KEY);
  } catch {
    // Removing an unusable save must never block the game.
  }
}

function getDefaultSessionStorage(): GameSessionStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage: GameSessionStorage | null | undefined) {
  return storage === undefined ? getDefaultSessionStorage() : storage;
}

export function readActiveGameSession(
  currentDailyDate: string,
  options: { now?: Date; storage?: GameSessionStorage | null } = {}
): ActiveGameSessionLookup {
  const storage = resolveStorage(options.storage);
  if (!storage) return { status: 'empty' };

  let stored: string | null;
  try {
    stored = storage.getItem(ACTIVE_GAME_SESSION_KEY);
  } catch {
    return { status: 'empty' };
  }
  if (!stored) return { status: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    expireSession(storage);
    return { status: 'invalid' };
  }

  if (!isStoredGameSession(parsed)) {
    expireSession(storage);
    return { status: 'invalid' };
  }

  const session = normalizeSession(parsed);
  const now = options.now ?? new Date();
  if (isDailySessionExpired(session, currentDailyDate, now)) {
    expireSession(storage);
    return { status: 'expired', session };
  }

  // Re-persist legacy sessions so the stored schema is upgraded in place.
  if (session !== parsed) {
    writeActiveGameSession(session, storage);
  }

  return { status: 'active', session };
}

export function writeActiveGameSession(
  session: ActiveGameSession,
  storage: GameSessionStorage | null = getDefaultSessionStorage()
) {
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_GAME_SESSION_KEY, JSON.stringify(session));
  } catch {
    // The in-memory game remains playable when storage is unavailable.
  }
}

export function clearActiveGameSession(
  storage: GameSessionStorage | null = getDefaultSessionStorage()
) {
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_GAME_SESSION_KEY);
  } catch {
    // The in-memory game can still return to the menu.
  }
}
