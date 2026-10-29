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

interface MmDefeatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  /** Total wins in the run that just ended. */
  wins: number;
  /** Total losses in the run that just ended. */
  losses: number;
  /** Final P/L of the run in USD (negative on a stop loss). */
  pnl?: number | null;
  /** Wall-clock ms from bot start to this stop-loss hit, or null if unknown. */
  durationMs?: number | null;
}

/**
 * MM bot stop-loss modal, shown once the bot stops with reason `stop-loss`.
 * Same crimson look as the Operations Martingale bot's `DefeatDialog`, plus
 * the run's final win / loss tally.
 */
export function MmDefeatDialog({
  open,
  onOpenChange,
  onContinue,
  wins,
  losses,
  pnl = null,
  durationMs = null,
}: MmDefeatDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md border-rose-500/30 bg-transparent p-0 shadow-[0_0_60px_10px_rgba(244,63,94,0.25)] overflow-hidden [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:z-10"
      >
        <div className="defeat-dialog-backdrop relative flex flex-col items-center px-6 pb-7 pt-9 text-center">
          <div className="relative mb-1 h-40 w-40 sm:h-48 sm:w-48">
            <div className="defeat-emblem-glow absolute inset-0 rounded-full" aria-hidden />
            <Image
              src="/vae-victis.png"
              alt=""
              fill
              sizes="192px"
              className="relative object-contain drop-shadow-[0_0_18px_rgba(244,63,94,0.35)]"
              priority
            />
          </div>

          <DialogTitle
            className={`${brandDisplay.className} text-2xl font-bold tracking-wide text-rose-300 sm:text-3xl`}
          >
            <Localize i18n_default_text="Vae Victis." />
          </DialogTitle>

          <DialogDescription className="mt-3 max-w-sm text-sm leading-relaxed text-rose-50/90 sm:text-base">
            <Localize i18n_default_text="Stop loss reached. The MM bot has stopped." />
          </DialogDescription>

          <div className="mt-5 flex w-full items-stretch justify-center gap-3">
            <div className="flex-1 rounded-xl border border-emerald-400/30 bg-emerald-950/30 px-4 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-emerald-200/80">
                <Localize i18n_default_text="Wins" />
              </div>
              <div className={`${brandDisplay.className} text-2xl font-bold text-emerald-300`}>{wins}</div>
            </div>
            <div className="flex-1 rounded-xl border border-rose-400/30 bg-rose-950/40 px-4 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-rose-200/80">
                <Localize i18n_default_text="Losses" />
              </div>
              <div className={`${brandDisplay.className} text-2xl font-bold text-rose-300`}>{losses}</div>
            </div>
          </div>

          {pnl !== null && (
            <div className="mt-3 text-sm font-semibold text-rose-100">
              <Localize i18n_default_text="Loss" />: {pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}
            </div>
          )}

          {durationMs !== null && (
            <div className="mt-3 flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-950/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-rose-200/80">
              <span>
                <Localize i18n_default_text="Session Duration" />
              </span>
              <span className={`${brandDisplay.className} font-mono text-sm tracking-normal text-rose-100`}>
                {formatSessionDuration(durationMs)}
              </span>
            </div>
          )}

          <Button
            onClick={onContinue}
            className="mt-6 w-full bg-rose-600 text-rose-50 hover:bg-rose-500 font-bold tracking-wide"
          >
            <Localize i18n_default_text="Redeem Yourself" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
