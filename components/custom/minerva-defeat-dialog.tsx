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

interface MinervaDefeatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  /** Wall-clock ms from bot start to this stop-loss hit, or null if unknown. */
  durationMs?: number | null;
}

/**
 * Minerva's stop-loss modal, shown once the Ra bot's stop reason becomes
 * `stop-loss`. Same structure/bloom technique as the Operations Martingale
 * bot's `DefeatDialog`, but re-skinned with the crimson statue instead of
 * the Vae Victis emblem — reuses the same red backdrop/glow classes since
 * it's the same "loss" moment.
 */
export function MinervaDefeatDialog({
  open,
  onOpenChange,
  onContinue,
  durationMs = null,
}: MinervaDefeatDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md border-rose-500/30 bg-transparent p-0 shadow-[0_0_60px_10px_rgba(244,63,94,0.25)] overflow-hidden [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:z-10"
      >
        <div className="defeat-dialog-backdrop relative flex flex-col items-center px-6 pb-7 pt-9 text-center">
          <div className="relative mb-1 flex items-end justify-center" style={{ height: 224 }}>
            <div
              className="defeat-emblem-glow absolute inset-x-[-25%] inset-y-[-12%] rounded-full"
              aria-hidden
            />
            <Image
              src="/minerva-stop-loss.png"
              alt=""
              width={218}
              height={700}
              sizes="224px"
              className="relative h-56 w-auto object-contain drop-shadow-[0_0_20px_rgba(244,63,94,0.45)] sm:h-64"
              priority
            />
          </div>

          <DialogTitle
            className={`${brandDisplay.className} text-2xl font-bold tracking-wide text-rose-300 sm:text-3xl`}
          >
            <Localize i18n_default_text="Vae Victis." />
          </DialogTitle>

          <DialogDescription className="mt-3 max-w-sm text-sm leading-relaxed text-rose-50/90 sm:text-base">
            <Localize i18n_default_text="Woe! You have incurred the loss which was marked as thy limit." />
          </DialogDescription>

          {durationMs !== null && (
            <div className="mt-4 flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-950/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-rose-200/80">
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
