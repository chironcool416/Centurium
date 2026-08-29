'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProposalInfo, BuyResult, Tick } from '@deriv/core';
import type { ContractMode, OpenPosition } from '@/lib/types';
import { getLastDigit } from '@/lib/digit-stats';

/**
 * Native port of the "Eye of Ra" browser-extension bot logic (previously a
 * Chrome extension DOM-scraping traderobot.pro) directly into Centurium,
 * driven by the real live tick stream instead of text-matching a page.
 *
 * Detection watches the over4 (digit > 4) / under5 (digit < 5) split, same
 * as the extension. Execution uses a wider barrier than detection, also
 * unchanged from the extension: a confirmed over4 run trades "Superior 3"
 * (DIGITOVER, barrier 3) and a confirmed under5 run trades "Inferior 6"
 * (DIGITUNDER, barrier 6) — Trend trades the same side that confirmed,
 * Counter trades the opposite side, Neutral never trades.
 *
 * Once a signal fires, Ra doesn't place a single trade and go back to
 * watching — it opens a "burst": it keeps repeating the same trade
 * (side/barrier fixed for the whole burst, stake still following Ra's own
 * martingale on losses) back-to-back as each one settles, accumulating a
 * burst-local P/L. The burst ends the moment that burst P/L reaches the
 * configured Account Take Profit or Account Stop Loss, at which point Ra
 * drops back to `idle` and resumes watching the digit stream for a brand
 * new arm/confirm sequence to open the next burst. The bot itself (`enabled`)
 * is unaffected by a burst ending — only an explicit stop(), or the
 * session-level accountTakeProfit/accountStopLoss being left at 0 forever
 * (which just means a burst never self-ends), changes that.
 */

export type RaSide = 'over4' | 'under5' | null;
export type RaTradingMode = 'trend' | 'neutral' | 'counter';
export type RaStopReason = 'manual' | 'take-profit' | 'stop-loss' | null;
export type RaPhase = 'idle' | 'awaiting-proposal' | 'awaiting-buy' | 'awaiting-settlement';
/** Why the most recently completed burst ended — for a transient UI note,
 *  distinct from RaStopReason which is about the whole bot stopping. */
export type RaBurstOutcome = 'take-profit' | 'stop-loss' | 'error' | null;

/** One settled Ra trade, for the Logs tab — same shape/purpose as the
 *  Martingale bot's BotLogEntry, plus which side/barrier Ra fired. */
export interface RaLogEntry {
  id: number;
  time: number;
  side: RaSide;
  barrier: 'Superior 3' | 'Inferior 6' | null;
  digit: number | null;
  exitSpot: number | null;
  won: boolean;
  stake: number;
  profit: number;
}

export interface RaBotConfig {
  /** N — consecutive same-side digits required to arm a side. 2-20. */
  streakCount: number;
  /** M — consecutive matching digits required, once armed, to fire a trade. 2-20. */
  confirmationStreak: number;
  /** Ra's own base stake, entirely separate from the Martingale bot's stake settings. */
  initialStake: number;
  /** Multiplier applied to Ra's stake after a loss, once martingaleStartAfter losses have occurred. */
  stakeMultiplier: number;
  /** Consecutive Ra losses before the multiplier starts being applied. 0 = multiply from the first loss. */
  martingaleStartAfter: number;
  /**
   * Native equivalent of the extension's "TP Increment": the extension bumped
   * the site's own Target Profit field by this amount after every win. Here,
   * the direct equivalent is bumping the Account Take Profit threshold below
   * by this amount after every Ra win.
   */
  tpIncrement: number;
  /** Minimum gap between trades, in seconds. */
  cooldownSeconds: number;
  tradingMode: RaTradingMode;
  /** Take-profit target for a single burst. 0 = off (burst only ends via
   *  stop-loss or a failed trade). Resets fresh at the start of every burst. */
  accountTakeProfit: number;
  /** Stop-loss for a single burst (positive number; ends the burst once its
   *  P/L <= -this). 0 = off. Resets fresh at the start of every burst. */
  accountStopLoss: number;
}

interface UseRaBotParams {
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
}

const DIGIT_RECORD_SIZE = 30;

function sideOf(digit: number): RaSide {
  return digit > 4 ? 'over4' : 'under5';
}

export function useRaBot({
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
}: UseRaBotParams) {
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<RaPhase>('idle');
  const [pnl, setPnl] = useState(0);
  const [digitRecord, setDigitRecord] = useState<number[]>([]);
  const [stoppedReason, setStoppedReason] = useState<RaStopReason>(null);
  const [armedSide, setArmedSide] = useState<RaSide>(null);
  const [confirmProgress, setConfirmProgress] = useState(0);
  const [lastFired, setLastFired] = useState<{ side: RaSide; barrier: 'Superior 3' | 'Inferior 6' } | null>(
    null
  );
  // Whether Ra is currently mid-burst (has fired and is looping trades
  // toward this burst's TP/SL) as opposed to idle and watching for a signal.
  const [burstActive, setBurstActive] = useState(false);
  // Cumulative P/L for the *current* burst only — resets to 0 each time a
  // new burst opens. `pnl` above keeps accumulating across every burst for
  // the whole run, same as before.
  const [burstPnl, setBurstPnl] = useState(0);
  const [lastBurstOutcome, setLastBurstOutcome] = useState<RaBurstOutcome>(null);
  const [log, setLog] = useState<RaLogEntry[]>([]);
  const logIdRef = useRef(0);

  const cfgRef = useRef<RaBotConfig>({
    streakCount: 5,
    confirmationStreak: 5,
    initialStake: 1,
    stakeMultiplier: 1,
    martingaleStartAfter: 0,
    tpIncrement: 0,
    cooldownSeconds: 60,
    tradingMode: 'neutral',
    accountTakeProfit: 0,
    accountStopLoss: 0,
  });
  // Runtime take-profit threshold for the *current burst* — reset to the
  // configured Account Take Profit at the start of every burst, and climbs
  // by tpIncrement after every win within that burst, mirroring the
  // extension bumping the site's Target Profit field on each TP popup.
  const takeProfitThresholdRef = useRef(Infinity);
  // Running P/L for the current burst — mirrors `burstPnl` state but usable
  // synchronously inside the settlement effect.
  const burstPnlRef = useRef(0);
  // The trade Ra is currently looping within a burst — fixed for the whole
  // burst so each subsequent trade re-fires the same side/barrier without
  // needing the arm/confirm streaks to complete again.
  const activeTradeRef = useRef<{
    side: RaSide;
    contractMode: ContractMode;
    selectedDigit: number;
    barrier: 'Superior 3' | 'Inferior 6';
    stake: number;
  } | null>(null);

  const armedSideRef = useRef<RaSide>(null);
  const primaryStreakRef = useRef<{ side: RaSide; count: number }>({ side: null, count: 0 });
  const confirmCountRef = useRef(0);
  const lastProcessedEpochRef = useRef<number | null>(null);
  const lastTradeTimeRef = useRef(0);
  const pendingContractIdRef = useRef<number | null>(null);
  // Ra's own consecutive-loss counter, driving its own stake martingale.
  // Entirely separate from the Martingale bot's loss tracking in
  // use-auto-bot.ts — Ra never reads or writes that bot's state.
  const lossStreakRef = useRef(0);
  // Guards against buying a stale proposal left over from before we changed
  // contractMode/selectedDigit: setContractMode/setSelectedDigit and the
  // phase flip to 'awaiting-proposal' happen in the same tick, but the old
  // proposal (for the previous contract type/barrier) isn't cleared until a
  // separate hook's effect runs — which can land one render later. Without
  // this guard, the "proposal ready" check below can see that stale
  // leftover proposal as truthy and buy it immediately, which the API then
  // rejects (or worse, silently buys the wrong contract). Requiring an
  // observed isProposalLoading=true first proves the old proposal was
  // actually cleared before we accept a new one.
  const sawProposalLoadingRef = useRef(false);

  const resetTracking = useCallback(() => {
    armedSideRef.current = null;
    primaryStreakRef.current = { side: null, count: 0 };
    confirmCountRef.current = 0;
    setArmedSide(null);
    setConfirmProgress(0);
  }, []);

  const pushLog = useCallback((entry: Omit<RaLogEntry, 'id' | 'time'>) => {
    setLog((prev) => [...prev.slice(-49), { ...entry, id: logIdRef.current++, time: Date.now() }]);
  }, []);

  const start = useCallback(
    (cfg: RaBotConfig) => {
      cfgRef.current = cfg;
      takeProfitThresholdRef.current = cfg.accountTakeProfit > 0 ? cfg.accountTakeProfit : Infinity;
      burstPnlRef.current = 0;
      activeTradeRef.current = null;
      resetTracking();
      lastProcessedEpochRef.current = null;
      lastTradeTimeRef.current = 0;
      pendingContractIdRef.current = null;
      lossStreakRef.current = 0;
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
      setEnabled(true);
    },
    [resetTracking]
  );

  const stop = useCallback(
    (reason: RaStopReason = 'manual') => {
      setEnabled(false);
      setStoppedReason(reason);
      setPhase('idle');
      setBurstActive(false);
      pendingContractIdRef.current = null;
      activeTradeRef.current = null;
    },
    []
  );

  // --- Fires (or re-fires, mid-burst) a single trade for the given side.
  // Computes the current martingale stake from Ra's own loss streak, sets
  // the contract mode/barrier, and flips the phase to kick off the
  // proposal → buy flow. Shared between opening a fresh burst and looping
  // the same trade again after a settlement that didn't hit TP/SL yet.
  const placeTrade = useCallback(
    (side: Exclude<RaSide, null>) => {
      const cfg = cfgRef.current;
      const lossesPastGrace = Math.max(0, lossStreakRef.current - cfg.martingaleStartAfter);
      const raStake = cfg.initialStake * Math.pow(cfg.stakeMultiplier, lossesPastGrace);
      setStake(raStake.toFixed(2));

      const contractMode: ContractMode = side === 'over4' ? 'DIGITOVER' : 'DIGITUNDER';
      const selectedDigit = side === 'over4' ? 3 : 6;
      const barrier: 'Superior 3' | 'Inferior 6' = side === 'over4' ? 'Superior 3' : 'Inferior 6';

      activeTradeRef.current = { side, contractMode, selectedDigit, barrier, stake: raStake };
      setContractMode(contractMode);
      setSelectedDigit(selectedDigit);
      setLastFired({ side, barrier });

      lastTradeTimeRef.current = Date.now();
      sawProposalLoadingRef.current = false;
      setPhase('awaiting-proposal');
    },
    [setStake, setContractMode, setSelectedDigit]
  );

  // --- Process each genuinely new tick: update the digit record, the
  // primary arm streak, the confirmation streak, and fire a trade signal
  // when confirmation completes. Tracked incrementally as ticks arrive
  // (not recomputed from a snapshot window), same as the extension —
  // tolerance for interruptions depends on the sequence, not just counts.
  useEffect(() => {
    if (!enabled || !currentTick) return;
    if (lastProcessedEpochRef.current === currentTick.epoch) return; // already handled this tick
    lastProcessedEpochRef.current = currentTick.epoch;

    const digit = getLastDigit(currentTick.quote, pipSize);
    const side = sideOf(digit);
    const cfg = cfgRef.current;

    setDigitRecord((prev) => [...prev.slice(-(DIGIT_RECORD_SIZE - 1)), digit]);

    // Primary (arming) streak — strict, resets on any opposite digit.
    const primary = primaryStreakRef.current;
    if (primary.side === side) {
      primary.count += 1;
    } else {
      primaryStreakRef.current = { side, count: 1 };
    }

    // Confirmation streak — only progresses once a side is armed, strict,
    // resets to 0 (not paused) on any non-matching digit. Clamped at the
    // target rather than left to grow unbounded once reached — see the
    // completion block below for why it does *not* reset here.
    if (armedSideRef.current !== null) {
      if (side === armedSideRef.current) {
        confirmCountRef.current = Math.min(confirmCountRef.current + 1, cfg.confirmationStreak);
      } else {
        confirmCountRef.current = 0;
      }
    }

    // Arm / abandon check — a full N-length run on the *other* side than
    // what's currently armed drops the old side's confirmation progress
    // entirely and arms the new side fresh. A run shorter than N on the
    // opposite side only resets confirmation (handled above) and never
    // triggers this.
    if (primaryStreakRef.current.count >= cfg.streakCount) {
      const streakSide = primaryStreakRef.current.side;
      if (armedSideRef.current === null) {
        armedSideRef.current = streakSide;
        confirmCountRef.current = 0;
      } else if (streakSide !== armedSideRef.current) {
        armedSideRef.current = streakSide;
        confirmCountRef.current = 0;
      }
      // else: already armed on this side — no change.
    }

    setArmedSide(armedSideRef.current);
    setConfirmProgress(confirmCountRef.current);

    // Confirmation complete — open a new burst (subject to Trading Mode and
    // cooldown). This only *opens* the burst with one trade; further trades
    // within the same burst are fired from the settlement effect below
    // without re-checking the arm/confirm streaks. On an *actual* fire, the
    // whole arm state is wiped — armedSide, confirmCount, AND the primary
    // streak — same as the extension's resetArmState() right before
    // triggerTrade(). That means the next signal (after this burst ends)
    // needs a completely fresh N-digit primary streak plus its own M-digit
    // confirmation, not just a fresh M. In Neutral mode, or while
    // cooldown/an in-flight burst blocks firing, nothing is reset — the
    // count just holds at the target ("ready and waiting") instead of
    // silently zeroing out — it still only drops back to 0 if a genuine
    // opposite-side digit interrupts it (handled above).
    if (armedSideRef.current !== null && confirmCountRef.current >= cfg.confirmationStreak) {
      const confirmedSide = armedSideRef.current;

      if (cfg.tradingMode !== 'neutral' && phase === 'idle') {
        const now = Date.now();
        const cooldownMs = cfg.cooldownSeconds * 1000;
        if (now - lastTradeTimeRef.current >= cooldownMs) {
          const tradeSide: Exclude<RaSide, null> =
            cfg.tradingMode === 'trend'
              ? (confirmedSide as Exclude<RaSide, null>)
              : confirmedSide === 'over4'
                ? 'under5'
                : 'over4';

          // Open a fresh burst: reset burst P/L and the TP threshold back
          // to the configured base (tpIncrement may have raised it during a
          // previous burst) before firing the opening trade.
          burstPnlRef.current = 0;
          setBurstPnl(0);
          takeProfitThresholdRef.current = cfg.accountTakeProfit > 0 ? cfg.accountTakeProfit : Infinity;
          setBurstActive(true);
          setLastBurstOutcome(null);
          placeTrade(tradeSide);

          // Full reset — mirrors the extension's resetArmState(): armed
          // side and primary streak are cleared too, not just confirmCount.
          armedSideRef.current = null;
          primaryStreakRef.current = { side: null, count: 0 };
          confirmCountRef.current = 0;
          setArmedSide(null);
          setConfirmProgress(0);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTick, enabled, pipSize, placeTrade]);

  // --- Once a proposal for the trade type we just set is ready, buy.
  // Only proceeds once isProposalLoading has been observed true at least
  // once since firing — see sawProposalLoadingRef above for why.
  useEffect(() => {
    if (phase !== 'awaiting-proposal') return;
    if (isProposalLoading) {
      sawProposalLoadingRef.current = true;
      return;
    }
    if (!sawProposalLoadingRef.current || !proposal) return;
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
      // Trade failed to place — end the burst (rather than retrying blindly
      // or hard-stopping the whole bot) and go back to watching for a fresh
      // signal to open the next one.
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

    // Exit spot / digit for the log — exit_spot can lag behind is_sold for
    // short contracts, so fall back to the last tick in tick_stream, same
    // reasoning/approach as the Martingale bot's log (use-auto-bot.ts).
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
      side: tradeInfo?.side ?? null,
      barrier: tradeInfo?.barrier ?? null,
      digit: exitDigit,
      exitSpot,
      won,
      stake: tradeInfo?.stake ?? 0,
      profit,
    });

    lossStreakRef.current = won ? 0 : lossStreakRef.current + 1;

    // tpIncrement bumps this burst's own TP threshold after a win, mirroring
    // the extension bumping the site's Target Profit field on each TP popup.
    if (won && cfgRef.current.tpIncrement > 0 && takeProfitThresholdRef.current !== Infinity) {
      takeProfitThresholdRef.current += cfgRef.current.tpIncrement;
    }

    // Overall P/L across the whole run (every burst) — never resets itself.
    setPnl((prevPnl) => prevPnl + profit);

    // This burst's own P/L — the thing actually checked against the
    // burst-local TP/SL to decide whether to keep looping.
    const nextBurstPnl = burstPnlRef.current + profit;
    burstPnlRef.current = nextBurstPnl;
    setBurstPnl(nextBurstPnl);

    const hitTakeProfit = nextBurstPnl >= takeProfitThresholdRef.current;
    const hitStopLoss = cfgRef.current.accountStopLoss > 0 && nextBurstPnl <= -cfgRef.current.accountStopLoss;

    if (hitTakeProfit || hitStopLoss) {
      // Burst complete — stop looping and go back to watching the digit
      // stream for the next arm/confirm signal. The bot itself keeps
      // running; only an explicit stop() disables it.
      activeTradeRef.current = null;
      setBurstActive(false);
      setLastBurstOutcome(hitTakeProfit ? 'take-profit' : 'stop-loss');
      setPhase('idle');
      return;
    }

    // Neither threshold hit yet — keep the burst going: re-fire the exact
    // same side/barrier immediately (no cooldown, no re-arming needed).
    const active = activeTradeRef.current;
    if (active) {
      placeTrade(active.side as Exclude<RaSide, null>);
    } else {
      setPhase('idle');
    }
  }, [phase, openPositions, placeTrade, pushLog]);

  return {
    enabled,
    running: enabled,
    phase,
    pnl,
    digitRecord,
    stoppedReason,
    armedSide,
    confirmProgress,
    lastFired,
    burstActive,
    burstPnl,
    lastBurstOutcome,
    log,
    start,
    stop,
  };
}
