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
 */

export type RaSide = 'over4' | 'under5' | null;
export type RaTradingMode = 'trend' | 'neutral' | 'counter';
export type RaStopReason = 'manual' | 'take-profit' | 'stop-loss' | null;
export type RaPhase = 'idle' | 'awaiting-proposal' | 'awaiting-buy' | 'awaiting-settlement';

export interface RaBotConfig {
  /** N — consecutive same-side digits required to arm a side. 2-20. */
  streakCount: number;
  /** M — consecutive matching digits required, once armed, to fire a trade. 2-20. */
  confirmationStreak: number;
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
  /** Session take-profit target. 0 = off. */
  accountTakeProfit: number;
  /** Session stop-loss (positive number; stops once pnl <= -this). 0 = off. */
  accountStopLoss: number;
}

interface UseRaBotParams {
  currentTick: Tick | null;
  pipSize: number;
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

  const cfgRef = useRef<RaBotConfig>({
    streakCount: 5,
    confirmationStreak: 5,
    tpIncrement: 0,
    cooldownSeconds: 60,
    tradingMode: 'neutral',
    accountTakeProfit: 0,
    accountStopLoss: 0,
  });
  // Runtime take-profit threshold — starts at the configured Account Take
  // Profit and climbs by tpIncrement after every win, mirroring the
  // extension bumping the site's Target Profit field on each TP popup.
  const takeProfitThresholdRef = useRef(Infinity);

  const armedSideRef = useRef<RaSide>(null);
  const primaryStreakRef = useRef<{ side: RaSide; count: number }>({ side: null, count: 0 });
  const confirmCountRef = useRef(0);
  const lastProcessedEpochRef = useRef<number | null>(null);
  const lastTradeTimeRef = useRef(0);
  const pendingContractIdRef = useRef<number | null>(null);

  const resetTracking = useCallback(() => {
    armedSideRef.current = null;
    primaryStreakRef.current = { side: null, count: 0 };
    confirmCountRef.current = 0;
    setArmedSide(null);
    setConfirmProgress(0);
  }, []);

  const start = useCallback(
    (cfg: RaBotConfig) => {
      cfgRef.current = cfg;
      takeProfitThresholdRef.current = cfg.accountTakeProfit > 0 ? cfg.accountTakeProfit : Infinity;
      resetTracking();
      lastProcessedEpochRef.current = null;
      lastTradeTimeRef.current = 0;
      pendingContractIdRef.current = null;
      setPnl(0);
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
      pendingContractIdRef.current = null;
    },
    []
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
    // resets to 0 (not paused) on any non-matching digit.
    if (armedSideRef.current !== null) {
      if (side === armedSideRef.current) {
        confirmCountRef.current += 1;
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

    // Confirmation complete — fire a trade signal (subject to Trading Mode
    // and cooldown), then reset confirmation so the next fire needs a fresh
    // unbroken run of M.
    if (armedSideRef.current !== null && confirmCountRef.current >= cfg.confirmationStreak) {
      const confirmedSide = armedSideRef.current;
      confirmCountRef.current = 0;
      setConfirmProgress(0);

      if (cfg.tradingMode !== 'neutral' && phase === 'idle') {
        const now = Date.now();
        const cooldownMs = cfg.cooldownSeconds * 1000;
        if (now - lastTradeTimeRef.current >= cooldownMs) {
          const tradeSide: RaSide =
            cfg.tradingMode === 'trend'
              ? confirmedSide
              : confirmedSide === 'over4'
                ? 'under5'
                : 'over4';
          if (tradeSide === 'over4') {
            setContractMode('DIGITOVER');
            setSelectedDigit(3);
            setLastFired({ side: tradeSide, barrier: 'Superior 3' });
          } else {
            setContractMode('DIGITUNDER');
            setSelectedDigit(6);
            setLastFired({ side: tradeSide, barrier: 'Inferior 6' });
          }
          lastTradeTimeRef.current = now;
          setPhase('awaiting-proposal');
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTick, enabled, pipSize, setContractMode, setSelectedDigit]);

  // --- Once a proposal for the trade type we just set is ready, buy.
  useEffect(() => {
    if (phase !== 'awaiting-proposal') return;
    if (isProposalLoading || !proposal) return;
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
      // Trade failed to place — go back to watching rather than hard-stopping.
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

    if (won && cfgRef.current.tpIncrement > 0 && takeProfitThresholdRef.current !== Infinity) {
      takeProfitThresholdRef.current += cfgRef.current.tpIncrement;
    }

    setPnl((prevPnl) => {
      const nextPnl = prevPnl + profit;
      if (nextPnl >= takeProfitThresholdRef.current) {
        setEnabled(false);
        setStoppedReason('take-profit');
        setPhase('idle');
        return nextPnl;
      }
      if (cfgRef.current.accountStopLoss > 0 && nextPnl <= -cfgRef.current.accountStopLoss) {
        setEnabled(false);
        setStoppedReason('stop-loss');
        setPhase('idle');
        return nextPnl;
      }
      setPhase('idle');
      return nextPnl;
    });
  }, [phase, openPositions]);

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
    start,
    stop,
  };
}
