'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Tick, ProposalInfo, BuyResult } from '@deriv/core';
import type { ContractMode, OpenPosition } from '@/lib/types';
import { getLastDigit } from '@/lib/digit-stats';

export type BotPhase =
  | 'idle'
  | 'virtual'
  | 'awaiting-proposal'
  | 'awaiting-buy'
  | 'awaiting-settlement'
  | 'stopped-target'
  | 'stopped-loss'
  | 'stopped-error';

export interface BotLogEntry {
  id: number;
  time: number;
  kind: 'virtual' | 'real';
  digit: number | null;
  won: boolean;
  stake: number;
  profit: number;
}

export interface BotConfig {
  initialStake: number;
  multiplier: number;
  virtualLossesNeeded: number;
  startWithVirtual: boolean;
  targetProfit: number; // Infinity = no target
  stopLossAmount: number; // positive number, Infinity = no stop-loss
}

/** Evaluates a Deriv digit contract's win condition against a settled digit. */
function evaluateDigitOutcome(
  contractMode: ContractMode,
  selectedDigit: number,
  digit: number
): boolean {
  switch (contractMode) {
    case 'DIGITMATCH':
      return digit === selectedDigit;
    case 'DIGITDIFF':
      return digit !== selectedDigit;
    case 'DIGITOVER':
      return digit > selectedDigit;
    case 'DIGITUNDER':
      return digit < selectedDigit;
    case 'DIGITEVEN':
      return digit % 2 === 0;
    case 'DIGITODD':
      return digit % 2 === 1;
    default:
      return false;
  }
}

interface UseAutoBotParams {
  currentTick: Tick | null;
  pipSize: number;
  contractMode: ContractMode;
  selectedDigit: number;
  duration: number;
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
 *  - optionally waits for N consecutive *virtual* (simulated, no real stake)
 *    losses of the selected condition before committing real money
 *  - on each real loss, multiplies the stake by `multiplier`; resets to the
 *    initial stake on a win
 *  - stops automatically once cumulative profit reaches `targetProfit` or
 *    cumulative loss reaches `stopLossAmount`
 *
 * Settlement of real contracts is detected via the live `openPositions`
 * WebSocket stream (proposal_open_contract), not by polling.
 */
export function useAutoBot({
  currentTick,
  pipSize,
  contractMode,
  selectedDigit,
  duration,
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
    virtualLossesNeeded: 0,
    startWithVirtual: false,
    targetProfit: Infinity,
    stopLossAmount: Infinity,
  });
  const stakeAmountRef = useRef(1);
  const virtualLossRef = useRef(0);
  const virtualTickCountRef = useRef(0);
  const pendingContractIdRef = useRef<number | null>(null);
  const logIdRef = useRef(0);

  const running = phase !== 'idle' && !phase.startsWith('stopped');

  const pushLog = useCallback((entry: Omit<BotLogEntry, 'id' | 'time'>) => {
    setLog((prev) => [...prev.slice(-49), { ...entry, id: logIdRef.current++, time: Date.now() }]);
  }, []);

  const start = useCallback(
    (cfg: BotConfig) => {
      cfgRef.current = cfg;
      stakeAmountRef.current = cfg.initialStake;
      setCurrentStake(cfg.initialStake);
      virtualLossRef.current = 0;
      virtualTickCountRef.current = 0;
      pendingContractIdRef.current = null;
      setPnl(0);
      setLog([]);
      if (cfg.startWithVirtual && cfg.virtualLossesNeeded > 0) {
        setPhase('virtual');
      } else {
        setStake(String(cfg.initialStake));
        setPhase('awaiting-proposal');
      }
    },
    [setStake]
  );

  const stop = useCallback(() => {
    setPhase('idle');
    pendingContractIdRef.current = null;
  }, []);

  // --- Virtual round: count ticks up to `duration`, then evaluate the same
  // win condition a real contract would use, without placing a real trade.
  useEffect(() => {
    if (phase !== 'virtual' || !currentTick) return;
    virtualTickCountRef.current += 1;
    if (virtualTickCountRef.current < duration) return;
    virtualTickCountRef.current = 0;

    const digit = getLastDigit(currentTick.quote, pipSize);
    const won = evaluateDigitOutcome(contractMode, selectedDigit, digit);
    pushLog({ kind: 'virtual', digit, won, stake: 0, profit: 0 });

    if (won) {
      virtualLossRef.current = 0;
      return;
    }
    virtualLossRef.current += 1;
    if (virtualLossRef.current >= cfgRef.current.virtualLossesNeeded) {
      setStake(String(stakeAmountRef.current));
      setPhase('awaiting-proposal');
    }
  }, [currentTick, phase, duration, pipSize, contractMode, selectedDigit, setStake, pushLog]);

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
    pushLog({ kind: 'real', digit: exitDigit, won, stake: stakeAmountRef.current, profit });
    pendingContractIdRef.current = null;

    setPnl((prevPnl) => {
      const nextPnl = prevPnl + profit;
      if (nextPnl >= cfgRef.current.targetProfit) {
        setPhase('stopped-target');
        return nextPnl;
      }
      if (nextPnl <= -cfgRef.current.stopLossAmount) {
        setPhase('stopped-loss');
        return nextPnl;
      }
      stakeAmountRef.current = won ? cfgRef.current.initialStake : stakeAmountRef.current * cfgRef.current.multiplier;
      setCurrentStake(stakeAmountRef.current);
      setStake(String(stakeAmountRef.current));
      setPhase('awaiting-proposal');
      return nextPnl;
    });
  }, [phase, openPositions, setStake, pipSize, pushLog]);

  return { phase, running, pnl, log, currentStake, start, stop };
}
