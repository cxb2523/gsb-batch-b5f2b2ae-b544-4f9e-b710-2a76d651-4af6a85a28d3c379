import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCrown,
  IconFlag,
  IconHome,
  IconPuzzle,
  IconRefresh,
  IconStar,
  IconTrophy,
} from '@tabler/icons-react';
import {
  type ShouldBlockFn,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLineClearSound, useGameAudio } from '@/components/game/game-audio';
import {
  CLEAR_EFFECT_DURATION,
  GameBoardView,
  type GameClearEffect,
} from '@/components/game/game-board-view';
import { GAME_COPY, type GameCopy } from '@/components/game/game-copy';
import {
  createGameRound,
  type GameRound,
  hasPlayablePiece,
  placeGamePiece,
} from '@/components/game/game-engine';
import { GAME_MODE_TARGETS } from '@/components/game/game-mode-config';
import { GameMenu } from '@/components/game/game-menu';
import { useGamePreferences } from '@/components/game/game-preferences';
import { createRoundId } from '@/components/game/game-round-id';
import { createGameSettlementGate } from '@/components/game/game-settlement';
import {
  type ActiveGameSession,
  ACTIVE_GAME_SESSION_VERSION,
  clearActiveGameSession,
  readActiveGameSession,
  writeActiveGameSession,
} from '@/components/game/game-session';
import {
  BEST_SCORE_KEY,
  ensureScoreStorageVersion,
  getLocalDateKey,
  type GameMode,
  readBestScore,
  readScoreHistory,
  SCORE_HISTORY_KEY,
  type ScoreRecord,
} from '@/components/game/game-storage';
import { triggerHapticFeedback } from '@/lib/haptics';

const DEFAULT_BEST_SCORE = 0;

interface GameSessionNotice {
  kind: 'expired';
  date: string;
}

interface RoundIdentity {
  dailyDate: string | null;
  id: string;
}

const CELEBRATION_COLORS = [
  '#ffcf32',
  '#ff5d73',
  '#5fd6ff',
  '#6ee7a5',
  '#a978ff',
  '#ff8a3d',
] as const;

const CHALLENGE_CONFETTI = Array.from({ length: 28 }, (_, index) => {
  const side = index % 2 === 0 ? -1 : 1;
  const lane = Math.floor(index / 2);
  const distance = 52 + ((lane * 31) % 104);
  return {
    color: CELEBRATION_COLORS[index % CELEBRATION_COLORS.length],
    delay: (index % 7) * 45 + Math.floor(index / 14) * 120,
    endX: side * (distance + 24),
    id: index,
    lift: 104 + ((lane * 37) % 96),
    origin: side < 0 ? '28%' : '72%',
    peakX: side * distance,
    rotation: side * (260 + ((lane * 47) % 400)),
  };
});

function joinClasses(...values: Array<string | false | null>) {
  return values.filter(Boolean).join(' ');
}

function getModeLabel(copy: GameCopy, mode: GameMode) {
  return mode === 'classic' ? copy.classic : copy.daily;
}

function createRoundIdentity(
  mode: GameMode,
  anchorDate: string
): RoundIdentity {
  return {
    dailyDate: mode === 'daily' ? anchorDate : null,
    id: createRoundId(),
  };
}

function roundFromSession(session: ActiveGameSession): GameRound {
  return {
    board: session.board,
    combo: session.combo,
    generation: session.generation,
    movesWithoutClear: session.movesWithoutClear,
    pieces: session.pieces,
    score: session.score,
    seed: session.seed,
  };
}

export function BlockPuzzleGame({ routeMode }: { routeMode?: GameMode } = {}) {
  const navigate = useNavigate();
  const { isHydrated, preferences } = useGamePreferences();
  const [screen, setScreen] = useState<'game' | 'menu'>(
    routeMode ? 'game' : 'menu'
  );
  const [mode, setMode] = useState<GameMode>(routeMode ?? 'classic');
  const [round, setRound] = useState<GameRound>(() =>
    createGameRound(routeMode ?? 'classic', getLocalDateKey())
  );
  const [bestScore, setBestScore] = useState(DEFAULT_BEST_SCORE);
  const [gameOver, setGameOver] = useState(false);
  const [challengeComplete, setChallengeComplete] = useState(false);
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<GameSessionNotice | null>(
    null
  );
  const [clearEffect, setClearEffect] = useState<GameClearEffect | null>(null);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [, setScoreHistory] = useState<ScoreRecord[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const roundIdentityRef = useRef<RoundIdentity>(
    createRoundIdentity(routeMode ?? 'classic', getLocalDateKey())
  );
  // Mirror of the live round. State updates are asynchronous, so rapid
  // duplicate clicks must resolve against this synchronous copy to avoid
  // placing (and scoring) the same turn twice.
  const roundRef = useRef(round);
  const settlementGateRef = useRef(createGameSettlementGate());
  const bestScoreRef = useRef(DEFAULT_BEST_SCORE);
  // A round restored from storage may already be unplayable or past its goal
  // even though the game-over transition was never persisted. The restore path
  // records the pending settlement here and it is applied once below.
  const pendingRestoreSettlementRef = useRef<{
    outcome: 'challengeComplete' | 'gameOver';
    roundId: string;
    score: number;
  } | null>(null);
  const finishTimerRef = useRef<number | null>(null);
  const clearEffectIdRef = useRef(0);
  const clearEffectTimerRef = useRef<number | null>(null);
  const isResolvingRef = useRef(false);
  const isReturningHomeRef = useRef(false);
  const { board, pieces, score } = round;
  const copy = GAME_COPY[preferences.language];
  const { playSound, startMusic, stopMusic } = useGameAudio({
    musicEnabled: preferences.music,
    soundEnabled: preferences.sound,
  });
  const shouldBlockGameNavigation = useCallback<ShouldBlockFn>(
    ({ next }) => next.pathname !== '/settings',
    []
  );
  const hasActiveGame = score > 0;
  const navigationBlocker = useBlocker({
    shouldBlockFn: shouldBlockGameNavigation,
    disabled:
      routeMode === undefined ||
      !isSessionReady ||
      screen !== 'game' ||
      !hasActiveGame ||
      gameOver ||
      challengeComplete,
    enableBeforeUnload: true,
    withResolver: true,
  });
  const dialogOpen =
    exitConfirmationOpen ||
    navigationBlocker.status === 'blocked' ||
    sessionNotice !== null;
  const isExitConfirmationOpen =
    exitConfirmationOpen || navigationBlocker.status === 'blocked';
  const isRoundSettled = gameOver || challengeComplete;
  // Inputs and the clock are frozen while any blocking dialog is visible, and
  // until the saved round has been restored so early clicks cannot land on the
  // throwaway initial round.
  const isInteractionPaused = dialogOpen || isRoundSettled || !isSessionReady;

  useEffect(() => {
    try {
      ensureScoreStorageVersion();
      const storedBest = readBestScore();
      bestScoreRef.current = storedBest;
      setBestScore(storedBest);
      setScoreHistory(readScoreHistory());
    } catch {
      // The game remains fully playable when storage is unavailable.
    }
  }, []);

  useEffect(
    () => () => {
      if (clearEffectTimerRef.current !== null) {
        window.clearTimeout(clearEffectTimerRef.current);
      }
      if (finishTimerRef.current !== null) {
        window.clearTimeout(finishTimerRef.current);
      }
    },
    []
  );

  const applyRound = useCallback((nextRound: GameRound) => {
    roundRef.current = nextRound;
    setRound(nextRound);
  }, []);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  const startFreshRound = useCallback(
    (nextMode: GameMode, anchorDate: string) => {
      pendingRestoreSettlementRef.current = null;
      roundIdentityRef.current = createRoundIdentity(nextMode, anchorDate);
      applyRound(createGameRound(nextMode, anchorDate));
      setElapsedSeconds(0);
      setGameOver(false);
      setChallengeComplete(false);
    },
    [applyRound]
  );

  useEffect(() => {
    const today = getLocalDateKey();
    const lookup = readActiveGameSession(today);
    // A fresh navigation into a mode always resumes persistence, even if the
    // player had just returned to the menu from an earlier round.
    isReturningHomeRef.current = false;

    if (routeMode === undefined) {
      setScreen('menu');
      setIsSessionReady(true);
      setSessionNotice(null);
      // Only a resumable session redirects back into the game. An expired or
      // invalid save is reported on the mode screen instead of disappearing.
      if (lookup.status === 'expired') {
        setSessionNotice({
          date: lookup.session.dailyDate ?? today,
          kind: 'expired',
        });
      } else if (lookup.status === 'active') {
        void navigate({
          to: '/play/$mode',
          params: { mode: lookup.session.mode },
          replace: true,
        });
      }
      return;
    }

    setSessionNotice(
      lookup.status === 'expired'
        ? { date: lookup.session.dailyDate ?? today, kind: 'expired' }
        : null
    );

    if (lookup.status === 'active' && lookup.session.mode === routeMode) {
      const session = lookup.session;
      setMode(session.mode);
      roundIdentityRef.current = {
        dailyDate: session.dailyDate,
        id: session.roundId,
      };
      const restoredRound = roundFromSession(session);
      applyRound(restoredRound);
      setElapsedSeconds(session.elapsedSeconds);
      setGameOver(session.gameOver);
      setChallengeComplete(session.challengeComplete);
      if (session.gameOver || session.challengeComplete) {
        // A settled round should never settle a second time after a refresh.
        settlementGateRef.current.trySettle(session.roundId);
      } else {
        const target = GAME_MODE_TARGETS[session.mode];
        if (target !== null && session.score >= target) {
          pendingRestoreSettlementRef.current = {
            outcome: 'challengeComplete',
            roundId: session.roundId,
            score: session.score,
          };
        } else if (!hasPlayablePiece(restoredRound)) {
          pendingRestoreSettlementRef.current = {
            outcome: 'gameOver',
            roundId: session.roundId,
            score: session.score,
          };
        }
      }
    } else {
      clearActiveGameSession();
      startFreshRound(routeMode, today);
    }

    setExitConfirmationOpen(false);
    setClearEffect(null);
    setScreen('game');
    setIsSessionReady(true);
  }, [applyRound, navigate, routeMode, startFreshRound]);

  const persistActiveGame = useCallback(() => {
    if (isReturningHomeRef.current || !isSessionReady || screen !== 'game') {
      return;
    }
    if (!hasActiveGame) {
      clearActiveGameSession();
      return;
    }
    writeActiveGameSession({
      board,
      challengeComplete,
      combo: round.combo,
      dailyDate: roundIdentityRef.current.dailyDate,
      elapsedSeconds,
      gameOver,
      generation: round.generation,
      mode,
      movesWithoutClear: round.movesWithoutClear,
      pieces,
      roundId: roundIdentityRef.current.id,
      score,
      seed: round.seed,
      version: ACTIVE_GAME_SESSION_VERSION,
    });
  }, [
    board,
    challengeComplete,
    elapsedSeconds,
    gameOver,
    hasActiveGame,
    isSessionReady,
    mode,
    round,
    screen,
  ]);

  useEffect(() => {
    persistActiveGame();
  }, [persistActiveGame]);

  useEffect(() => {
    if (screen !== 'game' || isInteractionPaused) {
      return;
    }

    const timer = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isInteractionPaused, screen]);

  useEffect(() => {
    if (screen !== 'game' || isRoundSettled) {
      stopMusic();
      return;
    }
    startMusic();
  }, [isRoundSettled, screen, startMusic, stopMusic]);

  const vibrate = useCallback(
    (pattern: number | number[]) => {
      if (preferences.haptics) triggerHapticFeedback(pattern);
    },
    [preferences.haptics]
  );

  const dismissClearEffect = useCallback(() => {
    if (clearEffectTimerRef.current !== null) {
      window.clearTimeout(clearEffectTimerRef.current);
      clearEffectTimerRef.current = null;
    }
    isResolvingRef.current = false;
    setClearEffect(null);
  }, []);

  const clearFinishTimer = useCallback(() => {
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const recordScore = useCallback(
    (roundId: string, finalScore: number, finalMode: GameMode) => {
      if (finalScore <= 0) return;

      setScoreHistory((current) => {
        const nextHistory = [
          ...current,
          {
            id: `${roundId}-${finalMode}-${finalScore}`,
            mode: finalMode,
            score: finalScore,
          },
        ]
          .sort((left, right) => right.score - left.score)
          .slice(0, 10);

        try {
          window.localStorage.setItem(
            SCORE_HISTORY_KEY,
            JSON.stringify(nextHistory)
          );
        } catch {
          // Keep the in-memory score history when storage is unavailable.
        }
        return nextHistory;
      });
    },
    []
  );

  const settleRound = useCallback(
    (
      roundId: string,
      finalScore: number,
      outcome: 'challengeComplete' | 'gameOver'
    ) => {
      // Timeouts and duplicate inputs can race to settle the same round. Only
      // the first settlement for a round may record a score or open a dialog.
      if (!settlementGateRef.current.trySettle(roundId)) return;

      const nextBest = Math.max(bestScoreRef.current, finalScore);
      bestScoreRef.current = nextBest;
      setBestScore(nextBest);
      if (outcome === 'challengeComplete') {
        setChallengeComplete(true);
        playSound('challengeComplete');
      } else {
        setGameOver(true);
        playSound('gameOver');
      }
      recordScore(roundId, finalScore, mode);
      stopMusic();
      vibrate([50, 40, 90]);

      try {
        window.localStorage.setItem(BEST_SCORE_KEY, String(nextBest));
      } catch {
        // Keep the in-memory best score when storage is unavailable.
      }
    },
    [mode, playSound, recordScore, stopMusic, vibrate]
  );

  const scheduleSettlement = useCallback(
    (
      resolution: {
        gameOver: boolean;
        nextRound: GameRound;
      },
      lineCount: number
    ) => {
      const roundId = roundIdentityRef.current.id;
      const target = GAME_MODE_TARGETS[mode];
      const reachedChallenge =
        target !== null && resolution.nextRound.score >= target;
      const delay =
        lineCount > 0 && !preferences.reducedMotion ? CLEAR_EFFECT_DURATION : 0;

      if (!reachedChallenge && !resolution.gameOver) return;

      const settle = () =>
        settleRound(
          roundId,
          resolution.nextRound.score,
          reachedChallenge ? 'challengeComplete' : 'gameOver'
        );

      if (delay > 0) {
        clearFinishTimer();
        finishTimerRef.current = window.setTimeout(() => {
          finishTimerRef.current = null;
          settle();
        }, delay);
        return;
      }
      settle();
    },
    [clearFinishTimer, mode, preferences.reducedMotion, settleRound]
  );

  useEffect(() => {
    if (!isSessionReady || screen !== 'game') return;
    const pending = pendingRestoreSettlementRef.current;
    if (!pending) return;
    pendingRestoreSettlementRef.current = null;
    settleRound(pending.roundId, pending.score, pending.outcome);
  }, [isSessionReady, screen, settleRound]);

  const placePiece = useCallback(
    (pieceIndex: number, row: number, column: number) => {
      if (
        isResolvingRef.current ||
        isInteractionPaused ||
        settlementGateRef.current.isSettled(roundIdentityRef.current.id)
      ) {
        return false;
      }
      const resolution = placeGamePiece(roundRef.current, {
        column,
        pieceIndex,
        row,
      });
      if (!resolution) {
        playSound('invalidMove');
        vibrate(20);
        return false;
      }

      const {
        clear,
        earned,
        gameOver: nextGameOver,
        round: nextRound,
      } = resolution;
      const lineCount = clear?.lineCount ?? 0;
      if (clear) {
        clearEffectIdRef.current += 1;
        const effectId = clearEffectIdRef.current;
        isResolvingRef.current = true;
        setClearEffect({
          ...clear,
          comboLevel: nextRound.combo,
          earned,
          id: effectId,
        });

        if (clearEffectTimerRef.current !== null) {
          window.clearTimeout(clearEffectTimerRef.current);
        }
        clearEffectTimerRef.current = window.setTimeout(
          () => {
            setClearEffect((current) =>
              current?.id === effectId ? null : current
            );
            isResolvingRef.current = false;
            clearEffectTimerRef.current = null;
          },
          preferences.reducedMotion ? 30 : CLEAR_EFFECT_DURATION
        );
      }

      applyRound(nextRound);
      if (nextRound.score > bestScoreRef.current) {
        bestScoreRef.current = nextRound.score;
        setBestScore(nextRound.score);
        try {
          window.localStorage.setItem(BEST_SCORE_KEY, String(nextRound.score));
        } catch {
          // Keep the in-memory best score when storage is unavailable.
        }
      }
      playSound('place');
      const clearSound = getLineClearSound(lineCount);
      if (clearSound) playSound(clearSound);
      if (lineCount > 0 && nextRound.combo >= 2) {
        playSound('combo', nextRound.combo);
      }
      vibrate(lineCount > 0 ? [20, 30, 35] : 12);

      scheduleSettlement({ gameOver: nextGameOver, nextRound }, lineCount);
      return true;
    },
    [
      applyRound,
      isInteractionPaused,
      playSound,
      preferences.reducedMotion,
      scheduleSettlement,
      vibrate,
    ]
  );

  const restartGame = useCallback(() => {
    isReturningHomeRef.current = false;
    clearFinishTimer();
    dismissClearEffect();
    startFreshRound(mode, getLocalDateKey());
    setExitConfirmationOpen(false);
    startMusic();
    playSound('gameStart');
  }, [
    clearFinishTimer,
    dismissClearEffect,
    mode,
    playSound,
    startFreshRound,
    startMusic,
  ]);

  const returnToMenu = useCallback(() => {
    isReturningHomeRef.current = true;
    clearFinishTimer();
    dismissClearEffect();
    clearActiveGameSession();
    roundIdentityRef.current = createRoundIdentity(mode, getLocalDateKey());
    setSessionNotice(null);
    setChallengeComplete(false);
    setGameOver(false);
    setExitConfirmationOpen(false);
    setScreen('menu');
    stopMusic(true);
    if (navigationBlocker.status === 'blocked') {
      navigationBlocker.proceed();
      return;
    }
    void navigate({ to: '/', ignoreBlocker: true });
  }, [
    clearFinishTimer,
    dismissClearEffect,
    mode,
    navigate,
    navigationBlocker,
    stopMusic,
  ]);

  const startNewDailyFromNotice = useCallback(() => {
    setSessionNotice(null);
    startFreshRound('daily', getLocalDateKey());
  }, [startFreshRound]);

  const keepPlaying = useCallback(() => {
    setExitConfirmationOpen(false);
    if (navigationBlocker.status === 'blocked') {
      navigationBlocker.reset();
    }
  }, [navigationBlocker]);

  const requestExit = useCallback(() => {
    if (hasActiveGame && !isRoundSettled) {
      setExitConfirmationOpen(true);
      return;
    }
    returnToMenu();
  }, [hasActiveGame, isRoundSettled, returnToMenu]);

  const gameClassName = joinClasses(
    'block-game',
    preferences.reducedMotion && 'reduce-game-motion'
  );
  const challengeFailed = gameOver && mode === 'daily';

  if (screen === 'game' && !isSessionReady) {
    // The board cannot be rendered before the saved session has been read:
    // the restore may swap in a different round, and rendering the throwaway
    // initial round would both flash the wrong board and break hydration when
    // the client date differs from the server render date across midnight.
    return (
      <div
        className={gameClassName}
        data-ready={false}
        data-testid="block-game"
      >
        <div className="game-backdrop" aria-hidden="true" />
      </div>
    );
  }

  if (screen === 'menu') {
    return (
      <div
        className={gameClassName}
        data-ready={isHydrated && isSessionReady}
        data-testid="block-game"
      >
        <div className="game-backdrop" aria-hidden="true">
          <span className="backdrop-block backdrop-block-one" />
          <span className="backdrop-block backdrop-block-two" />
          <span className="backdrop-block backdrop-block-three" />
          <span className="backdrop-block backdrop-block-four" />
        </div>
        <GameMenu bestScore={bestScore} copy={copy} />
        {sessionNotice && (
          <div className="game-modal-backdrop">
            <section
              className="game-modal session-expired-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="session-expired-title"
              data-testid="session-expired-modal"
            >
              <IconFlag className="modal-hero-icon" aria-hidden="true" />
              <h2 id="session-expired-title">{copy.sessionExpiredTitle}</h2>
              <p>{copy.sessionExpiredDescription(sessionNotice.date)}</p>
              <button
                type="button"
                className="restart-button"
                onClick={() => setSessionNotice(null)}
              >
                {copy.close}
              </button>
            </section>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={gameClassName}
      data-ready={isHydrated && isSessionReady}
      data-testid="block-game"
    >
      <div className="game-backdrop" aria-hidden="true">
        <span className="backdrop-block backdrop-block-one" />
        <span className="backdrop-block backdrop-block-two" />
        <span className="backdrop-block backdrop-block-three" />
        <span className="backdrop-block backdrop-block-four" />
      </div>

      <GameBoardView
        clearEffect={clearEffect}
        copy={copy}
        elapsedSeconds={elapsedSeconds}
        gameOver={gameOver}
        hintsEnabled={preferences.hints}
        interactionPaused={isInteractionPaused}
        mode={mode}
        onPersist={persistActiveGame}
        onPlace={placePiece}
        onRequestExit={requestExit}
        round={round}
      />

      {sessionNotice && (
        <div className="game-modal-backdrop">
          <section
            className="game-modal session-expired-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-expired-title"
            data-testid="session-expired-modal"
          >
            <IconFlag className="modal-hero-icon" aria-hidden="true" />
            <h2 id="session-expired-title">{copy.sessionExpiredTitle}</h2>
            <p>{copy.sessionExpiredDescription(sessionNotice.date)}</p>
            {mode === 'daily' && (
              <button
                type="button"
                className="restart-button"
                onClick={startNewDailyFromNotice}
              >
                <IconRefresh aria-hidden="true" />
                {copy.restartGame}
              </button>
            )}
            <button
              type="button"
              className={joinClasses(
                'restart-button',
                mode === 'daily' && 'result-home-button'
              )}
              onClick={returnToMenu}
            >
              <IconHome aria-hidden="true" />
              {copy.backHome}
            </button>
          </section>
        </div>
      )}

      {isExitConfirmationOpen && !isRoundSettled && !sessionNotice && (
        <div className="game-modal-backdrop">
          <section
            className="game-modal exit-confirmation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-game-title"
            data-testid="exit-confirmation-modal"
          >
            <IconAlertTriangle className="modal-hero-icon" aria-hidden="true" />
            <h2 id="exit-game-title">{copy.exitGameTitle}</h2>
            <p>{copy.exitGameDescription}</p>
            <button
              type="button"
              className="restart-button"
              onClick={keepPlaying}
            >
              <IconPuzzle aria-hidden="true" />
              {copy.keepPlaying}
            </button>
            <button
              type="button"
              className="restart-button exit-game-button"
              onClick={returnToMenu}
            >
              <IconArrowLeft aria-hidden="true" />
              {copy.confirmExit}
            </button>
          </section>
        </div>
      )}

      {gameOver && !sessionNotice && (
        <div className="game-modal-backdrop">
          <section
            className={joinClasses(
              'game-modal game-over-modal',
              challengeFailed && 'challenge-failed-modal'
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-over-title"
            data-testid="game-over-modal"
          >
            {challengeFailed ? (
              <IconFlag className="modal-hero-icon" aria-hidden="true" />
            ) : (
              <IconTrophy className="modal-hero-icon" aria-hidden="true" />
            )}
            <h2 id="game-over-title">
              {challengeFailed ? copy.challengeFailed : copy.greatGame}
            </h2>
            <p>
              {challengeFailed
                ? copy.challengeFailedDescription(GAME_MODE_TARGETS[mode] ?? 0)
                : copy.gameOverDescription}
            </p>
            <div className="final-score">
              <span>{copy.yourScore}</span>
              <strong>{score}</strong>
            </div>
            <div className="final-best">
              {challengeFailed ? (
                <>
                  <IconFlag aria-hidden="true" /> {copy.goal}{' '}
                  {GAME_MODE_TARGETS[mode]}
                </>
              ) : (
                <>
                  <IconCrown aria-hidden="true" /> {copy.yourBest} {bestScore}
                </>
              )}
            </div>
            <button
              type="button"
              className="restart-button"
              onClick={restartGame}
            >
              <IconRefresh aria-hidden="true" />
              {copy.playAgain}
            </button>
            <button
              type="button"
              className="restart-button result-home-button"
              onClick={returnToMenu}
            >
              <IconHome aria-hidden="true" />
              {copy.backHome}
            </button>
          </section>
        </div>
      )}

      {challengeComplete && !sessionNotice && (
        <div className="game-modal-backdrop">
          <section
            className="game-modal game-over-modal challenge-complete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="challenge-complete-title"
            data-testid="challenge-complete-modal"
          >
            <div className="celebration-confetti" aria-hidden="true">
              {CHALLENGE_CONFETTI.map((piece) => (
                <span
                  className="confetti-piece"
                  key={piece.id}
                  style={
                    {
                      '--confetti-color': piece.color,
                      '--confetti-delay': `${piece.delay}ms`,
                      '--confetti-end-x': `${piece.endX}px`,
                      '--confetti-lift': `${piece.lift}px`,
                      '--confetti-origin': piece.origin,
                      '--confetti-peak-x': `${piece.peakX}px`,
                      '--confetti-rotation': `${piece.rotation}deg`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <IconStar className="modal-hero-icon" aria-hidden="true" />
            <h2 id="challenge-complete-title">{copy.challengeComplete}</h2>
            <p>
              {copy.challengeCompleteDescription(GAME_MODE_TARGETS[mode] ?? 0)}
            </p>
            <div className="final-score">
              <span>{copy.yourScore}</span>
              <strong>{score}</strong>
            </div>
            <div className="final-best">
              <IconFlag aria-hidden="true" />
              {getModeLabel(copy, mode)}
            </div>
            <button
              type="button"
              className="restart-button challenge-home-button"
              onClick={returnToMenu}
            >
              <IconHome aria-hidden="true" />
              {copy.backHome}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
