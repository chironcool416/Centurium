'use client';

import { useMemo, useState } from 'react';
import { Localize } from '@deriv-com/translations';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import type { SequenceStream } from '@/hooks/use-sequence-scanner';
import { MM_TAPE_TICKS, type MmTapeEntry, type MmTradeMark } from '@/hooks/use-mm-bot';

const COLS = 10;

interface Props {
  /** Live streams from the shared scanner. */
  streams: Record<string, SequenceStream>;
  /** Ticks captured at the moment the robot last stopped (null if it hasn't run). */
  frozen: Record<string, MmTapeEntry> | null;
  running: boolean;
  /** Every trade the robot placed this run, pinned to a tick. */
  marks: MmTradeMark[];
  watchedCodes: string[];
  currentTradeSymbol: string | null;
  lastSignalSymbol: string | null;
}

/**
 * The last 30 ticks of one market as a 3×10 grid: oldest at the top-left,
 * newest at the bottom-right, so there is nothing to scroll sideways. Ticks
 * where the robot placed a trade are coloured (amber while open, green won,
 * red lost); every other tick keeps the plain colour. After the robot stops
 * the grid freezes, so the ticks leading into a Stop Loss can be reviewed.
 */
export function MmTickRecord({
  streams,
  frozen,
  running,
  marks,
  watchedCodes,
  currentTradeSymbol,
  lastSignalSymbol,
}: Props) {
  const { localize } = useAppTranslations();
  const [pick, setPick] = useState('auto');

  // Auto-follow: the market of the latest trade, else the one trading now,
  // else the one that last signalled, else the first watched market.
  const autoSymbol =
    (marks.length > 0 ? marks[marks.length - 1].symbol : null) ??
    currentTradeSymbol ??
    lastSignalSymbol ??
    watchedCodes[0] ??
    null;
  const symbol = pick !== 'auto' ? pick : autoSymbol;

  const tape = useMemo(() => {
    if (!symbol) return null;
    if (!running && frozen?.[symbol]) return { ...frozen[symbol], isFrozen: true };
    const st = streams[symbol];
    if (!st || st.digits.length === 0) return null;
    return {
      digits: st.digits.slice(-MM_TAPE_TICKS),
      epochs: st.recentEpochs.slice(-MM_TAPE_TICKS),
      isFrozen: false,
    };
  }, [symbol, running, frozen, streams]);

  const marksByEpoch = useMemo(() => {
    const map = new Map<number, MmTradeMark>();
    for (const m of marks) if (m.symbol === symbol) map.set(m.epoch, m);
    return map;
  }, [marks, symbol]);

  const n = tape ? tape.digits.length : 0;
  const offset = MM_TAPE_TICKS - n; // empty slots go first so the newest tick lands bottom-right
  const epochGap = tape ? tape.digits.length - tape.epochs.length : 0;

  const selectable = Array.from(new Set([...watchedCodes, ...(symbol ? [symbol] : [])]));

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide">
            <Localize i18n_default_text="Last 30 ticks" />
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {symbol ? getSymbolDisplayName(symbol) : '—'}
            {tape?.isFrozen && ` · ${localize('frozen when the robot stopped')}`}
          </p>
        </div>
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger className="h-7 w-[120px] shrink-0 text-[11px] font-semibold" aria-label="Market">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{localize('Last traded')}</SelectItem>
            {selectable.map((code) => (
              <SelectItem key={code} value={code}>
                {getSymbolDisplayName(code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {tape ? (
        <div className="grid grid-cols-10 gap-1">
          {Array.from({ length: MM_TAPE_TICKS }, (_, slot) => {
            const idx = slot - offset;
            if (idx < 0) {
              return <span key={slot} className="aspect-square rounded bg-muted/20" />;
            }
            const digit = tape.digits[idx];
            const epoch = idx - epochGap >= 0 ? tape.epochs[idx - epochGap] : undefined;
            const mark = epoch !== undefined ? marksByEpoch.get(epoch) : undefined;
            const isNewest = idx === n - 1;
            const title = mark
              ? `${mark.label} · ${localize('stake')} ${mark.stake.toFixed(2)} · ${
                  mark.status === 'pending'
                    ? localize('open')
                    : mark.status === 'won'
                      ? localize('won')
                      : localize('lost')
                }${mark.refire ? ` · ${localize('re-fire')}` : ''}`
              : epoch !== undefined
                ? new Date(epoch * 1000).toLocaleTimeString()
                : undefined;
            return (
              <span
                key={slot}
                title={title}
                className={cn(
                  'flex aspect-square items-center justify-center rounded text-[11px] font-bold tabular-nums',
                  !mark && 'bg-muted text-foreground/70',
                  mark?.status === 'pending' && 'bg-amber-400/30 text-amber-200 ring-1 ring-amber-400',
                  mark?.status === 'won' && 'bg-emerald-500/30 text-emerald-200 ring-1 ring-emerald-400',
                  mark?.status === 'lost' && 'bg-rose-500/30 text-rose-200 ring-1 ring-rose-400',
                  isNewest && !mark && 'ring-2 ring-primary'
                )}
              >
                {digit}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">
          <Localize i18n_default_text="Start the robot to record ticks." />
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded bg-muted" />
          <Localize i18n_default_text="tick" />
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded bg-amber-400/40 ring-1 ring-amber-400" />
          <Localize i18n_default_text="trade placed" />
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded bg-emerald-500/40 ring-1 ring-emerald-400" />
          <Localize i18n_default_text="won" />
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded bg-rose-500/40 ring-1 ring-rose-400" />
          <Localize i18n_default_text="lost" />
        </span>
        <span className="ml-auto">
          <Localize i18n_default_text="oldest top-left → newest bottom-right" />
        </span>
      </div>
    </div>
  );
}
