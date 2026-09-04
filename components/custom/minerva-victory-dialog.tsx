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

interface MinervaVictoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  /** Wall-clock ms from bot start to this take-profit hit, or null if unknown. */
  durationMs?: number | null;
}

/**
 * Minerva's take-profit celebration modal, shown once the Ra bot's stop
 * reason becomes `take-profit`. Same structure/bloom technique as the
 * Operations Martingale bot's `VictoryDialog`, but re-skinned with the
 * emerald statue instead of the Victoria Aeterna emblem — reuses the same
 * green backdrop/glow classes since it's the same "profit" moment.
 */
export function MinervaVictoryDialog({
  open,
  onOpenChange,
  onContinue,
  durationMs = null,
}: MinervaVictoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md border-emerald-500/30 bg-transparent p-0 shadow-[0_0_60px_10px_rgba(16,185,129,0.25)] overflow-hidden [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:z-10"
      >
        <div className="victory-dialog-backdrop relative flex flex-col items-center px-6 pb-7 pt-9 text-center">
          <div className="relative mb-1 flex items-end justify-center" style={{ height: 224 }}>
            <div
              className="victory-emblem-glow absolute inset-x-[-25%] inset-y-[-12%] rounded-full"
              aria-hidden
            />
            <Image
              src="/minerva-take-profit.png"
              alt=""
              width={218}
              height={700}
              sizes="224px"
              className="relative h-56 w-auto object-contain drop-shadow-[0_0_20px_rgba(52,211,153,0.45)] sm:h-64"
              priority
            />
          </div>

          <DialogTitle
            className={`${brandDisplay.className} text-2xl font-bold tracking-wide text-emerald-300 sm:text-3xl`}
          >
            <Localize i18n_default_text="Io, Victor!" />
          </DialogTitle>

          <DialogDescription className="mt-3 max-w-sm text-sm leading-relaxed text-emerald-50/90 sm:text-base">
            <Localize i18n_default_text="Rejoice! You have attained the targeted profit that was set before thee." />
          </DialogDescription>

          {durationMs !== null && (
            <div className="mt-4 flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-950/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-emerald-200/80">
              <span>
                <Localize i18n_default_text="Session Duration" />
              </span>
              <span className={`${brandDisplay.className} font-mono text-sm tracking-normal text-emerald-100`}>
                {formatSessionDuration(durationMs)}
              </span>
            </div>
          )}

          <Button
            onClick={onContinue}
            className="mt-6 w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400 font-bold tracking-wide"
          >
            <Localize i18n_default_text="Continue Trading" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
