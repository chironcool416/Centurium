'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DerivWS, ActiveSymbol, Tick, TicksHistoryResponse } from '@deriv/core';
import { computeDigitStats, pipSizeFromPip } from '@/lib/digit-stats';

/**
 * Watches digit-percentage conditions across any number of markets *at the
 * same time*, entirely independent of which symbol happens to be selected
 * in the trade panel — the point being that you can sit on Vol 25 and still
 * get told the moment digit 9 crosses 10% on Vol 100.
 *
 * Each rule's symbol gets its own tick subscription, opened directly against
 * the shared `ws` (not through `useTicks`/`useDigitsTrading`), so it keeps
 * running regardless of what the main trading view is subscribed to or how
 * often the user switches symbols there.
 *
 * One gotcha this has to defend against: `useTicks` (the trade panel's own
 * tick hook) sends `forget_all: 'ticks'` on cleanup — e.g. every time the
 * user switches symbols on the trade panel — which unsubscribes *every*
 * open ticks stream on the connection server-side, including these
 * watcher streams, not just the one the trade panel meant to drop. A
 * watchdog below detects the resulting silence (no tick for STALE_MS) and
 * transparently re-subscribes, so a rule never just quietly goes dark.
 */

export type AlertDirection = 'over' | 'under' | 'equals';
export const ALERT_WINDOW_OPTIONS = [25, 50, 100, 250, 1000] as const;
export type AlertWindow = (typeof ALERT_WINDOW_OPTIONS)[number];
/** 'all': every digit in the group must satisfy the condition to fire
 *  (e.g. "0,2,4,6,8 are ALL over 10%"). 'any': firing as soon as at least
 *  one of them does (e.g. "any of 0,1,2 goes under 5%"). */
export type AlertMatchMode = 'all' | 'any';

export interface DigitAlertRule {
  id: string;
  symbol: string;
  /** One or more digits (0-9) this rule watches as a group. A single-digit
   *  array behaves exactly like the old single-digit rule. */
  digits: number[];
  matchMode: AlertMatchMode;
  direction: AlertDirection;
  /** Percent threshold, e.g. 10 for "10%". */
  threshold: number;
  window: AlertWindow;
  enabled: boolean;
  createdAt: number;
}

export interface DigitAlertFire {
  id: number;
  ruleId: string;
  symbol: string;
  digits: number[];
  matchMode: AlertMatchMode;
  direction: AlertDirection;
  threshold: number;
  /** Percentage for each entry in `digits`, same order. */
  actualPcts: number[];
  window: AlertWindow;
  time: number;
}

export type SymbolStreamStatus = 'connecting' | 'live' | 'stale';

export interface SymbolStreamInfo {
  status: SymbolStreamStatus;
  pipSize: number;
  /** Latest percentage-per-digit for every window size any rule on this
   *  symbol currently cares about, so the UI can show a live readout next
   *  to each rule without recomputing anything itself. */
  statsByWindow: Partial<Record<AlertWindow, number[]>>;
  totalTicks: number;
}

const MAX_WINDOW = Math.max(...ALERT_WINDOW_OPTIONS);
// Real tick streams update every 1-2s, so anything quieter than this for a
// watched symbol means the stream died (most likely `forget_all: 'ticks'`
// from the main trade panel — see the file header comment) rather than the
// market just being slow. Kept tight, together with a tight watchdog poll,
// so a dead stream is caught — and rules stop evaluating against frozen
// data — within a couple of seconds instead of sitting stale for 20s+.
const STALE_MS = 6_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const FIRE_COOLDOWN_MS = 60_000;
const MAX_FIRED_LOG = 50;
const RULES_STORAGE_KEY = 'centurium:digit-alert-rules';

function loadStoredRules(): DigitAlertRule[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RULES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Migrate pre-grouped-digit rules (single `digit: number`) into the
    // current `digits: number[]` + `matchMode` shape, so nobody's saved
    // alerts silently disappear after this update.
    return parsed.map((r: Partial<DigitAlertRule> & { digit?: number }) => ({
      ...r,
      digits: Array.isArray(r.digits) ? r.digits : typeof r.digit === 'number' ? [r.digit] : [],
      matchMode: r.matchMode === 'any' ? 'any' : 'all',
    })) as DigitAlertRule[];
  } catch {
    return [];
  }
}

function persistRules(rules: DigitAlertRule[]) {
  try {
    window.localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // Non-fatal — rules just won't survive a reload this time.
  }
}

function breaches(pct: number, direction: AlertDirection, threshold: number): boolean {
  switch (direction) {
    case 'over':
      return pct > threshold;
    case 'under':
      return pct < threshold;
    case 'equals':
      return Math.abs(pct - threshold) < 0.05;
  }
}

interface StreamState {
  pipSize: number;
  prices: number[];
  lastTickAt: number;
  status: SymbolStreamStatus;
}

interface UseDigitAlertsParams {
  ws: DerivWS | null;
  isConnected: boolean;
  symbols: ActiveSymbol[];
  /** Called every time a rule's condition fires (subject to per-rule cooldown). */
  onFire?: (fire: DigitAlertFire) => void;
}

export function useDigitAlerts({ ws, isConnected, symbols, onFire }: UseDigitAlertsParams) {
  const [rules, setRules] = useState<DigitAlertRule[]>([]);
  const [streams, setStreams] = useState<Record<string, SymbolStreamInfo>>({});
  const [firedLog, setFiredLog] = useState<DigitAlertFire[]>([]);

  const rulesRef = useRef<DigitAlertRule[]>([]);
  const streamStateRef = useRef<Record<string, StreamState>>({});
  const unsubscribeRef = useRef<Record<string, () => void>>({});
  const subscribingRef = useRef<Set<string>>(new Set());
  const lastFiredAtRef = useRef<Record<string, number>>({});
  const onFireRef = useRef(onFire);
  const fireIdRef = useRef(0);
  onFireRef.current = onFire;

  const symbolLookup = useMemo(() => {
    const map = new Map<string, ActiveSymbol>();
    for (const s of symbols) map.set(s.underlying_symbol, s);
    return map;
  }, [symbols]);

  // Load persisted rules once on mount.
  useEffect(() => {
    const stored = loadStoredRules();
    if (stored.length > 0) {
      setRules(stored);
      rulesRef.current = stored;
    }
  }, []);

  const publishStreamInfo = useCallback((symbol: string) => {
    const state = streamStateRef.current[symbol];
    if (!state) return;
    const windowsNeeded = new Set<AlertWindow>();
    for (const r of rulesRef.current) {
      if (r.symbol === symbol && r.enabled) windowsNeeded.add(r.window);
    }
    const statsByWindow: Partial<Record<AlertWindow, number[]>> = {};
    let totalTicks = 0;
    for (const w of windowsNeeded) {
      const slice = state.prices.slice(-w);
      const stats = computeDigitStats(slice, state.pipSize);
      statsByWindow[w] = stats.percentages;
      totalTicks = Math.max(totalTicks, stats.totalTicks);
    }
    setStreams((prev) => ({
      ...prev,
      [symbol]: {
        status: state.status,
        pipSize: state.pipSize,
        statsByWindow,
        totalTicks,
      },
    }));
  }, []);

  const checkRulesForSymbol = useCallback((symbol: string) => {
    const state = streamStateRef.current[symbol];
    if (!state) return;
    // Never evaluate against a stream that isn't confirmed live — a
    // 'connecting' stream has no ticks yet, and a 'stale' one is showing
    // frozen numbers from before the connection dropped. Firing (or
    // displaying a breach) off either reads as the alert lying about the
    // real, current percentage.
    if (state.status !== 'live') return;
    const now = Date.now();
    for (const rule of rulesRef.current) {
      if (rule.symbol !== symbol || !rule.enabled || rule.digits.length === 0) continue;
      const slice = state.prices.slice(-rule.window);
      if (slice.length === 0) continue;
      const stats = computeDigitStats(slice, state.pipSize);
      const pcts = rule.digits.map((d) => stats.percentages[d]);
      const flags = pcts.map((pct) => breaches(pct, rule.direction, rule.threshold));
      const matched = rule.matchMode === 'all' ? flags.every(Boolean) : flags.some(Boolean);
      if (!matched) continue;

      const lastFired = lastFiredAtRef.current[rule.id] ?? 0;
      if (now - lastFired < FIRE_COOLDOWN_MS) continue;
      lastFiredAtRef.current[rule.id] = now;

      const fire: DigitAlertFire = {
        id: ++fireIdRef.current,
        ruleId: rule.id,
        symbol: rule.symbol,
        digits: rule.digits,
        matchMode: rule.matchMode,
        direction: rule.direction,
        threshold: rule.threshold,
        actualPcts: pcts,
        window: rule.window,
        time: now,
      };
      setFiredLog((prev) => [fire, ...prev].slice(0, MAX_FIRED_LOG));
      onFireRef.current?.(fire);
    }
  }, []);

  const unsubscribeSymbol = useCallback((symbol: string) => {
    unsubscribeRef.current[symbol]?.();
    delete unsubscribeRef.current[symbol];
    subscribingRef.current.delete(symbol);
    delete streamStateRef.current[symbol];
    setStreams((prev) => {
      if (!(symbol in prev)) return prev;
      const next = { ...prev };
      delete next[symbol];
      return next;
    });
  }, []);

  const subscribeSymbol = useCallback(
    (symbol: string) => {
      if (!ws || !isConnected) return;
      if (unsubscribeRef.current[symbol] || subscribingRef.current.has(symbol)) return;
      const activeSymbol = symbolLookup.get(symbol);
      subscribingRef.current.add(symbol);

      streamStateRef.current[symbol] = {
        pipSize: activeSymbol ? pipSizeFromPip(activeSymbol.pip_size) : 2,
        prices: [],
        lastTickAt: Date.now(),
        status: 'connecting',
      };
      publishStreamInfo(symbol);

      let disposed = false;

      (async () => {
        try {
          const historyResponse = await ws.send<TicksHistoryResponse>({
            ticks_history: symbol,
            end: 'latest',
            start: 1,
            count: MAX_WINDOW,
            style: 'ticks',
          });
          if (disposed) return;

          const state = streamStateRef.current[symbol];
          if (!state) return;
          state.prices = historyResponse.history?.prices ?? [];
          state.status = 'live';
          state.lastTickAt = Date.now();
          publishStreamInfo(symbol);
          checkRulesForSymbol(symbol);

          const sub = await ws.subscribe({ ticks: symbol }, (data) => {
            const tick = (data as { tick?: Tick }).tick;
            if (!tick) return;
            const s = streamStateRef.current[symbol];
            if (!s) return;
            if (tick.pip_size) s.pipSize = tick.pip_size;
            s.prices = [...s.prices, tick.quote];
            if (s.prices.length > MAX_WINDOW) s.prices = s.prices.slice(-MAX_WINDOW);
            s.lastTickAt = Date.now();
            s.status = 'live';
            publishStreamInfo(symbol);
            checkRulesForSymbol(symbol);
          });

          if (disposed) {
            sub.unsubscribe();
            return;
          }
          unsubscribeRef.current[symbol] = sub.unsubscribe;
        } catch {
          // Leave status as 'connecting' — the watchdog below will retry.
        } finally {
          subscribingRef.current.delete(symbol);
        }
      })();

      return () => {
        disposed = true;
      };
    },
    [ws, isConnected, symbolLookup, publishStreamInfo, checkRulesForSymbol]
  );

  // Reconcile subscriptions with whatever set of symbols the enabled rules
  // currently need — add new ones, drop ones no longer referenced.
  useEffect(() => {
    rulesRef.current = rules;
    persistRules(rules);

    if (!ws || !isConnected) return;

    const needed = new Set(rules.filter((r) => r.enabled).map((r) => r.symbol));

    for (const symbol of needed) {
      if (!unsubscribeRef.current[symbol] && !subscribingRef.current.has(symbol)) {
        subscribeSymbol(symbol);
      }
    }
    for (const symbol of Object.keys(unsubscribeRef.current)) {
      if (!needed.has(symbol)) unsubscribeSymbol(symbol);
    }
    // Re-publish so windows added/removed by a rule edit show up immediately.
    for (const symbol of needed) publishStreamInfo(symbol);
  }, [rules, ws, isConnected, subscribeSymbol, unsubscribeSymbol, publishStreamInfo]);

  // Watchdog: detect streams gone silent (most likely killed by some other
  // part of the app calling forget_all on the shared connection) and
  // transparently re-subscribe rather than leaving a rule dark forever.
  useEffect(() => {
    if (!ws || !isConnected) return;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [symbol, state] of Object.entries(streamStateRef.current)) {
        if (now - state.lastTickAt > STALE_MS) {
          if (state.status !== 'stale') {
            state.status = 'stale';
            publishStreamInfo(symbol);
          }
          unsubscribeRef.current[symbol]?.();
          delete unsubscribeRef.current[symbol];
          subscribingRef.current.delete(symbol);
          subscribeSymbol(symbol);
        }
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ws, isConnected, subscribeSymbol, publishStreamInfo]);

  // Drop every subscription on unmount (e.g. leaving the Minerva page).
  useEffect(() => {
    return () => {
      for (const unsub of Object.values(unsubscribeRef.current)) unsub();
      unsubscribeRef.current = {};
    };
  }, []);

  const addRule = useCallback((input: Omit<DigitAlertRule, 'id' | 'createdAt' | 'enabled'>) => {
    const rule: DigitAlertRule = {
      ...input,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      enabled: true,
      createdAt: Date.now(),
    };
    setRules((prev) => [...prev, rule]);
    return rule.id;
  }, []);

  const removeRule = useCallback((id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    delete lastFiredAtRef.current[id];
  }, []);

  const toggleRule = useCallback((id: string, enabled?: boolean) => {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: enabled ?? !r.enabled } : r))
    );
  }, []);

  const clearFiredLog = useCallback(() => setFiredLog([]), []);

  return {
    rules,
    addRule,
    removeRule,
    toggleRule,
    streams,
    firedLog,
    clearFiredLog,
  };
}
