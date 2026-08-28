'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProposalInfo, BuyResult } from '@deriv/core';
import type { OpenPosition } from '@/lib/types';
import { getLastDigit } from '@/lib/digit-stats';

export type BotPhase =
  | 'idle'
  | 'awaiting-proposal'
  | 'awaiting-buy'
  | 'awaiting-settlement'
  | 'stopped-target'
  | 'stopped-loss'
  | 'stopped-error';

export interface BotLogEntry {
  id: number;
  time: number;
  digit: number | null;
  won: boolean;
  stake: number;
  profit: number;
}

export interface BotConfig {
  initialStake: number;
  multiplier: number;
  /** Number of consecutive losses to absorb at the initial stake before the
   *  martingale multiplier starts being applied. 0 = multiply from the very
   *  first loss. */
  martingaleStartAfter: number;
  targetProfit: number; // Infinity = no target
  stopLossAmount: number; // positive number, Infinity = no stop-loss (ignored when stopLossLossCount is finite)
  /** Stop once this many consecutive losses occur (no intervening win).
   *  Infinity = disabled (use `stopLossAmount` instead). Checked exactly at
   *  the loss that reaches the count, so a value of 4 stops after the 4th
   *  loss in a row, precisely. */
  stopLossLossCount: number;
}

interface UseAutoBotParams {
  pipSize: number;
  setStake: (value: string) => void;
  proposal: ProposalInfo | null;
  isProposalLoading: boolean;
  buyContract: () => Promise<void>;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;
  openPositions: OpenPosition[];
}

/**
 * Runs a martingale-style digit trading loop entirely client-side, reusing
 * the same proposal/buy machinery as Manual mode:
 *  - places real trades from the start
 *  - absorbs the first `martingaleStartAfter` consecutive losses at the
 *    initial stake, then multiplies the stake by `multiplier` on each loss
 *    beyond that; any win resets both the stake and the loss streak
 *  - stops automatically once cumulative profit reaches `targetProfit`, and
 *    on the loss side either once cumulative loss reaches `stopLossAmount`
 *    or once `stopLossLossCount` consecutive losses occur (no intervening
 *    win) — whichever mode is configured
 *
 * Settlement of real contracts is detected via the live `openPositions`
 * WebSocket stream (proposal_open_contract), not by polling.
 */
export function useAutoBot({
  pipSize,
  setStake,
  proposal,
  isProposalLoading,
  buyContract,
  buyResult,
  buyError,
  clearBuyResult,
  openPositions,
}: UseAutoBotParams) {
  const [phase, setPhase] = useState<BotPhase>('idle');
  const [pnl, setPnl] = useState(0);
  const [log, setLog] = useState<BotLogEntry[]>([]);
  const [currentStake, setCurrentStake] = useState(0);

  const cfgRef = useRef<BotConfig>({
    initialStake: 1,
    multiplier: 2,
    martingaleStartAfter: 0,
    targetProfit: Infinity,
    stopLossAmount: Infinity,
    stopLossLossCount: Infinity,
  });
  const stakeAmountRef = useRef(1);
  const consecutiveLossesRef = useRef(0);
  const pendingContractIdRef = useRef<number | null>(null);
  const logIdRef = useRef(0);

  const running = phase !== 'idle' && !phase.startsWith('stopped');

  const pushLog = useCallback((entry: Omit<BotLogEntry, 'id' | 'time'>) => {
    setLog((prev) => [...prev.slice(-49), { ...entry, id: logIdRef.current++, time: Date.now() }]);
  }, []);

  const start = useCallback(
    (cfg: BotConfig) => {
      const initialStake = Math.round(cfg.initialStake * 100) / 100;
      cfgRef.current = { ...cfg, initialStake };
      stakeAmountRef.current = initialStake;
      setCurrentStake(initialStake);
      consecutiveLossesRef.current = 0;
      pendingContractIdRef.current = null;
      setPnl(0);
      setLog([]);
      setStake(String(initialStake));
      setPhase('awaiting-proposal');
    },
    [setStake]
  );

  const stop = useCallback(() => {
    setPhase('idle');
    pendingContractIdRef.current = null;
  }, []);

  /** Zeroes the displayed cumulative profit/loss without affecting a run in
   *  progress — lets the user start a fresh count for a new session. */
  const resetPnl = useCallback(() => {
    setPnl(0);
  }, []);

  // --- Once a fresh proposal matching the stake we asked for is ready, buy.
  useEffect(() => {
    if (phase !== 'awaiting-proposal') return;
    if (isProposalLoading || !proposal) return;
    if (Math.abs(proposal.askPrice - stakeAmountRef.current) > 0.01) return; // stale proposal, wait
    setPhase('awaiting-buy');
    buyContract();
  }, [phase, proposal, isProposalLoading, buyContract]);

  // --- Once bought, remember the contract id and wait for it to settle.
  useEffect(() => {
    if (phase !== 'awaiting-buy') return;
    if (buyResult) {
      pendingContractIdRef.current = buyResult.contractId;
      clearBuyResult();
      setPhase('awaiting-settlement');
    } else if (buyError) {
      setPhase('stopped-error');
    }
  }, [phase, buyResult, buyError, clearBuyResult]);

  // --- Watch the live open-positions stream for our contract closing.
  useEffect(() => {
    if (phase !== 'awaiting-settlement' || pendingContractIdRef.current == null) return;
    const pos = openPositions.find((p) => p.contract_id === pendingContractIdRef.current);
    if (!pos) return;
    const isClosed = !!pos.is_sold || !!pos.is_expired || pos.status !== 'open';
    if (!isClosed) return;

    const profit = parseFloat(pos.profit);
    const won = profit > 0;
    const exitDigit = typeof pos.exit_spot === 'number' ? getLastDigit(pos.exit_spot, pipSize) : null;
    pushLog({ digit: exitDigit, won, stake: stakeAmountRef.current, profit });
    pendingContractIdRef.current = null;

    setPnl((prevPnl) => {
      const nextPnl = prevPnl + profit;
      if (nextPnl >= cfgRef.current.targetProfit) {
        setPhase('stopped-target');
        return nextPnl;
      }
      // Amount-based stop-loss (ignored when a loss-count stop-loss is configured).
      if (
        cfgRef.current.stopLossLossCount === Infinity &&
        nextPnl <= -cfgRef.current.stopLossAmount
      ) {
        setPhase('stopped-loss');
        return nextPnl;
      }

      if (won) {
        consecutiveLossesRef.current = 0;
        stakeAmountRef.current = cfgRef.current.initialStake;
      } else {
        consecutiveLossesRef.current += 1;
        // Loss-count-based stop-loss: stop exactly at the configured streak length.
        if (consecutiveLossesRef.current >= cfgRef.current.stopLossLossCount) {
          setPhase('stopped-loss');
          return nextPnl;
        }
        stakeAmountRef.current =
          consecutiveLossesRef.current > cfgRef.current.martingaleStartAfter
            ? Math.round(stakeAmountRef.current * cfgRef.current.multiplier * 100) / 100
            : cfgRef.current.initialStake;
      }

      setCurrentStake(stakeAmountRef.current);
      setStake(String(stakeAmountRef.current));
      setPhase('awaiting-proposal');
      return nextPnl;
    });
  }, [phase, openPositions, setStake, pipSize, pushLog]);

  return { phase, running, pnl, log, currentStake, start, stop, resetPnl };
}
