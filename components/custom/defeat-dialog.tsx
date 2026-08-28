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

interface DefeatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}

/**
 * Stop-loss modal, shown once the auto-bot's phase becomes `stopped-loss`.
 * Mirrors VictoryDialog's structure exactly, re-themed red for a loss: the
 * Vae Victis emblem on a breathing red bloom, set against a dark red
 * backdrop, with the copy rewritten in the app's Roman-centurion voice.
 */
export function DefeatDialog({ open, onOpenChange, onContinue }: DefeatDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md border-rose-500/30 bg-transparent p-0 shadow-[0_0_60px_10px_rgba(244,63,94,0.25)] overflow-hidden [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:z-10"
      >
        {/* Dark red radial backdrop, matching the app's existing glow language. */}
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
            <Localize i18n_default_text="Your campaign hath fallen short." />
          </DialogDescription>

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
