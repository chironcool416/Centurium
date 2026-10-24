'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ActiveSymbol } from '@deriv/core';
import {
  MIN_RUN_OPTIONS,
  SEQUENCE_CONDITIONS,
  conditionKey,
  parseConditionKey,
} from '@/lib/digit-sequences';
import { DEFAULT_SEQUENCE_SYMBOLS } from '@/hooks/use-sequence-scanner';

const STORAGE_KEY = 'centurium:multi-market-sequences';

/**
 * The Multi-market panel's own selections (what to count, how long, which
 * markets), kept in one place above the panel so the MM bot can follow the
 * same market list the panel shows. Persisted to localStorage.
 */
export function useSequencePanelSettings(symbols: ActiveSymbol[]) {
  const [conditionValue, setConditionValue] = useState(conditionKey({ side: 'over', barrier: 5 }));
  const [minLen, setMinLen] = useState(4);
  const [hidden, setHidden] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { condition?: string; min?: number; hidden?: string[] };
        if (
          typeof saved.condition === 'string' &&
          SEQUENCE_CONDITIONS.some((c) => conditionKey(c) === saved.condition)
        ) {
          setConditionValue(saved.condition);
        }
        if (typeof saved.min === 'number' && (MIN_RUN_OPTIONS as readonly number[]).includes(saved.min)) {
          setMinLen(saved.min);
        }
        if (Array.isArray(saved.hidden)) setHidden(saved.hidden.filter((h) => typeof h === 'string'));
      }
    } catch {
      // Non-fatal — falls back to defaults.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ condition: conditionValue, min: minLen, hidden })
      );
    } catch {
      // Non-fatal.
    }
  }, [loaded, conditionValue, minLen, hidden]);

  const condition = useMemo(() => parseConditionKey(conditionValue), [conditionValue]);

  // Markets that exist on this account, in the app's default order.
  const available = useMemo(() => {
    const present = new Set(symbols.map((s) => s.underlying_symbol));
    return (DEFAULT_SEQUENCE_SYMBOLS as readonly string[]).filter((code) => present.has(code));
  }, [symbols]);

  const activeCodes = useMemo(
    () => available.filter((code) => !hidden.includes(code)),
    [available, hidden]
  );

  return {
    conditionValue,
    setConditionValue,
    condition,
    minLen,
    setMinLen,
    hidden,
    setHidden,
    available,
    activeCodes,
  };
}

export type SequencePanelSettings = ReturnType<typeof useSequencePanelSettings>;
