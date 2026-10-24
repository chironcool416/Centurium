'use client';

import { useMemo } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Localize } from '@deriv-com/translations';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import {
  SEQUENCE_CONDITIONS,
  MIN_RUN_OPTIONS,
  analyzeSequences,
  buildBins,
  conditionKey,
  conditionLabel,
  countInBin,
  expectedInBin,
  hitProbability,
  type SequenceAnalysis,
} from '@/lib/digit-sequences';
import {
  DEFAULT_SEQUENCE_SYMBOLS,
  WINDOW_TICKS,
  type SequenceStream,
  type SequenceStreamStatus,
} from '@/hooks/use-sequence-scanner';
import type { SequencePanelSettings } from '@/hooks/use-sequence-panel-settings';
import type { MmSignal } from '@/hooks/use-mm-bot';
import type { SequenceCondition } from '@/lib/digit-sequences';

/** Stable per-market colours (same order as DEFAULT_SEQUENCE_SYMBOLS). */
const MARKET_COLORS = [
  '#3b82f6', // R_100
  '#22c55e', // R_75
  '#f59e0b', // R_50
  '#a855f7', // R_25
  '#ef4444', // R_10
  '#06b6d4', // 1HZ100V
  '#84cc16', // 1HZ75V
  '#eab308', // 1HZ50V
  '#6366f1', // 1HZ25V
  '#ec4899', // 1HZ10V
  '#14b8a6', // RDBULL
  '#f97316', // RDBEAR
  '#8b5cf6', // JD100
  '#10b981', // JD75
  '#fb7185', // JD50
  '#38bdf8', // JD25
  '#c084fc', // JD10
];

function colorFor(code: string): string {
  const idx = (DEFAULT_SEQUENCE_SYMBOLS as readonly string[]).indexOf(code);
  return MARKET_COLORS[(idx >= 0 ? idx : 0) % MARKET_COLORS.length];
}

function niceAxis(max: number): { top: number; ticks: number[] } {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const target = Math.max(max, 1);
  const step = steps.find((s) => target / s <= 5) ?? 1000;
  const top = Math.ceil(target / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

function StatusDot({ status }: { status: SequenceStreamStatus | undefined }) {
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        status === 'live' && 'bg-emerald-400',
        status === 'stale' && 'bg-amber-400',
        (status === 'connecting' || !status) && 'bg-foreground/30 animate-pulse'
      )}
    />
  );
}

interface Row {
  code: string;
  name: string;
  color: string;
  status: SequenceStreamStatus | undefined;
  analysis: SequenceAnalysis;
}

interface Props {
  /** Shared selections (condition, min, markets), owned by the robot view. */
  panel: SequencePanelSettings;
  /** Live digit buffers per market, from the shared scanner. */
  streams: Record<string, SequenceStream>;
  /** Set while the MM bot is running: the panel then mirrors what it watches. */
  botWatch: { condition: SequenceCondition; length: number } | null;
  /** Most recent MM bot signal, for the banner and row highlight. */
  lastSignal: MmSignal | null;
}

export function MultiMarketSequences({ panel, streams, botWatch, lastSignal }: Props) {
  const { localize } = useAppTranslations();
  const { available, activeCodes, hidden, setHidden } = panel;

  // While the bot runs, the chart shows exactly what it is counting: its
  // condition, and a Min low enough that its watched length is always a bar.
  const condition = botWatch ? botWatch.condition : panel.condition;
  const conditionValue = conditionKey(condition);
  const minLen = botWatch ? Math.min(panel.minLen, botWatch.length) : panel.minLen;
  const setConditionValue = panel.setConditionValue;
  const setMinLen = panel.setMinLen;
  const locked = botWatch !== null;

  const rows: Row[] = useMemo(
    () =>
      activeCodes.map((code) => ({
        code,
        name: getSymbolDisplayName(code),
        color: colorFor(code),
        status: streams[code]?.status,
        analysis: analyzeSequences(streams[code]?.digits ?? [], condition),
      })),
    [activeCodes, streams, condition]
  );

  const p = hitProbability(condition);
  const bins = useMemo(() => buildBins(minLen), [minLen]);
  const maxTicks = rows.reduce((m, r) => Math.max(m, r.analysis.ticks), 0);

  const counts = useMemo(
    () => rows.map((r) => bins.map((bin) => countInBin(r.analysis.completedRuns, bin))),
    [rows, bins]
  );
  const expected = useMemo(
    () => bins.map((bin) => expectedInBin(maxTicks, p, bin)),
    [bins, maxTicks, p]
  );

  const yMax = Math.max(1, ...counts.flat(), ...expected);
  const { top, ticks } = niceAxis(yMax);

  // Chart geometry
  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 30;
  const plotH = 210;
  const groupW = Math.max(64, rows.length * 7 + 18);
  const W = padL + padR + bins.length * groupW;
  const H = padT + plotH + padB;
  const yOf = (v: number) => padT + plotH - (v / top) * plotH;

  const summaryRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          b.analysis.currentRun - a.analysis.currentRun || b.analysis.longestRun - a.analysis.longestRun
      ),
    [rows]
  );

  const toggleMarket = (code: string) =>
    setHidden((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const label = conditionLabel(condition);
  const recentSignal = lastSignal !== null && Date.now() - lastSignal.time < 15_000;

  return (
    <div className="space-y-4">
      {/* Sequence lengths */}
      <div className="rounded-lg border border-border bg-card/40 p-3 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wide">
            <Localize i18n_default_text="Sequence lengths" />
          </h3>
          <div className="flex items-center gap-2">
            <Select value={conditionValue} onValueChange={setConditionValue} disabled={locked}>
              <SelectTrigger className="h-8 w-[104px] text-xs font-semibold" aria-label="Condition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEQUENCE_CONDITIONS.map((c) => (
                  <SelectItem key={conditionKey(c)} value={conditionKey(c)}>
                    {conditionLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(minLen)} onValueChange={(v) => setMinLen(Number(v))} disabled={locked}>
              <SelectTrigger className="h-8 w-[92px] text-xs font-semibold" aria-label="Minimum run length">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MIN_RUN_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    Min: {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {botWatch && (
          <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs leading-snug">
            <span className="font-bold text-primary">MM</span>{' '}
            <Localize i18n_default_text="bot is watching" />{' '}
            <span className="font-semibold">{label}</span> ·{' '}
            {localize('runs of exactly {{n}} on {{m}} markets', { n: botWatch.length, m: rows.length })}
            {lastSignal && (
              <span className="mt-1 block text-foreground/80">
                {localize('Last signal')}: {getSymbolDisplayName(lastSignal.symbol)} ·{' '}
                {localize('run of {{n}} ended', { n: lastSignal.runLength })} →{' '}
                {lastSignal.action === 'traded'
                  ? `${localize('traded')} ${lastSignal.tradeLabel}`
                  : lastSignal.action === 'busy'
                    ? localize('skipped (trade in progress)')
                    : localize('skipped (market cooldown)')}{' '}
                · {Math.max(0, Math.round((Date.now() - lastSignal.time) / 1000))}s {localize('ago')}
              </span>
            )}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {available.length === 0 ? (
              <Localize i18n_default_text="Loading markets…" />
            ) : (
              <Localize i18n_default_text="No markets selected. Use the filter button below to pick some." />
            )}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                style={{ minWidth: W }}
                className="h-auto w-full text-foreground"
                role="img"
                aria-label={`${label} sequence lengths by market`}
              >
                {ticks.map((t) => (
                  <g key={t}>
                    <line
                      x1={padL}
                      x2={W - padR}
                      y1={yOf(t)}
                      y2={yOf(t)}
                      stroke="currentColor"
                      strokeOpacity={0.12}
                    />
                    <text
                      x={padL - 8}
                      y={yOf(t) + 3}
                      textAnchor="end"
                      fontSize={10}
                      fill="currentColor"
                      fillOpacity={0.6}
                    >
                      {t}
                    </text>
                  </g>
                ))}
                <text
                  transform={`translate(11 ${padT + plotH / 2}) rotate(-90)`}
                  textAnchor="middle"
                  fontSize={10}
                  fill="currentColor"
                  fillOpacity={0.6}
                >
                  Frequency
                </text>

                {bins.map((bin, bi) => {
                  const x0 = padL + bi * groupW;
                  const barW = Math.min(14, (groupW - 14) / rows.length);
                  const startX = x0 + (groupW - barW * rows.length) / 2;
                  return (
                    <g key={bin.label}>
                      {botWatch && bin.from === botWatch.length && (
                        <rect
                          x={x0 + 2}
                          y={padT}
                          width={groupW - 4}
                          height={plotH}
                          rx={4}
                          fill="#3b82f6"
                          fillOpacity={0.1}
                          stroke="#3b82f6"
                          strokeOpacity={0.45}
                          strokeDasharray="3 3"
                        >
                          <title>{`MM bot trades when a run of exactly ${botWatch.length} ends`}</title>
                        </rect>
                      )}
                      {rows.map((row, ri) => {
                        const count = counts[ri][bi];
                        const h = (count / top) * plotH;
                        const x = startX + ri * barW;
                        return (
                          <g key={row.code}>
                            {count > 0 && (
                              <rect
                                x={x + 0.5}
                                y={yOf(count)}
                                width={Math.max(1, barW - 1)}
                                height={h}
                                rx={1}
                                fill={row.color}
                              >
                                <title>{`${row.name} · length ${bin.label}: ${count}`}</title>
                              </rect>
                            )}
                            {count > 0 && barW >= 7 && (
                              <text
                                x={x + barW / 2}
                                y={yOf(count) - 3}
                                textAnchor="middle"
                                fontSize={8}
                                fill="currentColor"
                                fillOpacity={0.75}
                              >
                                {count}
                              </text>
                            )}
                          </g>
                        );
                      })}
                      {/* What pure chance would give each market at this length */}
                      <line
                        x1={x0 + 4}
                        x2={x0 + groupW - 4}
                        y1={yOf(expected[bi])}
                        y2={yOf(expected[bi])}
                        stroke="currentColor"
                        strokeOpacity={0.55}
                        strokeDasharray="4 3"
                      >
                        <title>{`Expected per market by chance at ${bin.label}: ${expected[bi].toFixed(1)}`}</title>
                      </line>
                      <text
                        x={x0 + groupW / 2}
                        y={padT + plotH + 16}
                        textAnchor="middle"
                        fontSize={11}
                        fill="currentColor"
                        fillOpacity={0.8}
                      >
                        {bin.label}
                      </text>
                    </g>
                  );
                })}
                <text
                  x={padL + (W - padL - padR) / 2}
                  y={H - 2}
                  textAnchor="middle"
                  fontSize={11}
                  fill="currentColor"
                  fillOpacity={0.7}
                >
                  Sequence Lengths
                </text>
              </svg>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {rows.map((row) => (
                <span key={row.code} className="flex items-center gap-1.5 text-xs font-semibold">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                  {row.name}
                </span>
              ))}
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <svg width="18" height="6" aria-hidden>
                  <line x1="0" x2="18" y1="3" y2="3" stroke="currentColor" strokeDasharray="4 3" />
                </svg>
                <Localize i18n_default_text="expected per market from chance alone" />
              </span>
            </div>
          </>
        )}
      </div>

      {/* Market digit sequence summary */}
      <div className="rounded-lg border border-border bg-card/40 p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wide">
            <Localize i18n_default_text="Market digit sequence summary" />
          </h3>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                title="Choose markets"
                aria-label="Choose markets"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground/80 transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wide">
                  <Localize i18n_default_text="Markets" />
                </span>
                <div className="flex gap-2 text-xs">
                  <button type="button" className="underline-offset-2 hover:underline" onClick={() => setHidden([])}>
                    <Localize i18n_default_text="All" />
                  </button>
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => setHidden([...available])}
                  >
                    <Localize i18n_default_text="None" />
                  </button>
                </div>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {available.map((code) => (
                  <label key={code} className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={!hidden.includes(code)}
                      onChange={() => toggleMarket(code)}
                    />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorFor(code) }} />
                    {getSymbolDisplayName(code)}
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {summaryRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-2 font-semibold">
                    <Localize i18n_default_text="Market" />
                  </th>
                  <th className="px-2 py-1.5 text-right font-semibold">
                    <Localize i18n_default_text="Now" />
                  </th>
                  <th className="px-2 py-1.5 text-right font-semibold">
                    <Localize i18n_default_text="Longest" />
                  </th>
                  <th className="px-2 py-1.5 text-right font-semibold">
                    {`Runs ≥ ${minLen}`}
                  </th>
                  <th className="px-2 py-1.5 text-right font-semibold">
                    <Localize i18n_default_text="Expected" />
                  </th>
                  <th className="py-1.5 pl-2 text-right font-semibold">
                    {`${label} %`}
                  </th>
                </tr>
              </thead>
              <tbody>
                {summaryRows.map((row) => {
                  const a = row.analysis;
                  const longRuns = a.completedRuns.filter((r) => r >= minLen).length;
                  const exp = a.ticks * (1 - p) * Math.pow(p, minLen);
                  const hot = a.currentRun >= minLen;
                  return (
                    <tr
                      key={row.code}
                      className={cn(
                        'border-b border-border/50 last:border-0',
                        hot && 'bg-primary/10',
                        recentSignal && lastSignal?.symbol === row.code && 'ring-1 ring-inset ring-amber-400/70'
                      )}
                    >
                      <td className="py-1.5 pr-2">
                        <span className="flex items-center gap-1.5 font-semibold">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                          {row.name}
                          <StatusDot status={row.status} />
                          {recentSignal && lastSignal?.symbol === row.code && (
                            <span className="rounded bg-amber-400/20 px-1 text-[10px] font-bold uppercase text-amber-300">
                              {localize('signal')}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', hot && 'font-bold text-primary')}>
                        {a.currentRun}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{a.longestRun}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{longRuns}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {exp.toFixed(1)}
                      </td>
                      <td className="py-1.5 pl-2 text-right tabular-nums">
                        {a.ticks > 0 ? ((a.hits / a.ticks) * 100).toFixed(1) : '–'}
                        <span className="text-muted-foreground"> / {(p * 100).toFixed(0)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] leading-snug text-muted-foreground">
          {localize(
            'Counts the last {{ticks}} ticks per market; a run is consecutive ticks whose last digit is {{label}}. Last digits are independent from tick to tick, so the dashed line and Expected column show what chance alone produces.',
            { ticks: WINDOW_TICKS, label }
          )}
        </p>
      </div>
    </div>
  );
}
