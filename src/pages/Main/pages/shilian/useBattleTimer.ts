import { useCallback, useEffect, useRef } from 'react';

/**
 * 战斗相关定时器。
 *
 * 每个定时器都带一个自增令牌：清理定时器时令牌立即失效，即使某个回调
 * 已经被宿主排进任务队列，执行时也会因令牌不匹配而直接返回。这样停挂 /
 * 遁逃之后，正在等待的回合回调不会再推进战斗。
 */
export default function useBattleTimer() {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const guajiTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoBattleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const combatToken = useRef(0);
  const guajiToken = useRef(0);
  const autoBattleToken = useRef(0);

  const clearCombatTimer = useCallback(() => {
    combatToken.current += 1;
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const clearGuajiTimer = useCallback(() => {
    guajiToken.current += 1;
    if (guajiTimer.current !== null) {
      clearInterval(guajiTimer.current);
      guajiTimer.current = null;
    }
  }, []);

  const clearAutoBattleTimer = useCallback(() => {
    autoBattleToken.current += 1;
    if (autoBattleTimer.current !== null) {
      clearTimeout(autoBattleTimer.current);
      autoBattleTimer.current = null;
    }
  }, []);

  const setCombatTimer = useCallback(
    (fn: () => void, interval: number) => {
      clearCombatTimer();
      const token = combatToken.current;
      timer.current = setInterval(() => {
        if (token !== combatToken.current) return;
        fn();
      }, interval);
    },
    [clearCombatTimer]
  );

  const setGuajiTimer = useCallback(
    (fn: () => void, interval: number) => {
      clearGuajiTimer();
      const token = guajiToken.current;
      guajiTimer.current = setInterval(() => {
        if (token !== guajiToken.current) return;
        fn();
      }, interval);
    },
    [clearGuajiTimer]
  );

  const setAutoBattleTimer = useCallback(
    (fn: () => void, delay: number) => {
      clearAutoBattleTimer();
      const token = autoBattleToken.current;
      autoBattleTimer.current = setTimeout(() => {
        if (token !== autoBattleToken.current) return;
        fn();
      }, delay);
    },
    [clearAutoBattleTimer]
  );

  const clearAll = useCallback(() => {
    clearCombatTimer();
    clearGuajiTimer();
    clearAutoBattleTimer();
  }, [clearCombatTimer, clearGuajiTimer, clearAutoBattleTimer]);

  useEffect(() => clearAll, [clearAll]);

  return {
    setCombatTimer,
    setGuajiTimer,
    setAutoBattleTimer,
    clearCombatTimer,
    clearGuajiTimer,
    clearAutoBattleTimer,
    clearAll
  };
}
