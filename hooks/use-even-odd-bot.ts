'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProposalInfo, BuyResult, Tick } from '@deriv/core';
import type { ContractMode, OpenPosition } from '@/lib/types';
import { getLastDigit } from '@/lib/digit-stats';
import { usePhaseWatchdog, timeoutReason, type TimeoutReason } from '@/hooks/use-phase-watchdog';

/**
 * Even/Odd bot. Same skeleton as the Eye of Ra bot (`use-ra-bot.ts`) —
 * arm → (optional) confirm → burst of trades with its own martingale,
 * Trend / Neutral / Counter, Burst / Continuous, ARM time limit, Take
 * Profit / Stop Loss / Run TP, insufficient-funds stop — but with a
 * different detection rule and a different contract.
 *
 * DETECTION. Every digit is put into one of four classes by combining its
 * parity with the usual over4 / under5 split (over = 5-9, under = 0-4):
 *
 *   odd-over   5 7 9        even-over  6 8
 *   odd-under  1 3          even-under 0 2 4
 *
 * A class "arms" once `streakCount` consecutive digits fall in it — e.g.
 * with a count of 4, "7 9 5 7" arms odd-over, "3 3 1 3" arms odd-under,
 * "2 2 4 0" arms even-under. Strict: any digit outside the class (even one
 * of the same parity but the other range, like 7 9 5 6) breaks the run.
 * `watchParity` / `watchRange` can narrow which of the four classes are
 * allowed to arm at all; a digit in a disallowed class just interrupts.
 *
 * Like Ra, an optional Confirmation Streak follows arming (M more digits
 * in the same class). 0 (the default) means fire the moment the run is
 * complete.
 *
 * EXECUTION. The trade is always an Even or Odd contract (no barrier):
 * Trend trades the parity of the detected class (odd-* → Odd, even-* →
 * Even); Counter trades the opposite parity (e.g. 3 3 1 3 = odd-under →
 * trades Even; 2 2 4 0 = even-under → trades Odd). Neutral never trades.
 *
 * Burst / Continuous / martingale / TP / SL behave exactly as in Ra.
 */

export type EoSide = 'even' | 'odd' | null;
export type EoClass = 'odd-over' | 'even-over' | 'odd-under' | 'even-under';
export type EoDetectionClass = EoClass | null;
export type EoTradingMode = 'trend' | 'neutral' | 'counter';
export type EoRunMode = 'burst' | 'continuous';
export type EoWatchParity = 'both' | 'odd' | 'even';
export type EoWatchRange = 'both' | 'over' | 'under';
export type EoStopReason = 'manual' | 'take-profit' | 'stop-loss' | 'insufficient-funds' | TimeoutReason | null;
export type EoPhase = 'idle' | 'awaiting-proposal' | 'awaiting-buy' | 'awaiting-settlement';
export type EoBurstOutcome = 'won' | 'error' | null;
export type EoBarrier = 'Even' | 'Odd';

export interface EoLogEntry {
  id: number;
  time: number;
  /** The class (e.g. odd-over) whose run actually triggered this burst. */
  signalClass: EoDetectionClass;
  /** The parity actually traded — equals the signal's parity in Trend mode, the opposite in Counter. */
  side: EoSide;
  barrier: EoBarrier | null;
  digit: number | null;
  exitSpot: number | null;
  won: boolean;
  stake: number;
  profit: number;
}

export interface EoBotConfig {
  /** N — consecutive digits of the same class required to arm. 2-20. */
  streakCount: number;
  /** M — extra consecutive same-class digits required after arming. 0 = fire immediately. */
  confirmationStreak: number;
  watchParity: EoWatchParity;
  watchRange: EoWatchRange;
  initialStake: number;
  stakeMultiplier: number;
  martingaleStartAfter: number;
  armTimeLimitSeconds?: number;
  tradingMode: EoTradingMode;
  takeProfit: number;
  stopLoss: number;
  runTakeProfit?: number;
  runMode?: EoRunMode;
}

interface UseEvenOddBotParams {
  currentTick: Tick | null;
  pipSize: number;
  setStake: (value: string) => void;
  setContractMode: (mode: ContractMode) => void;
  proposal: ProposalInfo | null;
  isProposalLoading: boolean;
  buyContract: () => Promise<void>;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;
  openPositions: OpenPosition[];
  balance: number | null;
}

const DIGIT_RECORD_SIZE = 30;

/** Class of a digit, or null when it falls outside what the config watches. */
export function eoClassOf(
  digit: number,
  watchParity: EoWatchParity,
  watchRange: EoWatchRange
): EoDetectionClass {
  const parity = digit % 2 === 0 ? 'even' : 'odd';
  const range = digit > 4 ? 'over' : 'under';
  if (watchParity !== 'both' && watchParity !== parity) return null;
  if (watchRange !== 'both' && watchRange !== range) return null;
  return `${parity}-${range}` as EoClass;
}

export function eoParityOfClass(cls: EoClass): Exclude<EoSide, null> {
  return cls.startsWith('odd') ? 'odd' : 'even';
}

function eoStakeFor(cfg: EoBotConfig, lossStreak: number): number {
  const lossesPastGrace = Math.max(0, lossStreak - cfg.martingaleStartAfter);
  return cfg.initialStake * Math.pow(cfg.stakeMultiplier, lossesPastGrace);
}

export function useEvenOddBot({
  currentTick,
  pipSize,
  setStake,
  setContractMode,
  proposal,
  isProposalLoading,
  buyContract,
  buyResult,
  buyError,
  clearBuyResult,
  openPositions,
  balance,
}: UseEvenOddBotParams) {
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<EoPhase>('idle');
  const [pnl, setPnl] = useState(0);
  const [digitRecord, setDigitRecord] = useState<number[]>([]);
  const [stoppedReason, setStoppedReason] = useState<EoStopReason>(null);
  const [armedClass, setArmedClass] = useState<EoDetectionClass>(null);
  const [confirmProgress, setConfirmProgress] = useState(0);
  /** Length of the run currently building on the digit stream (0 when none). */
  const [runProgress, setRunProgress] = useState<{ cls: EoDetectionClass; count: number }>({
    cls: null,
    count: 0,
  });
  const [lastFired, setLastFired] = useState<{ side: EoSide; barrier: EoBarrier } | null>(null);
  const [burstActive, setBurstActive] = useState(false);
  const [burstPnl, setBurstPnl] = useState(0);
  const [lastBurstOutcome, setLastBurstOutcome] = useState<EoBurstOutcome>(null);
  const [log, setLog] = useState<EoLogEntry[]>([]);
  const logIdRef = useRef(0);
  const sessionStartRef = useRef<number | null>(null);
  const [sessionDurationMs, setSessionDurationMs] = useState<number | null>(null);

  const cfgRef = useRef<EoBotConfig>({
    streakCount: 4,
    confirmationStreak: 0,
    watchParity: 'both',
    watchRange: 'both',
    initialStake: 1,
    stakeMultiplier: 1,
    martingaleStartAfter: 0,
    armTimeLimitSeconds: 0,
    tradingMode: 'neutral',
    takeProfit: 0,
    stopLoss: 0,
  });
  const pnlRef = useRef(0);
  const burstPnlRef = useRef(0);
  const activeTradeRef = useRef<{
    side: EoSide;
    signalClass: EoDetectionClass;
    contractMode: ContractMode;
    barrier: EoBarrier;
    stake: number;
  } | null>(null);

  const armedClassRef = useRef<EoDetectionClass>(null);
  const primaryStreakRef = useRef<{ cls: EoDetectionClass; count: number }>({ cls: null, count: 0 });
  const confirmCountRef = useRef(0);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProcessedEpochRef = useRef<number | null>(null);
  const pendingContractIdRef = useRef<number | null>(null);
  const lossStreakRef = useRef(0);
  const balanceRef = useRef<number | null>(balance);
  useEffect(() => {
    balanceRef.current = balance;
  }, [balance]);
  // See use-ra-bot.ts for why these two exist (stale-proposal guard and the
  // "same contract/stake as last time never pulses loading" case).
  const sawProposalLoadingRef = useRef(false);
  const lastFireKeyRef = useRef<string | null>(null);
  const skipLoadingWaitRef = useRef(false);

  const clearArmTimer = useCallback(() => {
    if (armTimerRef.current !== null) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);

  const scheduleArmTimer = useCallback(() => {
    clearArmTimer();
    const limit = cfgRef.current.armTimeLimitSeconds;
    if (!limit || limit <= 0) return;
    armTimerRef.current = setTimeout(() => {
      armedClassRef.current = null;
      primaryStreakRef.current = { cls: null, count: 0 };
      confirmCountRef.current = 0;
      setArmedClass(null);
      setConfirmProgress(0);
      setRunProgress({ cls: null, count: 0 });
      armTimerRef.current = null;
    }, limit * 1000);
  }, [clearArmTimer]);

  useEffect(() => {
    return () => clearArmTimer();
  }, [clearArmTimer]);

  const resetTracking = useCallback(() => {
    clearArmTimer();
    armedClassRef.current = null;
    primaryStreakRef.current = { cls: null, count: 0 };
    confirmCountRef.current = 0;
    setArmedClass(null);
    setConfirmProgress(0);
    setRunProgress({ cls: null, count: 0 });
  }, [clearArmTimer]);

  const pushLog = useCallback((entry: Omit<EoLogEntry, 'id' | 'time'>) => {
    const id = logIdRef.current++;
    setLog((prev) => [...prev.slice(-49), { ...entry, id, time: Date.now() }]);
  }, []);

  const start = useCallback(
    (cfg: EoBotConfig) => {
      cfgRef.current = cfg;
      pnlRef.current = 0;
      burstPnlRef.current = 0;
      activeTradeRef.current = null;
      resetTracking();
      lastProcessedEpochRef.current = null;
      pendingContractIdRef.current = null;
      lossStreakRef.current = 0;
      lastFireKeyRef.current = null;
      skipLoadingWaitRef.current = false;
      setPnl(0);
      setBurstPnl(0);
      setBurstActive(false);
      setLastBurstOutcome(null);
      setLog([]);
      logIdRef.current = 0;
      setDigitRecord([]);
      setStoppedReason(null);
      setLastFired(null);
      setPhase('idle');
      sessionStartRef.current = Date.now();
      setSessionDurationMs(null);
      setEnabled(true);
    },
    [resetTracking]
  );

  const stop = useCallback(
    (reason: EoStopReason = 'manual') => {
      clearArmTimer();
      setEnabled(false);
      setStoppedReason(reason);
      setPhase('idle');
      setBurstActive(false);
      pendingContractIdRef.current = null;
      activeTradeRef.current = null;
      setSessionDurationMs(
        sessionStartRef.current !== null ? Date.now() - sessionStartRef.current : null
      );
    },
    [clearArmTimer]
  );

  const placeTrade = useCallback(
    (side: Exclude<EoSide, null>, signalClass: Exclude<EoDetectionClass, null>) => {
      const cfg = cfgRef.current;
      const stake = eoStakeFor(cfg, lossStreakRef.current);
      setStake(stake.toFixed(2));

      const contractMode: ContractMode = side === 'odd' ? 'DIGITODD' : 'DIGITEVEN';
      const barrier: EoBarrier = side === 'odd' ? 'Odd' : 'Even';

      const fireKey = `${contractMode}:${stake.toFixed(2)}`;
      skipLoadingWaitRef.current = fireKey === lastFireKeyRef.current;
      lastFireKeyRef.current = fireKey;

      activeTradeRef.current = { side, signalClass, contractMode, barrier, stake };
      setContractMode(contractMode);
      setLastFired({ side, barrier });

      sawProposalLoadingRef.current = false;
      setPhase('awaiting-proposal');
    },
    [setStake, setContractMode]
  );

  // --- Each genuinely new tick: update digit record, run streak, confirm
  // streak, and fire when the signal completes.
  useEffect(() => {
    if (!enabled || !currentTick) return;
    if (lastProcessedEpochRef.current === currentTick.epoch) return;
    lastProcessedEpochRef.current = currentTick.epoch;

    const digit = getLastDigit(currentTick.quote, pipSize);
    const cfg = cfgRef.current;
    const cls = eoClassOf(digit, cfg.watchParity, cfg.watchRange);

    setDigitRecord((prev) => [...prev.slice(-(DIGIT_RECORD_SIZE - 1)), digit]);

    // Primary (arming) streak — strict, resets on any digit of another class.
    const primary = primaryStreakRef.current;
    if (primary.cls === cls) {
      primary.count += 1;
    } else {
      primaryStreakRef.current = { cls, count: 1 };
    }
    setRunProgress(
      primaryStreakRef.current.cls === null
        ? { cls: null, count: 0 }
        : { cls: primaryStreakRef.current.cls, count: primaryStreakRef.current.count }
    );

    // Confirmation streak — only once armed; strict, resets to 0 on a miss.
    if (armedClassRef.current !== null) {
      if (cls === armedClassRef.current) {
        confirmCountRef.current = Math.min(confirmCountRef.current + 1, cfg.confirmationStreak);
      } else {
        confirmCountRef.current = 0;
      }
    }

    // Arm / re-arm. A null class (a digit outside the watched set) is never
    // a real signal, however many in a row.
    if (primaryStreakRef.current.cls !== null && primaryStreakRef.current.count >= cfg.streakCount) {
      const streakClass = primaryStreakRef.current.cls;
      if (armedClassRef.current === null) {
        armedClassRef.current = streakClass;
        confirmCountRef.current = 0;
        scheduleArmTimer();
      } else if (streakClass !== armedClassRef.current) {
        armedClassRef.current = streakClass;
        confirmCountRef.current = 0;
        scheduleArmTimer();
      }
    }

    setArmedClass(armedClassRef.current);
    setConfirmProgress(confirmCountRef.current);

    // Signal complete — open a burst (subject to Trading Mode).
    if (armedClassRef.current !== null && confirmCountRef.current >= cfg.confirmationStreak) {
      const confirmedClass = armedClassRef.current;

      if (cfg.tradingMode !== 'neutral' && phase === 'idle') {
        const natural = eoParityOfClass(confirmedClass);
        const tradeSide: Exclude<EoSide, null> =
          cfg.tradingMode === 'trend' ? natural : natural === 'odd' ? 'even' : 'odd';

        burstPnlRef.current = 0;
        setBurstPnl(0);
        setBurstActive(true);
        setLastBurstOutcome(null);
        placeTrade(tradeSide, confirmedClass);

        // Wipe the whole arm state — the next signal needs a fresh run.
        clearArmTimer();
        armedClassRef.current = null;
        primaryStreakRef.current = { cls: null, count: 0 };
        confirmCountRef.current = 0;
        setArmedClass(null);
        setConfirmProgress(0);
        setRunProgress({ cls: null, count: 0 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTick, enabled, pipSize, placeTrade]);

  // --- Proposal ready → buy.
  useEffect(() => {
    if (phase !== 'awaiting-proposal') return;
    if (isProposalLoading) {
      sawProposalLoadingRef.current = true;
      return;
    }
    if (!proposal) return;
    if (!skipLoadingWaitRef.current && !sawProposalLoadingRef.current) return;
    const intended = activeTradeRef.current?.stake;
    if (intended !== undefined && Math.abs(proposal.askPrice - Number(intended.toFixed(2))) > 0.005) return;
    setPhase('awaiting-buy');
    buyContract();
  }, [phase, proposal, isProposalLoading, buyContract]);

  // --- Bought → wait for settlement.
  useEffect(() => {
    if (phase !== 'awaiting-buy') return;
    if (buyResult) {
      pendingContractIdRef.current = buyResult.contractId;
      clearBuyResult();
      setPhase('awaiting-settlement');
    } else if (buyError) {
      activeTradeRef.current = null;
      setBurstActive(false);
      setLastBurstOutcome('error');
      setPhase('idle');
    }
  }, [phase, buyResult, buyError, clearBuyResult]);

  // --- Pending contract closed → book it, then decide what happens next.
  useEffect(() => {
    if (phase !== 'awaiting-settlement' || pendingContractIdRef.current === null) return;
    const pos = openPositions.find((p) => p.contract_id === pendingContractIdRef.current);
    if (!pos) return;
    const isClosed = !!pos.is_sold || !!pos.is_expired || pos.status !== 'open';
    if (!isClosed) return;

    const profit = parseFloat(pos.profit);
    const won = profit > 0;
    pendingContractIdRef.current = null;

    const lastStreamTick =
      pos.tick_stream && pos.tick_stream.length > 0
        ? pos.tick_stream[pos.tick_stream.length - 1]
        : null;
    const exitSpot =
      typeof pos.exit_spot === 'number'
        ? pos.exit_spot
        : lastStreamTick
          ? lastStreamTick.tick
          : null;
    const exitDigit = exitSpot !== null ? getLastDigit(exitSpot, pipSize) : null;

    const tradeInfo = activeTradeRef.current;
    pushLog({
      signalClass: tradeInfo?.signalClass ?? null,
      side: tradeInfo?.side ?? null,
      barrier: tradeInfo?.barrier ?? null,
      digit: exitDigit,
      exitSpot,
      won,
      stake: tradeInfo?.stake ?? 0,
      profit,
    });

    lossStreakRef.current = won ? 0 : lossStreakRef.current + 1;

    const nextPnl = pnlRef.current + profit;
    pnlRef.current = nextPnl;
    setPnl(nextPnl);

    const nextBurstPnl = burstPnlRef.current + profit;
    burstPnlRef.current = nextBurstPnl;
    setBurstPnl(nextBurstPnl);

    const cfg = cfgRef.current;
    const hitTakeProfit = cfg.takeProfit > 0 && nextPnl >= cfg.takeProfit;
    const hitStopLoss = cfg.stopLoss > 0 && nextPnl <= -cfg.stopLoss;

    if (hitTakeProfit || hitStopLoss) {
      stop(hitTakeProfit ? 'take-profit' : 'stop-loss');
      return;
    }

    const hitRunTakeProfit =
      !!cfg.runTakeProfit && cfg.runTakeProfit > 0 && nextBurstPnl >= cfg.runTakeProfit;

    if (hitRunTakeProfit) {
      activeTradeRef.current = null;
      setBurstActive(false);
      setLastBurstOutcome('won');
      setPhase('idle');
      return;
    }

    const active = activeTradeRef.current;

    if (won) {
      if (cfg.runMode === 'continuous' && active) {
        const nextStake = eoStakeFor(cfg, lossStreakRef.current);
        const bal = balanceRef.current;
        if (bal !== null && nextStake > bal + 0.001) {
          stop('insufficient-funds');
          return;
        }
        setLastBurstOutcome('won');
        placeTrade(active.side as Exclude<EoSide, null>, active.signalClass as Exclude<EoDetectionClass, null>);
        return;
      }

      activeTradeRef.current = null;
      setBurstActive(false);
      setLastBurstOutcome('won');
      setPhase('idle');
      return;
    }

    // Lost — re-fire the same side at the martingale stake if affordable.
    if (active) {
      const nextStake = eoStakeFor(cfg, lossStreakRef.current);
      const bal = balanceRef.current;
      if (bal !== null && nextStake > bal + 0.001) {
        stop('insufficient-funds');
        return;
      }
      placeTrade(active.side as Exclude<EoSide, null>, active.signalClass as Exclude<EoDetectionClass, null>);
    } else {
      setPhase('idle');
    }
  }, [phase, openPositions, placeTrade, pushLog, stop, pipSize]);

  usePhaseWatchdog(enabled, phase, (stuckPhase) => stop(timeoutReason(stuckPhase)));

  return {
    enabled,
    running: enabled,
    phase,
    pnl,
    digitRecord,
    stoppedReason,
    armedClass,
    confirmProgress,
    runProgress,
    lastFired,
    burstActive,
    burstPnl,
    lastBurstOutcome,
    log,
    sessionDurationMs,
    start,
    stop,
  };
}
