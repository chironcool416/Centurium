'use client';

import { createContext, useContext, useEffect } from 'react';
import { useDerivWS } from '@deriv/core';
import { useAuth } from '@/hooks/use-auth';
import { useBalanceSync } from '@/hooks/use-balance-sync';
import type { DerivWS } from '@deriv/core';
import type { UseAuthReturn } from '@/hooks/use-auth';

interface DerivWSContextValue {
  ws: DerivWS | null;
  isConnected: boolean;
  isExhausted: boolean;
  auth: UseAuthReturn;
}

const DerivWSContext = createContext<DerivWSContextValue | null>(null);

/**
 * Maintains a single WebSocket connection and auth state above all page components
 * so navigation between pages (e.g. main → reports → back) does not tear down
 * and recreate the connection.
 */
export function DerivWSProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const { ws, isConnected, isExhausted } = useDerivWS({
    url: auth.wsUrl,
    accountId: auth.activeAccountId ?? undefined,
    getFreshUrl: auth.getFreshWsUrl,
  });
  // Gate on wsUrl, not activeAccountId alone. An account is selected well before
  // its socket is authorized — it is restored from storage at mount and set by
  // completeAuth before the OTP URL resolves — and `balance` on the public
  // socket earns AuthorizationRequired, which the app's blanket WS-error toast
  // showed the user as "Please log in." right after a successful login
  // (deriv-com/deriv-api-v2#587). Matches the `isAuthenticated: !!auth.wsUrl`
  // gate every other authenticated consumer already uses.
  useBalanceSync(
    ws,
    isConnected,
    auth.wsUrl ? auth.activeAccountId : null,
    auth.updateAccountBalance
  );

  // Backup balance sources. Every buy/sell response and every transaction
  // event (which fires when a contract settles) carries the account balance, so
  // the displayed/practice balance moves on each trade even if the dedicated
  // balance stream is slow or silent.
  const { wsUrl, activeAccountId, updateAccountBalance } = auth;
  useEffect(() => {
    if (!ws || !isConnected || !wsUrl || !activeAccountId) return;

    const num = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const push = (v: unknown) => {
      const n = num(v);
      if (n !== null) updateAccountBalance(activeAccountId, n.toFixed(2));
    };

    const unlisten = ws.onMessage(msg => {
      const buy = msg.buy as { balance_after?: unknown } | undefined;
      const sell = msg.sell as { balance_after?: unknown } | undefined;
      if (buy) push(buy.balance_after);
      if (sell) push(sell.balance_after);
    });

    let disposed = false;
    let unsubscribe = () => {};
    ws.subscribe({ transaction: 1 }, msg => {
      const tx = msg.transaction as { balance?: unknown } | undefined;
      if (tx) push(tx.balance);
    })
      .then(sub => {
        if (disposed) sub.unsubscribe();
        else unsubscribe = sub.unsubscribe;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten();
      unsubscribe();
    };
  }, [ws, isConnected, wsUrl, activeAccountId, updateAccountBalance]);

  return (
    <DerivWSContext.Provider value={{ ws, isConnected, isExhausted, auth }}>
      {children}
    </DerivWSContext.Provider>
  );
}

export function useDerivWSContext(): DerivWSContextValue {
  const ctx = useContext(DerivWSContext);
  if (!ctx) {
    throw new Error('useDerivWSContext must be used within a DerivWSProvider');
  }
  return ctx;
}
