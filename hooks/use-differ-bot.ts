'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProposalInfo, BuyResult, Tick } from '@deriv/core';
import type { ContractMode, OpenPosition } from '@/lib/types';
import { getLastDigit } from '@/lib/digit-stats';

/**
 * "Differ" bot: watches the live tick stream for a digit repeating N times
 * in a row (N adjustable), and when that happens fires a Differs or
 * Matches trade (whichever the user picked) predicting that same digit.
 *
 * Simpler, single-stage cousin of the Ra bot (use-ra-bot.ts) — there's no
 * separate arm/confirm phase, just one streak counter on the exact digit
 * (0-9) rather than the over4/under5 side split. Once the streak hits N,
 * a burst opens: the same digit/contract keeps firing (Differ's own
 * martingale on losses) until it wins, then the bot drops back to
 * watching the digit stream for the next N-run. Take Profit/Stop Loss are
 * whole-run thresholds checked after every settlement, same as Ra's.
 *
 * `patternGap` generalizes the streak from strictly-consecutive
 * (gap = 0, e.g. 5,5,5) to evenly-spaced (gap = 1 → 5,x,5,x,5; gap = 2 →
 * 5,x,x,5,x,x,5; …), where the `x` ticks in between can be anything. This
 * is tracked with `period = gap + 1` parallel "lanes", one per tick-index
 * phase mod period — each lane behaves exactly like the old single
 * consecutive-run counter, just only looking at every `period`-th tick.
 * gap = 0 collapses to a single lane and is byte-for-byte the old
 * behaviour.
 */

export type DifferTradeType = 'differs' | 'matches';
export type DifferStopReason = 'manual' | 'take-profit' | 'stop-loss' | 'insufficient-funds' | null;
export type DifferPhase = 'idle' | 'awaiting-proposal' | 'awaiting-buy' | 'awaiting-settlement';
/** Why the most recently completed burst ended — for a transient UI note.
 *  Distinct from DifferStopReason: hitting Take Profit/Stop Loss now stops
 *  the whole bot rather than just ending a burst. */
export type DifferBurstOutcome = 'won' | 'error' | null;
/** 'burst' (default): a win ends the current burst and Differ waits for a
 *  fresh N-run before trading again. 'continuous': a win keeps the run
 *  going — Differ re-fires the same digit/trade immediately, with no
 *  wait, until Take Profit/Stop Loss stops it outright. */
export type DifferRunMode = 'burst' | 'continuous';

/** One settled Differ trade, for the Logs tab — same shape/purpose as the
 *  Ra bot's RaLogEntry. */
export interface DifferLogEntry {
  id: number;
  time: number;
  /** The digit whose N-run triggered this burst — fixed for every trade
   *  within the burst. */
  streakDigit: number | null;
  tradeType: DifferTradeType;
  digit: number | null;
  exitSpot: number | null;
  won: boolean;
  stake: number;
  profit: number;
}

export interface DifferBotConfig {
  /** N — how many times the same digit must appear (spaced `patternGap`
   *  ticks apart, see below) before Differ fires. 2-9. */
  streakLength: number;
  /** Ticks between each occurrence of N. 0 = consecutive (N,N,N — the
   *  original behaviour). 1 = every other tick (N,x,N,x,N). 2 = every
   *  third tick (N,x,x,N,x,x,N). Etc. 0-9. */
  patternGap: number;
  /** Which contract Differ fires once a streak completes. */
  tradeType: DifferTradeType;
  /** Differ's own base stake, entirely separate from the Martingale/Ra
   *  bots' stake settings. */
  initialStake: number;
  /** Multiplier applied to Differ's stake after a loss, once
   *  martingaleStartAfter losses have occurred. */
  stakeMultiplier: number;
  /** Consecutive Differ losses before the multiplier starts being applied.
   *  0 = multiply from the first loss. */
  martingaleStartAfter: number;
  /** Take-profit for the whole run: once total P/L (across every burst)
   *  reaches this, the bot stops outright. 0 = off. */
  takeProfit: number;
  /** Stop-loss for the whole run (positive number; stops the bot once
   *  total P/L <= -this). 0 = off. */
  stopLoss: number;
  /** What a win does — see DifferRunMode above. Undefined/omitted behaves
   *  as 'burst'. */
  runMode?: DifferRunMode;
}

interface UseDifferBotParams {
  currentTick: Tick | null;
  pipSize: number;
  setStake: (value: string) => void;
  setContractMode: (mode: ContractMode) => void;
  setSelectedDigit: (digit: number) => void;
  proposal: ProposalInfo | null;
  isProposalLoading: boolean;
  buyContract: () => Promise<void>;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;
  openPositions: OpenPosition[];
  /** Current account balance, read live for the insufficient-funds check
   *  below. Null while unauthenticated/unknown — the check is simply
   *  skipped in that case. */
  balance: number | null;
}

const DIGIT_RECORD_SIZE = 30;

/** Differ's own martingale stake for a given loss streak — mirrors the
 *  calculation inside `placeTrade` below, factored out so the
 *  insufficient-funds pre-check can compute "what would the next stake be"
 *  without duplicating (or drifting from) the real firing logic. */
function differStakeFor(cfg: DifferBotConfig, lossStreak: number): number {
  const lossesPastGrace = Math.max(0, lossStreak - cfg.martingaleStartAfter);
  return cfg.initialStake * Math.pow(cfg.stakeMultiplier, lossesPastGrace);
}

export function useDifferBot({
  currentTick,
  pipSize,
  setStake,
  setContractMode,
  setSelectedDigit,
  proposal,
  isProposalLoading,
  buyContract,
  buyResult,
  buyError,
  clearBuyResult,
  openPositions,
  balance,
}: UseDifferBotParams) {
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<DifferPhase>('idle');
  const [pnl, setPnl] = useState(0);
  const [digitRecord, setDigitRecord] = useState<number[]>([]);
  const [stoppedReason, setStoppedReason] = useState<DifferStopReason>(null);
  const [streakDigit, setStreakDigit] = useState<number | null>(null);
  const [streakProgress, setStreakProgress] = useState(0);
  // Whether Differ is currently mid-burst (has fired and is looping trades)
  // as opposed to idle and watching the digit stream for a fresh streak.
  const [burstActive, setBurstActive] = useState(false);
  // Cumulative P/L for the *current* burst only — resets to 0 each time a
  // new burst opens. `pnl` keeps accumulating across every burst.
  const [burstPnl, setBurstPnl] = useState(0);
  const [lastBurstOutcome, setLastBurstOutcome] = useState<DifferBurstOutcome>(null);
  const [log, setLog] = useState<DifferLogEntry[]>([]);
  const logIdRef = useRef(0);
  const sessionStartRef = useRef<number | null>(null);
  const [sessionDurationMs, setSessionDurationMs] = useState<number | null>(null);

  const cfgRef = useRef<DifferBotConfig>({
    streakLength: 3,
    patternGap: 0,
    tradeType: 'differs',
    initialStake: 1,
    stakeMultiplier: 1,
    martingaleStartAfter: 0,
    takeProfit: 0,
    stopLoss: 0,
  });
  const pnlRef = useRef(0);
  const burstPnlRef = useRef(0);
  // The trade Differ is currently looping within a burst — fixed for the
  // whole burst so each subsequent trade re-fires the same digit/contract
  // without needing the streak to complete again.
  const activeTradeRef = useRef<{
    streakDigit: number;
    contractMode: ContractMode;
    stake: number;
  } | null>(null);

  // Current in-progress streak(s) on the raw digit stream (not yet fired).
  // One "lane" per phase of `period` (= patternGap + 1) — lane[i] tracks
  // the run of ticks whose index ≡ i (mod period). At patternGap 0,
  // period is 1 and there's exactly one lane, equivalent to the old
  // single-counter behaviour.
  const lanesRef = useRef<{ digit: number | null; count: number }[]>([{ digit: null, count: 0 }]);
  const tickIndexRef = useRef(0);
  const lastProcessedEpochRef = useRef<number | null>(null);
  const pendingContractIdRef = useRef<number | null>(null);
  // Differ's own consecutive-loss counter, driving its own stake
  // martingale. Entirely separate from the Martingale/Ra bots' tracking.
  const lossStreakRef = useRef(0);
  const balanceRef = useRef<number | null>(balance);
  useEffect(() => {
    balanceRef.current = balance;
  }, [balance]);
  // Same "skip the loading-pulse wait" guard as the Ra bot — see
  // use-ra-bot.ts for the full reasoning. Needed here too since a repeat
  // trade inside a burst (same digit, same contract, stake reset by a win)
  // won't cause useProposal to re-subscribe.
  const sawProposalLoadingRef = useRef(false);
  const lastFireKeyRef = useRef<string | null>(null);
  const skipLoadingWaitRef = useRef(false);

  const resetTracking = useCallback(() => {
    const period = Math.max(1, cfgRef.current.patternGap + 1);
    lanesRef.current = Array.from({ length: period }, () => ({ digit: null, count: 0 }));
    tickIndexRef.current = 0;
    setStreakDigit(null);
    setStreakProgress(0);
  }, []);

  const pushLog = useCallback((entry: Omit<DifferLogEntry, 'id' | 'time'>) => {
    setLog((prev) => [...prev.slice(-49), { ...entry, id: logIdRef.current++, time: Date.now() }]);
  }, []);

  const start = useCallback(
    (cfg: DifferBotConfig) => {
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
      setPhase('idle');
      sessionStartRef.current = Date.now();
      setSessionDurationMs(null);
      setEnabled(true);
    },
    [resetTracking]
  );

  const stop = useCallback(
    (reason: DifferStopReason = 'manual') => {
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
    []
  );

  // --- Fires (or re-fires, mid-burst) a single trade for the given digit.
  // Computes the current martingale stake from Differ's own loss streak,
  // sets the contract mode/barrier digit, and flips the phase to kick off
  // the proposal → buy flow.
  const placeTrade = useCallback(
    (digit: number) => {
      const cfg = cfgRef.current;
      const stakeAmount = differStakeFor(cfg, lossStreakRef.current);
      setStake(stakeAmount.toFixed(2));

      const contractMode: ContractMode = cfg.tradeType === 'differs' ? 'DIGITDIFF' : 'DIGITMATCH';

      const fireKey = `${contractMode}:${digit}:${stakeAmount.toFixed(2)}`;
      skipLoadingWaitRef.current = fireKey === lastFireKeyRef.current;
      lastFireKeyRef.current = fireKey;

      activeTradeRef.current = { streakDigit: digit, contractMode, stake: stakeAmount };
      setContractMode(contractMode);
      setSelectedDigit(digit);

      sawProposalLoadingRef.current = false;
      setPhase('awaiting-proposal');
    },
    [setStake, setContractMode, setSelectedDigit]
  );

  // --- Process each genuinely new tick: update the digit record and the
  // in-progress streak, and fire a trade once the streak hits N.
  useEffect(() => {
    if (!enabled || !currentTick) return;
    if (lastProcessedEpochRef.current === currentTick.epoch) return; // already handled this tick
    lastProcessedEpochRef.current = currentTick.epoch;

    const digit = getLastDigit(currentTick.quote, pipSize);
    const cfg = cfgRef.current;

    setDigitRecord((prev) => [...prev.slice(-(DIGIT_RECORD_SIZE - 1)), digit]);

    // Route this tick to its lane (period = gap + 1 lanes, cycling by tick
    // index) and run the same consecutive-run counter as before, but only
    // against that lane's previous value — so a match `period` ticks ago
    // continues the count, exactly like the old back-to-back check did at
    // period 1. Resets to 1 on a mismatch within the lane.
    const period = Math.max(1, cfg.patternGap + 1);
    if (lanesRef.current.length !== period) {
      // Config changed mid-flight (shouldn't normally happen since gap is
      // fixed for a run, but keep this safe) — re-align the lanes.
      lanesRef.current = Array.from({ length: period }, () => ({ digit: null, count: 0 }));
      tickIndexRef.current = 0;
    }
    const laneIndex = tickIndexRef.current % period;
    tickIndexRef.current += 1;
    const lane = lanesRef.current[laneIndex];
    if (lane.digit === digit) {
      lane.count += 1;
    } else {
      lanesRef.current[laneIndex] = { digit, count: 1 };
    }
    const activeLane = lanesRef.current[laneIndex];

    setStreakDigit(activeLane.digit);
    setStreakProgress(Math.min(activeLane.count, cfg.streakLength));

    // Streak complete — open a new burst. Only fires while idle (a burst
    // already in flight loops from the settlement effect below without
    // re-checking this streak). On an actual fire, every lane is wiped so
    // the next signal needs a fresh N-run from scratch.
    if (activeLane.count >= cfg.streakLength && phase === 'idle') {
      const firedDigit = activeLane.digit as number;

      burstPnlRef.current = 0;
      setBurstPnl(0);
      setBurstActive(true);
      setLastBurstOutcome(null);
      placeTrade(firedDigit);

      resetTracking();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTick, enabled, pipSize, phase, placeTrade, resetTracking]);

  // --- Once a proposal for the trade type we just set is ready, buy.
  useEffect(() => {
    if (phase !== 'awaiting-proposal') return;
    if (isProposalLoading) {
      sawProposalLoadingRef.current = true;
      return;
    }
    if (!proposal) return;
    if (!skipLoadingWaitRef.current && !sawProposalLoadingRef.current) return;
    setPhase('awaiting-buy');
    buyContract();
  }, [phase, proposal, isProposalLoading, buyContract]);

  // --- Once bought, remember the contract id and wait for settlement.
  useEffect(() => {
    if (phase !== 'awaiting-buy') return;
    if (buyResult) {
      pendingContractIdRef.current = buyResult.contractId;
      clearBuyResult();
      setPhase('awaiting-settlement');
    } else if (buyError) {
      // Trade failed to place — end the burst and go back to watching for
      // a fresh streak, rather than retrying blindly or hard-stopping.
      activeTradeRef.current = null;
      setBurstActive(false);
      setLastBurstOutcome('error');
      setPhase('idle');
    }
  }, [phase, buyResult, buyError, clearBuyResult]);

  // --- Watch the live open-positions stream for the pending contract closing.
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
    const cfg = cfgRef.current;
    pushLog({
      streakDigit: tradeInfo?.streakDigit ?? null,
      tradeType: cfg.tradeType,
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

    const hitTakeProfit = cfg.takeProfit > 0 && nextPnl >= cfg.takeProfit;
    const hitStopLoss = cfg.stopLoss > 0 && nextPnl <= -cfg.stopLoss;

    if (hitTakeProfit || hitStopLoss) {
      stop(hitTakeProfit ? 'take-profit' : 'stop-loss');
      return;
    }

    const active = activeTradeRef.current;

    if (won) {
      if (cfg.runMode === 'continuous' && active) {
        // Continuous mode: a win doesn't end the run — re-fire the same
        // digit immediately instead of dropping back to idle to wait for a
        // fresh streak. lossStreak was just reset to 0, so this goes out
        // at Differ's base stake.
        const nextStake = differStakeFor(cfg, lossStreakRef.current);
        const bal = balanceRef.current;
        if (bal !== null && nextStake > bal + 0.001) {
          stop('insufficient-funds');
          return;
        }
        setLastBurstOutcome('won');
        placeTrade(active.streakDigit);
        return;
      }

      // Burst mode (default) — go back to watching the digit stream for
      // the next N-run. The bot itself keeps running.
      activeTradeRef.current = null;
      setBurstActive(false);
      setLastBurstOutcome('won');
      setPhase('idle');
      return;
    }

    // Lost — before re-firing, check whether the account can actually
    // afford the next martingale stake. If not, stop the whole bot outright.
    if (active) {
      const nextStake = differStakeFor(cfg, lossStreakRef.current);
      const bal = balanceRef.current;
      if (bal !== null && nextStake > bal + 0.001) {
        stop('insufficient-funds');
        return;
      }
      placeTrade(active.streakDigit);
    } else {
      setPhase('idle');
    }
  }, [phase, openPositions, placeTrade, pushLog, stop, pipSize]);

  return {
    enabled,
    running: enabled,
    phase,
    pnl,
    digitRecord,
    stoppedReason,
    streakDigit,
    streakProgress,
    burstActive,
    burstPnl,
    lastBurstOutcome,
    log,
    sessionDurationMs,
    start,
    stop,
  };
}
