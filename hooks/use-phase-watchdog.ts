'use client';

import { useEffect, useRef } from 'react';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';

/**
 * How long a bot may sit in each waiting phase before it is considered stuck.
 * Generous on purpose: a 10-tick contract on a 2s index takes ~20s to settle.
 */
export const PHASE_LIMITS_MS: Record<string, number> = {
  'awaiting-proposal': 30_000,
  'awaiting-buy': 30_000,
  'awaiting-settlement': 120_000,
};

export type TimeoutReason = 'timeout-proposal' | 'timeout-buy' | 'timeout-settlement';

/** Which step the bot was stuck on, so the stop message can say so. */
export function timeoutReason(phase: string): TimeoutReason {
  if (phase === 'awaiting-proposal') return 'timeout-proposal';
  if (phase === 'awaiting-buy') return 'timeout-buy';
  return 'timeout-settlement';
}

/**
 * Safety net for the trading bots. The bots are state machines driven by
 * WebSocket events; if a reply never arrives, nothing advances them and they
 * would sit "running" forever. This fires `onTimeout` if `phase` stays
 * unchanged past its limit while the bot is active.
 *
 * The clock only runs while the connection is up. If the socket drops (phone
 * locked, wifi blip) the timer is paused, and it restarts with a full window
 * once the connection is back — a network outage alone never stops a bot.
 */
export function usePhaseWatchdog(
  active: boolean,
  phase: string,
  onTimeout: (phase: string) => void
): void {
  const { isConnected } = useDerivWSContext();
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!active || !isConnected) return;
    const limit = PHASE_LIMITS_MS[phase];
    if (!limit) return;
    const timer = setTimeout(() => onTimeoutRef.current(phase), limit);
    return () => clearTimeout(timer);
  }, [active, phase, isConnected]);
}
