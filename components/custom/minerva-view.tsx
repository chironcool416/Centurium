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
import { TradeControls } from '@/components/trade-controls';
import { PositionsTable } from '@/components/custom/positions-table';
import { cn } from '@/lib/utils';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { computeDigitStats, getLastDigit } from '@/lib/digit-stats';
import {
  useMinervaBot,
  type MinervaPhase,
  type MinervaTradingMode,
  type MinervaTradeType,
  type MinervaRunMode,
  type MinervaSide,
  type MinervaLogEntry,
} from '@/hooks/use-minerva-bot';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { MinervaVictoryDialog } from '@/components/custom/minerva-victory-dialog';
import { MinervaDefeatDialog } from '@/components/custom/minerva-defeat-dialog';
import { MinervaInsufficientFundsDialog } from '@/components/custom/minerva-insufficient-funds-dialog';
import { MinervaSettingsProfilesDialog } from '@/components/custom/minerva-settings-profiles-dialog';
import type {
  ActiveSymbol,
  Tick,
  DurationLimits,
  ProposalInfo,
  BuyResult,
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

type Tab = 'chart' | 'digits' | 'trades' | 'logs';

export interface MinervaViewProps {
  isConnected: boolean;
  isAuthenticated: boolean;
  balanceLabel: string | null;
  /** Raw numeric account balance, used by Minerva's own bot to check
   *  whether the next martingale stake within a burst is affordable before
   *  firing it (see `useRaBot`'s insufficient-funds stop reason). Null
   *  while unauthenticated/unknown, in which case that check is skipped. */
  balance: number | null;

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
// Legacy single-slot key from before named profiles existed. Only read once,
// to migrate whatever was saved there into a "Default" profile.
const LEGACY_ROBOT_SETTINGS_STORAGE_KEY = 'centurium:robot-settings';
const ROBOT_SETTINGS_PROFILES_STORAGE_KEY = 'centurium:robot-settings-profiles';
const ROBOT_SETTINGS_ACTIVE_PROFILE_STORAGE_KEY = 'centurium:robot-settings-active-profile';

interface SavedRobotSettings {
  duration: number;
  raStreakCount: string;
  raConfirmationStreak: string;
  raInitialStake: string;
  raStakeMultiplier: string;
  raMartingaleAfterLosses: string;
  raArmTimeLimitSeconds: string;
  raTradingMode: MinervaTradingMode;
  raTradeType: MinervaTradeType;
  raRunMode: MinervaRunMode;
  raTakeProfit: string;
  raStopLoss: string;
}

/** A named, timestamped settings snapshot — one entry per saved profile. */
interface RobotSettingsProfileRecord {
  name: string;
  savedAt: number;
  settings: SavedRobotSettings;
}

type RobotSettingsProfilesMap = Record<string, RobotSettingsProfileRecord>;

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
              isSelected ? 'border-destructive ring-1 ring-destructive' : 'border-border',
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
                isHighest && 'text-amber-300',
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
                  isHighest ? 'text-primary' : isLowest ? 'text-rose-400' : 'text-foreground/80'
                )}
              >
                {stats.totalTicks > 0 ? `${Math.round(pct)}%` : ''}
              </span>
              <div className="w-full h-20 flex items-end">
                <div
                  className={cn(
                    'w-full rounded-sm',
                    isHighest ? 'bg-primary' : isLowest ? 'bg-rose-500/70' : 'bg-muted-foreground/50'
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
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={isLast ? 4 : 2.5}
            className={isLast ? 'fill-primary' : 'fill-amber-300/80'}
          />
        );
      })}
    </svg>
  );
}

function raSideLabel(side: MinervaSide, localize: (t: string) => string): string {
  if (side === 'over4') return localize('Over 4');
  if (side === 'under5') return localize('Under 5');
  return '';
}

function getRaStatusLabel(
  phase: MinervaPhase,
  armedSide: MinervaSide,
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
  reason: 'manual' | 'take-profit' | 'stop-loss' | 'insufficient-funds' | null,
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
    default:
      return null;
  }
}

/** Transient note shown while Minerva is still running but idle between bursts,
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

/** Small strip of the last digits seen while Minerva was on — oldest to newest,
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
        'pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-300 ease-out shadow-[0_14px_32px_-12px_rgba(0,0,0,0.35),0_0_0_1px_rgba(217,160,90,0.55),0_0_26px_4px_rgba(217,160,90,0.45),0_0_56px_14px_rgba(217,160,90,0.22)]' +
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
 * state one level up in `MinervaView` — the Card here is a plain
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

export function MinervaView({
  isConnected,
  isAuthenticated,
  balanceLabel,
  balance,
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
}: MinervaViewProps) {
  const { localize } = useAppTranslations();
  const digitTradeTypeOptions = getDigitTradeTypeOptions(localize);
  const digitContractLabels = getDigitContractLabels(localize);

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
  // `prices` already contains the pre-fetched history merged with live ticks
  // (see useTicks), so derive from it directly instead of keeping a separate
  // buffer that would start empty and duplicate/lag the real data.
  const priceHistory = useMemo(() => prices.slice(-HISTORY_WINDOW), [prices]);

  const [raStreakCount, setRaStreakCount] = useState('5');
  const [raConfirmationStreak, setRaConfirmationStreak] = useState('5');
  const [raInitialStake, setRaInitialStake] = useState('1');
  const [raStakeMultiplier, setRaStakeMultiplier] = useState('2.5');
  const [raMartingaleAfterLosses, setRaMartingaleAfterLosses] = useState('0');
  // ARM Time Limit (seconds): 0 = no time limit. See use-ra-bot.ts.
  const [raArmTimeLimitSeconds, setRaArmTimeLimitSeconds] = useState('0');
  const [raTradingMode, setRaTradingMode] = useState<MinervaTradingMode>('neutral');
  // Trade 1 (original): over4 → Superior 3, under5 → Inferior 6.
  // Trade 2: over4 → Superior 6, under5 → Inferior 3.
  const [raTradeType, setRaTradeType] = useState<MinervaTradeType>('trade1');
  // Burst (default): a win ends the burst and Minerva waits for a fresh
  // signal. Continuous: a win keeps the run going straight through to
  // Take Profit/Stop Loss, with no wait in between.
  const [raRunMode, setRaRunMode] = useState<MinervaRunMode>('burst');
  const [raTakeProfit, setRaTakeProfit] = useState('0');
  const [raStopLoss, setRaStopLoss] = useState('0');

  const [robotProfiles, setRobotProfiles] = useState<RobotSettingsProfilesMap>({});
  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);
  const [profilesDialogOpen, setProfilesDialogOpen] = useState(false);

  const applySettings = (saved: Partial<SavedRobotSettings>) => {
    if (typeof saved.duration === 'number') setDuration(saved.duration);
    if (typeof saved.raStreakCount === 'string') setRaStreakCount(saved.raStreakCount);
    if (typeof saved.raConfirmationStreak === 'string') setRaConfirmationStreak(saved.raConfirmationStreak);
    if (typeof saved.raInitialStake === 'string') setRaInitialStake(saved.raInitialStake);
    if (typeof saved.raStakeMultiplier === 'string') setRaStakeMultiplier(saved.raStakeMultiplier);
    if (typeof saved.raMartingaleAfterLosses === 'string') setRaMartingaleAfterLosses(saved.raMartingaleAfterLosses);
    if (typeof saved.raArmTimeLimitSeconds === 'string') setRaArmTimeLimitSeconds(saved.raArmTimeLimitSeconds);
    if (typeof saved.raTradingMode === 'string') setRaTradingMode(saved.raTradingMode);
    if (typeof saved.raTradeType === 'string') setRaTradeType(saved.raTradeType);
    if (typeof saved.raRunMode === 'string') setRaRunMode(saved.raRunMode);
    if (typeof saved.raTakeProfit === 'string') setRaTakeProfit(saved.raTakeProfit);
    if (typeof saved.raStopLoss === 'string') setRaStopLoss(saved.raStopLoss);
  };

  const currentSettingsSnapshot = (): SavedRobotSettings => ({
    duration,
    raStreakCount,
    raConfirmationStreak,
    raInitialStake,
    raStakeMultiplier,
    raMartingaleAfterLosses,
    raArmTimeLimitSeconds,
    raTradingMode,
    raTradeType,
    raRunMode,
    raTakeProfit,
    raStopLoss,
  });

  const persistProfiles = (next: RobotSettingsProfilesMap) => {
    window.localStorage.setItem(ROBOT_SETTINGS_PROFILES_STORAGE_KEY, JSON.stringify(next));
  };

  // Load any saved profiles once on mount. Also migrates the old single-slot
  // save (from before named profiles existed) into a "Default" profile, so
  // nobody's existing saved settings silently disappear.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ROBOT_SETTINGS_PROFILES_STORAGE_KEY);
      let map: RobotSettingsProfilesMap = raw ? (JSON.parse(raw) as RobotSettingsProfilesMap) : {};

      if (!raw) {
        const legacyRaw = window.localStorage.getItem(LEGACY_ROBOT_SETTINGS_STORAGE_KEY);
        if (legacyRaw) {
          const legacySettings = JSON.parse(legacyRaw) as SavedRobotSettings;
          map = {
            Default: { name: 'Default', savedAt: Date.now(), settings: legacySettings },
          };
          persistProfiles(map);
        }
      }

      setRobotProfiles(map);

      const lastActive = window.localStorage.getItem(ROBOT_SETTINGS_ACTIVE_PROFILE_STORAGE_KEY);
      if (lastActive && map[lastActive]) {
        applySettings(map[lastActive].settings);
        setActiveProfileName(lastActive);
      }
    } catch {
      // Ignore malformed/unavailable storage — fields just keep their defaults.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveProfile = (name: string) => {
    try {
      const next: RobotSettingsProfilesMap = {
        ...robotProfiles,
        [name]: { name, savedAt: Date.now(), settings: currentSettingsSnapshot() },
      };
      persistProfiles(next);
      setRobotProfiles(next);
      setActiveProfileName(name);
      window.localStorage.setItem(ROBOT_SETTINGS_ACTIVE_PROFILE_STORAGE_KEY, name);
      toast.success(localize('Saved profile "{{name}}"', { name }));
    } catch {
      toast.error(localize('Could not save settings on this device.'));
    }
  };

  const handleLoadProfile = (name: string) => {
    const profile = robotProfiles[name];
    if (!profile) return;
    applySettings(profile.settings);
    setActiveProfileName(name);
    try {
      window.localStorage.setItem(ROBOT_SETTINGS_ACTIVE_PROFILE_STORAGE_KEY, name);
    } catch {
      // Non-fatal — the settings are already applied in-memory either way.
    }
    toast.success(localize('Loaded profile "{{name}}"', { name }));
    setProfilesDialogOpen(false);
  };

  const handleDeleteProfile = (name: string) => {
    const next = { ...robotProfiles };
    delete next[name];
    try {
      persistProfiles(next);
    } catch {
      // Ignore — in-memory state below still reflects the deletion this session.
    }
    setRobotProfiles(next);
    if (activeProfileName === name) {
      setActiveProfileName(null);
      try {
        window.localStorage.removeItem(ROBOT_SETTINGS_ACTIVE_PROFILE_STORAGE_KEY);
      } catch {
        // Non-fatal.
      }
    }
    toast.success(localize('Deleted profile "{{name}}"', { name }));
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

  const raBot = useMinervaBot({
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

  // Used to gate Manual mode and to decide what the Start/Stop button and
  // header status line show.
  const activeBotRunning = raBot.running;

  // Celebration/defeat/insufficient-funds modals — same pattern as
  // Operations' trade-robot-view.tsx: each opens the moment the bot's
  // stopped reason matches, independent of that reason so the user can
  // dismiss it (and start a new run) without the reason itself changing.
  const [minervaVictoryOpen, setMinervaVictoryOpen] = useState(false);
  useEffect(() => {
    if (raBot.stoppedReason === 'take-profit') {
      setMinervaVictoryOpen(true);
    }
  }, [raBot.stoppedReason]);

  const [minervaDefeatOpen, setMinervaDefeatOpen] = useState(false);
  useEffect(() => {
    if (raBot.stoppedReason === 'stop-loss') {
      setMinervaDefeatOpen(true);
    }
  }, [raBot.stoppedReason]);

  const [minervaInsufficientOpen, setMinervaInsufficientOpen] = useState(false);
  useEffect(() => {
    if (raBot.stoppedReason === 'insufficient-funds') {
      setMinervaInsufficientOpen(true);
    }
  }, [raBot.stoppedReason]);

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
      toast.error(localize('Enter a valid Minerva stake first.'));
      return;
    }
    const armTimeLimitSeconds = Math.max(0, parseInt(raArmTimeLimitSeconds, 10) || 0);
    raBot.start({
      streakCount,
      confirmationStreak,
      initialStake: raStake,
      stakeMultiplier: parseFloat(raStakeMultiplier) || 1,
      martingaleStartAfter: Math.max(0, parseInt(raMartingaleAfterLosses, 10) || 0),
      armTimeLimitSeconds,
      tradingMode: raTradingMode,
      tradeType: raTradeType,
      runMode: raRunMode,
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

  const handleStart = handleRaStart;

  return (
    <>
    <MinervaVictoryDialog
      open={minervaVictoryOpen}
      onOpenChange={setMinervaVictoryOpen}
      onContinue={() => setMinervaVictoryOpen(false)}
    />
    <MinervaDefeatDialog
      open={minervaDefeatOpen}
      onOpenChange={setMinervaDefeatOpen}
      onContinue={() => setMinervaDefeatOpen(false)}
    />
    <MinervaInsufficientFundsDialog
      open={minervaInsufficientOpen}
      onOpenChange={setMinervaInsufficientOpen}
      onContinue={() => setMinervaInsufficientOpen(false)}
    />
    <MinervaSettingsProfilesDialog
      open={profilesDialogOpen}
      onOpenChange={setProfilesDialogOpen}
      profiles={robotProfiles}
      activeProfileName={activeProfileName}
      onSave={handleSaveProfile}
      onLoad={handleLoadProfile}
      onDelete={handleDeleteProfile}
    />
    <div className="minerva-theme w-full max-w-[1760px] mx-auto px-3 py-4 sm:px-4 flex flex-col lg:flex-row gap-4">
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
        className={`minerva-settings-panel panel-glow bg-card/60 backdrop-blur-md flex flex-col lg:sticky lg:top-[88px] lg:max-h-[calc(100dvh-124px)] overflow-visible ${settingsPanel.className}`}
        style={settingsPanel.style}
        onMouseEnter={settingsPanel.onMouseEnter}
        onMouseLeave={settingsPanel.onMouseLeave}
        onFocus={settingsPanel.onFocus}
        onBlur={settingsPanel.onBlur}
      >
        <div aria-hidden className={settingsPanel.overlayClassName} />
        <CardHeader className="pb-3 shrink-0 lg:rounded-t-[inherit]">
          <CardTitle className="minerva-engraved-title text-xl">
            MINERVA
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
              {getRaStatusLabel(
                raBot.phase,
                raBot.armedSide,
                raBot.confirmProgress,
                raConfirmationStreak,
                localize,
                raBot.burstActive,
                raBot.burstPnl
              )}
            </span>
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'text-sm font-mono font-bold tabular-nums',
                  raBot.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                )}
              >
                {raBot.pnl >= 0 ? '+' : ''}
                {raBot.pnl.toFixed(2)}
              </span>
            </div>
          </div>
          {!raBot.running && getRaStoppedLabel(raBot.stoppedReason, localize) && (
            <p className="text-[11px] text-muted-foreground px-0.5">
              {getRaStoppedLabel(raBot.stoppedReason, localize)}
            </p>
          )}
          {raBot.running &&
            !raBot.burstActive &&
            getRaLastBurstLabel(raBot.lastBurstOutcome, localize) && (
              <p className="text-[11px] text-muted-foreground px-0.5">
                {getRaLastBurstLabel(raBot.lastBurstOutcome, localize)}
              </p>
            )}
        </CardHeader>
        <CardContent className="space-y-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:rounded-b-[inherit]">
          <fieldset disabled={activeBotRunning} className="space-y-3 border-0 p-0 m-0 min-w-0">
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

                    <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake" />
              </Label>
              <Input value={raInitialStake} onChange={(e) => setRaInitialStake(e.target.value)} />
            </div>
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label className="text-xs font-semibold text-foreground/90">
                <Localize i18n_default_text="Stake Multiplier" />
              </Label>
              <Input value={raStakeMultiplier} onChange={(e) => setRaStakeMultiplier(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
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
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
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
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
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

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label
              className="text-xs font-semibold text-foreground/90"
              title={localize('Seconds a side may stay ARMED without reaching the confirmation streak before the arm is abandoned and Minerva goes back to watching for a fresh streak. 0 = no time limit.')}
            >
              <Localize i18n_default_text="ARM Time Limit (seconds)" />
            </Label>
            <Input
              type="number"
              min={0}
              max={3600}
              value={raArmTimeLimitSeconds}
              onChange={(e) => setRaArmTimeLimitSeconds(e.target.value)}
            />
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Trading Mode" />
            </Label>
            <ToggleGroup
              type="single"
              value={raTradingMode}
              onValueChange={(v) => {
                if (v) setRaTradingMode(v as MinervaTradingMode);
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

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Trade Type" />
            </Label>
            <ToggleGroup
              type="single"
              value={raTradeType}
              onValueChange={(v) => {
                if (v) setRaTradeType(v as MinervaTradeType);
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              <ToggleGroupItem value="trade1" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Trade 1" />
              </ToggleGroupItem>
              <ToggleGroupItem value="trade2" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Trade 2" />
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">
              {raTradeType === 'trade1' ? (
                <Localize i18n_default_text="Over4 → Superior 3, Under5 → Inferior 6." />
              ) : (
                <Localize i18n_default_text="Over4 → Superior 6, Under5 → Inferior 3." />
              )}
            </p>
          </div>

          <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
            <Label className="text-xs font-semibold text-foreground/90">
              <Localize i18n_default_text="Run Mode" />
            </Label>
            <ToggleGroup
              type="single"
              value={raRunMode}
              onValueChange={(v) => {
                if (v) setRaRunMode(v as MinervaRunMode);
              }}
              className="w-full gap-0 rounded-full bg-muted p-1"
            >
              <ToggleGroupItem value="burst" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Burst" />
              </ToggleGroupItem>
              <ToggleGroupItem value="continuous" className="flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground">
                <Localize i18n_default_text="Continuous" />
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">
              {raRunMode === 'burst' ? (
                <Localize i18n_default_text="A win ends the run — Minerva waits for the next signal." />
              ) : (
                <Localize i18n_default_text="A win keeps going — Minerva re-fires immediately, no waiting, straight to Take Profit/Stop Loss." />
              )}
            </p>
          </div>

          <div className="border-t border-border pt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Once total profit across the whole run reaches this amount, Minerva stops. 0 = off.'
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
            <div className="space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]">
              <Label
                className="text-xs font-semibold text-foreground/90"
                title={localize(
                  'Once total loss across the whole run reaches this amount, Minerva stops. 0 = off.'
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
            {raRunMode === 'burst' ? (
              <Localize i18n_default_text="Each signal opens a burst that trades continuously (same side, Minerva's own martingale on losses) until it wins, then Minerva waits for the next signal. Take Profit and Stop Loss track total profit/loss across every burst and stop Minerva outright once hit." />
            ) : (
              <Localize i18n_default_text="Once a signal fires, Minerva trades continuously (same side, martingale on losses, back to base stake on each win) with no pauses in between, straight through until Take Profit or Stop Loss stops it outright." />
            )}
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
          </fieldset>

          <Button
            className="w-full"
            variant="outline"
            onClick={() => setProfilesDialogOpen(true)}
          >
            <Localize i18n_default_text="Settings profiles" />
            {activeProfileName ? ` — ${activeProfileName}` : ''}
          </Button>

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
        <div aria-hidden className="minerva-digit-engraved-bg">
          <span>MINERVA</span>
        </div>
        <CardHeader className="pb-0">
          <div className="flex items-center gap-5 border-b border-border">
            {(
              [
                ['chart', localize('Chart')],
                ['digits', localize('Digits')],
                ['trades', localize('Trades')],
                ['logs', localize('Logs')],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'pb-2.5 text-sm font-bold border-b-2 -mb-px transition-colors',
                  activeTab === key
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-foreground/70 hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-4 space-y-6">
          {activeTab === 'digits' && (
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

          {activeTab === 'logs' && (
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
              {raBot.log.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Localize i18n_default_text="No robot activity yet — start it from the left panel." />
                </div>
              )}
              {[...raBot.log].reverse().map((entry: MinervaLogEntry) => (
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
          <fieldset disabled={activeBotRunning} className="space-y-3 border-0 p-0 m-0 min-w-0">
            <div className="space-y-1.5">
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

            {tradeType !== 'even-odd' && (
              <div className="space-y-1.5">
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
