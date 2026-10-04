'use client';

import { useEffect, useRef } from 'react';

/**
 * How long a bot may sit in each waiting phase before it is considered stuck.
 * Generous on purpose: a 10-tick contract on a 2s index takes ~20s to settle.
 */
export const PHASE_LIMITS_MS: Record<string, number> = {
  'awaiting-proposal': 20_000,
  'awaiting-buy': 25_000,
  'awaiting-settlement': 90_000,
};

/**
 * Safety net for the trading bots. The bots are state machines driven by
 * WebSocket events; if the socket drops or a reply never arrives, nothing
 * advances them and they would sit "running" forever (possibly with a live,
 * untracked contract). This fires `onTimeout` if `phase` stays unchanged past
 * its limit while the bot is active. Any phase change resets the timer.
 */
export function usePhaseWatchdog(
  active: boolean,
  phase: string,
  onTimeout: (phase: string) => void
): void {
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!active) return;
    const limit = PHASE_LIMITS_MS[phase];
    if (!limit) return;
    const timer = setTimeout(() => onTimeoutRef.current(phase), limit);
    return () => clearTimeout(timer);
  }, [active, phase]);
}
