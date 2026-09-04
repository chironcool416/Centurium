'use client';

import Image from 'next/image';
import { Localize } from '@deriv-com/translations';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { brandDisplay } from '@/lib/fonts';
import { formatSessionDuration } from '@/lib/duration-utils';

interface MinervaInsufficientFundsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  /** Wall-clock ms from bot start to running out of funds, or null if unknown. */
  durationMs?: number | null;
}

/**
 * Minerva's "can't afford the next martingale stake" modal, shown once the
 * Ra bot's stop reason becomes `insufficient-funds` (the account balance no
 * longer covers the stake the burst's martingale would need to fire next).
 * Same structure/bloom technique as `MinervaVictoryDialog` / the Operations
 * Martingale bot's `VictoryDialog`, re-skinned bronze — a third outcome that
 * is neither a win nor a loss, just the run running out of road.
 */
export function MinervaInsufficientFundsDialog({
  open,
  onOpenChange,
  onContinue,
  durationMs = null,
}: MinervaInsufficientFundsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md border-amber-600/30 bg-transparent p-0 shadow-[0_0_60px_10px_rgba(180,83,9,0.25)] overflow-hidden [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:z-10"
      >
        <div className="minerva-insufficient-dialog-backdrop relative flex flex-col items-center px-6 pb-7 pt-9 text-center">
          <div className="relative mb-1 flex items-end justify-center" style={{ height: 224 }}>
            <div
              className="minerva-insufficient-glow absolute inset-x-[-25%] inset-y-[-12%] rounded-full"
              aria-hidden
            />
            <Image
              src="/minerva-insufficient-funds.png"
              alt=""
              width={218}
              height={700}
              sizes="224px"
              className="relative h-56 w-auto object-contain drop-shadow-[0_0_20px_rgba(217,119,6,0.45)] sm:h-64"
              priority
            />
          </div>

          <DialogTitle
            className={`${brandDisplay.className} text-2xl font-bold tracking-wide text-amber-400 sm:text-3xl`}
          >
            <Localize i18n_default_text="Inadequate Funds." />
          </DialogTitle>

          <DialogDescription className="mt-3 max-w-sm text-sm leading-relaxed text-amber-50/90 sm:text-base">
            <Localize i18n_default_text="Insufficient gold remains to carry forth this operation." />
          </DialogDescription>

          {durationMs !== null && (
            <div className="mt-4 flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-950/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-amber-200/80">
              <span>
                <Localize i18n_default_text="Session Duration" />
              </span>
              <span className={`${brandDisplay.className} font-mono text-sm tracking-normal text-amber-100`}>
                {formatSessionDuration(durationMs)}
              </span>
            </div>
          )}

          <Button
            onClick={onContinue}
            className="mt-6 w-full bg-amber-600 text-amber-50 hover:bg-amber-500 font-bold tracking-wide"
          >
            <Localize i18n_default_text="Continue Trading" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
