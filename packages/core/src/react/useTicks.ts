'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DerivWS } from '../ws';
import type { ActiveSymbol, Tick, TicksHistoryResponse } from '../types';

const DEFAULT_TICK_COUNT = 1000;

interface UseTicksReturn {
  currentTick: Tick | null;
  prices: number[];
  pipSize: number;
  /** Set when loading history / subscribing failed and retries are exhausted. */
  error: string | null;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

export function useTicks(
  ws: DerivWS | null,
  isConnected: boolean,
  activeSymbol: ActiveSymbol | null,
  tickCount: number = DEFAULT_TICK_COUNT
): UseTicksReturn {
  const pricesRef = useRef<number[]>([]);
  const pipSizeRef = useRef<number>(2);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const [currentTick, setCurrentTick] = useState<Tick | null>(null);
  const [prices, setPrices] = useState<number[]>([]);
  const [pipSize, setPipSize] = useState<number>(2);
  const [error, setError] = useState<string | null>(null);
  // Bumped to re-run the subscribe effect after a failure.
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptsRef = useRef(0);
  const lastSymbolRef = useRef<string | null>(null);

  const pipSizeFromPip = useCallback((pip: number): number => {
    if (pip >= 1) return 0;
    const str = pip.toString();
    const dotIndex = str.indexOf('.');
    return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
  }, []);

  useEffect(() => {
    if (!ws || !isConnected || !activeSymbol) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // A new symbol starts with a fresh retry budget.
    if (lastSymbolRef.current !== activeSymbol.underlying_symbol) {
      lastSymbolRef.current = activeSymbol.underlying_symbol;
      attemptsRef.current = 0;
    }

    // Unsubscribe from previous
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    // Reset refs
    pricesRef.current = [];

    const ps = pipSizeFromPip(activeSymbol.pip_size);
    pipSizeRef.current = ps;

    async function subscribe() {
      const historyResponse = await ws!.send<TicksHistoryResponse>({
        ticks_history: activeSymbol!.underlying_symbol,
        end: 'latest',
        start: 1,
        count: tickCount,
        style: 'ticks',
      });
      if (disposed) return;

      setPipSize(ps);
      const historyPrices = historyResponse.history?.prices ?? [];
      pricesRef.current = historyPrices;
      setPrices([...historyPrices]);

      const sub = await ws!.subscribe(
        { ticks: activeSymbol!.underlying_symbol },
        (data) => {
          const tick = (data as { tick?: Tick }).tick;
          if (tick) {
            const tickPs = tick.pip_size ?? pipSizeRef.current;
            if (tick.pip_size && tick.pip_size !== pipSizeRef.current) {
              pipSizeRef.current = tick.pip_size;
            }

            setCurrentTick(tick);

            // Sliding window update
            pricesRef.current = [...pricesRef.current, tick.quote];
            if (pricesRef.current.length > tickCount) {
              pricesRef.current = pricesRef.current.slice(-tickCount);
            }
            setPrices([...pricesRef.current]);
            setPipSize(tickPs);
          }
        }
      );
      if (disposed) {
        sub.unsubscribe();
        return;
      }
      unsubscribeRef.current = sub.unsubscribe;
    }

    subscribe()
      .then(() => {
        if (disposed) return;
        attemptsRef.current = 0;
        setError(null);
      })
      .catch((err) => {
        if (disposed) return;
        // Previously swallowed, which left the digit stats frozen with no
        // sign anything was wrong. Retry a few times, then surface it.
        if (attemptsRef.current < MAX_RETRIES) {
          attemptsRef.current += 1;
          retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), RETRY_DELAY_MS);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load ticks');
        }
      });

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      setCurrentTick(null);
      setPrices([]);
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      // No forget_all here: DerivWS.subscribe() now multiplexes duplicate
      // requests for the same symbol onto one real API subscription and
      // ref-counts unsubscribes, so this hook only ever tears down its own
      // stream. Broadcasting forget_all would wipe out anyone else's (e.g.
      // digit-alerts) subscription on the same connection.
    };
  }, [ws, isConnected, activeSymbol, tickCount, pipSizeFromPip, retryNonce]);

  return { currentTick, prices, pipSize, error };
}
