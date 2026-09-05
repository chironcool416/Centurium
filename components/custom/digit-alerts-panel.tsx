'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Bell, BellOff, Trash2 } from 'lucide-react';
import { Localize } from '@deriv-com/translations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { getSubmarketDisplayName } from '@/lib/active-symbols-display-names';
import {
  ALERT_WINDOW_OPTIONS,
  type AlertDirection,
  type AlertMatchMode,
  type AlertWindow,
  type DigitAlertFire,
  type DigitAlertRule,
  type SymbolStreamInfo,
} from '@/hooks/use-digit-alerts';
import type { ActiveSymbol } from '@deriv/core';

const SOUND_STORAGE_KEY = 'centurium:digit-alert-sound-enabled';

const DIGIT_PRESETS: { label: string; digits: number[] }[] = [
  { label: 'Evens', digits: [0, 2, 4, 6, 8] },
  { label: 'Odds', digits: [1, 3, 5, 7, 9] },
  { label: 'Low 0-4', digits: [0, 1, 2, 3, 4] },
  { label: 'High 5-9', digits: [5, 6, 7, 8, 9] },
  { label: 'All', digits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
];

/** Short two-tone chime via WebAudio — no audio asset needed. */
function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.24);
    });
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    // Non-fatal — visual toast still fires either way.
  }
}

function directionLabel(direction: AlertDirection, localize: (t: string) => string): string {
  switch (direction) {
    case 'over':
      return localize('over');
    case 'under':
      return localize('under');
    case 'equals':
      return localize('at');
  }
}

function digitsLabel(digits: number[]): string {
  return [...digits].sort((a, b) => a - b).join(', ');
}

function ruleDescription(rule: DigitAlertRule, localize: (t: string) => string): string {
  const digitWord = rule.digits.length > 1 ? localize('Digits') : localize('Digit');
  const groupWord =
    rule.digits.length > 1 ? (rule.matchMode === 'all' ? localize('all') : localize('any')) + ' ' : '';
  return `${digitWord} ${digitsLabel(rule.digits)} ${groupWord}${directionLabel(rule.direction, localize)} ${rule.threshold}% (${localize('last')} ${rule.window})`;
}

interface DigitAlertsPanelProps {
  symbols: ActiveSymbol[];
  rules: DigitAlertRule[];
  addRule: (input: Omit<DigitAlertRule, 'id' | 'createdAt' | 'enabled'>) => string;
  removeRule: (id: string) => void;
  toggleRule: (id: string, enabled?: boolean) => void;
  streams: Record<string, SymbolStreamInfo>;
  firedLog: DigitAlertFire[];
  clearFiredLog: () => void;
  /** Latest fire, surfaced by the parent so the panel can toast/chime it
   *  exactly once even though `firedLog` itself is stable across renders. */
  lastFire: DigitAlertFire | null;
}

type SubmarketGroup = { displayName: string; symbols: ActiveSymbol[] };

function groupBySubmarket(symbols: ActiveSymbol[]): Map<string, SubmarketGroup> {
  const groups = new Map<string, SubmarketGroup>();
  for (const symbol of symbols) {
    const key = symbol.submarket;
    const existing = groups.get(key);
    if (existing) {
      existing.symbols.push(symbol);
    } else {
      const displayName = symbol.submarket_display_name ?? getSubmarketDisplayName(symbol.submarket);
      groups.set(key, { displayName, symbols: [symbol] });
    }
  }
  return groups;
}

/** Whether a single digit's live percentage currently breaches a rule's
 *  condition — shared between the "is this rule breaching" check and the
 *  per-digit chip coloring below. */
function digitBreaches(pct: number | undefined, direction: AlertDirection, threshold: number): boolean {
  if (pct === undefined) return false;
  switch (direction) {
    case 'over':
      return pct > threshold;
    case 'under':
      return pct < threshold;
    case 'equals':
      return Math.abs(pct - threshold) < 0.05;
  }
}

export function DigitAlertsPanel({
  symbols,
  rules,
  addRule,
  removeRule,
  toggleRule,
  streams,
  firedLog,
  clearFiredLog,
  lastFire,
}: DigitAlertsPanelProps) {
  const { localize } = useAppTranslations();
  const grouped = useMemo(() => groupBySubmarket(symbols), [symbols]);

  const [formSymbol, setFormSymbol] = useState<string>('');
  const [formDigits, setFormDigits] = useState<number[]>([9]);
  const [formMatchMode, setFormMatchMode] = useState<AlertMatchMode>('all');
  const [formDirection, setFormDirection] = useState<AlertDirection>('over');
  const [formThreshold, setFormThreshold] = useState<string>('10');
  const [formWindow, setFormWindow] = useState<AlertWindow>(100);
  const [soundEnabled, setSoundEnabled] = useState(true);

  useEffect(() => {
    if (!formSymbol && symbols.length > 0) setFormSymbol(symbols[0].underlying_symbol);
  }, [symbols, formSymbol]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SOUND_STORAGE_KEY);
      if (raw !== null) setSoundEnabled(raw === '1');
    } catch {
      // Ignore — default stays on.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SOUND_STORAGE_KEY, soundEnabled ? '1' : '0');
    } catch {
      // Non-fatal.
    }
  }, [soundEnabled]);

  // Toast + chime exactly once per new fire.
  useEffect(() => {
    if (!lastFire) return;
    const symbolName =
      symbols.find((s) => s.underlying_symbol === lastFire.symbol)?.underlying_symbol_name ??
      lastFire.symbol;
    const digitWord = lastFire.digits.length > 1 ? localize('Digits') : localize('Digit');
    const groupWord =
      lastFire.digits.length > 1
        ? (lastFire.matchMode === 'all' ? localize('all') : localize('any')) + ' '
        : '';
    const breakdown = lastFire.digits
      .map((d, i) => `${d}: ${lastFire.actualPcts[i].toFixed(1)}%`)
      .join('  ');
    toast(
      `${symbolName}: ${digitWord} ${digitsLabel(lastFire.digits)} ${groupWord}${directionLabel(lastFire.direction, localize)} ${lastFire.threshold}%`,
      {
        description: `${breakdown} (${localize('last')} ${lastFire.window} ${localize('ticks')})`,
        duration: 10000,
      }
    );
    if (soundEnabled) playChime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFire]);

  const handleAdd = () => {
    const thresholdNum = parseFloat(formThreshold);
    if (!formSymbol || formDigits.length === 0 || Number.isNaN(thresholdNum) || thresholdNum < 0 || thresholdNum > 100) {
      toast.error(localize('Pick a market, at least one digit, and a threshold between 0 and 100.'));
      return;
    }
    addRule({
      symbol: formSymbol,
      digits: formDigits,
      matchMode: formDigits.length > 1 ? formMatchMode : 'all',
      direction: formDirection,
      threshold: thresholdNum,
      window: formWindow,
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            <Localize i18n_default_text="Add a new alert" />
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1.5"
            onClick={() => setSoundEnabled((v) => !v)}
          >
            {soundEnabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
            {soundEnabled ? localize('Sound on') : localize('Sound off')}
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            <Localize i18n_default_text="Market" />
          </Label>
          <Select value={formSymbol} onValueChange={setFormSymbol}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder={localize('Select a market')} />
            </SelectTrigger>
            <SelectContent>
              {Array.from(grouped.entries()).map(([submarket, { displayName, symbols: group }]) => (
                <SelectGroup key={submarket}>
                  <SelectLabel>{displayName}</SelectLabel>
                  {group.map((symbol) => (
                    <SelectItem key={symbol.underlying_symbol} value={symbol.underlying_symbol}>
                      {symbol.underlying_symbol_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">
              <Localize i18n_default_text="Digits (pick one or more)" />
            </Label>
            <div className="flex gap-1 flex-wrap justify-end">
              {DIGIT_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setFormDigits(preset.digits)}
                >
                  {localize(preset.label)}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setFormDigits([])}
              >
                <Localize i18n_default_text="Clear" />
              </Button>
            </div>
          </div>
          <ToggleGroup
            type="multiple"
            value={formDigits.map(String)}
            onValueChange={(v) => setFormDigits(v.map((d) => parseInt(d, 10)).sort((a, b) => a - b))}
            className="justify-start flex-wrap"
          >
            {Array.from({ length: 10 }, (_, d) => (
              <ToggleGroupItem key={d} value={String(d)} className="h-9 w-9 p-0 text-sm font-semibold">
                {d}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {formDigits.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                <Localize i18n_default_text="Match" />
              </Label>
              <ToggleGroup
                type="single"
                value={formMatchMode}
                onValueChange={(v) => v && setFormMatchMode(v as AlertMatchMode)}
                className="justify-start"
              >
                <ToggleGroupItem value="all" className="h-9 px-2.5 text-xs">
                  <Localize i18n_default_text="All of them" />
                </ToggleGroupItem>
                <ToggleGroupItem value="any" className="h-9 px-2.5 text-xs">
                  <Localize i18n_default_text="Any of them" />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              <Localize i18n_default_text="Condition" />
            </Label>
            <ToggleGroup
              type="single"
              value={formDirection}
              onValueChange={(v) => v && setFormDirection(v as AlertDirection)}
              className="justify-start"
            >
              <ToggleGroupItem value="over" className="h-9 px-2.5 text-xs">
                <Localize i18n_default_text="Over" />
              </ToggleGroupItem>
              <ToggleGroupItem value="under" className="h-9 px-2.5 text-xs">
                <Localize i18n_default_text="Under" />
              </ToggleGroupItem>
              <ToggleGroupItem value="equals" className="h-9 px-2.5 text-xs">
                <Localize i18n_default_text="At" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              <Localize i18n_default_text="Threshold %" />
            </Label>
            <Input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={formThreshold}
              onChange={(e) => setFormThreshold(e.target.value)}
              className="h-9"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              <Localize i18n_default_text="Window (last N ticks)" />
            </Label>
            <Select value={String(formWindow)} onValueChange={(v) => setFormWindow(parseInt(v, 10) as AlertWindow)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALERT_WINDOW_OPTIONS.map((w) => (
                  <SelectItem key={w} value={String(w)}>
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {formDigits.length > 1
              ? localize(
                  formMatchMode === 'all'
                    ? 'Fires only once every one of {{digits}} is {{direction}} {{threshold}}%.'
                    : 'Fires as soon as any of {{digits}} is {{direction}} {{threshold}}%.',
                  {
                    digits: digitsLabel(formDigits),
                    direction: directionLabel(formDirection, localize),
                    threshold: formThreshold || '0',
                  }
                )
              : localize('Pick more than one digit to require all (or any) of them to breach together.')}
          </p>
          <Button onClick={handleAdd} size="sm" className="shrink-0">
            <Localize i18n_default_text="Add alert" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          <Localize i18n_default_text="Watched markets" />
        </p>
        {rules.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <Localize i18n_default_text="No alerts yet — add one above. Each one runs on its own live subscription, independent of whatever market is selected for trading." />
          </div>
        )}
        <div className="space-y-1.5">
          {rules.map((rule) => {
            const symbolName =
              symbols.find((s) => s.underlying_symbol === rule.symbol)?.underlying_symbol_name ??
              rule.symbol;
            const stream = streams[rule.symbol];
            const pctByDigit = stream?.statsByWindow[rule.window];
            const flags = rule.digits.map((d) => digitBreaches(pctByDigit?.[d], rule.direction, rule.threshold));
            const isBreaching =
              rule.enabled && (rule.matchMode === 'all' ? flags.every(Boolean) && flags.length > 0 : flags.some(Boolean));

            return (
              <div
                key={rule.id}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm',
                  isBreaching ? 'border-primary bg-primary/5' : 'border-border',
                  !rule.enabled && 'opacity-50'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{symbolName}</span>
                    <span className="text-foreground/70">{ruleDescription(rule, localize)}</span>
                    {stream?.status === 'connecting' && (
                      <Badge variant="outline" className="text-[10px] py-0">
                        <Localize i18n_default_text="connecting…" />
                      </Badge>
                    )}
                    {stream?.status === 'stale' && (
                      <Badge variant="destructive" className="text-[10px] py-0">
                        <Localize i18n_default_text="reconnecting…" />
                      </Badge>
                    )}
                  </div>
                  {/* Per-digit live readout — most useful once a rule watches more than one digit. */}
                  <div className="flex items-center gap-1.5 flex-wrap mt-1">
                    {rule.digits.map((d, i) => {
                      const pct = pctByDigit?.[d];
                      const breach = flags[i];
                      return (
                        <span
                          key={d}
                          className={cn(
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold tabular-nums',
                            breach ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground/60'
                          )}
                        >
                          {d}:{pct !== undefined ? `${pct.toFixed(1)}%` : '—'}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => toggleRule(rule.id)}
                  >
                    {rule.enabled ? localize('Pause') : localize('Resume')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive"
                    onClick={() => removeRule(rule.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            <Localize i18n_default_text="Recent alerts" />
          </p>
          {firedLog.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearFiredLog}>
              <Localize i18n_default_text="Clear" />
            </Button>
          )}
        </div>
        {firedLog.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <Localize i18n_default_text="Nothing has fired yet." />
          </div>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {firedLog.map((fire) => {
              const symbolName =
                symbols.find((s) => s.underlying_symbol === fire.symbol)?.underlying_symbol_name ??
                fire.symbol;
              const breakdown = fire.digits.map((d, i) => `${d}:${fire.actualPcts[i].toFixed(1)}%`).join(' ');
              return (
                <div
                  key={fire.id}
                  className="flex items-center justify-between text-xs rounded-md border border-border px-3 py-1.5 gap-3"
                >
                  <span className="text-foreground/80">
                    {new Date(fire.time).toLocaleTimeString()} — <span className="font-semibold">{symbolName}</span>{' '}
                    {localize('digits')} {digitsLabel(fire.digits)} {directionLabel(fire.direction, localize)} {fire.threshold}%
                  </span>
                  <span className="font-mono font-semibold tabular-nums shrink-0">{breakdown}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
