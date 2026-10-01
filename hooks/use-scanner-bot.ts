'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveSymbol, DerivWS, TicksHistoryResponse } from '@deriv/core';
import { pipSizeFromPip } from '@/lib/digit-stats';
import { analyseMarket, type ScanCandidate } from '@/lib/scanner-analysis';
import { SYMBOL_DISPLAY_NAMES } from '@/lib/active-symbols-display-names';

/**
 * AI Scanner. Three jobs:
 *  1. scan(): pull recent ticks for every volatility market, score Over N /
 *     Under (9-N) on each, and pick the cleanest setup (or report none).
 *  2. start(): trade the chosen setup 1 tick at a time with a martingale
 *     recovery flow, stopping at take-profit, stop-loss, max recovery steps
 *     or when the user presses stop.
 *  3. autoRun(): keep scanning (pausing between rounds) until a clean setup
 *     turns up, then immediately trade it via start().
 */

export type ScanPhase = 'idle' | 'scanning' | 'done';
export type ScannerLogKind = 'info' | 'win' | 'loss' | 'error';
export interface ScannerLogEntry {
  id: number;
  time: number;
  kind: ScannerLogKind;
  text: string;
}

export interface ScannerSettings {
  initialStake: number;
  multiplier: number;
  maxSteps: number;
  takeProfit: number;
  stopLoss: number;
}

export interface ScannerStats {
  wins: number;
  losses: number;
  profit: number;
  step: number;
  nextStake: number;
}

const EMPTY_STATS: ScannerStats = { wins: 0, losses: 0, profit: 0, step: 0, nextStake: 0 };
const MAX_LOG = 60;
const VOL_SYMBOL = /^(R_\d+|1HZ\d+V)$/;

function nameOf(s: ActiveSymbol): string {
  return s.underlying_symbol_name || SYMBOL_DISPLAY_NAMES[s.underlying_symbol] || s.underlying_symbol;
}

interface Params {
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  symbols: ActiveSymbol[];
  currency: string;
  balance: number | null;
}

export function useScannerBot({ ws, isConnected, isAuthenticated, symbols, currency, balance }: Params) {
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [progress, setProgress] = useState({ index: 0, total: 0, name: '' });
  const [ranking, setRanking] = useState<ScanCandidate[]>([]);
  const [selected, setSelected] = useState<ScanCandidate | null>(null);
  const [message, setMessage] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<ScannerStats>(EMPTY_STATS);
  const [log, setLog] = useState<ScannerLogEntry[]>([]);
  const [auto, setAuto] = useState(false);
  const [round, setRound] = useState(0);
  const [countdown, setCountdown] = useState(0);

  const runningRef = useRef(false);
  const scanningRef = useRef(false);
  const abortRef = useRef(false);
  const autoRef = useRef(false);
  const scanFailedRef = useRef(false);
  const logId = useRef(0);
  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  const addLog = useCallback((kind: ScannerLogKind, text: string) => {
    setLog((prev) => [{ id: ++logId.current, time: Date.now(), kind, text }, ...prev].slice(0, MAX_LOG));
  }, []);

  // Stop everything if the connection drops.
  useEffect(() => {
    if (!isConnected) {
      runningRef.current = false;
      abortRef.current = true;
    }
  }, [isConnected]);
  useEffect(
    () => () => {
      runningRef.current = false;
      scanningRef.current = false;
      abortRef.current = true;
      autoRef.current = false;
    },
    []
  );

  const scan = useCallback(
    async (overBarrier: number, tickCount: number): Promise<ScanCandidate | null> => {
      if (!ws || !isConnected || scanningRef.current || runningRef.current) return null;
      const markets = symbols.filter((s) => VOL_SYMBOL.test(s.underlying_symbol));
      scanFailedRef.current = false;
      if (markets.length === 0) {
        scanFailedRef.current = true;
        setMessage('No volatility markets are available right now.');
        setPhase('done');
        return null;
      }
      scanningRef.current = true;
      setPhase('scanning');
      setSelected(null);
      setRanking([]);
      setMessage('');
      const count = Math.min(5000, Math.max(100, Math.floor(tickCount) || 3000));
      const all: ScanCandidate[] = [];

      for (let i = 0; i < markets.length; i++) {
        if (abortRef.current) break;
        const m = markets[i];
        const name = nameOf(m);
        setProgress({ index: i + 1, total: markets.length, name });
        try {
          const res = await ws.send<TicksHistoryResponse>({
            ticks_history: m.underlying_symbol,
            end: 'latest',
            count,
            style: 'ticks',
          });
          const prices = res.history?.prices ?? [];
          all.push(...analyseMarket(m.underlying_symbol, name, prices, pipSizeFromPip(m.pip_size), overBarrier));
        } catch {
          // Skip a market that fails to load; the scan carries on.
        }
      }

      scanningRef.current = false;
      if (abortRef.current) {
        setPhase('idle');
        return null;
      }
      if (all.length === 0) {
        scanFailedRef.current = true;
        setMessage('Could not load market data. Check your connection.');
        setPhase('done');
        return null;
      }
      const ranked = all.sort((a, b) => Number(b.passes) - Number(a.passes) || b.score - a.score);
      setRanking(ranked.slice(0, 6));
      const best = ranked.find((c) => c.passes) ?? null;
      setSelected(best);
      setMessage(
        best
          ? `Best setup: ${best.side === 'over' ? 'Over' : 'Under'} ${best.barrier} on ${best.symbolName}.`
          : 'No clean setup found. The scanner blocked noisy or low-confidence setups.'
      );
      setPhase('done');
      return best;
    },
    [ws, isConnected, symbols]
  );

  /** Manual single scan (does not trade). */
  const scanOnce = useCallback(
    async (overBarrier: number, tickCount: number) => {
      abortRef.current = false;
      return scan(overBarrier, tickCount);
    },
    [scan]
  );

  const stop = useCallback(() => {
    runningRef.current = false;
    abortRef.current = true;
    autoRef.current = false;
  }, []);

  /** Wait for a contract to settle; resolves with its profit. */
  const awaitResult = useCallback(
    (contractId: number): Promise<number> =>
      new Promise((resolve, reject) => {
        if (!ws) return reject(new Error('Not connected'));
        let unsub: (() => void) | null = null;
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          unsub?.();
          reject(new Error('Timed out waiting for the contract to settle'));
        }, 60_000);
        ws.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (data) => {
          const c = data.proposal_open_contract as { is_sold?: number; profit?: number } | undefined;
          if (!c || !c.is_sold || done) return;
          done = true;
          clearTimeout(timer);
          unsub?.();
          resolve(Number(c.profit ?? 0));
        })
          .then((s) => {
            unsub = s.unsubscribe;
            if (done) s.unsubscribe();
          })
          .catch((e) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e);
          });
      }),
    [ws]
  );

  const start = useCallback(
    async (setup: ScanCandidate, s: ScannerSettings) => {
      if (!ws || !isConnected || !isAuthenticated || runningRef.current || scanningRef.current) return;
      if (!(s.initialStake > 0)) {
        addLog('error', 'Enter a stake greater than 0.');
        return;
      }
      runningRef.current = true;
      setRunning(true);
      setStats({ ...EMPTY_STATS, nextStake: s.initialStake });
      addLog('info', `Started: ${setup.side === 'over' ? 'Over' : 'Under'} ${setup.barrier} on ${setup.symbolName}.`);

      let step = 0;
      let stake = s.initialStake;
      let wins = 0;
      let losses = 0;
      let profit = 0;
      let reason = 'Stopped.';
      const contractType = setup.side === 'over' ? 'DIGITOVER' : 'DIGITUNDER';

      try {
        while (runningRef.current) {
          stake = Math.round(stake * 100) / 100;
          if (balanceRef.current !== null && stake > balanceRef.current) {
            reason = 'Stopped: next stake exceeds your balance.';
            break;
          }
          const res = await ws.send<{ buy?: { contract_id: number; buy_price: number } }>({
            buy: 1,
            price: stake,
            parameters: {
              amount: stake,
              basis: 'stake',
              contract_type: contractType,
              currency,
              duration: 1,
              duration_unit: 't',
              symbol: setup.symbol,
              barrier: String(setup.barrier),
            },
          });
          if (!res.buy) throw new Error('Purchase failed');
          const pnl = await awaitResult(res.buy.contract_id);
          profit += pnl;

          if (pnl > 0) {
            wins++;
            addLog('win', `Win +${pnl.toFixed(2)} (stake ${stake.toFixed(2)})`);
            step = 0;
            stake = s.initialStake;
          } else {
            losses++;
            addLog('loss', `Loss ${pnl.toFixed(2)} (stake ${stake.toFixed(2)})`);
            step++;
            stake = stake * s.multiplier;
          }
          setStats({ wins, losses, profit, step, nextStake: stake });

          if (s.takeProfit > 0 && profit >= s.takeProfit) {
            reason = `Take-profit reached (+${profit.toFixed(2)}).`;
            break;
          }
          if (s.stopLoss > 0 && profit <= -s.stopLoss) {
            reason = `Stop-loss reached (${profit.toFixed(2)}).`;
            break;
          }
          if (s.maxSteps > 0 && step >= s.maxSteps) {
            reason = `Stopped: ${step} losses in a row (max recovery steps).`;
            break;
          }
        }
      } catch (e) {
        reason = `Stopped: ${e instanceof Error ? e.message : 'unexpected error'}`;
        addLog('error', reason);
      }

      runningRef.current = false;
      setRunning(false);
      addLog('info', reason);
      setMessage(reason);
    },
    [ws, isConnected, isAuthenticated, currency, awaitResult, addLog]
  );

  /**
   * Continuous mode: scan, and if nothing clean turns up wait `delaySec` and
   * scan again — repeating until a setup passes — then trade it straight away.
   */
  const autoRun = useCallback(
    async (overBarrier: number, tickCount: number, settings: ScannerSettings, delaySec: number) => {
      if (!ws || !isConnected || !isAuthenticated || autoRef.current || runningRef.current || scanningRef.current) return;
      autoRef.current = true;
      abortRef.current = false;
      setAuto(true);
      setRound(0);
      addLog('info', 'Auto scan started — scanning until a clean setup appears.');

      let n = 0;
      let found: ScanCandidate | null = null;
      while (autoRef.current && !abortRef.current) {
        n++;
        setRound(n);
        found = await scan(overBarrier, tickCount);
        if (!autoRef.current || abortRef.current) break;
        if (found) break;
        if (scanFailedRef.current) {
          addLog('error', 'Auto scan stopped: could not load market data.');
          break;
        }
        // Nothing clean this round — wait, then scan again.
        const wait = Math.max(1, Math.floor(delaySec) || 5);
        addLog('info', `Round ${n}: no clean setup. Rescanning in ${wait}s.`);
        for (let t = wait; t > 0 && autoRef.current && !abortRef.current; t--) {
          setCountdown(t);
          await new Promise((r) => setTimeout(r, 1000));
        }
        setCountdown(0);
      }

      const stillOn = autoRef.current && !abortRef.current;
      if (found && stillOn) {
        addLog('info', `Round ${n}: setup found — placing trades.`);
        autoRef.current = false;
        setAuto(false);
        await start(found, settings);
        return;
      }
      autoRef.current = false;
      setAuto(false);
      setCountdown(0);
      addLog('info', 'Auto scan stopped.');
    },
    [ws, isConnected, isAuthenticated, scan, start, addLog]
  );

  return {
    phase, progress, ranking, selected, message, running, stats, log,
    auto, round, countdown,
    scan: scanOnce, start, stop, autoRun,
  };
}
