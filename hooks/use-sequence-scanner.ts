'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DerivWS, ActiveSymbol, Tick, TicksHistoryResponse } from '@deriv/core';
import { getLastDigit, pipSizeFromPip } from '@/lib/digit-stats';

/**
 * Feeds the Digits tab's Multi-market view: keeps the last WINDOW_TICKS
 * last-digits of every market in `symbolCodes` up to date, each on its own
 * tick subscription, independent of whichever symbol is selected for trading.
 *
 * Same approach as `useDigitAlerts` (history first, then a live subscription,
 * a watchdog that re-subscribes silent streams) with two differences:
 *  - it only runs while `enabled` is true, so the ~17 streams are not held
 *    open while the user is looking at the Single-market view;
 *  - digits live in refs and are published to React on a short timer instead
 *    of per tick, so 17 busy markets don't trigger 17 re-renders a second.
 *
 * Every (re)subscribe refetches history and replaces the buffer, so a dropped
 * stream can never splice two separate stretches of ticks into one fake run.
 */

export const WINDOW_TICKS = 1000;

/** Default markets for the scanner (those that exist in active_symbols are used). */
export const DEFAULT_SEQUENCE_SYMBOLS = [
  'R_100',
  'R_75',
  'R_50',
  'R_25',
  'R_10',
  '1HZ100V',
  '1HZ75V',
  '1HZ50V',
  '1HZ25V',
  '1HZ10V',
  'RDBULL',
  'RDBEAR',
  'JD100',
  'JD75',
  'JD50',
  'JD25',
  'JD10',
] as const;

export type SequenceStreamStatus = 'connecting' | 'live' | 'stale';

export interface SequenceStream {
  status: SequenceStreamStatus;
  /** Last digits, oldest → newest, at most WINDOW_TICKS long. */
  digits: number[];
  /** Epoch (seconds) of the most recent ticks, aligned to the END of `digits`
   *  (last element ↔ last digit). Only the newest RECENT_EPOCHS are kept. */
  recentEpochs: number[];
}

/** How many trailing tick epochs each published stream carries. */
export const RECENT_EPOCHS = 60;

const STALE_MS = 8_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const PUBLISH_INTERVAL_MS = 500;

interface StreamState {
  pipSize: number;
  digits: number[];
  /** Epoch of every digit in `digits` (same length, same order). */
  epochs: number[];
  lastEpoch: number;
  lastTickAt: number;
  status: SequenceStreamStatus;
}

interface Params {
  ws: DerivWS | null;
  isConnected: boolean;
  symbols: ActiveSymbol[];
  symbolCodes: string[];
  enabled: boolean;
  /** Called synchronously for every genuinely new live tick (never for the
   *  history load), with the market's digit buffer already including the new
   *  digit as its last entry. The array is the live buffer: read it, don't
   *  keep or mutate it. Used by the MM bot for tick-accurate detection
   *  instead of the 500ms-throttled `streams` snapshot. */
  onTick?: (symbol: string, digits: readonly number[], epochs: readonly number[]) => void;
}

export function useSequenceScanner({ ws, isConnected, symbols, symbolCodes, enabled, onTick }: Params) {
  const [streams, setStreams] = useState<Record<string, SequenceStream>>({});
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const stateRef = useRef<Record<string, StreamState>>({});
  const unsubRef = useRef<Record<string, () => void>>({});
  const subscribingRef = useRef<Set<string>>(new Set());
  const generationRef = useRef<Record<string, number>>({});
  const dirtyRef = useRef(false);

  const symbolLookup = useMemo(() => {
    const map = new Map<string, ActiveSymbol>();
    for (const s of symbols) map.set(s.underlying_symbol, s);
    return map;
  }, [symbols]);

  const publish = useCallback(() => {
    const next: Record<string, SequenceStream> = {};
    for (const [symbol, st] of Object.entries(stateRef.current)) {
      next[symbol] = {
        status: st.status,
        digits: st.digits.slice(),
        recentEpochs: st.epochs.slice(-RECENT_EPOCHS),
      };
    }
    setStreams(next);
  }, []);

  const dropSymbol = useCallback((symbol: string) => {
    generationRef.current[symbol] = (generationRef.current[symbol] ?? 0) + 1;
    unsubRef.current[symbol]?.();
    delete unsubRef.current[symbol];
    subscribingRef.current.delete(symbol);
    delete stateRef.current[symbol];
    dirtyRef.current = true;
  }, []);

  const subscribeSymbol = useCallback(
    (symbol: string) => {
      if (!ws || !isConnected) return;
      if (unsubRef.current[symbol] || subscribingRef.current.has(symbol)) return;

      const meta = symbolLookup.get(symbol);
      const generation = (generationRef.current[symbol] ?? 0) + 1;
      generationRef.current[symbol] = generation;
      subscribingRef.current.add(symbol);

      const previous = stateRef.current[symbol];
      stateRef.current[symbol] = {
        pipSize: meta ? pipSizeFromPip(meta.pip_size) : (previous?.pipSize ?? 2),
        digits: previous?.digits ?? [],
        epochs: previous?.epochs ?? [],
        lastEpoch: previous?.lastEpoch ?? 0,
        lastTickAt: Date.now(),
        status: 'connecting',
      };
      dirtyRef.current = true;

      const isCurrent = () => generationRef.current[symbol] === generation;

      (async () => {
        try {
          const history = await ws.send<TicksHistoryResponse>({
            ticks_history: symbol,
            end: 'latest',
            start: 1,
            count: WINDOW_TICKS,
            style: 'ticks',
          });
          if (!isCurrent()) return;
          const st = stateRef.current[symbol];
          if (!st) return;

          const prices = history.history?.prices ?? [];
          const times = history.history?.times ?? [];
          st.digits = prices.map((p) => getLastDigit(p, st.pipSize));
          st.epochs = times.length === prices.length ? times.slice() : [];
          st.lastEpoch = times.length > 0 ? times[times.length - 1] : 0;
          st.status = 'live';
          st.lastTickAt = Date.now();
          dirtyRef.current = true;

          const sub = await ws.subscribe({ ticks: symbol }, (data) => {
            const tick = (data as { tick?: Tick }).tick;
            if (!tick) return;
            const s = stateRef.current[symbol];
            if (!s || !isCurrent()) return;
            // Skip anything already covered by the history we loaded.
            if (tick.epoch <= s.lastEpoch) {
              s.lastTickAt = Date.now();
              s.status = 'live';
              return;
            }
            if (tick.pip_size) s.pipSize = tick.pip_size;
            s.digits.push(getLastDigit(tick.quote, s.pipSize));
            s.epochs.push(tick.epoch);
            if (s.digits.length > WINDOW_TICKS) s.digits.splice(0, s.digits.length - WINDOW_TICKS);
            if (s.epochs.length > WINDOW_TICKS) s.epochs.splice(0, s.epochs.length - WINDOW_TICKS);
            s.lastEpoch = tick.epoch;
            s.lastTickAt = Date.now();
            s.status = 'live';
            dirtyRef.current = true;
            onTickRef.current?.(symbol, s.digits, s.epochs);
          });

          if (!isCurrent()) {
            sub.unsubscribe();
            return;
          }
          unsubRef.current[symbol] = sub.unsubscribe;
        } catch {
          // Stays 'connecting'; the watchdog retries.
        } finally {
          if (isCurrent()) subscribingRef.current.delete(symbol);
        }
      })();
    },
    [ws, isConnected, symbolLookup]
  );

  const wanted = useMemo(() => symbolCodes.join('|'), [symbolCodes]);

  // Reconcile subscriptions with the wanted set (and tear everything down
  // when the view is not visible).
  useEffect(() => {
    if (!ws || !isConnected || !enabled) {
      for (const symbol of Object.keys(stateRef.current)) dropSymbol(symbol);
      publish();
      return;
    }
    const want = new Set(wanted ? wanted.split('|') : []);
    for (const symbol of want) subscribeSymbol(symbol);
    for (const symbol of Object.keys(stateRef.current)) {
      if (!want.has(symbol)) dropSymbol(symbol);
    }
    publish();
  }, [ws, isConnected, enabled, wanted, subscribeSymbol, dropSymbol, publish]);

  // Throttled publish to React.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      publish();
    }, PUBLISH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, publish]);

  // Watchdog: re-subscribe streams that went silent (e.g. killed by a
  // forget_all elsewhere in the app). Re-subscribing refetches history.
  useEffect(() => {
    if (!ws || !isConnected || !enabled) return;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [symbol, st] of Object.entries(stateRef.current)) {
        if (now - st.lastTickAt <= STALE_MS) continue;
        if (st.status !== 'stale') {
          st.status = 'stale';
          dirtyRef.current = true;
        }
        generationRef.current[symbol] = (generationRef.current[symbol] ?? 0) + 1;
        unsubRef.current[symbol]?.();
        delete unsubRef.current[symbol];
        subscribingRef.current.delete(symbol);
        subscribeSymbol(symbol);
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ws, isConnected, enabled, subscribeSymbol]);

  // Drop everything on unmount.
  useEffect(() => {
    return () => {
      for (const unsub of Object.values(unsubRef.current)) unsub();
      unsubRef.current = {};
      subscribingRef.current.clear();
      stateRef.current = {};
    };
  }, []);

  return { streams };
}
