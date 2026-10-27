'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProposalInfo, BuyResult } from '@deriv/core';
import type { ContractMode, OpenPosition } from '@/lib/types';
import { usePhaseWatchdog, timeoutReason, type TimeoutReason } from '@/hooks/use-phase-watchdog';
import { runJustEndedAt, conditionLabel, type SequenceCondition } from '@/lib/digit-sequences';

/**
 * "MM" (Multi-market) bot.
 *
 * Signal: on any watched market, a run of consecutive digits that satisfy the
 * chosen condition (e.g. Over 5) ends after *exactly* `sequenceLength` ticks
 * — i.e. that length's bar in the Multi-market sequence chart just went up by
 * one. Runs shorter or longer than that length do nothing.
 *
 * Action, on the market that signalled:
 *  - Trend:   trade the condition itself (Over 5 → Over 5).
 *  - Counter: trade whatever the user picked explicitly (`counterTrade`) —
 *             nothing is inferred from the signal.
 *
 * Execution reuses the same manual trade panel flow as the other bots (set
 * stake / contract / barrier, wait for the proposal, buy, wait for the
 * contract to settle). Because the signal can come from any market, the bot
 * first switches the panel's active market to the signalling one and will not
 * buy until the quote it holds is for that market.
 *
 * Loss lock (when `stayOnMarket` is on): after a loss, the bot stays on the market that lost. Signals from
 * every other market are skipped, and the next trade (with the martingale
 * stake) only happens on a fresh signal from that same market, until a win
 * releases the lock and all markets are watched again. The market cooldown
 * does not apply to the locked market, so recovery isn't delayed by it.
 * While locked, `recoveryMode` decides what triggers the next trade:
 * 'burst' re-fires at once on that market until a win (like Differ's burst),
 * 'continuous' waits for the next fresh signal on it, and 'target' keeps
 * re-firing on that market (wins included) until the profit since the first
 * loss of the cycle reaches `recoveryTarget` USD.
 *
 * Money handling mirrors the Differ bot: martingale multiplier applied after
 * `martingaleStartAfter` consecutive losses, whole-run Take Profit / Stop
 * Loss in USD, insufficient-funds stop; plus an optional Max Stake stop and a
 * per-market cooldown. One trade at a time: signals that arrive while a trade
 * is in flight are counted but not taken.
 */

export type MmMode = 'trend' | 'counter';
export type MmCounterKind = 'over' | 'under' | 'even' | 'odd' | 'matches' | 'differs';

export interface MmCounterTrade {
  kind: MmCounterKind;
  /** Barrier / digit. Ignored for even/odd. Over: 0-8, Under: 1-9, Matches/Differs: 0-9. */
  digit: number;
}

/** What happens after a loss while locked to a market (see `stayOnMarket`):
 *  'burst'      — re-fire immediately on that market (martingale stake) until
 *                 a win; a win then waits for a fresh signal on any market.
 *  'continuous' — wait for the next fresh signal on that same market before
 *                 each martingale trade.
 *  'target'     — re-fire immediately on that market after every trade (loss
 *                 or win) until the net profit of the recovery cycle,
 *                 counted from the first losing trade, reaches
 *                 `recoveryTarget` USD. Wins below the target go back to the
 *                 base stake and keep firing. */
export type MmRecoveryMode = 'burst' | 'continuous' | 'target';

export type MmStopReason =
  | 'manual'
  | 'take-profit'
  | 'stop-loss'
  | 'insufficient-funds'
  | 'max-stake'
  | TimeoutReason
  | null;
export type MmPhase = 'idle' | 'awaiting-proposal' | 'awaiting-buy' | 'awaiting-settlement';

export interface MmBotConfig {
  /** The digit condition whose runs are watched, e.g. Over 5. */
  condition: SequenceCondition;
  /** Exact run length that triggers a signal (2-10). */
  sequenceLength: number;
  mode: MmMode;
  /** Only used in Counter mode. */
  counterTrade: MmCounterTrade;
  initialStake: number;
  stakeMultiplier: number;
  /** Consecutive losses before the multiplier starts applying. 0 = from the first loss. */
  martingaleStartAfter: number;
  /** Whole-run take profit in USD. 0 = off. */
  takeProfit: number;
  /** Whole-run stop loss in USD (positive number). 0 = off. */
  stopLoss: number;
  /** Stop the bot instead of placing a stake above this. 0 = off. */
  maxStake: number;
  /** Ticks a market sits out after the bot traded it. 0 = off. */
  cooldownTicks: number;
  /** After a loss, only trade the market that lost until a win. Off = any market. */
  stayOnMarket: boolean;
  /** How recovery trades are triggered while locked. Ignored when `stayOnMarket` is off. */
  recoveryMode: MmRecoveryMode;
  /** 'target' mode only: net USD to make over the recovery cycle (counted from
   *  the first loss that started it) before the lock is released. */
  recoveryTarget: number;
}

export interface MmLogEntry {
  id: number;
  time: number;
  symbol: string;
  runLength: number;
  /** What was bought, e.g. "Over 5" or "Even". */
  tradeLabel: string;
  exitSpot: number | null;
  won: boolean;
  stake: number;
  profit: number;
  /** True for a Burst re-fire (no new signal behind it). */
  refire: boolean;
}

export interface MmSignal {
  id: number;
  time: number;
  symbol: string;
  runLength: number;
  action: 'traded' | 'busy' | 'cooldown' | 'locked';
  tradeLabel: string;
}

/** Where on a market's tick tape a trade was placed. */
export interface MmTradeMark {
  contractId: number;
  symbol: string;
  /** Epoch of the newest tick on that market when the buy was confirmed. */
  epoch: number;
  status: 'pending' | 'won' | 'lost';
  label: string;
  stake: number;
  time: number;
  refire: boolean;
}

/** Last ticks of one market, oldest → newest, epochs aligned to digits. */
export interface MmTapeEntry {
  digits: number[];
  epochs: number[];
}

/** How many ticks the tick record shows (3 rows of 10). */
export const MM_TAPE_TICKS = 30;
const MAX_TRADE_MARKS = 60;

interface ResolvedTrade {
  contractMode: ContractMode;
  digit: number;
  label: string;
}

export function resolveMmTrade(cfg: MmBotConfig): ResolvedTrade {
  if (cfg.mode === 'trend') {
    const { side, barrier } = cfg.condition;
    return {
      contractMode: side === 'over' ? 'DIGITOVER' : 'DIGITUNDER',
      digit: barrier,
      label: conditionLabel(cfg.condition),
    };
  }
  const { kind, digit } = cfg.counterTrade;
  switch (kind) {
    case 'over':
      return { contractMode: 'DIGITOVER', digit, label: `Over ${digit}` };
    case 'under':
      return { contractMode: 'DIGITUNDER', digit, label: `Under ${digit}` };
    case 'matches':
      return { contractMode: 'DIGITMATCH', digit, label: `Matches ${digit}` };
    case 'differs':
      return { contractMode: 'DIGITDIFF', digit, label: `Differs ${digit}` };
    case 'even':
      return { contractMode: 'DIGITEVEN', digit: 0, label: 'Even' };
    case 'odd':
      return { contractMode: 'DIGITODD', digit: 0, label: 'Odd' };
  }
}

/** Stake for the next trade given the current consecutive-loss count. */
export function mmStakeFor(cfg: MmBotConfig, lossStreak: number): number {
  const lossesPastGrace = Math.max(0, lossStreak - cfg.martingaleStartAfter);
  return cfg.initialStake * Math.pow(cfg.stakeMultiplier, lossesPastGrace);
}

interface Params {
  /** Underlying symbol of the market currently selected in the trade panel. */
  activeSymbolCode: string | null;
  selectSymbol: (symbol: string) => void;
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
  balance: number | null;
}

interface ActiveTrade {
  symbol: string;
  runLength: number;
  contractMode: ContractMode;
  digit: number;
  label: string;
  stake: number;
  refire: boolean;
}

export function useMmBot({
  activeSymbolCode,
  selectSymbol,
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
}: Params) {
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<MmPhase>('idle');
  const [pnl, setPnl] = useState(0);
  const [stoppedReason, setStoppedReason] = useState<MmStopReason>(null);
  const [log, setLog] = useState<MmLogEntry[]>([]);
  const [lastSignal, setLastSignal] = useState<MmSignal | null>(null);
  const [tradeMarks, setTradeMarks] = useState<MmTradeMark[]>([]);
  // Last ticks of every watched market, frozen the moment the bot stops so they
  // can be inspected afterwards (e.g. after a Stop Loss).
  const [frozenTape, setFrozenTape] = useState<Record<string, MmTapeEntry> | null>(null);
  const [signalCount, setSignalCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [currentTrade, setCurrentTrade] = useState<{ symbol: string; label: string } | null>(null);
  const [lossStreak, setLossStreak] = useState(0);
  // Market the bot is recovering on after a loss; null when free to take any market.
  const [lockedSymbol, setLockedSymbol] = useState<string | null>(null);
  const [sessionDurationMs, setSessionDurationMs] = useState<number | null>(null);

  const cfgRef = useRef<MmBotConfig | null>(null);
  const enabledRef = useRef(false);
  const phaseRef = useRef<MmPhase>('idle');
  const pnlRef = useRef(0);
  const lossStreakRef = useRef(0);
  const lockedSymbolRef = useRef<string | null>(null);
  // Total P/L just before the loss that started the current recovery cycle
  // ('target' mode measures its goal from here).
  const cycleStartPnlRef = useRef(0);
  // Live per-market tick buffers as last seen by handleTick (references to the
  // scanner's arrays, which it mutates in place).
  const bufRef = useRef<Record<string, { digits: readonly number[]; epochs: readonly number[] }>>({});
  const activeTradeRef = useRef<ActiveTrade | null>(null);
  const pendingContractIdRef = useRef<number | null>(null);
  const cooldownRef = useRef<Record<string, number>>({});
  const logIdRef = useRef(0);
  const signalIdRef = useRef(0);
  const sessionStartRef = useRef<number | null>(null);
  const balanceRef = useRef<number | null>(balance);
  const sawProposalLoadingRef = useRef(false);
  const lastFireKeyRef = useRef<string | null>(null);
  const skipLoadingWaitRef = useRef(false);

  // Latest versions of the trade-panel callbacks, read from `handleTick`
  // (which must stay referentially stable for the scanner).
  const apiRef = useRef({ selectSymbol, setStake, setContractMode, setSelectedDigit });
  apiRef.current = { selectSymbol, setStake, setContractMode, setSelectedDigit };

  useEffect(() => {
    balanceRef.current = balance;
  }, [balance]);

  const setPhaseSync = useCallback((next: MmPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const pushLog = useCallback((entry: Omit<MmLogEntry, 'id' | 'time'>) => {
    const id = logIdRef.current++;
    setLog((prev) => [...prev.slice(-49), { ...entry, id, time: Date.now() }]);
  }, []);

  const start = useCallback(
    (cfg: MmBotConfig) => {
      cfgRef.current = cfg;
      pnlRef.current = 0;
      lossStreakRef.current = 0;
      lockedSymbolRef.current = null;
      cycleStartPnlRef.current = 0;
      setLockedSymbol(null);
      bufRef.current = {};
      setTradeMarks([]);
      setFrozenTape(null);
      activeTradeRef.current = null;
      pendingContractIdRef.current = null;
      cooldownRef.current = {};
      lastFireKeyRef.current = null;
      skipLoadingWaitRef.current = false;
      logIdRef.current = 0;
      signalIdRef.current = 0;
      setPnl(0);
      setLossStreak(0);
      setLog([]);
      setLastSignal(null);
      setSignalCount(0);
      setSkippedCount(0);
      setCurrentTrade(null);
      setStoppedReason(null);
      setSessionDurationMs(null);
      sessionStartRef.current = Date.now();
      setPhaseSync('idle');
      enabledRef.current = true;
      setEnabled(true);
    },
    [setPhaseSync]
  );

  const stop = useCallback(
    (reason: MmStopReason = 'manual') => {
      enabledRef.current = false;
      setEnabled(false);
      lockedSymbolRef.current = null;
      setLockedSymbol(null);
      // Keep the last ticks of every watched market for after-the-fact review.
      const frozen: Record<string, MmTapeEntry> = {};
      for (const [sym, buf] of Object.entries(bufRef.current)) {
        frozen[sym] = {
          digits: buf.digits.slice(-MM_TAPE_TICKS),
          epochs: buf.epochs.slice(-MM_TAPE_TICKS),
        };
      }
      setFrozenTape(Object.keys(frozen).length > 0 ? frozen : null);
      setStoppedReason(reason);
      setPhaseSync('idle');
      pendingContractIdRef.current = null;
      activeTradeRef.current = null;
      setCurrentTrade(null);
      setSessionDurationMs(
        sessionStartRef.current !== null ? Date.now() - sessionStartRef.current : null
      );
    },
    [setPhaseSync]
  );

  const recordSignal = useCallback(
    (symbol: string, runLength: number, action: MmSignal['action'], tradeLabel: string) => {
      setSignalCount((n) => n + 1);
      if (action !== 'traded') setSkippedCount((n) => n + 1);
      setLastSignal({
        id: ++signalIdRef.current,
        time: Date.now(),
        symbol,
        runLength,
        action,
        tradeLabel,
      });
    },
    []
  );

  /**
   * Point the trade panel at `symbol` and start one trade there: stake from the
   * current loss streak, contract from the configured mode. `refire` marks a
   * Burst re-fire (not caused by a new signal). Returns false if it stopped the
   * bot instead (Max Stake / insufficient funds).
   */
  const fireTrade = useCallback(
    (symbol: string, runLength: number, refire: boolean): boolean => {
      const cfg = cfgRef.current;
      if (!cfg) return false;
      const trade = resolveMmTrade(cfg);
      const stakeAmount = mmStakeFor(cfg, lossStreakRef.current);
      if (cfg.maxStake > 0 && stakeAmount > cfg.maxStake + 0.001) {
        stop('max-stake');
        return false;
      }
      const bal = balanceRef.current;
      if (bal !== null && stakeAmount > bal + 0.001) {
        stop('insufficient-funds');
        return false;
      }

      if (!refire) recordSignal(symbol, runLength, 'traded', trade.label);

      const fireKey = `${symbol}:${trade.contractMode}:${trade.digit}:${stakeAmount.toFixed(2)}`;
      skipLoadingWaitRef.current = fireKey === lastFireKeyRef.current;
      lastFireKeyRef.current = fireKey;

      activeTradeRef.current = {
        symbol,
        runLength,
        contractMode: trade.contractMode,
        digit: trade.digit,
        label: trade.label,
        stake: stakeAmount,
        refire,
      };
      setCurrentTrade({ symbol, label: trade.label });

      // Point the trade panel at the signalling market and the chosen contract.
      const api = apiRef.current;
      api.selectSymbol(symbol);
      api.setStake(stakeAmount.toFixed(2));
      api.setContractMode(trade.contractMode);
      if (trade.contractMode !== 'DIGITEVEN' && trade.contractMode !== 'DIGITODD') {
        api.setSelectedDigit(trade.digit);
      }
      sawProposalLoadingRef.current = false;
      setPhaseSync('awaiting-proposal');
      return true;
    },
    [recordSignal, setPhaseSync, stop]
  );

  /**
   * Fed by the scanner for every new live tick of every watched market.
   * Detects "a run of exactly N just ended on this market".
   */
  const handleTick = useCallback(
    (symbol: string, digits: readonly number[], epochs: readonly number[]) => {
      if (!enabledRef.current) return;
      const cfg = cfgRef.current;
      if (!cfg) return;
      bufRef.current[symbol] = { digits, epochs };

      const cd = cooldownRef.current[symbol] ?? 0;
      if (cd > 0) cooldownRef.current[symbol] = cd - 1;

      // Did a run of exactly the watched length just end on this tick?
      if (!runJustEndedAt(digits, cfg.condition, cfg.sequenceLength)) return;
      const run = cfg.sequenceLength;

      const trade = resolveMmTrade(cfg);

      // Recovering from a loss: only the market that lost may trade.
      const locked = lockedSymbolRef.current;
      if (locked !== null && symbol !== locked) {
        recordSignal(symbol, run, 'locked', trade.label);
        return;
      }
      if (phaseRef.current !== 'idle') {
        recordSignal(symbol, run, 'busy', trade.label);
        return;
      }
      if (locked === null && (cooldownRef.current[symbol] ?? 0) > 0) {
        recordSignal(symbol, run, 'cooldown', trade.label);
        return;
      }

      fireTrade(symbol, run, false);
    },
    [recordSignal, fireTrade]
  );

  // --- Buy once a quote for the right market / stake is ready.
  useEffect(() => {
    if (phase !== 'awaiting-proposal') return;
    const trade = activeTradeRef.current;
    if (!trade) return;
    // The panel must actually be on the signalling market before any quote counts.
    if (activeSymbolCode !== trade.symbol) return;
    if (isProposalLoading) {
      sawProposalLoadingRef.current = true;
      return;
    }
    if (!proposal) return;
    if (!skipLoadingWaitRef.current && !sawProposalLoadingRef.current) return;
    // Never buy a quote for a different stake than the one just asked for.
    if (Math.abs(proposal.askPrice - Number(trade.stake.toFixed(2))) > 0.005) return;
    setPhaseSync('awaiting-buy');
    buyContract();
  }, [phase, proposal, isProposalLoading, activeSymbolCode, buyContract, setPhaseSync]);

  // --- Bought: remember the contract and wait for it to settle.
  useEffect(() => {
    if (phase !== 'awaiting-buy') return;
    if (buyResult) {
      pendingContractIdRef.current = buyResult.contractId;
      // Pin this trade to the newest tick on its market, so the tick record
      // can show exactly where the bot started trading.
      const placed = activeTradeRef.current;
      const buf = placed ? bufRef.current[placed.symbol] : undefined;
      const markEpoch = buf && buf.epochs.length > 0 ? buf.epochs[buf.epochs.length - 1] : null;
      if (placed && markEpoch !== null) {
        const mark: MmTradeMark = {
          contractId: buyResult.contractId,
          symbol: placed.symbol,
          epoch: markEpoch,
          status: 'pending',
          label: placed.label,
          stake: placed.stake,
          time: Date.now(),
          refire: placed.refire,
        };
        setTradeMarks((prev) => [...prev.slice(-(MAX_TRADE_MARKS - 1)), mark]);
      }
      clearBuyResult();
      setPhaseSync('awaiting-settlement');
    } else if (buyError) {
      // Failed to place: drop this signal and keep watching.
      activeTradeRef.current = null;
      setCurrentTrade(null);
      setPhaseSync('idle');
    }
  }, [phase, buyResult, buyError, clearBuyResult, setPhaseSync]);

  // --- Settlement.
  useEffect(() => {
    if (phase !== 'awaiting-settlement' || pendingContractIdRef.current === null) return;
    const pos = openPositions.find((p) => p.contract_id === pendingContractIdRef.current);
    if (!pos) return;
    const isClosed = !!pos.is_sold || !!pos.is_expired || pos.status !== 'open';
    if (!isClosed) return;

    const profit = parseFloat(pos.profit);
    const won = profit > 0;
    const settledId = pendingContractIdRef.current;
    pendingContractIdRef.current = null;
    setTradeMarks((prev) =>
      prev.map((m) => (m.contractId === settledId ? { ...m, status: won ? 'won' : 'lost' } : m))
    );

    const lastStreamTick =
      pos.tick_stream && pos.tick_stream.length > 0 ? pos.tick_stream[pos.tick_stream.length - 1] : null;
    const exitSpot =
      typeof pos.exit_spot === 'number' ? pos.exit_spot : lastStreamTick ? lastStreamTick.tick : null;

    const trade = activeTradeRef.current;
    const cfg = cfgRef.current;
    if (trade) {
      pushLog({
        symbol: trade.symbol,
        runLength: trade.runLength,
        tradeLabel: trade.label,
        exitSpot,
        won,
        stake: trade.stake,
        profit,
        refire: trade.refire,
      });
      if (cfg && cfg.cooldownTicks > 0) cooldownRef.current[trade.symbol] = cfg.cooldownTicks;
    }

    lossStreakRef.current = won ? 0 : lossStreakRef.current + 1;
    setLossStreak(lossStreakRef.current);
    const nextPnl = pnlRef.current + profit;
    // A loss pins the bot to that market; a win frees it. In 'target' mode a
    // win only frees it once the cycle (counted from the first loss) has made
    // the target amount.
    const wasLocked = lockedSymbolRef.current !== null;
    let nextLock: string | null;
    if (!cfg?.stayOnMarket) {
      nextLock = null;
    } else if (cfg.recoveryMode === 'target') {
      if (!won && !wasLocked) cycleStartPnlRef.current = pnlRef.current;
      const cycleActive = !won || wasLocked;
      const reached = nextPnl - cycleStartPnlRef.current >= cfg.recoveryTarget - 0.001;
      nextLock = cycleActive && !reached ? (trade?.symbol ?? lockedSymbolRef.current) : null;
    } else {
      nextLock = won ? null : (trade?.symbol ?? lockedSymbolRef.current);
    }
    lockedSymbolRef.current = nextLock;
    setLockedSymbol(nextLock);

    pnlRef.current = nextPnl;
    setPnl(nextPnl);

    activeTradeRef.current = null;
    setCurrentTrade(null);

    if (cfg) {
      const hitTakeProfit = cfg.takeProfit > 0 && nextPnl >= cfg.takeProfit;
      const hitStopLoss = cfg.stopLoss > 0 && nextPnl <= -cfg.stopLoss;
      if (hitTakeProfit || hitStopLoss) {
        stop(hitTakeProfit ? 'take-profit' : 'stop-loss');
        return;
      }
      if (!won) {
        const nextStake = mmStakeFor(cfg, lossStreakRef.current);
        if (cfg.maxStake > 0 && nextStake > cfg.maxStake + 0.001) {
          stop('max-stake');
          return;
        }
        const bal = balanceRef.current;
        if (bal !== null && nextStake > bal + 0.001) {
          stop('insufficient-funds');
          return;
        }
      }
    }
    // Burst: after a loss, go again straight away on the market that lost,
    // with no new signal needed, until a win clears the lock.
    // Target: same, but also after wins that haven't yet reached the target.
    if (
      cfg &&
      cfg.stayOnMarket &&
      nextLock &&
      ((cfg.recoveryMode === 'burst' && !won) || cfg.recoveryMode === 'target')
    ) {
      fireTrade(nextLock, trade?.runLength ?? cfg.sequenceLength, true);
      return;
    }
    setPhaseSync('idle');
  }, [phase, openPositions, pushLog, stop, setPhaseSync, fireTrade]);

  usePhaseWatchdog(enabled, phase, (stuckPhase) => stop(timeoutReason(stuckPhase)));

  return {
    enabled,
    running: enabled,
    phase,
    pnl,
    stoppedReason,
    log,
    lastSignal,
    signalCount,
    skippedCount,
    currentTrade,
    lossStreak,
    lockedSymbol,
    tradeMarks,
    frozenTape,
    sessionDurationMs,
    start,
    stop,
    handleTick,
  };
}
