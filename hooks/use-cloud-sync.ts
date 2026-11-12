'use client';

import { useEffect } from 'react';
import { cloudPull } from '@/lib/cloud-sync';

const REFOCUS_MIN_GAP_MS = 20_000;

/**
 * Keeps saved strategies in step with the signed-in account: pulls once the
 * user is signed in (and whenever they switch account), and again when the tab
 * comes back to the foreground so a save made on another device shows up.
 */
export function useCloudSync(signedIn: boolean, accountId: string | null): void {
  useEffect(() => {
    if (!signedIn) return;
    void cloudPull();

    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last < REFOCUS_MIN_GAP_MS) return;
      last = Date.now();
      void cloudPull();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [signedIn, accountId]);
}
