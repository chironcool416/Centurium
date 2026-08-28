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

interface VictoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}

/**
 * Take-profit celebration modal, shown once the auto-bot's phase becomes
 * `stopped-target`. Reskins the generic "Congratulations / take profit
 * reached" popup with the Centurium brand: the Victoria Aeterna emblem on a
 * breathing emerald bloom, set against a dark green backdrop, with the copy
 * rewritten in the app's Roman-centurion voice.
 */
export function VictoryDialog({ open, onOpenChange, onContinue }: VictoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md border-emerald-500/30 bg-transparent p-0 shadow-[0_0_60px_10px_rgba(16,185,129,0.25)] overflow-hidden [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:z-10"
      >
        {/* Dark green radial backdrop, matching the app's existing glow language. */}
        <div className="victory-dialog-backdrop relative flex flex-col items-center px-6 pb-7 pt-9 text-center">
          <div className="relative mb-1 h-40 w-40 sm:h-48 sm:w-48">
            <div className="victory-emblem-glow absolute inset-0 rounded-full" aria-hidden />
            <Image
              src="/victoria-aeterna.png"
              alt=""
              fill
              sizes="192px"
              className="relative object-contain drop-shadow-[0_0_18px_rgba(163,230,53,0.35)]"
              priority
            />
          </div>

          <DialogTitle
            className={`${brandDisplay.className} text-2xl font-bold tracking-wide text-emerald-300 sm:text-3xl`}
          >
            <Localize i18n_default_text="Io, Victor!" />
          </DialogTitle>

          <DialogDescription className="mt-3 max-w-sm text-sm leading-relaxed text-emerald-50/90 sm:text-base">
            <Localize i18n_default_text="You have reached thy targeted bounty. The automaton now rests. Tread wisely, and beware of greed, lest Fortune favors you no longer." />
          </DialogDescription>

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
