'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Localize } from '@deriv-com/translations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SymbolSelector } from '@/components/custom/symbol-selector';
import { TradeControls, getContractModeOptions } from '@/components/trade-controls';
import { PositionsTable } from '@/components/custom/positions-table';
import { VictoryDialog } from '@/components/custom/victory-dialog';
import { DefeatDialog } from '@/components/custom/defeat-dialog';
import { cn } from '@/lib/utils';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { computeDigitStats, getLastDigit, pipSizeFromPip } from '@/lib/digit-stats';
import { useAutoBot, type BotPhase } from '@/hooks/use-auto-bot';
import { useRaBot, type RaPhase, type RaTradingMode, type RaDetectionSide, type RaLogEntry } from '@/hooks/use-ra-bot';
import {
  useDifferBot,
  type DifferPhase,
  type DifferTradeType,
  type DifferLogEntry,
} from '@/hooks/use-differ-bot';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useDigitAlerts, type DigitAlertFire } from '@/hooks/use-digit-alerts';
import { DigitAlertsPanel } from '@/components/custom/digit-alerts-panel';
import { MultiMarketSequences } from '@/components/custom/multi-market-sequences';
import { RobotPresets, type RobotPreset } from '@/components/custom/robot-presets';
import { MmTickRecord } from '@/components/custom/mm-tick-record';
import {
  useMmBot,
  type MmPhase,
  type MmMode,
  type MmCounterKind,
  type MmRecoveryMode,
  type MmTargetTrigger,
  oppositeCondition,
  type MmStopReason,
  type MmLogEntry,
} from '@/hooks/use-mm-bot';
import { useSequenceScanner } from '@/hooks/use-sequence-scanner';
import { useSequencePanelSettings } from '@/hooks/use-sequence-panel-settings';
import {
  SEQUENCE_CONDITIONS,
  conditionKey,
  conditionLabel,
  parseConditionKey,
} from '@/lib/digit-sequences';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import type {
  ActiveSymbol,
  Tick,
  DurationLimits,
  ProposalInfo,
  BuyResult,
  DerivWS,
} from '@deriv/core';
import type {
  ContractMode,
  TradeType,
  DigitStats,
  OpenPosition,
  ClosedPosition,
} from '@/lib/types';

const DIGIT_CONTRACT_TYPES = [
  'DIGITMATCH',
  'DIGITDIFF',
  'DIGITOVER',
  'DIGITUNDER',
  'DIGITEVEN',
  'DIGITODD',
];

function getDigitContractLabels(
  localize: (text: string) => string
): Record<string, string> {
  return {
    DIGITMATCH: localize('Digit Match'),
    DIGITDIFF: localize('Digit Differs'),
    DIGITOVER: localize('Digit Over'),
    DIGITUNDER: localize('Digit Under'),
    DIGITEVEN: localize('Digit Even'),
    DIGITODD: localize('Digit Odd'),
  };
}

function getDigitTradeTypeOptions(
  localize: (text: string) => string
): { value: TradeType; label: string }[] {
  return [
    { value: 'matches-differs', label: localize('Matches/Differs') },
    { value: 'over-under', label: localize('Over/Under') },
    { value: 'even-odd', label: localize('Even/Odd') },
  ];
}

type Tab = 'chart' | 'digits' | 'trades' | 'logs' | 'alerts';

export interface TradeRobotViewProps {
  isConnected: boolean;
  isAuthenticated: boolean;
  balanceLabel: string | null;
  /** Raw numeric account balance — used by the Ra bot's insufficient-funds
   *  check (see `useRaBot`) to know whether the next martingale stake
   *  within a burst is affordable. Null while unauthenticated/unknown. */
  balance: number | null;
  /** Shared WS instance — used only by the Alerts tab to run its own
   *  independent tick subscriptions per watched market, separate from
   *  whichever symbol is selected for trading below. */
  ws: DerivWS | null;

  symbols: ActiveSymbol[];
  activeSymbol: ActiveSymbol | null;
  selectSymbol: (symbol: string) => void;
  currentTick: Tick | null;
  /** Full tick-price history (includes pre-fetched history, not just live ticks). */
  prices: number[];
  pipSize: number;

  tradeType: TradeType;
  setTradeType: (type: TradeType) => void;
  contractMode: ContractMode;
  setContractMode: (mode: ContractMode) => void;
  selectedDigit: number;
  setSelectedDigit: (digit: number) => void;
  stake: string;
  setStake: (value: string) => void;
  duration: number;
  setDuration: (value: number) => void;
  durationLimits: DurationLimits;
  proposal: ProposalInfo | null;
  isProposalLoading: boolean;
  buyContract: () => Promise<void>;
  isBuying: boolean;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;

  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  sellContract: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  sellError: string | null;
  clearSellError: () => void;
}

const HISTORY_WINDOW = 100;
const RECENT_DIGITS_SHOWN = 26;
const ROBOT_SETTINGS_STORAGE_KEY = 'centurium:robot-settings';

interface SavedRobotSettings {
  multiplier: string;
  martingaleAfterLosses: string;
  initialAmount: string;
  targetProfit: string;
  stopLossLosses: string;
  duration: number;
  raStreakCount: string;
  raConfirmationStreak: string;
  raInitialStake: string;
  raStakeMultiplier: string;
  raMartingaleAfterLosses: string;
  raTradingMode: RaTradingMode;
  raTakeProfit: string;
  raStopLoss: string;
  differStreakLength: string;
  differPatternGap: string;
  differTradeType: DifferTradeType;
  differInitialStake: string;
  differStakeMultiplier: string;
  differMartingaleAfterLosses: string;
  differTakeProfit: string;
  differStopLoss: string;
  mmCondition: string;
  mmWatchOpposite: boolean;
  mmLength: string;
  mmMode: MmMode;
  mmCounterKind: MmCounterKind;
  mmCounterDigit: string;
  mmInitialStake: string;
  mmStakeMultiplier: string;
  mmMartingaleAfterLosses: string;
  mmTakeProfit: string;
  mmStopLoss: string;
  mmMaxStake: string;
  mmCooldown: string;
  mmStayOnMarket: boolean;
  mmRecoveryMode: MmRecoveryMode;
  mmRecoveryTarget: string;
  mmRecoveryTrigger: MmTargetTrigger;
}

// Same spring used for the equivalent glide animation on the standalone
// Digits page, so the motion feels identical across both pages.
const ROBOT_GLIDE_SPRING = { type: 'spring', stiffness: 340, damping: 30, mass: 0.7 } as const;

function DigitFrequencyRow({
  digitStats,
  selectedDigit,
  onSelect,
  lastDigit,
}: {
  digitStats: DigitStats;
  selectedDigit: number;
  onSelect: (digit: number) => void;
  /** The digit currently being generated by the live tick stream — when
   *  provided, a glowing pointer glides to whichever button this matches,
   *  matching the animation on the standalone Digits page. */
  lastDigit?: number | null;
}) {
  const maxPct = Math.max(...digitStats.percentages);
  const minPct = Math.min(...digitStats.percentages);
  return (
    <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
      {digitStats.percentages.map((pct, digit) => {
        const isSelected = digit === selectedDigit;
        const isCurrent = digit === lastDigit;
        const isHighest = digitStats.totalTicks > 0 && pct === maxPct;
        const isLowest = digitStats.totalTicks > 0 && pct === minPct;
        return (
          <button
            key={digit}
            onClick={() => onSelect(digit)}
            className={cn(
              'relative flex flex-col items-center gap-1 rounded-md border py-2 transition-all duration-200',
              isSelected
                ? 'border-destructive ring-1 ring-destructive'
                : isHighest
                  ? 'border-emerald-500/60'
                  : 'border-border',
              'bg-muted/30 hover:bg-muted/60 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]'
            )}
          >
            {isCurrent && (
              <>
                {/* Caret — glides above whichever digit is currently live */}
                <motion.span
                  layoutId="robot-digit-pointer-caret-live"
                  transition={ROBOT_GLIDE_SPRING}
                  className="pointer-events-none absolute -top-2.5 left-1/2 h-0 w-0 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent border-t-primary"
                />
                {/* Glow ring — glides to sit around the currently live digit */}
                <motion.span
                  layoutId="robot-digit-pointer-glow-live"
                  transition={ROBOT_GLIDE_SPRING}
                  className="pointer-events-none absolute -inset-0.5 rounded-md ring-2 ring-primary shadow-[0_0_14px_2px] shadow-primary/50"
                />
              </>
            )}
            <span className="text-lg font-bold text-foreground">{digit}</span>
            <span
              className={cn(
                'text-xs font-mono font-bold',
                isHighest && 'text-emerald-400',
                isLowest && 'text-rose-400',
                !isHighest && !isLowest && 'text-foreground/80'
              )}
            >
              {pct.toFixed(1)}%
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DigitHistogram({ title, stats }: { title: string; stats: DigitStats }) {
  const maxPct = Math.max(...stats.percentages, 1);
  const highest = Math.max(...stats.percentages);
  const lowest = Math.min(...stats.percentages);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-foreground/90">{title}</span>
      <div className="flex items-end gap-1 h-28">
        {stats.percentages.map((pct, digit) => {
          const isHighest = stats.totalTicks > 0 && pct === highest;
          const isLowest = stats.totalTicks > 0 && pct === lowest;
          return (
            <div
              key={digit}
              className="flex-1 flex flex-col items-center gap-1 rounded-md py-1 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]"
            >
              <span
                className={cn(
                  'text-[10px] font-bold',
                  isHighest ? 'text-emerald-400' : isLowest ? 'text-rose-400' : 'text-foreground/80'
                )}
              >
                {stats.totalTicks > 0 ? `${Math.round(pct)}%` : ''}
              </span>
              <div className="w-full h-20 flex items-end">
                <div
                  className={cn(
                    'w-full rounded-sm',
                    isHighest ? 'bg-emerald-500' : isLowest ? 'bg-rose-500/70' : 'bg-muted-foreground/50'
                  )}
                  style={{ height: `${Math.max((pct / maxPct) * 100, 3)}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold text-foreground/80">{digit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TickSparkline({ prices }: { prices: number[] }) {
  const points = prices.slice(-24);
  if (points.length < 2) {
    return (
      <div className="h-24 flex items-center justify-center text-xs font-semibold text-foreground/90">
        <Localize i18n_default_text="Waiting for enough ticks…" />
      </div>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 600;
  const h = 90;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / range) * (h - 16) - 8;
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-24" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" className="text-primary" strokeWidth={2} />
      {coords.map(([x, y], i) => {
        const isLast = i === coords.length - 1;
        const isUp = i > 0 && points[i] >= points[i - 1];
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={isLast ? 4 : 2.5}
            className={isUp ? 'fill-emerald-500' : 'fill-rose-500'}
          />
        );
      })}
    </svg>
  );
}

function getBotStatusLabel(phase: BotPhase, localize: (t: string) => string): string {
  switch (phase) {
    case 'idle':
      return localize('Not running');
    case 'awaiting-proposal':
    case 'awaiting-buy':
      return localize('Placing trade…');
    case 'awaiting-settlement':
      return localize('Trade running…');
    case 'stopped-target':
      return localize('Stopped — target profit reached');
    case 'stopped-loss':
      return localize('Stopped — stop-loss reached');
    case 'stopped-error':
      return localize('Stopped — trade failed');
    case 'stopped-funds':
      return localize('Stopped — insufficient funds');
    case 'stopped-timeout-proposal':
      return localize('Stopped — no price received, check Reports');
    case 'stopped-timeout-buy':
      return localize('Stopped — buy not confirmed, check Reports');
    case 'stopped-timeout-settlement':
      return localize('Stopped — no trade result, check Reports');
    default:
      return localize('Not running');
  }
}

function raSideLabel(side: RaDetectionSide, localize: (t: string) => string): string {
  if (side === 'over4') return localize('Over 4');
  if (side === 'under5') return localize('Under 5');
  if (side === 'over6') return localize('Over 6');
  if (side === 'under3') return localize('Under 3');
  return '';
}

function getRaStatusLabel(
  phase: RaPhase,
  armedSide: RaDetectionSide,
  confirmProgress: number,
  confirmationStreak: string,
  localize: (t: string) => string,
  burstActive?: boolean,
  burstPnl?: number
): string {
  switch (phase) {
    case 'awaiting-proposal':
    case 'awaiting-buy':
      return burstActive
        ? `${localize('Placing trade…')} (${(burstPnl ?? 0) >= 0 ? '+' : ''}${(burstPnl ?? 0).toFixed(2)})`
        : localize('Placing trade…');
    case 'awaiting-settlement':
      return burstActive
        ? `${localize('Trade running…')} (${(burstPnl ?? 0) >= 0 ? '+' : ''}${(burstPnl ?? 0).toFixed(2)})`
        : localize('Trade running…');
    default:
      if (armedSide) {
        return `${raSideLabel(armedSide, localize)} ${localize('ARMED')} — ${localize(
          'waiting for confirmation streak'
        )} (${confirmProgress}/${confirmationStreak})`;
      }
      return localize('Watching…');
  }
}

function getRaStoppedLabel(
  reason: 'manual' | 'take-profit' | 'stop-loss' | 'insufficient-funds' | 'timeout-proposal' | 'timeout-buy' | 'timeout-settlement' | null,
  localize: (t: string) => string
): string | null {
  switch (reason) {
    case 'manual':
      return localize('Stopped: Manual');
    case 'take-profit':
      return localize('Stopped: Take Profit');
    case 'stop-loss':
      return localize('Stopped: Stop Loss');
    case 'insufficient-funds':
      return localize('Stopped: Insufficient Funds');
    case 'timeout-proposal':
      return localize('Stopped: No price received — check Reports');
    case 'timeout-buy':
      return localize('Stopped: Buy not confirmed — check Reports');
    case 'timeout-settlement':
      return localize('Stopped: No trade result — check Reports');
    default:
      return null;
  }
}

/** Transient note shown while Ra is still running but idle between bursts,
 *  explaining how the last burst ended before a new signal opens the next one. */
function getRaLastBurstLabel(
  outcome: 'won' | 'error' | null,
  localize: (t: string) => string
): string | null {
  switch (outcome) {
    case 'won':
      return localize('Last run finished in profit — watching for the next signal.');
    case 'error':
      return localize('Last trade failed — watching for the next signal.');
    default:
      return null;
  }
}

/** Small strip of the last digits seen while Ra was on — oldest to newest,
 *  over4 (5-9) and under5 (0-4) colored differently, newest highlighted.
 *  Native equivalent of the extension's popup "Digit Record". */
function RaDigitRecord({ digits }: { digits: number[] }) {
  if (digits.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 rounded-md bg-muted/30 p-2">
      {digits.map((d, i) => {
        const isOver4 = d > 4;
        const isNewest = i === digits.length - 1;
        return (
          <span
            key={i}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold tabular-nums',
              isOver4 ? 'bg-emerald-500/25 text-emerald-400' : 'bg-rose-500/25 text-rose-400',
              isNewest && 'ring-2 ring-primary'
            )}
          >
            {d}
          </span>
        );
      })}
    </div>
  );
}

function getDifferStatusLabel(
  phase: DifferPhase,
  streakDigit: number | null,
  streakProgress: number,
  streakLength: string,
  localize: (t: string) => string,
  burstActive?: boolean,
  burstPnl?: number
): string {
  switch (phase) {
    case 'awaiting-proposal':
    case 'awaiting-buy':
      return burstActive
        ? `${localize('Placing trade…')} (${(burstPnl ?? 0) >= 0 ? '+' : ''}${(burstPnl ?? 0).toFixed(2)})`
        : localize('Placing trade…');
    case 'awaiting-settlement':
      return burstActive
        ? `${localize('Trade running…')} (${(burstPnl ?? 0) >= 0 ? '+' : ''}${(burstPnl ?? 0).toFixed(2)})`
        : localize('Trade running…');
    default:
      if (streakDigit !== null && streakProgress > 0) {
        return `${localize('Digit')} ${streakDigit} — ${streakProgress}/${streakLength}`;
      }
      return localize('Watching…');
  }
}

function getDifferStoppedLabel(
  reason: 'manual' | 'take-profit' | 'stop-loss' | 'insufficient-funds' | 'timeout-proposal' | 'timeout-buy' | 'timeout-settlement' | null,
  localize: (t: string) => string
): string | null {
  switch (reason) {
    case 'manual':
      return localize('Stopped: Manual');
    case 'take-profit':
      return localize('Stopped: Take Profit');
    case 'stop-loss':
      return localize('Stopped: Stop Loss');
    case 'insufficient-funds':
      return localize('Stopped: Insufficient Funds');
    case 'timeout-proposal':
      return localize('Stopped: No price received — check Reports');
    case 'timeout-buy':
      return localize('Stopped: Buy not confirmed — check Reports');
    case 'timeout-settlement':
      return localize('Stopped: No trade result — check Reports');
    default:
      return null;
  }
}

/** Transient note shown while Differ is still running but idle between
 *  bursts, explaining how the last burst ended before a new streak opens
 *  the next one. */
function getDifferLastBurstLabel(
  outcome: 'won' | 'error' | null,
  localize: (t: string) => string
): string | null {
  switch (outcome) {
    case 'won':
      return localize('Last run finished in profit — watching for the next streak.');
    case 'error':
      return localize('Last trade failed — watching for the next streak.');
    default:
      return null;
  }
}

function getMmStatusLabel(
  phase: MmPhase,
  trade: { symbol: string; label: string } | null,
  watching: number,
  lockedSymbol: string | null,
  localize: (t: string) => string
): string {
  const where = trade ? ` · ${getSymbolDisplayName(trade.symbol)}` : '';
  switch (phase) {
    case 'awaiting-proposal':
    case 'awaiting-buy':
      return `${localize('Placing trade…')}${where}`;
    case 'awaiting-settlement':
      return `${localize('Trade running…')}${where}`;
    default:
      if (lockedSymbol) return `${localize('Recovering on')} ${getSymbolDisplayName(lockedSymbol)}…`;
      return `${localize('Watching')} ${watching} ${localize('markets…')}`;
  }
}

function getMmStoppedLabel(reason: MmStopReason, localize: (t: string) => string): string | null {
  switch (reason) {
    case 'manual':
      return localize('Stopped: Manual');
    case 'take-profit':
      return localize('Stopped: Take Profit');
    case 'stop-loss':
      return localize('Stopped: Stop Loss');
    case 'insufficient-funds':
      return localize('Stopped: Insufficient Funds');
    case 'max-stake':
      return localize('Stopped: Max Stake reached');
    case 'timeout-proposal':
      return localize('Stopped: No price received — check Reports');
    case 'timeout-buy':
      return localize('Stopped: Buy not confirmed — check Reports');
    case 'timeout-settlement':
      return localize('Stopped: No trade result — check Reports');
    default:
      return null;
  }
}

/** Valid barrier digits for each explicit Counter trade kind. */
function counterDigitRange(kind: MmCounterKind): number[] {
  switch (kind) {
    case 'over':
      return [0, 1, 2, 3, 4, 5, 6, 7, 8];
    case 'under':
      return [1, 2, 3, 4, 5, 6, 7, 8, 9];
    case 'matches':
    case 'differs':
      return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    default:
      return [];
  }
}

/** Small strip of the last digits seen while Differ was on — oldest to
 *  newest, the digits actually forming the current in-progress pattern
 *  highlighted (spaced `gap` ticks apart, walking back from the newest
 *  tick), newest given a ring. Native equivalent of RaDigitRecord above,
 *  keyed on the exact digit rather than the over4/under5 side split. */
function DifferDigitRecord({
  digits,
  streakDigit,
  streakProgress,
  gap,
  bannedDigits,
}: {
  digits: number[];
  streakDigit: number | null;
  streakProgress: number;
  gap: number;
  bannedDigits: number[];
}) {
  if (digits.length === 0) return null;

  // Indices (into `digits`) that are actually part of the in-progress
  // pattern: walking back from the newest tick in steps of `period`,
  // for as many steps as the current streak has counted.
  const period = Math.max(1, gap + 1);
  const highlighted = new Set<number>();
  if (streakDigit !== null && streakProgress > 0) {
    let idx = digits.length - 1;
    for (let i = 0; i < streakProgress && idx >= 0; i++) {
      highlighted.add(idx);
      idx -= period;
    }
  }
  const banned = new Set(bannedDigits);

  return (
    <div className="flex flex-wrap gap-1 rounded-md bg-muted/30 p-2">
      {digits.map((d, i) => {
        const isStreakDigit = highlighted.has(i);
        const isBanned = banned.has(d);
        const isNewest = i === digits.length - 1;
        return (
          <span
            key={i}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold tabular-nums',
              isBanned
                ? 'bg-muted text-muted-foreground/50 line-through decoration-2'
                : isStreakDigit
                  ? 'bg-primary/25 text-primary'
                  : 'bg-muted text-foreground/70',
              isNewest && 'ring-2 ring-primary'
            )}
          >
            {d}
          </span>
        );
      })}
    </div>
  );
}

type RobotPanelKey = 'settings' | 'analysis' | 'manual';

/**
 * Same premium hover micro-interaction used on the homepage's entry cards:
 * the hovered panel lifts/scales up and its `.panel-glow` breathing glow
 * gets a brighter overlay faded in on top (rather than swapping the
 * keyframes, which would make the glow jump instead of smoothly
 * intensifying). The other panels dim slightly while one is hovered.
 */
function useRobotPanelHover() {
  const [hovered, setHovered] = useState<RobotPanelKey | null>(null);

  function panelProps(key: RobotPanelKey) {
    const isHovered = hovered === key;
    const isDimmed = hovered !== null && hovered !== key;
    return {
      onMouseEnter: () => setHovered(key),
      onMouseLeave: () =>
        setHovered((current: RobotPanelKey | null) => (current === key ? null : current)),
      onFocus: () => setHovered(key),
      onBlur: () =>
        setHovered((current: RobotPanelKey | null) => (current === key ? null : current)),
      style: {
        transform: isHovered ? 'translateY(-4px) scale(1.02)' : 'translateY(0) scale(1)',
        opacity: isDimmed ? 0.92 : 1,
      },
      className:
        'relative transition-[transform,opacity] duration-300 ease-out will-change-transform',
      overlayClassName:
        'pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-300 ease-out shadow-[0_14px_32px_-12px_rgba(0,0,0,0.35),0_0_0_1px_rgba(59,130,246,0.55),0_0_26px_4px_rgba(59,130,246,0.45),0_0_56px_14px_rgba(59,130,246,0.22)]' +
        (isHovered ? ' opacity-100' : ' opacity-0'),
    };
  }

  return panelProps;
}

/** Which side panel is currently open. The two are mutually exclusive —
 *  opening one always collapses the other, and the Digit panel in between
 *  is never collapsed, only pushed left/right by the resulting resize. */
type OpenSide = 'automated' | 'manual';

// Widths for the two side panels (desktop/lg only — on mobile both panels
// are always shown at full width, stacked, since there's no horizontal
// space to fight over there).
const AUTOMATED_OPEN_WIDTH = 420;
const MANUAL_OPEN_WIDTH = 300;
const SIDE_COLLAPSED_WIDTH = 40;

/**
 * A side panel (Automated Robot or Manual) that can collapse down to a
 * thin strip showing only a subtle arrow. This behaves like a real
 * sliding drawer: the panel's content stays mounted and fully visible at
 * all times — nothing fades or swaps — while the wrapper's *width*
 * animates continuously between its open and collapsed size. A
 * `clip-path` on the wrapper reveals/hides the content as that width
 * changes, so the whole thing reads as one continuous slide rather than
 * a pop-in/vanish.
 *
 * `clip-path` is used instead of `overflow-hidden` deliberately: unlike
 * `overflow`, it doesn't establish a new scroll/containing context, so it
 * won't interfere with the Automated panel's `position: sticky` scroll
 * behavior.
 *
 * All of the panel's actual data (form values, selections, etc.) lives in
 * state one level up in `TradeRobotView` — the Card here is a plain
 * presentation of that state — so keeping it mounted while collapsed
 * costs nothing and there's no state to lose.
 */
function CollapsibleSidePanel({
  isMobile,
  isOpen,
  onExpand,
  openWidth,
  arrowSide,
  arrowIcon: ArrowIcon,
  ariaLabel,
  children,
}: {
  isMobile: boolean;
  isOpen: boolean;
  onExpand: () => void;
  openWidth: number;
  /** Which edge of the wrapper the collapsed arrow sits on — this is
   *  always the panel's "inner" edge, the one that moves as it
   *  slides open/shut. */
  arrowSide: 'left' | 'right';
  arrowIcon: typeof ChevronLeft;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  if (isMobile) {
    // No horizontal space constraint when stacked — always show in full.
    return <div className="w-full">{children}</div>;
  }

  return (
    <motion.div
      initial={false}
      animate={{ width: isOpen ? openWidth : SIDE_COLLAPSED_WIDTH }}
      transition={ROBOT_GLIDE_SPRING}
      style={{ clipPath: 'inset(0)' }}
      className="relative shrink-0 self-stretch"
    >
      {/* Fixed at its full open width so it never reflows — the wrapper's
          clip-path is what continuously reveals or hides it as the width
          above animates, which is what produces the sliding motion. */}
      <div
        style={{ width: openWidth }}
        className={cn('h-full', !isOpen && 'pointer-events-none')}
        aria-hidden={!isOpen}
      >
        {children}
      </div>

      {/* Collapsed-state arrow, anchored to the panel's inner edge (so it
          sits in the right spot whether the panel is open or shut) and
          simply cross-fading in as the slide finishes closing. Bold and
          purple with a breathing glow — deliberately eye-catching rather
          than subtle, so a first-time user notices there's a panel to
          expand instead of missing it as a sliver of dead space. */}
      <button
        type="button"
        onClick={onExpand}
        aria-label={ariaLabel}
        tabIndex={isOpen ? -1 : 0}
        className={cn(
          'side-panel-arrow absolute inset-y-0 flex items-center justify-center rounded-xl border-2 bg-card/95 backdrop-blur-sm text-purple-400 hover:text-purple-200 hover:bg-card transition-[opacity,color] duration-200',
          arrowSide === 'right' ? 'right-0' : 'left-0',
          isOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
        style={{ width: SIDE_COLLAPSED_WIDTH }}
      >
        <ArrowIcon className="h-5 w-5" strokeWidth={2.75} />
      </button>
    </motion.div>
  );
}

export function TradeRobotView({
  isConnected,
  isAuthenticated,
  balanceLabel,
  balance,
  ws,
  symbols,
  activeSymbol,
  selectSymbol,
  currentTick,
  prices,
  pipSize,
  tradeType,
  setTradeType,
  contractMode,
  setContractMode,
  selectedDigit,
  setSelectedDigit,
  stake,
  setStake,
  duration,
  setDuration,
  durationLimits,
  proposal,
  isProposalLoading,
  buyContract,
  isBuying,
  buyResult,
  buyError,
  clearBuyResult,
  openPositions,
  closedPositions,
  sellContract,
  sellingId,
  sellError,
  clearSellError,
}: TradeRobotViewProps) {
  const { localize } = useAppTranslations();
  const digitTradeTypeOptions = getDigitTradeTypeOptions(localize);
  const digitContractLabels = getDigitContractLabels(localize);
  const contractModeOptions = getContractModeOptions(localize)[tradeType];

  const getPanelProps = useRobotPanelHover();
  const settingsPanel = getPanelProps('settings');
  const analysisPanel = getPanelProps('analysis');
  const manualPanel = getPanelProps('manual');

  const isMobile = useIsMobile();
  // Automated Robot is expanded and Manual is collapsed by default; the two
  // are mutually exclusive, so a single value fully describes the layout.
  const [openSide, setOpenSide] = useState<OpenSide>('automated');
  const isAutomatedOpen = openSide === 'automated';
  const isManualOpen = openSide === 'manual';

  const [activeTab, setActiveTab] = useState<Tab>('digits');
  // Digits tab sub-view: the selected market only, or the multi-market sequence scanner.
  const [digitsView, setDigitsView] = useState<'single' | 'multi'>('single');

  // Multi-market digit alerts — deliberately independent of `activeSymbol`
  // above: each rule opens and maintains its own tick subscription, so a
  // rule on Vol 100 keeps watching even while this panel is trading Vol 25.
  const [lastAlertFire, setLastAlertFire] = useState<DigitAlertFire | null>(null);
  const digitAlerts = useDigitAlerts({
    ws,
    isConnected,
    symbols,
    onFire: setLastAlertFire,
  });
  const breachingAlertCount = useMemo(
    () =>
      digitAlerts.rules.filter((rule) => {
        if (!rule.enabled || rule.digits.length === 0) return false;
        const pctByDigit = digitAlerts.streams[rule.symbol]?.statsByWindow[rule.window];
        const flags = rule.digits.map((d) => {
          const pct = pctByDigit?.[d];
          if (pct === undefined) return false;
          return rule.direction === 'over'
            ? pct > rule.threshold
            : rule.direction === 'under'
              ? pct < rule.threshold
              : Math.abs(pct - rule.threshold) < 0.05;
        });
        return rule.matchMode === 'all' ? flags.every(Boolean) : flags.some(Boolean);
      }).length,
    [digitAlerts.rules, digitAlerts.streams]
  );

  // `prices` already contains the pre-fetched history merged with live ticks
  // (see useTicks), so derive from it directly instead of keeping a separate
  // buffer that would start empty and duplicate/lag the real data.
  const priceHistory = useMemo(() => prices.slice(-HISTORY_WINDOW), [prices]);

  const [multiplier, setMultiplier] = useState('2.5');
  const [martingaleAfterLosses, setMartingaleAfterLosses] = useState('0');
  const [initialAmount, setInitialAmount] = useState('1');
  const [targetProfit, setTargetProfit] = useState('5');
  const [stopLossLosses, setStopLossLosses] = useState('4');

  // --- Ra mode: which automated strategy the left panel runs. Ra's stake
  // fields are entirely separate from the Martingale bot's (multiplier,
  // martingaleAfterLosses, initialAmount above) — Ra never reads those.
  const [botMode, setBotMode] = useState<'martingale' | 'ra' | 'differ' | 'mm'>('martingale');
  const [raStreakCount, setRaStreakCount] = useState('5');
  const [raConfirmationStreak, setRaConfirmationStreak] = useState('5');
  const [raInitialStake, setRaInitialStake] = useState('1');
  const [raStakeMultiplier, setRaStakeMultiplier] = useState('2.5');
  const [raMartingaleAfterLosses, setRaMartingaleAfterLosses] = useState('0');
  const [raTradingMode, setRaTradingMode] = useState<RaTradingMode>('neutral');
  const [raTakeProfit, setRaTakeProfit] = useState('0');
  const [raStopLoss, setRaStopLoss] = useState('0');

  // --- Differ mode: fires Differs/Matches once a digit repeats N times in
  // a row. Entirely separate stake/martingale state from Martingale/Ra.
  const [differStreakLength, setDifferStreakLength] = useState('3');
  // 0 = consecutive (old behaviour). N = N ticks between each occurrence,
  // e.g. 1 -> 5,x,5,x,5.
  const [differPatternGap, setDifferPatternGap] = useState('0');
  const [differTradeType, setDifferTradeType] = useState<DifferTradeType>('differs');
  const [differInitialStake, setDifferInitialStake] = useState('1');
  const [differStakeMultiplier, setDifferStakeMultiplier] = useState('2.5');
  const [differMartingaleAfterLosses, setDifferMartingaleAfterLosses] = useState('0');
  const [differTakeProfit, setDifferTakeProfit] = useState('0');
  const [differStopLoss, setDifferStopLoss] = useState('0');

  // --- MM (Multi-market) mode: trades when a run of exactly N digits meeting
  // a condition (e.g. Over 5) ends on any market ticked in the Multi-market
  // panel. Own stake/martingale state, separate from every other mode.
  const [mmCondition, setMmCondition] = useState(conditionKey({ side: 'over', barrier: 5 }));
  const [mmWatchOpposite, setMmWatchOpposite] = useState(false);
  const [mmLength, setMmLength] = useState('3');
  const [mmMode, setMmMode] = useState<MmMode>('trend');
  const [mmCounterKind, setMmCounterKind] = useState<MmCounterKind>('under');
  const [mmCounterDigit, setMmCounterDigit] = useState('5');
  const [mmInitialStake, setMmInitialStake] = useState('1');
  const [mmStakeMultiplier, setMmStakeMultiplier] = useState('2.5');
  const [mmMartingaleAfterLosses, setMmMartingaleAfterLosses] = useState('0');
  const [mmTakeProfit, setMmTakeProfit] = useState('0');
  const [mmStopLoss, setMmStopLoss] = useState('0');
  const [mmMaxStake, setMmMaxStake] = useState('0');
  const [mmCooldown, setMmCooldown] = useState('0');
  const [mmStayOnMarket, setMmStayOnMarket] = useState(true);
  const [mmRecoveryMode, setMmRecoveryMode] = useState<MmRecoveryMode>('continuous');
  const [mmRecoveryTarget, setMmRecoveryTarget] = useState('2');
  const [mmRecoveryTrigger, setMmRecoveryTrigger] = useState<MmTargetTrigger>('loss');

  // Apply a (possibly partial) set of saved settings to the panel. Shared by
  // the on-mount reload, and loading a named preset.
  const applySettings = (saved: Partial<SavedRobotSettings>) => {
    if (typeof saved.multiplier === 'string') setMultiplier(saved.multiplier);
    if (typeof saved.martingaleAfterLosses === 'string') setMartingaleAfterLosses(saved.martingaleAfterLosses);
    if (typeof saved.initialAmount === 'string') setInitialAmount(saved.initialAmount);
    if (typeof saved.targetProfit === 'string') setTargetProfit(saved.targetProfit);
    if (typeof saved.stopLossLosses === 'string') setStopLossLosses(saved.stopLossLosses);
    if (typeof saved.duration === 'number') setDuration(saved.duration);
    if (typeof saved.raStreakCount === 'string') setRaStreakCount(saved.raStreakCount);
    if (typeof saved.raConfirmationStreak === 'string') setRaConfirmationStreak(saved.raConfirmationStreak);
    if (typeof saved.raInitialStake === 'string') setRaInitialStake(saved.raInitialStake);
    if (typeof saved.raStakeMultiplier === 'string') setRaStakeMultiplier(saved.raStakeMultiplier);
    if (typeof saved.raMartingaleAfterLosses === 'string') setRaMartingaleAfterLosses(saved.raMartingaleAfterLosses);
    if (typeof saved.raTradingMode === 'string') setRaTradingMode(saved.raTradingMode);
    if (typeof saved.raTakeProfit === 'string') setRaTakeProfit(saved.raTakeProfit);
    if (typeof saved.raStopLoss === 'string') setRaStopLoss(saved.raStopLoss);
    if (typeof saved.differStreakLength === 'string') setDifferStreakLength(saved.differStreakLength);
    if (typeof saved.differPatternGap === 'string') setDifferPatternGap(saved.differPatternGap);
    if (typeof saved.differTradeType === 'string') setDifferTradeType(saved.differTradeType);
    if (typeof saved.differInitialStake === 'string') setDifferInitialStake(saved.differInitialStake);
    if (typeof saved.differStakeMultiplier === 'string') setDifferStakeMultiplier(saved.differStakeMultiplier);
    if (typeof saved.differMartingaleAfterLosses === 'string')
      setDifferMartingaleAfterLosses(saved.differMartingaleAfterLosses);
    if (typeof saved.differTakeProfit === 'string') setDifferTakeProfit(saved.differTakeProfit);
    if (typeof saved.differStopLoss === 'string') setDifferStopLoss(saved.differStopLoss);
    if (
      typeof saved.mmCondition === 'string' &&
      SEQUENCE_CONDITIONS.some((c) => conditionKey(c) === saved.mmCondition)
    )
      setMmCondition(saved.mmCondition);
    if (typeof saved.mmLength === 'string') setMmLength(saved.mmLength);
    if (typeof saved.mmWatchOpposite === 'boolean') setMmWatchOpposite(saved.mmWatchOpposite);
    if (saved.mmMode === 'trend' || saved.mmMode === 'counter') setMmMode(saved.mmMode);
    if (typeof saved.mmCounterKind === 'string') setMmCounterKind(saved.mmCounterKind);
    if (typeof saved.mmCounterDigit === 'string') setMmCounterDigit(saved.mmCounterDigit);
    if (typeof saved.mmInitialStake === 'string') setMmInitialStake(saved.mmInitialStake);
    if (typeof saved.mmStakeMultiplier === 'string') setMmStakeMultiplier(saved.mmStakeMultiplier);
    if (typeof saved.mmMartingaleAfterLosses === 'string')
      setMmMartingaleAfterLosses(saved.mmMartingaleAfterLosses);
    if (typeof saved.mmTakeProfit === 'string') setMmTakeProfit(saved.mmTakeProfit);
    if (typeof saved.mmStopLoss === 'string') setMmStopLoss(saved.mmStopLoss);
    if (typeof saved.mmMaxStake === 'string') setMmMaxStake(saved.mmMaxStake);
    if (typeof saved.mmCooldown === 'string') setMmCooldown(saved.mmCooldown);
    if (typeof saved.mmStayOnMarket === 'boolean') setMmStayOnMarket(saved.mmStayOnMarket);
    if (
      saved.mmRecoveryMode === 'burst' ||
      saved.mmRecoveryMode === 'continuous' ||
      saved.mmRecoveryMode === 'target'
    )
      setMmRecoveryMode(saved.mmRecoveryMode);
    if (typeof saved.mmRecoveryTarget === 'string') setMmRecoveryTarget(saved.mmRecoveryTarget);
    if (saved.mmRecoveryTrigger === 'loss' || saved.mmRecoveryTrigger === 'always')
      setMmRecoveryTrigger(saved.mmRecoveryTrigger);
  };

  // Load any saved robot settings once on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ROBOT_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      applySettings(JSON.parse(raw) as Partial<SavedRobotSettings>);
    } catch {
      // Ignore malformed/unavailable storage — fields just keep their defaults.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snapshot of every robot setting as it is right now.
  const collectSettings = (): SavedRobotSettings => ({
    multiplier,
    martingaleAfterLosses,
    initialAmount,
    targetProfit,
    stopLossLosses,
    duration,
    raStreakCount,
    raConfirmationStreak,
    raInitialStake,
    raStakeMultiplier,
    raMartingaleAfterLosses,
    raTradingMode,
    raTakeProfit,
    raStopLoss,
    differStreakLength,
    differPatternGap,
    differTradeType,
    differInitialStake,
    differStakeMultiplier,
    differMartingaleAfterLosses,
    differTakeProfit,
    differStopLoss,
    mmCondition,
    mmWatchOpposite,
    mmLength,
    mmMode,
    mmCounterKind,
    mmCounterDigit,
    mmInitialStake,
    mmStakeMultiplier,
    mmMartingaleAfterLosses,
    mmTakeProfit,
    mmStopLoss,
    mmMaxStake,
    mmCooldown,
    mmStayOnMarket,
    mmRecoveryMode,
    mmRecoveryTarget,
    mmRecoveryTrigger,
  });

  const handleSaveSettings = () => {
    try {
      window.localStorage.setItem(ROBOT_SETTINGS_STORAGE_KEY, JSON.stringify(collectSettings()));
      toast.success(localize('Settings saved'));
    } catch {
      toast.error(localize('Could not save settings on this device.'));
    }
  };

  const overallStats = useMemo(
    () => computeDigitStats(priceHistory, pipSize),
    [priceHistory, pipSize]
  );
  const last25 = useMemo(
    () => computeDigitStats(priceHistory.slice(-25), pipSize),
    [priceHistory, pipSize]
  );
  const last50 = useMemo(
    () => computeDigitStats(priceHistory.slice(-50), pipSize),
    [priceHistory, pipSize]
  );
  const last100 = useMemo(
    () => computeDigitStats(priceHistory.slice(-100), pipSize),
    [priceHistory, pipSize]
  );
  const recentDigits = useMemo(
    () => priceHistory.slice(-RECENT_DIGITS_SHOWN).map((p) => getLastDigit(p, pipSize)),
    [priceHistory, pipSize]
  );
  const lastDigit = useMemo(
    () => (currentTick ? getLastDigit(currentTick.quote, pipSize) : null),
    [currentTick, pipSize]
  );

  const bot = useAutoBot({
    pipSize,
    setStake,
    proposal,
    isProposalLoading,
    buyContract,
    buyResult,
    buyError,
    clearBuyResult,
    openPositions,
    balance,
  });

  const raBot = useRaBot({
    currentTick,
    pipSize,
    setStake,
    setContractMode,
    setSelectedDigit,
    proposal,
    isProposalLoading,
    buyContract,
    buyResult,
    buyError,
    clearBuyResult,
    openPositions,
    balance,
  });

  const differBot = useDifferBot({
    currentTick,
    pipSize,
    setStake,
    setContractMode,
    setSelectedDigit,
    proposal,
    isProposalLoading,
    buyContract,
    buyResult,
    buyError,
    clearBuyResult,
    openPositions,
    balance,
  });

  const mmBot = useMmBot({
    activeSymbolCode: activeSymbol?.underlying_symbol ?? null,
    selectSymbol,
    setStake,
    setContractMode,
    setSelectedDigit,
    proposal,
    isProposalLoading,
    buyContract,
    buyResult,
    buyError,
    clearBuyResult,
    openPositions,
    balance,
  });

  // The Multi-market panel and the MM bot share one scanner (and one market
  // list — the panel's filter), so what the chart shows is exactly what the
  // bot counts. Streams stay open only while the panel is visible or the bot
  // is running.
  const seqPanel = useSequencePanelSettings(symbols);
  const seqScanner = useSequenceScanner({
    ws,
    isConnected,
    symbols,
    symbolCodes: seqPanel.activeCodes,
    enabled: (activeTab === 'digits' && digitsView === 'multi') || mmBot.running,
    onTick: mmBot.handleTick,
  });
  const mmWatch = useMemo(
    () =>
      mmBot.running
        ? { condition: parseConditionKey(mmCondition), length: parseInt(mmLength, 10) || 3 }
        : null,
    // The bot's config is frozen at Start, but the inputs are disabled while
    // it runs, so reading them live is equivalent and keeps this memo simple.
    [mmBot.running, mmCondition, mmLength]
  );

  // Whichever strategy is currently selected — used to gate Manual mode and
  // to decide what the Start/Stop button and header status line show.
  const activeBotRunning =
    botMode === 'ra'
      ? raBot.running
      : botMode === 'differ'
        ? differBot.running
        : botMode === 'mm'
          ? mmBot.running
          : bot.running;
  const activePnl =
    botMode === 'ra'
      ? raBot.pnl
      : botMode === 'differ'
        ? differBot.pnl
        : botMode === 'mm'
          ? mmBot.pnl
          : bot.pnl;

  // Celebration modal — opens the moment the bot's phase flips to
  // `stopped-target`, independent of that phase so the user can dismiss it
  // (and start a new run) without the phase itself changing.
  const [victoryOpen, setVictoryOpen] = useState(false);
  useEffect(() => {
    if (bot.phase === 'stopped-target') {
      setVictoryOpen(true);
    }
  }, [bot.phase]);

  // Same pattern as the victory modal above, but for the stop-loss phase.
  const [defeatOpen, setDefeatOpen] = useState(false);
  useEffect(() => {
    if (bot.phase === 'stopped-loss') {
      setDefeatOpen(true);
    }
  }, [bot.phase]);

  const handleRaStart = () => {
    if (raBot.running) {
      raBot.stop('manual');
      toast.info(localize('Robot stopped'));
      return;
    }
    const streakCount = parseInt(raStreakCount, 10);
    const confirmationStreak = parseInt(raConfirmationStreak, 10);
    if (!streakCount || streakCount < 2 || streakCount > 20) {
      toast.error(localize('Enter a valid Streak Count (2-20) first.'));
      return;
    }
    if (!confirmationStreak || confirmationStreak < 2 || confirmationStreak > 20) {
      toast.error(localize('Enter a valid Confirmation Streak (2-20) first.'));
      return;
    }
    const raStake = parseFloat(raInitialStake);
    if (!raStake || raStake <= 0) {
      toast.error(localize('Enter a valid Ra stake first.'));
      return;
    }
    raBot.start({
      streakCount,
      confirmationStreak,
      initialStake: raStake,
      stakeMultiplier: parseFloat(raStakeMultiplier) || 1,
      martingaleStartAfter: Math.max(0, parseInt(raMartingaleAfterLosses, 10) || 0),
      tradingMode: raTradingMode,
      takeProfit: parseFloat(raTakeProfit) || 0,
      stopLoss: parseFloat(raStopLoss) || 0,
    });
    toast.info(localize('Robot started'), {
      description:
        raTradingMode === 'neutral'
          ? localize('Watching for arm/confirm streaks — pick Trend or Counter to actually trade.')
          : localize('Watching for arm/confirm streaks on the digit stream.'),
    });
  };

  const handleDifferStart = () => {
    if (differBot.running) {
      differBot.stop('manual');
      toast.info(localize('Robot stopped'));
      return;
    }
    const streakLength = parseInt(differStreakLength, 10);
    if (!streakLength || streakLength < 2 || streakLength > 9) {
      toast.error(localize('Enter a valid Streak Length (2-9) first.'));
      return;
    }
    const patternGap = parseInt(differPatternGap, 10);
    if (isNaN(patternGap) || patternGap < 0 || patternGap > 9) {
      toast.error(localize('Enter a valid gap (0-9) first.'));
      return;
    }
    const differStake = parseFloat(differInitialStake);
    if (!differStake || differStake <= 0) {
      toast.error(localize('Enter a valid Differ stake first.'));
      return;
    }
    differBot.start({
      streakLength,
      patternGap,
      tradeType: differTradeType,
      initialStake: differStake,
      stakeMultiplier: parseFloat(differStakeMultiplier) || 1,
      martingaleStartAfter: Math.max(0, parseInt(differMartingaleAfterLosses, 10) || 0),
      takeProfit: parseFloat(differTakeProfit) || 0,
      stopLoss: parseFloat(differStopLoss) || 0,
    });
    toast.info(localize('Robot started'), {
      description: localize('Watching the digit stream for a repeating digit.'),
    });
  };

  const handleMmStart = () => {
    if (mmBot.running) {
      mmBot.stop('manual');
      toast.info(localize('Robot stopped'));
      return;
    }
    const sequenceLength = parseInt(mmLength, 10);
    if (!sequenceLength || sequenceLength < 2 || sequenceLength > 10) {
      toast.error(localize('Enter a valid sequence length (2-10) first.'));
      return;
    }
    const stake = parseFloat(mmInitialStake);
    if (!stake || stake <= 0) {
      toast.error(localize('Enter a valid MM stake first.'));
      return;
    }
    if (seqPanel.activeCodes.length === 0) {
      toast.error(localize('Pick at least one market in the Multi-market panel first.'));
      return;
    }
    const counterDigit = parseInt(mmCounterDigit, 10);
    if (mmMode === 'counter' && counterDigitRange(mmCounterKind).length > 0) {
      if (!counterDigitRange(mmCounterKind).includes(counterDigit)) {
        toast.error(localize('Pick a valid digit for the Counter trade first.'));
        return;
      }
    }
    if (mmStayOnMarket && mmRecoveryMode === 'target' && !(parseFloat(mmRecoveryTarget) > 0)) {
      toast.error(localize('Enter a profit target above 0 for the Target recovery.'));
      return;
    }
    mmBot.start({
      condition: parseConditionKey(mmCondition),
      watchOpposite: mmWatchOpposite,
      sequenceLength,
      mode: mmMode,
      counterTrade: { kind: mmCounterKind, digit: isNaN(counterDigit) ? 0 : counterDigit },
      initialStake: stake,
      stakeMultiplier: parseFloat(mmStakeMultiplier) || 1,
      martingaleStartAfter: Math.max(0, parseInt(mmMartingaleAfterLosses, 10) || 0),
      takeProfit: parseFloat(mmTakeProfit) || 0,
      stopLoss: parseFloat(mmStopLoss) || 0,
      maxStake: parseFloat(mmMaxStake) || 0,
      cooldownTicks: Math.max(0, parseInt(mmCooldown, 10) || 0),
      stayOnMarket: mmStayOnMarket,
      recoveryMode: mmRecoveryMode,
      recoveryTarget: parseFloat(mmRecoveryTarget) || 0,
      recoveryTrigger: mmRecoveryTrigger,
    });
    toast.info(localize('Robot started'), {
      description: localize('Watching the Multi-market panel for the chosen run length.'),
    });
  };

  const handleStart = () => {
    if (botMode === 'mm') {
      handleMmStart();
      return;
    }
    if (botMode === 'ra') {
      handleRaStart();
      return;
    }
    if (botMode === 'differ') {
      handleDifferStart();
      return;
    }
    if (bot.running) {
      bot.stop();
      toast.info(localize('Robot stopped'));
      return;
    }
    const initial = parseFloat(initialAmount);
    if (!initial || initial <= 0) {
      toast.error(localize('Enter a valid initial stake first.'));
      return;
    }
    const mult = parseFloat(multiplier) || 1;
    const martingaleStartAfter = Math.max(0, parseInt(martingaleAfterLosses, 10) || 0);
    const target = parseFloat(targetProfit);
    const lossCount = parseInt(stopLossLosses, 10);
    if (!lossCount || lossCount <= 0) {
      toast.error(localize('Enter a valid number of losses first.'));
      return;
    }
    bot.start({
      initialStake: initial,
      multiplier: mult,
      martingaleStartAfter,
      targetProfit: target > 0 ? target : Infinity,
      stopLossLossCount: lossCount,
      stopLossAmount: Infinity,
    });
    toast.info(localize('Robot started'), {
      description:
        martingaleStartAfter > 0
          ? localize('Trading at the initial stake until a loss streak triggers the martingale.')
          : localize('Placing trades using the settings on the left.'),
    });
  };

  return (
    <>
    <VictoryDialog
      open={victoryOpen}
      onOpenChange={setVictoryOpen}
      onContinue={() => setVictoryOpen(false)}
    />
    <DefeatDialog
      open={defeatOpen}
      onOpenChange={setDefeatOpen}
      onContinue={() => setDefeatOpen(false)}
    />
    <div className="w-full max-w-[1760px] mx-auto px-3 py-4 sm:px-4 flex flex-col lg:flex-row gap-4">
      {/* Left: Automated Robot settings. Collapsible — expanded by default,
          and mutually exclusive with the Manual panel on the far right.
          Sticky with its own scroll area on desktop so it can be scrolled
          independently of the page. */}
      <CollapsibleSidePanel
        isMobile={isMobile}
        isOpen={isAutomatedOpen}
        onExpand={() => setOpenSide('automated')}
        openWidth={AUTOMATED_OPEN_WIDTH}
        arrowSide="right"
        arrowIcon={ChevronRight}
        ariaLabel={localize('Expand automated robot panel')}
      >
      <Card
        className={`panel-glow bg-card/60 backdrop-blur-md flex flex-col lg:sticky lg:top-[88px] lg:max-h-[calc(100dvh-124px)] overflow-visible ${settingsPanel.className}`}
        style={settingsPanel.style}
        onMouseEnter={settingsPanel.onMouseEnter}
        onMouseLeave={settingsPanel.onMouseLeave}
        onFocus={settingsPanel.onFocus}
        onBlur={settingsPanel.onBlur}
      >
        <div aria-hidden className={settingsPanel.overlayClassName} />
        <CardHeader className="pb-3 shrink-0 lg:rounded-t-[inherit]">
          <CardTitle className="text-base">
            <Localize i18n_default_text="Robot settings" />
          </CardTitle>
          <p className="text-xs font-semibold text-foreground/90">
            {isConnected ? (
              balanceLabel ? (
                balanceLabel
              ) : (
                <Localize i18n_default_text="Connected" />
              )
            ) : (
              <Localize i18n_default_text="Not connected" />
            )}
          </p>
          <div className="flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5 mt-1">
            <span className={cn('text-xs font-bold pr-2 min-w-0', activeBotRunning ? 'text-emerald-400' : 'text-foreground/85')}>
              {botMode === 'ra'
                ? getRaStatusLabel(
                    raBot.phase,
                    raBot.armedSide,
                    raBot.confirmProgress,
                    raConfirmationStreak,
                    localize,
                    raBot.burstActive,
                    raBot.burstPnl
                  )
                : botMode === 'mm'
                  ? getMmStatusLabel(
                      mmBot.phase,
                      mmBot.currentTrade,
                      seqPanel.activeCodes.length,
                      mmBot.lockedSymbol,
                      localize
                    )
                : botMode === 'differ'
                  ? getDifferStatusLabel(
                      differBot.phase,
                      differBot.streakDigit,
                      differBot.streakProgress,
                      differStreakLength,
                      localize,
                      differBot.burstActive,
                      differBot.burstPnl
                    )
                  : getBotStatusLabel(bot.phase, localize)}
            </span>
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'text-sm font-mono font-bold tabular-nums',
                  activePnl >= 0
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                )}
              >
                {activePnl >= 0 ? '+' : ''}
                {activePnl.toFixed(2)}
              </span>
              {botMode === 'martingale' && (
                <button
                  type="button"
                  onClick={bot.resetPnl}
                  title={localize('Reset profit/loss to 0')}
                  className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors"
                >
                  <Localize i18n_default_text="Reset" />
                </button>
              )}
            </div>
          </div>
          {botMode === 'ra' && !raBot.running && getRaStoppedLabel(raBot.stoppedReason, localize) && (
            <p className="text-[11px] text-muted-foreground px-0.5">
              {getRaStoppedLabel(raBot.stoppedReason, localize)}
            </p>
          )}
          {botMode === 'ra' &&
            raBot.running &&
            !raBot.burstActive &&
            getRaLastBurstLabel(raBot.lastBurstOutcome, localize) && (
              <p className="text-[11px] text-muted-foreground px-0.5">
                {getRaLastBurstLabel(raBot.lastBurstOutcome, localize)}
              </p>
            )}
          {botMode === 'mm' && !mmBot.running && getMmStoppedLabel(mmBot.stoppedReason, localize) && (
            <p className="text-[11px] text-muted-foreground px-0.5">
              {getMmStoppedLabel(mmBot.stoppedReason, localize)}
            </p>
          )}
          {botMode === 'differ' && !differBot.running && getDifferStoppedLabel(differBot.stoppedReason, localize) && (
            <p className="text-[11px] text-muted-foreground px-0.5">
              {getDifferStoppedLabel(differBot.stoppedReason, localize)}
            </p>
          )}
          {botMode === 'differ' &&
            differBot.running &&
            !differBot.burstActive &&
            getDifferLastBurstLabel(differBot.lastBurstOutcome, localize) && (
              <p className="text-[11px] text-muted-foreground px-0.5">
                {getDifferLastBurstLabel(differBot.lastBurstOutcome, localize)}
              </p>
            )}
        </CardHeader>
        <CardContent className="space-y-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:rounded-b-[inherit]">
          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Bot Mode" />
            </Label>
            <ToggleGroup
              type="single"
              value={botMode}
              onValueChange={(v) => {
                if (v && !activeBotRunning) setBotMode(v as 'martingale' | 'ra' | 'differ' | 'mm');
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              <ToggleGroupItem
                value="martingale"
                disabled={activeBotRunning}
                className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground"
              >
                <Localize i18n_default_text="Martingale" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="ra"
                disabled={activeBotRunning}
                className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground"
              >
                <Localize i18n_default_text="Ra" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="differ"
                disabled={activeBotRunning}
                className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground"
              >
                <Localize i18n_default_text="Differ" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="mm"
                disabled={activeBotRunning}
                title={localize('Multi-market: trades when a run of an exact length ends on any watched market')}
                className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground"
              >
                <Localize i18n_default_text="MM" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <fieldset disabled={activeBotRunning} className="space-y-3 border-0 p-0 m-0 min-w-0">
          {botMode !== 'mm' ? (
          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Market" />
            </Label>
            <SymbolSelector
              symbols={symbols}
              activeSymbol={activeSymbol}
              onSymbolChange={selectSymbol}
            />
          </div>
          ) : (
          <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-2.5 py-2">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Markets" />
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {localize('Watching {{n}} markets from the Multi-market panel (Digits tab → filter button). Each trade goes to the market that signalled.', { n: seqPanel.activeCodes.length })}
            </p>
          </div>
          )}

          {botMode === 'martingale' && (
          <>
          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Trade Type" />
            </Label>
            <Select value={tradeType} onValueChange={(v) => setTradeType(v as TradeType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {digitTradeTypeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Trade Function" />
            </Label>
            <ToggleGroup
              type="single"
              value={contractMode}
              onValueChange={(value) => {
                if (value) setContractMode(value as ContractMode);
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              {contractModeOptions.map((opt) => (
                <ToggleGroupItem
                  key={opt.value}
                  value={opt.value}
                  className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground"
                >
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {tradeType !== 'even-odd' && (
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Prediction" />
              </Label>
              <Select
                value={String(selectedDigit)}
                onValueChange={(v) => setSelectedDigit(parseInt(v, 10))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 10 }, (_, d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Duration" />
              </Label>
              <Input
                type="number"
                value={duration}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) setDuration(val);
                }}
                min={durationLimits.min}
                max={durationLimits.max}
                labelRight={localize('Ticks')}
              />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Multiplier" />
              </Label>
              <Input value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label
              className="text-xs font-semibold text-foreground/90"
              title={localize(
                'Stays at the initial stake for this many losses before the multiplier kicks in. 0 = multiply from the first loss.'
              )}
            >
              <Localize i18n_default_text="Martingale after N losses" />
            </Label>
            <Input
              value={martingaleAfterLosses}
              onChange={(e) => setMartingaleAfterLosses(e.target.value)}
            />
          </div>

          <div className="border-t border-border pt-2 grid grid-cols-3 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Initial" />
              </Label>
              <Input value={initialAmount} onChange={(e) => setInitialAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Target profit" />
              </Label>
              <Input value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('Stop after this many losses in a row')}
              >
                <Localize i18n_default_text="Stop loss" />
              </Label>
              <Input
                type="number"
                min={1}
                value={stopLossLosses}
                onChange={(e) => setStopLossLosses(e.target.value)}
                labelRight={localize('losses')}
              />
            </div>
          </div>
          </>
          )}

          {botMode === 'ra' && (
          <>
          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Duration" />
            </Label>
            <Input
              type="number"
              value={duration}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setDuration(val);
              }}
              min={durationLimits.min}
              max={durationLimits.max}
              labelRight={localize('Ticks')}
            />
          </div>

                    <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake" />
              </Label>
              <Input value={raInitialStake} onChange={(e) => setRaInitialStake(e.target.value)} />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake Multiplier" />
              </Label>
              <Input value={raStakeMultiplier} onChange={(e) => setRaStakeMultiplier(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label
              className="text-xs font-semibold text-foreground/90"
              title={localize(
                'Stays at the initial stake for this many losses before the multiplier kicks in. 0 = multiply from the first loss.'
              )}
            >
              <Localize i18n_default_text="Start Martingale after N losses" />
            </Label>
            <Input
              value={raMartingaleAfterLosses}
              onChange={(e) => setRaMartingaleAfterLosses(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('N consecutive same-side digits (over4 / under5) required to arm a run before confirmation starts.')}
              >
                <Localize i18n_default_text="Streak Count" />
              </Label>
              <Input
                type="number"
                min={2}
                max={20}
                value={raStreakCount}
                onChange={(e) => setRaStreakCount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('M more consecutive same-side digits, uninterrupted, required after arming before the trade fires.')}
              >
                <Localize i18n_default_text="Confirmation Streak" />
              </Label>
              <Input
                type="number"
                min={2}
                max={20}
                value={raConfirmationStreak}
                onChange={(e) => setRaConfirmationStreak(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Trading Mode" />
            </Label>
            <ToggleGroup
              type="single"
              value={raTradingMode}
              onValueChange={(v) => {
                if (v) setRaTradingMode(v as RaTradingMode);
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              <ToggleGroupItem value="trend" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Trend" />
              </ToggleGroupItem>
              <ToggleGroupItem value="neutral" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Neutral" />
              </ToggleGroupItem>
              <ToggleGroupItem value="counter" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Counter" />
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">
              {raTradingMode === 'trend' && (
                <Localize i18n_default_text="Confirmed over4 → Superior 3, confirmed under5 → Inferior 6." />
              )}
              {raTradingMode === 'neutral' && (
                <Localize i18n_default_text="Won't trade until you pick Trend or Counter." />
              )}
              {raTradingMode === 'counter' && (
                <Localize i18n_default_text="Confirmed over4 → Inferior 6, confirmed under5 → Superior 3." />
              )}
            </p>
          </div>

          <div className="border-t border-border pt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Once total profit across the whole run reaches this amount, Ra stops. 0 = off.'
                )}
              >
                <Localize i18n_default_text="Take Profit" />
              </Label>
              <Input
                value={raTakeProfit}
                onChange={(e) => setRaTakeProfit(e.target.value)}
                labelRight="USD"
              />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Once total loss across the whole run reaches this amount, Ra stops. 0 = off.'
                )}
              >
                <Localize i18n_default_text="Stop Loss" />
              </Label>
              <Input
                value={raStopLoss}
                onChange={(e) => setRaStopLoss(e.target.value)}
                labelRight="USD"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground px-0.5 -mt-1">
            <Localize i18n_default_text="Each signal opens a run that trades continuously (same side, Ra's own martingale on losses) until it wins, then Ra waits for the next signal. Take Profit and Stop Loss track total profit/loss across every run and stop Ra outright once hit." />
          </p>

          {(raBot.running || raBot.digitRecord.length > 0) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Digit Record" />
                </Label>
                {raBot.armedSide && (
                  <span className="text-[11px] font-semibold text-foreground/80">
                    {raSideLabel(raBot.armedSide, localize)} {localize('ARMED')} · {raBot.confirmProgress}/
                    {raConfirmationStreak}
                  </span>
                )}
              </div>
              <RaDigitRecord digits={raBot.digitRecord} />
            </div>
          )}
          </>
          )}

          {botMode === 'differ' && (
          <>
          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Duration" />
            </Label>
            <Input
              type="number"
              value={duration}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setDuration(val);
              }}
              min={durationLimits.min}
              max={durationLimits.max}
              labelRight={localize('Ticks')}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('How many times a digit must occur before Differ fires. 2-9.')}
              >
                <Localize i18n_default_text="Occurrences (N)" />
              </Label>
              <Input
                type="number"
                min={2}
                max={9}
                value={differStreakLength}
                onChange={(e) => setDifferStreakLength(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Ticks between each occurrence of N. 0 = back-to-back (5,5,5). 1 = every other tick (5,x,5,x,5). 2 = every third tick, and so on.'
                )}
              >
                <Localize i18n_default_text="Gap" />
              </Label>
              <Input
                type="number"
                min={0}
                max={9}
                value={differPatternGap}
                onChange={(e) => setDifferPatternGap(e.target.value)}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground px-1.5">
            {parseInt(differPatternGap, 10) > 0 ? (
              <Localize i18n_default_text="Fires once a digit shows up N times with this many ticks between each — e.g. gap 1: 5,x,5,x,5." />
            ) : (
              <Localize i18n_default_text="Fires once a digit repeats N times back-to-back." />
            )}
          </p>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Trade" />
            </Label>
            <ToggleGroup
              type="single"
              value={differTradeType}
              onValueChange={(v) => {
                if (v) setDifferTradeType(v as DifferTradeType);
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              <ToggleGroupItem value="differs" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Differs" />
              </ToggleGroupItem>
              <ToggleGroupItem value="matches" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Matches" />
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">
              {differTradeType === 'differs' ? (
                <Localize i18n_default_text="Once the digit repeats N times, bets it won't show that digit again." />
              ) : (
                <Localize i18n_default_text="Once the digit repeats N times, bets it will show that digit again." />
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake" />
              </Label>
              <Input value={differInitialStake} onChange={(e) => setDifferInitialStake(e.target.value)} />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake Multiplier" />
              </Label>
              <Input value={differStakeMultiplier} onChange={(e) => setDifferStakeMultiplier(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label
              className="text-xs font-semibold text-foreground/90"
              title={localize(
                'Stays at the initial stake for this many losses before the multiplier kicks in. 0 = multiply from the first loss.'
              )}
            >
              <Localize i18n_default_text="Start Martingale after N losses" />
            </Label>
            <Input
              value={differMartingaleAfterLosses}
              onChange={(e) => setDifferMartingaleAfterLosses(e.target.value)}
            />
          </div>

          <div className="border-t border-border pt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Once total profit across the whole run reaches this amount, Differ stops. 0 = off.'
                )}
              >
                <Localize i18n_default_text="Take Profit" />
              </Label>
              <Input
                value={differTakeProfit}
                onChange={(e) => setDifferTakeProfit(e.target.value)}
                labelRight="USD"
              />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Once total loss across the whole run reaches this amount, Differ stops. 0 = off.'
                )}
              >
                <Localize i18n_default_text="Stop Loss" />
              </Label>
              <Input
                value={differStopLoss}
                onChange={(e) => setDifferStopLoss(e.target.value)}
                labelRight="USD"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground px-0.5 -mt-1">
            <Localize i18n_default_text="Each repeated digit opens a run and trades that digit. A loss benches it and Differ waits for a different repeat instead of retrying the same one, still escalating the martingale stake — until a win on any digit clears the bench and the run ends. Take Profit and Stop Loss track total profit/loss across every run and stop Differ outright once hit." />
          </p>

          {(differBot.running || differBot.digitRecord.length > 0) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Digit Record" />
                </Label>
                {differBot.streakDigit !== null && differBot.streakProgress > 0 && (
                  <span className="text-[11px] font-semibold text-foreground/80">
                    {localize('Digit')} {differBot.streakDigit} · {differBot.streakProgress}/
                    {differStreakLength}
                  </span>
                )}
              </div>
              {differBot.bannedDigits.length > 0 && (
                <p className="text-[11px] text-muted-foreground px-0.5">
                  <Localize i18n_default_text="Benched (ignored until a different digit wins):" />{' '}
                  <span className="font-semibold text-foreground/80">
                    {differBot.bannedDigits.join(', ')}
                  </span>
                </p>
              )}
              <DifferDigitRecord
                digits={differBot.digitRecord}
                streakDigit={differBot.streakDigit}
                streakProgress={differBot.streakProgress}
                gap={parseInt(differPatternGap, 10) || 0}
                bannedDigits={differBot.bannedDigits}
              />
            </div>
          )}
          </>
          )}
          {botMode === 'mm' && (
          <>
          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Duration" />
            </Label>
            <Input
              type="number"
              value={duration}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setDuration(val);
              }}
              min={durationLimits.min}
              max={durationLimits.max}
              labelRight={localize('Ticks')}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('The digit condition whose runs are counted, e.g. Over 5 = last digit 6, 7, 8 or 9.')}
              >
                <Localize i18n_default_text="Watch digit" />
              </Label>
              <Select value={mmCondition} onValueChange={setMmCondition}>
                <SelectTrigger>
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
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('Fires when a run ends after exactly this many ticks. Shorter or longer runs are ignored. 2-10.')}
              >
                <Localize i18n_default_text="Exact length" />
              </Label>
              <Select value={mmLength} onValueChange={setMmLength}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2 px-1.5">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 accent-primary"
              checked={mmWatchOpposite}
              onChange={(e) => setMmWatchOpposite(e.target.checked)}
            />
            <span className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Watch the opposite too" />
              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                {mmWatchOpposite
                  ? localize('On: also watches {{opp}} (the mirror of {{label}}, digits d → 9-d) and trades the mirrored contract on its signals.', {
                      opp: conditionLabel(oppositeCondition(parseConditionKey(mmCondition))),
                      label: conditionLabel(parseConditionKey(mmCondition)),
                    })
                  : localize('Off: only the watched digit above can signal.')}
              </span>
            </span>
          </label>
          <p className="text-[11px] text-muted-foreground px-1.5">
            {mmWatchOpposite
              ? localize(
                  'Fires when a run of {{label}} or {{opp}} ends after exactly {{n}} ticks on any watched market.',
                  {
                    label: conditionLabel(parseConditionKey(mmCondition)),
                    opp: conditionLabel(oppositeCondition(parseConditionKey(mmCondition))),
                    n: mmLength,
                  }
                )
              : localize(
                  'Fires when a run of {{label}} ends after exactly {{n}} ticks on any watched market — i.e. that length\'s bar in the chart goes up by one.',
                  { label: conditionLabel(parseConditionKey(mmCondition)), n: mmLength }
                )}
          </p>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Mode" />
            </Label>
            <ToggleGroup
              type="single"
              value={mmMode}
              onValueChange={(v) => {
                if (v) setMmMode(v as MmMode);
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              <ToggleGroupItem value="trend" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Trend" />
              </ToggleGroupItem>
              <ToggleGroupItem value="counter" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Counter" />
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">
              {mmMode === 'trend'
                ? localize('Trend trades the watched digit itself: {{label}}, on the market that signalled.', {
                    label: conditionLabel(parseConditionKey(mmCondition)),
                  })
                : mmWatchOpposite
                  ? localize('Counter trades the contract you choose below on the watched digit\'s signal, and its mirror (Under 5 → Over 4, Even → Odd) on the opposite\'s signal.')
                  : localize('Counter trades exactly the contract you choose below, on the market that signalled.')}
            </p>
          </div>

          {mmMode === 'counter' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Counter trade" />
                </Label>
                <Select
                  value={mmCounterKind}
                  onValueChange={(v) => {
                    const kind = v as MmCounterKind;
                    setMmCounterKind(kind);
                    const range = counterDigitRange(kind);
                    if (range.length > 0 && !range.includes(parseInt(mmCounterDigit, 10))) {
                      setMmCounterDigit(String(range[Math.min(5, range.length - 1)]));
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="over">{localize('Over')}</SelectItem>
                    <SelectItem value="under">{localize('Under')}</SelectItem>
                    <SelectItem value="even">{localize('Even')}</SelectItem>
                    <SelectItem value="odd">{localize('Odd')}</SelectItem>
                    <SelectItem value="matches">{localize('Matches')}</SelectItem>
                    <SelectItem value="differs">{localize('Differs')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {counterDigitRange(mmCounterKind).length > 0 && (
                <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
                  <Label className="text-xs font-semibold text-foreground/90">
                    <Localize i18n_default_text="Digit" />
                  </Label>
                  <Select value={mmCounterDigit} onValueChange={setMmCounterDigit}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {counterDigitRange(mmCounterKind).map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake" />
              </Label>
              <Input value={mmInitialStake} onChange={(e) => setMmInitialStake(e.target.value)} />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake Multiplier" />
              </Label>
              <Input value={mmStakeMultiplier} onChange={(e) => setMmStakeMultiplier(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
            <Label
              className="text-xs font-semibold text-foreground/90"
              title={localize(
                'Stays at the initial stake for this many losses before the multiplier kicks in. 0 = multiply from the first loss.'
              )}
            >
              <Localize i18n_default_text="Start Martingale after N losses" />
            </Label>
            <Input
              value={mmMartingaleAfterLosses}
              onChange={(e) => setMmMartingaleAfterLosses(e.target.value)}
            />
          </div>

          <div className="border-t border-border pt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('Once total profit across the whole run reaches this amount, MM stops. 0 = off.')}
              >
                <Localize i18n_default_text="Take Profit" />
              </Label>
              <Input value={mmTakeProfit} onChange={(e) => setMmTakeProfit(e.target.value)} labelRight="USD" />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('Once total loss across the whole run reaches this amount, MM stops. 0 = off.')}
              >
                <Localize i18n_default_text="Stop Loss" />
              </Label>
              <Input value={mmStopLoss} onChange={(e) => setMmStopLoss(e.target.value)} labelRight="USD" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('MM stops instead of placing a stake above this. Caps how far the martingale can climb. 0 = off.')}
              >
                <Localize i18n_default_text="Max Stake" />
              </Label>
              <Input value={mmMaxStake} onChange={(e) => setMmMaxStake(e.target.value)} labelRight="USD" />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize('After MM trades a market, ignore its signals for this many of its ticks. 0 = off.')}
              >
                <Localize i18n_default_text="Market cooldown" />
              </Label>
              <Input value={mmCooldown} onChange={(e) => setMmCooldown(e.target.value)} labelRight={localize('ticks')} />
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2 px-0.5">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 accent-primary"
              checked={mmStayOnMarket}
              onChange={(e) => setMmStayOnMarket(e.target.checked)}
            />
            <span className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Stay on the same market after a loss" />
              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                {mmStayOnMarket
                  ? localize('On: after a loss, only that market can trade until a win; other markets\' signals are skipped.')
                  : localize('Off: after a loss, a signal from any watched market can take the next trade.')}
              </span>
            </span>
          </label>
          {mmStayOnMarket && (
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="After a loss" />
              </Label>
              <ToggleGroup
                type="single"
                value={mmRecoveryMode}
                onValueChange={(v) => {
                  if (v) setMmRecoveryMode(v as MmRecoveryMode);
                }}
                className="w-full gap-0 rounded-full bg-muted p-1"
              >
                <ToggleGroupItem value="burst" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                  <Localize i18n_default_text="Burst" />
                </ToggleGroupItem>
                <ToggleGroupItem value="continuous" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                  <Localize i18n_default_text="Continuous" />
                </ToggleGroupItem>
                <ToggleGroupItem value="target" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                  <Localize i18n_default_text="Target" />
                </ToggleGroupItem>
              </ToggleGroup>
              {mmRecoveryMode === 'target' && (
                <div className="space-y-1.5 pt-1">
                  <Label className="text-xs font-semibold text-foreground/90">
                    <Localize i18n_default_text="Re-fire" />
                  </Label>
                  <ToggleGroup
                    type="single"
                    value={mmRecoveryTrigger}
                    onValueChange={(v) => {
                      if (v) setMmRecoveryTrigger(v as MmTargetTrigger);
                    }}
                    className="w-full gap-0 rounded-full bg-muted p-1"
                  >
                    <ToggleGroupItem value="loss" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                      <Localize i18n_default_text="On loss" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="always" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                      <Localize i18n_default_text="Always" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Label
                    className="text-xs font-semibold text-foreground/90"
                    title={localize('Net profit to make on that market, counted from the loss that started the recovery, before MM goes back to watching all markets.')}
                  >
                    <Localize i18n_default_text="Profit target" />
                  </Label>
                  <Input value={mmRecoveryTarget} onChange={(e) => setMmRecoveryTarget(e.target.value)} labelRight="USD" />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                {mmRecoveryMode === 'burst'
                  ? localize('Burst: re-fires straight away on that market (martingale stake) until a win, then waits for a fresh signal.')
                  : mmRecoveryMode === 'target'
                    ? mmRecoveryTrigger === 'always'
                    ? localize('Target (always): every signal trade keeps re-firing on its market, wins included (base stake after a win), until the net profit since that first trade reaches the target, then waits for a fresh signal.')
                    : localize('Target (on loss): after a loss, keeps re-firing on that market, wins included (base stake after a win), until the net profit since that loss reaches the target, then waits for a fresh signal.')
                    : localize('Continuous: waits for the next fresh signal on that market before each martingale trade, until a win.')}
              </p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground px-0.5 -mt-1">
            <Localize i18n_default_text="One trade at a time: a signal that arrives while a trade is running is counted but skipped. A loss raises the stake per the martingale settings; a win returns to the base stake. Take Profit, Stop Loss and Max Stake stop MM outright." />
          </p>

          {(mmBot.running || mmBot.signalCount > 0) && (
            <div className="rounded-md bg-muted/40 px-2.5 py-2 text-[11px] space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground/90">
                  <Localize i18n_default_text="Signals" />
                </span>
                <span className="tabular-nums text-foreground/80">
                  {mmBot.signalCount} · {localize('skipped')} {mmBot.skippedCount}
                </span>
              </div>
              {mmBot.lastSignal && (
                <p className="text-muted-foreground">
                  {getSymbolDisplayName(mmBot.lastSignal.symbol)} · {localize('run of')} {mmBot.lastSignal.runLength} →{' '}
                  {mmBot.lastSignal.action === 'traded'
                    ? `${localize('traded')} ${mmBot.lastSignal.tradeLabel}`
                    : mmBot.lastSignal.action === 'busy'
                      ? localize('skipped (trade in progress)')
                      : mmBot.lastSignal.action === 'locked'
                        ? localize('skipped (recovering on another market)')
                        : localize('skipped (market cooldown)')}
                </p>
              )}
              {mmBot.lossStreak > 0 && (
                <p className="text-muted-foreground">
                  {localize('Current loss streak')}: {mmBot.lossStreak}
                  {mmBot.lockedSymbol && ` · ${localize('locked to')} ${getSymbolDisplayName(mmBot.lockedSymbol)}`}
                </p>
              )}
            </div>
          )}
          </>
          )}
          </fieldset>

          {botMode === 'mm' && (
            <MmTickRecord
              streams={seqScanner.streams}
              frozen={mmBot.frozenTape}
              running={mmBot.running}
              marks={mmBot.tradeMarks}
              watchedCodes={seqPanel.activeCodes}
              currentTradeSymbol={mmBot.currentTrade?.symbol ?? null}
              lastSignalSymbol={mmBot.lastSignal?.symbol ?? null}
            />
          )}

          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={handleSaveSettings}>
              <Localize i18n_default_text="Save settings" />
            </Button>
            <RobotPresets<SavedRobotSettings>
              botMode={botMode}
              collect={collectSettings}
              loadDisabled={activeBotRunning}
              onLoad={(preset: RobotPreset<SavedRobotSettings>) => {
                applySettings(preset.settings);
                setBotMode(preset.botMode);
                toast.success(localize('Preset loaded'), { description: preset.name });
              }}
            />
          </div>

          <Button
            className="w-full"
            size="lg"
            variant={activeBotRunning ? 'destructive' : 'default'}
            onClick={handleStart}
            disabled={!isConnected || !isAuthenticated}
          >
            {activeBotRunning ? <Localize i18n_default_text="Stop" /> : <Localize i18n_default_text="Start" />}
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            {isAuthenticated ? (
              <Localize i18n_default_text="Uses the same trading connection as Manual mode — only one can trade at a time." />
            ) : (
              <Localize i18n_default_text="Log in to run the robot." />
            )}
          </p>
        </CardContent>
      </Card>
      </CollapsibleSidePanel>

      {/* Center: Digit panel. Always visible, never collapses — it simply
          fills whichever space the two side panels leave it. Since the
          side panels animate their own width every frame (not via a
          discrete swap), the browser reflows this panel's size in lock
          step automatically — no extra animation needed here for it to
          read as being smoothly pushed left/right. */}
      <div className={isMobile ? 'w-full' : 'flex-1 min-w-0'}>
      <Card
        className={`panel-glow bg-card/60 backdrop-blur-md h-fit ${analysisPanel.className}`}
        style={analysisPanel.style}
        onMouseEnter={analysisPanel.onMouseEnter}
        onMouseLeave={analysisPanel.onMouseLeave}
        onFocus={analysisPanel.onFocus}
        onBlur={analysisPanel.onBlur}
      >
        <div aria-hidden className={analysisPanel.overlayClassName} />
        <CardHeader className="pb-0">
          <div className="flex items-center gap-5 border-b border-border">
            {(
              [
                ['chart', localize('Chart')],
                ['digits', localize('Digits')],
                ['trades', localize('Trades')],
                ['logs', localize('Logs')],
                ['alerts', localize('Alerts')],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'relative pb-2.5 text-sm font-bold border-b-2 -mb-px transition-colors',
                  activeTab === key
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-foreground/70 hover:text-foreground'
                )}
              >
                {label}
                {key === 'alerts' && breachingAlertCount > 0 && (
                  <span className="absolute -top-1 -right-3 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {breachingAlertCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-4 space-y-6">
          {activeTab === 'digits' && (
            <div className="flex items-center gap-5 border-b border-border -mt-1">
              {(
                [
                  ['single', localize('Single market')],
                  ['multi', localize('Multi-market')],
                ] as ['single' | 'multi', string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setDigitsView(key)}
                  className={cn(
                    'pb-2 text-xs font-bold uppercase tracking-wide border-b-2 -mb-px transition-colors',
                    digitsView === key
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-foreground/60 hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {activeTab === 'digits' && digitsView === 'multi' && (
            <MultiMarketSequences
              panel={seqPanel}
              streams={seqScanner.streams}
              botWatch={mmWatch}
              lastSignal={mmBot.lastSignal}
            />
          )}

          {activeTab === 'digits' && digitsView === 'single' && (
            <>
              <div className="space-y-2">
                <p className="text-center text-sm font-medium">
                  <Localize i18n_default_text="Digits frequency percentage" />
                </p>
                <DigitFrequencyRow
                  digitStats={overallStats}
                  selectedDigit={selectedDigit}
                  onSelect={setSelectedDigit}
                  lastDigit={lastDigit}
                />
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  <Localize i18n_default_text="Most recent digits" />
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recentDigits.length === 0 && (
                    <span className="text-xs font-semibold text-foreground/90">
                      <Localize i18n_default_text="Waiting for ticks…" />
                    </span>
                  )}
                  {recentDigits.map((d, i) => {
                    const isLast = i === recentDigits.length - 1;
                    return (
                      <span
                        key={i}
                        className={cn(
                          'w-7 h-7 flex items-center justify-center rounded-md text-sm font-bold transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]',
                          isLast
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground/85'
                        )}
                      >
                        {d}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DigitHistogram title={localize('Last 25 digits')} stats={last25} />
                <DigitHistogram title={localize('Last 50 digits')} stats={last50} />
                <DigitHistogram title={localize('Last 100 digits')} stats={last100} />
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  <Localize i18n_default_text="Recent ticks" />
                </p>
                <TickSparkline prices={priceHistory} />
              </div>
            </>
          )}

          {activeTab === 'chart' && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Localize i18n_default_text="A full price chart isn't wired into this view yet — the live spot and recent ticks are shown on the Digits tab." />
            </div>
          )}

          {activeTab === 'alerts' && (
            <div className="max-h-[420px] overflow-y-auto pr-1 -mr-1">
              <DigitAlertsPanel
                symbols={symbols}
                rules={digitAlerts.rules}
                addRule={digitAlerts.addRule}
                removeRule={digitAlerts.removeRule}
                toggleRule={digitAlerts.toggleRule}
                streams={digitAlerts.streams}
                firedLog={digitAlerts.firedLog}
                clearFiredLog={digitAlerts.clearFiredLog}
                lastFire={lastAlertFire}
              />
            </div>
          )}

          {activeTab === 'trades' && (
            <>
              {isAuthenticated ? (
                <PositionsTable
                  openPositions={openPositions.filter((p) => DIGIT_CONTRACT_TYPES.includes(p.contract_type))}
                  closedPositions={closedPositions.filter((p) => DIGIT_CONTRACT_TYPES.includes(p.contract_type))}
                  onSell={sellContract}
                  sellingId={sellingId}
                  sellError={sellError}
                  onClearSellError={clearSellError}
                  contractTypeLabels={digitContractLabels}
                  className="mt-0"
                />
              ) : (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Localize i18n_default_text="Log in to see your open and closed positions." />
                </div>
              )}
            </>
          )}

          {activeTab === 'logs' && botMode === 'ra' && (
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
              {raBot.log.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Localize i18n_default_text="No robot activity yet — start it from the left panel." />
                </div>
              )}
              {[...raBot.log].reverse().map((entry: RaLogEntry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between text-xs rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/10 text-primary">
                      {localize('Real')}
                    </span>
                    {entry.signalSide && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-muted text-foreground/80">
                        {raSideLabel(entry.signalSide, localize)} {localize('streak')}
                      </span>
                    )}
                    {entry.barrier && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/15 text-primary">
                        {localize('Traded')} {entry.barrier}
                      </span>
                    )}
                    <span className="text-foreground/80 font-medium">
                      {new Date(entry.time).toLocaleTimeString()}
                    </span>
                    {entry.exitSpot !== null && (
                      <span className="tabular-nums font-mono font-semibold text-foreground">{entry.exitSpot.toFixed(pipSize)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-foreground/70">
                      {localize('Stake')} {entry.stake.toFixed(2)}
                    </span>
                    <span className={entry.won ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {entry.won ? localize('Win') : localize('Loss')}
                    </span>
                    <span className={cn('tabular-nums font-bold', entry.profit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {entry.profit >= 0 ? '+' : ''}
                      {entry.profit.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'logs' && botMode === 'differ' && (
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
              {differBot.log.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Localize i18n_default_text="No robot activity yet — start it from the left panel." />
                </div>
              )}
              {[...differBot.log].reverse().map((entry: DifferLogEntry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between text-xs rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/10 text-primary">
                      {localize('Real')}
                    </span>
                    {entry.streakDigit !== null && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-muted text-foreground/80">
                        {localize('Digit')} {entry.streakDigit} {localize('streak')}
                      </span>
                    )}
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/15 text-primary">
                      {localize('Traded')} {entry.tradeType === 'differs' ? localize('Differs') : localize('Matches')}
                    </span>
                    <span className="text-foreground/80 font-medium">
                      {new Date(entry.time).toLocaleTimeString()}
                    </span>
                    {entry.exitSpot !== null && (
                      <span className="tabular-nums font-mono font-semibold text-foreground">{entry.exitSpot.toFixed(pipSize)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-foreground/70">
                      {localize('Stake')} {entry.stake.toFixed(2)}
                    </span>
                    <span className={entry.won ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {entry.won ? localize('Win') : localize('Loss')}
                    </span>
                    <span className={cn('tabular-nums font-bold', entry.profit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {entry.profit >= 0 ? '+' : ''}
                      {entry.profit.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'logs' && botMode === 'mm' && (
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
              {mmBot.log.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Localize i18n_default_text="No robot activity yet — start it from the left panel." />
                </div>
              )}
              {[...mmBot.log].reverse().map((entry: MmLogEntry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-2 text-xs rounded-md border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/10 text-primary">
                      {localize('Real')}
                    </span>
                    <span className="font-semibold text-foreground">{getSymbolDisplayName(entry.symbol)}</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-muted text-foreground/80">
                      {entry.refire ? localize('Re-fire') : `${localize('Run of')} ${entry.runLength}`}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/15 text-primary">
                      {localize('Traded')} {entry.tradeLabel}
                    </span>
                    <span className="text-foreground/80 font-medium">
                      {new Date(entry.time).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums text-foreground/70">
                      {localize('Stake')} {entry.stake.toFixed(2)}
                    </span>
                    <span className={entry.won ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {entry.won ? localize('Win') : localize('Loss')}
                    </span>
                    {entry.exitSpot !== null && (() => {
                      // Exit price at the market's own decimals, with the last
                      // digit (the one the contract is settled on) highlighted.
                      const meta = symbols.find((sym) => sym.underlying_symbol === entry.symbol);
                      const text = entry.exitSpot.toFixed(meta ? pipSizeFromPip(meta.pip_size) : pipSize);
                      return (
                        <span className="tabular-nums font-mono font-semibold text-foreground">
                          {text.slice(0, -1)}
                          <span className={entry.won ? 'font-extrabold text-emerald-400' : 'font-extrabold text-rose-400'}>
                            {text.slice(-1)}
                          </span>
                        </span>
                      );
                    })()}
                    <span className={cn('tabular-nums font-bold', entry.profit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {entry.profit >= 0 ? '+' : ''}
                      {entry.profit.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'logs' && botMode === 'martingale' && (
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
              {bot.log.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Localize i18n_default_text="No robot activity yet — start it from the left panel." />
                </div>
              )}
              {[...bot.log].reverse().map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between text-xs rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/10 text-primary">
                      {localize('Real')}
                    </span>
                    <span className="text-foreground/80 font-medium">
                      {new Date(entry.time).toLocaleTimeString()}
                    </span>
                    {entry.exitSpot !== null && (
                      <span className="tabular-nums font-mono font-semibold text-foreground">{entry.exitSpot.toFixed(pipSize)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={entry.won ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {entry.won ? localize('Win') : localize('Loss')}
                    </span>
                    <span className={cn('tabular-nums font-bold', entry.profit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {entry.profit >= 0 ? '+' : ''}
                      {entry.profit.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* Right: Manual mode. Collapsible — collapsed by default, and
          mutually exclusive with the Automated Robot panel on the far
          left. Opening it collapses Automated and pushes Digit left. */}
      <CollapsibleSidePanel
        isMobile={isMobile}
        isOpen={isManualOpen}
        onExpand={() => setOpenSide('manual')}
        openWidth={MANUAL_OPEN_WIDTH}
        arrowSide="left"
        arrowIcon={ChevronLeft}
        ariaLabel={localize('Expand manual mode panel')}
      >
      <Card
        className={`panel-glow bg-card/60 backdrop-blur-md h-fit ${manualPanel.className}`}
        style={manualPanel.style}
        onMouseEnter={manualPanel.onMouseEnter}
        onMouseLeave={manualPanel.onMouseLeave}
        onFocus={manualPanel.onFocus}
        onBlur={manualPanel.onBlur}
      >
        <div aria-hidden className={manualPanel.overlayClassName} />
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            <Localize i18n_default_text="Manual mode" />
          </CardTitle>
          <p className="text-xs font-semibold text-foreground/90">
            {activeSymbol?.underlying_symbol_name ?? localize('Select a market')}
          </p>
        </CardHeader>
        <CardContent>
          {activeBotRunning && (
            <p className="text-xs text-amber-500 bg-amber-500/10 rounded-md px-2.5 py-1.5 mb-3">
              <Localize i18n_default_text="Manual trading is paused while the robot is running." />
            </p>
          )}
          <fieldset disabled={activeBotRunning} className="border-0 p-0 m-0 min-w-0">
            <TradeControls
              tradeType={tradeType}
              contractMode={contractMode}
              onContractModeChange={setContractMode}
              selectedDigit={selectedDigit}
              isConnected={isConnected}
              stake={stake}
              onStakeChange={setStake}
              duration={duration}
              onDurationChange={setDuration}
              durationLimits={durationLimits}
              proposal={proposal}
              isProposalLoading={isProposalLoading}
              onBuy={buyContract}
              isBuying={isBuying}
              buyResult={buyResult}
              buyError={buyError}
              onClearBuyResult={clearBuyResult}
              isAuthenticated={isAuthenticated}
            />
          </fieldset>
        </CardContent>
      </Card>
      </CollapsibleSidePanel>
    </div>
    </>
  );
}
