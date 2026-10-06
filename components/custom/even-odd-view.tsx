'use client';

import { useEffect, useMemo, useState } from 'react';
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
  useEvenOddBot,
  eoClassOf,
  type EoPhase,
  type EoStopReason,
  type EoTradingMode,
  type EoRunMode,
  type EoWatchParity,
  type EoWatchRange,
  type EoDetectionClass,
  type EoLogEntry,
} from '@/hooks/use-even-odd-bot';
import { MinervaVictoryDialog } from '@/components/custom/minerva-victory-dialog';
import { MinervaDefeatDialog } from '@/components/custom/minerva-defeat-dialog';
import { MinervaInsufficientFundsDialog } from '@/components/custom/minerva-insufficient-funds-dialog';
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

type Tab = 'digits' | 'trades' | 'logs';

export interface EvenOddViewProps {
  isConnected: boolean;
  isAuthenticated: boolean;
  balanceLabel: string | null;
  balance: number | null;
  ws: DerivWS | null;

  symbols: ActiveSymbol[];
  activeSymbol: ActiveSymbol | null;
  selectSymbol: (symbol: string) => void;
  currentTick: Tick | null;
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

const TOGGLE_ITEM =
  'flex-1 rounded-full text-xs font-semibold text-foreground/70 data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:font-bold data-[state=on]:shadow-sm hover:text-foreground';
const FIELD =
  'space-y-1.5 rounded-lg p-1.5 -m-1.5 transition-shadow duration-200 hover:ring-1 hover:ring-yellow-400/70 hover:shadow-[0_0_14px_3px_rgba(250,204,21,0.45)]';

function eoClassLabel(cls: EoDetectionClass, localize: (t: string) => string): string {
  switch (cls) {
    case 'odd-over':
      return `${localize('Odd')} · ${localize('Over 4')}`;
    case 'even-over':
      return `${localize('Even')} · ${localize('Over 4')}`;
    case 'odd-under':
      return `${localize('Odd')} · ${localize('Under 5')}`;
    case 'even-under':
      return `${localize('Even')} · ${localize('Under 5')}`;
    default:
      return '';
  }
}

function getStatusLabel(
  phase: EoPhase,
  armedClass: EoDetectionClass,
  confirmProgress: number,
  confirmationStreak: string,
  runProgress: { cls: EoDetectionClass; count: number },
  streakCount: string,
  burstActive: boolean,
  burstPnl: number,
  localize: (t: string) => string
): string {
  const pnlText = burstActive ? ` (${burstPnl >= 0 ? '+' : ''}${burstPnl.toFixed(2)})` : '';
  switch (phase) {
    case 'awaiting-proposal':
    case 'awaiting-buy':
      return `${localize('Placing trade…')}${pnlText}`;
    case 'awaiting-settlement':
      return `${localize('Trade running…')}${pnlText}`;
    default:
      if (armedClass) {
        return `${eoClassLabel(armedClass, localize)} ${localize('ARMED')} — ${localize(
          'waiting for confirmation streak'
        )} (${confirmProgress}/${confirmationStreak})`;
      }
      if (runProgress.cls && runProgress.count > 0) {
        return `${localize('Watching…')} ${eoClassLabel(runProgress.cls, localize)} ${runProgress.count}/${streakCount}`;
      }
      return localize('Watching…');
  }
}

function getStoppedLabel(reason: EoStopReason, localize: (t: string) => string): string | null {
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

/** Odd digits green, even digits red; stronger shade = Over 4 (5-9), lighter
 *  = Under 5 (0-4). Digits outside the watched classes are muted. */
function EoDigitRecord({
  digits,
  watchParity,
  watchRange,
}: {
  digits: number[];
  watchParity: EoWatchParity;
  watchRange: EoWatchRange;
}) {
  if (digits.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 rounded-md bg-muted/30 p-2">
      {digits.map((d, i) => {
        const isNewest = i === digits.length - 1;
        const cls = eoClassOf(d, watchParity, watchRange);
        const colorClass =
          cls === 'odd-over'
            ? 'bg-emerald-500/45 text-emerald-300'
            : cls === 'odd-under'
              ? 'bg-emerald-500/15 text-emerald-400'
              : cls === 'even-over'
                ? 'bg-rose-500/45 text-rose-300'
                : cls === 'even-under'
                  ? 'bg-rose-500/15 text-rose-400'
                  : 'bg-muted text-muted-foreground/70';
        return (
          <span
            key={i}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold tabular-nums',
              colorClass,
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

export function EvenOddView({
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
}: EvenOddViewProps) {
  const { localize } = useAppTranslations();
  const [activeTab, setActiveTab] = useState<Tab>('digits');

  const [streakCount, setStreakCount] = useState('4');
  const [confirmationStreak, setConfirmationStreak] = useState('0');
  const [watchParity, setWatchParity] = useState<EoWatchParity>('both');
  const [watchRange, setWatchRange] = useState<EoWatchRange>('both');
  const [initialStake, setInitialStake] = useState('1');
  const [stakeMultiplier, setStakeMultiplier] = useState('2.2');
  const [martingaleAfterLosses, setMartingaleAfterLosses] = useState('0');
  const [armTimeLimitSeconds, setArmTimeLimitSeconds] = useState('0');
  const [tradingMode, setTradingMode] = useState<EoTradingMode>('neutral');
  const [runMode, setRunMode] = useState<EoRunMode>('burst');
  const [takeProfit, setTakeProfit] = useState('0');
  const [stopLoss, setStopLoss] = useState('0');
  const [runTakeProfit, setRunTakeProfit] = useState('0');

  const priceHistory = useMemo(() => prices.slice(-HISTORY_WINDOW), [prices]);
  const stats = useMemo(() => computeDigitStats(priceHistory, pipSize), [priceHistory, pipSize]);
  const recentDigits = useMemo(
    () => priceHistory.slice(-RECENT_DIGITS_SHOWN).map((p) => getLastDigit(p, pipSize)),
    [priceHistory, pipSize]
  );
  const lastDigit = useMemo(
    () => (currentTick ? getLastDigit(currentTick.quote, pipSize) : null),
    [currentTick, pipSize]
  );

  const bot = useEvenOddBot({
    currentTick,
    pipSize,
    setStake,
    setContractMode,
    proposal,
    isProposalLoading,
    buyContract,
    buyResult,
    buyError,
    clearBuyResult,
    openPositions,
    balance,
  });
  const botRunning = bot.running;

  const [victoryOpen, setVictoryOpen] = useState(false);
  useEffect(() => {
    if (bot.stoppedReason === 'take-profit') setVictoryOpen(true);
  }, [bot.stoppedReason]);
  const [defeatOpen, setDefeatOpen] = useState(false);
  useEffect(() => {
    if (bot.stoppedReason === 'stop-loss') setDefeatOpen(true);
  }, [bot.stoppedReason]);
  const [insufficientOpen, setInsufficientOpen] = useState(false);
  useEffect(() => {
    if (bot.stoppedReason === 'insufficient-funds') setInsufficientOpen(true);
  }, [bot.stoppedReason]);

  useEffect(() => {
    const where: Record<string, string> = {
      'timeout-proposal': 'waiting for a price quote',
      'timeout-buy': 'waiting for the buy confirmation',
      'timeout-settlement': 'waiting for the contract to settle',
    };
    const reason = bot.stoppedReason;
    if (reason && where[reason]) {
      toast.error(localize('Even/Odd stopped: no response'), {
        description: `Stuck ${where[reason]}. Check Reports for any open contract before restarting.`,
        duration: 15000,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.stoppedReason]);

  const handleStart = () => {
    if (bot.running) {
      bot.stop('manual');
      toast.info(localize('Robot stopped'));
      return;
    }
    const streak = parseInt(streakCount, 10);
    const confirm = parseInt(confirmationStreak, 10);
    if (!streak || streak < 2 || streak > 20) {
      toast.error(localize('Enter a valid Streak Count (2-20) first.'));
      return;
    }
    if (Number.isNaN(confirm) || confirm < 0 || confirm > 9) {
      toast.error(localize('Enter a valid Confirmation Streak (0-9) first.'));
      return;
    }
    const baseStake = parseFloat(initialStake);
    if (!baseStake || baseStake <= 0) {
      toast.error(localize('Enter a valid stake first.'));
      return;
    }
    bot.start({
      streakCount: streak,
      confirmationStreak: confirm,
      watchParity,
      watchRange,
      initialStake: baseStake,
      stakeMultiplier: parseFloat(stakeMultiplier) || 1,
      martingaleStartAfter: Math.max(0, parseInt(martingaleAfterLosses, 10) || 0),
      armTimeLimitSeconds: Math.max(0, parseInt(armTimeLimitSeconds, 10) || 0),
      tradingMode,
      runMode,
      takeProfit: parseFloat(takeProfit) || 0,
      stopLoss: parseFloat(stopLoss) || 0,
      runTakeProfit: parseFloat(runTakeProfit) || 0,
    });
    toast.info(localize('Robot started'), {
      description:
        tradingMode === 'neutral'
          ? localize('Watching for digit runs — pick Trend or Counter to actually trade.')
          : localize('Watching for digit runs on the digit stream.'),
    });
  };

  const contractLabels: Record<string, string> = {
    DIGITMATCH: localize('Digit Match'),
    DIGITDIFF: localize('Digit Differs'),
    DIGITOVER: localize('Digit Over'),
    DIGITUNDER: localize('Digit Under'),
    DIGITEVEN: localize('Digit Even'),
    DIGITODD: localize('Digit Odd'),
  };
  const tradeTypeOptions: { value: TradeType; label: string }[] = [
    { value: 'matches-differs', label: localize('Matches/Differs') },
    { value: 'over-under', label: localize('Over/Under') },
    { value: 'even-odd', label: localize('Even/Odd') },
  ];
  const stoppedLabel = getStoppedLabel(bot.stoppedReason, localize);

  return (
    <>
      <MinervaVictoryDialog
        open={victoryOpen}
        onOpenChange={setVictoryOpen}
        onContinue={() => setVictoryOpen(false)}
        durationMs={bot.sessionDurationMs}
      />
      <MinervaDefeatDialog
        open={defeatOpen}
        onOpenChange={setDefeatOpen}
        onContinue={() => setDefeatOpen(false)}
        durationMs={bot.sessionDurationMs}
      />
      <MinervaInsufficientFundsDialog
        open={insufficientOpen}
        onOpenChange={setInsufficientOpen}
        onContinue={() => setInsufficientOpen(false)}
        durationMs={bot.sessionDurationMs}
      />

      <div className="w-full max-w-[1760px] mx-auto px-3 py-4 sm:px-4 flex flex-col lg:flex-row gap-4">
        {/* Left: bot settings */}
        <Card className="panel-glow bg-card/60 backdrop-blur-md flex flex-col w-full lg:w-[420px] lg:shrink-0 lg:sticky lg:top-[88px] lg:max-h-[calc(100dvh-124px)] self-start">
          <CardHeader className="pb-3 shrink-0">
            <CardTitle className="text-xl font-bold tracking-wide">EVEN / ODD</CardTitle>
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
              <span
                className={cn(
                  'text-xs font-bold pr-2 min-w-0',
                  botRunning ? 'text-emerald-400' : 'text-foreground/85'
                )}
              >
                {getStatusLabel(
                  bot.phase,
                  bot.armedClass,
                  bot.confirmProgress,
                  confirmationStreak,
                  bot.runProgress,
                  streakCount,
                  bot.burstActive,
                  bot.burstPnl,
                  localize
                )}
              </span>
              <span
                className={cn(
                  'text-sm font-mono font-bold tabular-nums',
                  bot.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                )}
              >
                {bot.pnl >= 0 ? '+' : ''}
                {bot.pnl.toFixed(2)}
              </span>
            </div>
            {!bot.running && stoppedLabel && (
              <p className="text-[11px] text-muted-foreground px-0.5">{stoppedLabel}</p>
            )}
            {bot.running && !bot.burstActive && bot.lastBurstOutcome === 'won' && (
              <p className="text-[11px] text-muted-foreground px-0.5">
                <Localize i18n_default_text="Last run finished in profit — watching for the next signal." />
              </p>
            )}
            {bot.running && !bot.burstActive && bot.lastBurstOutcome === 'error' && (
              <p className="text-[11px] text-muted-foreground px-0.5">
                <Localize i18n_default_text="Last trade failed — watching for the next signal." />
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
            <fieldset disabled={botRunning} className="space-y-3 border-0 p-0 m-0 min-w-0">
              <div className={FIELD}>
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Market" />
                </Label>
                <SymbolSelector
                  symbols={symbols}
                  activeSymbol={activeSymbol}
                  onSymbolChange={selectSymbol}
                />
              </div>

              <div className={FIELD}>
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
                <div className={FIELD}>
                  <Label className="text-xs font-semibold text-foreground/90">
                    <Localize i18n_default_text="Stake" />
                  </Label>
                  <Input value={initialStake} onChange={(e) => setInitialStake(e.target.value)} />
                </div>
                <div className={FIELD}>
                  <Label className="text-xs font-semibold text-foreground/90">
                    <Localize i18n_default_text="Stake Multiplier" />
                  </Label>
                  <Input value={stakeMultiplier} onChange={(e) => setStakeMultiplier(e.target.value)} />
                </div>
              </div>

              <div className={FIELD}>
                <Label
                  className="text-xs font-semibold text-foreground/90"
                  title={localize(
                    'Stays at the initial stake for this many losses before the multiplier kicks in. 0 = multiply from the first loss.'
                  )}
                >
                  <Localize i18n_default_text="Start Martingale after N losses" />
                </Label>
                <Input
                  value={martingaleAfterLosses}
                  onChange={(e) => setMartingaleAfterLosses(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className={FIELD}>
                  <Label
                    className="text-xs font-semibold text-foreground/90"
                    title={localize(
                      'N consecutive digits in the same class (e.g. all odd AND all over 4) required to arm a run. With 4: 7-9-5-7 arms Odd/Over, 3-3-1-3 arms Odd/Under, 2-2-4-0 arms Even/Under.'
                    )}
                  >
                    <Localize i18n_default_text="Streak Count" />
                  </Label>
                  <Input
                    type="number"
                    min={2}
                    max={20}
                    value={streakCount}
                    onChange={(e) => setStreakCount(e.target.value)}
                  />
                </div>
                <div className={FIELD}>
                  <Label
                    className="text-xs font-semibold text-foreground/90"
                    title={localize(
                      'M more consecutive digits of the same class, uninterrupted, required after arming before the trade fires. 0 = fire immediately once the run is complete.'
                    )}
                  >
                    <Localize i18n_default_text="Confirmation Streak" />
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    max={9}
                    value={confirmationStreak}
                    onChange={(e) => setConfirmationStreak(e.target.value)}
                  />
                </div>
              </div>

              <div className={FIELD}>
                <Label
                  className="text-xs font-semibold text-foreground/90"
                  title={localize(
                    'Seconds a run may stay ARMED without reaching the confirmation streak before the arm is abandoned and the bot goes back to watching for a fresh run. 0 = no time limit.'
                  )}
                >
                  <Localize i18n_default_text="ARM Time Limit (seconds)" />
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={armTimeLimitSeconds}
                  onChange={(e) => setArmTimeLimitSeconds(e.target.value)}
                />
              </div>

              <div className={FIELD}>
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Watch: Even / Odd" />
                </Label>
                <ToggleGroup
                  type="single"
                  value={watchParity}
                  onValueChange={(v) => {
                    if (v) setWatchParity(v as EoWatchParity);
                  }}
                  className="w-full gap-0 rounded-full bg-muted p-1"
                >
                  <ToggleGroupItem value="both" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Both" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="odd" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Odd" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="even" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Even" />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className={FIELD}>
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Watch: Over / Under" />
                </Label>
                <ToggleGroup
                  type="single"
                  value={watchRange}
                  onValueChange={(v) => {
                    if (v) setWatchRange(v as EoWatchRange);
                  }}
                  className="w-full gap-0 rounded-full bg-muted p-1"
                >
                  <ToggleGroupItem value="both" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Both" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="over" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Over 4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="under" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Under 5" />
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[11px] text-muted-foreground">
                  <Localize i18n_default_text="A run is N digits in a row that are all the same class: Odd/Over (5 7 9), Even/Over (6 8), Odd/Under (1 3) or Even/Under (0 2 4). Any other digit breaks it." />
                </p>
              </div>

              <div className={FIELD}>
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Trading Mode" />
                </Label>
                <ToggleGroup
                  type="single"
                  value={tradingMode}
                  onValueChange={(v) => {
                    if (v) setTradingMode(v as EoTradingMode);
                  }}
                  className="w-full gap-0 rounded-full bg-muted p-1"
                >
                  <ToggleGroupItem value="trend" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Trend" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="neutral" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Neutral" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="counter" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Counter" />
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[11px] text-muted-foreground">
                  {tradingMode === 'neutral' && (
                    <Localize i18n_default_text="Won't trade until you pick Trend or Counter." />
                  )}
                  {tradingMode === 'trend' && (
                    <Localize i18n_default_text="Trades with the run: an Odd run trades Odd, an Even run trades Even." />
                  )}
                  {tradingMode === 'counter' && (
                    <Localize i18n_default_text="Trades against the run: an Odd run trades Even, an Even run trades Odd." />
                  )}
                </p>
              </div>

              <div className={FIELD}>
                <Label className="text-xs font-semibold text-foreground/90">
                  <Localize i18n_default_text="Run Mode" />
                </Label>
                <ToggleGroup
                  type="single"
                  value={runMode}
                  onValueChange={(v) => {
                    if (v) setRunMode(v as EoRunMode);
                  }}
                  className="w-full gap-0 rounded-full bg-muted p-1"
                >
                  <ToggleGroupItem value="burst" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Burst" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="continuous" className={TOGGLE_ITEM}>
                    <Localize i18n_default_text="Continuous" />
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[11px] text-muted-foreground">
                  {runMode === 'burst' ? (
                    <Localize i18n_default_text="A win ends the run — the bot waits for the next signal." />
                  ) : (
                    <Localize i18n_default_text="A win keeps going — the bot re-fires immediately, straight to Take Profit/Stop Loss." />
                  )}
                </p>
              </div>

              <div className="border-t border-border pt-2 grid grid-cols-2 gap-2">
                <div className={FIELD}>
                  <Label
                    className="text-xs font-semibold text-foreground/90"
                    title={localize('Once total profit across the whole run reaches this amount, the bot stops. 0 = off.')}
                  >
                    <Localize i18n_default_text="Take Profit" />
                  </Label>
                  <Input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} labelRight="USD" />
                </div>
                <div className={FIELD}>
                  <Label
                    className="text-xs font-semibold text-foreground/90"
                    title={localize('Once total loss across the whole run reaches this amount, the bot stops. 0 = off.')}
                  >
                    <Localize i18n_default_text="Stop Loss" />
                  </Label>
                  <Input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} labelRight="USD" />
                </div>
                <div className={cn('col-span-2', FIELD)}>
                  <Label
                    className="text-xs font-semibold text-foreground/90"
                    title={localize(
                      "Once THIS signal's own profit reaches this amount, the bot stops that signal and waits for the next one — it keeps running and never pops the Take Profit popup. 0 = off."
                    )}
                  >
                    <Localize i18n_default_text="Run TP" />
                  </Label>
                  <Input
                    value={runTakeProfit}
                    onChange={(e) => setRunTakeProfit(e.target.value)}
                    labelRight="USD"
                  />
                </div>
              </div>

              {(bot.running || bot.digitRecord.length > 0) && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-foreground/90">
                      <Localize i18n_default_text="Digit Record" />
                    </Label>
                    {bot.armedClass && (
                      <span className="text-[11px] font-semibold text-foreground/80">
                        {eoClassLabel(bot.armedClass, localize)} {localize('ARMED')} · {bot.confirmProgress}/
                        {confirmationStreak}
                      </span>
                    )}
                  </div>
                  <EoDigitRecord
                    digits={bot.digitRecord}
                    watchParity={watchParity}
                    watchRange={watchRange}
                  />
                </div>
              )}
            </fieldset>

            <Button
              className="w-full"
              size="lg"
              variant={botRunning ? 'destructive' : 'default'}
              onClick={handleStart}
              disabled={!isConnected || !isAuthenticated}
            >
              {botRunning ? <Localize i18n_default_text="Stop" /> : <Localize i18n_default_text="Start" />}
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

        {/* Right: digits / trades / logs, then manual mode */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <Card className="panel-glow bg-card/60 backdrop-blur-md h-fit">
            <CardHeader className="pb-0">
              <div className="flex items-center gap-5 border-b border-border">
                {(
                  [
                    ['digits', localize('Digits')],
                    ['trades', localize('Trades')],
                    ['logs', localize('Logs')],
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
                    <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                      {stats.percentages.map((pct, digit) => (
                        <div
                          key={digit}
                          className={cn(
                            'flex flex-col items-center gap-1 rounded-md border py-2 bg-muted/30',
                            digit === lastDigit ? 'border-primary ring-2 ring-primary' : 'border-border'
                          )}
                        >
                          <span className="text-lg font-bold text-foreground">{digit}</span>
                          <span className="text-xs font-mono font-bold text-foreground/80">
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
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
                      {recentDigits.map((d, i) => (
                        <span
                          key={i}
                          className={cn(
                            'w-7 h-7 flex items-center justify-center rounded-md text-sm font-bold',
                            i === recentDigits.length - 1
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-foreground/85'
                          )}
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
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
                      contractTypeLabels={contractLabels}
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
                  {bot.log.length === 0 && (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      <Localize i18n_default_text="No robot activity yet — start it from the left panel." />
                    </div>
                  )}
                  {[...bot.log].reverse().map((entry: EoLogEntry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between text-xs rounded-md border border-border px-3 py-2"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {entry.signalClass && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-muted text-foreground/80">
                            {eoClassLabel(entry.signalClass, localize)} {localize('run')}
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
                          <span className="tabular-nums font-mono font-semibold text-foreground">
                            {entry.exitSpot.toFixed(pipSize)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums text-foreground/70">
                          {localize('Stake')} {entry.stake.toFixed(2)}
                        </span>
                        <span className={entry.won ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                          {entry.won ? localize('Win') : localize('Loss')}
                        </span>
                        <span
                          className={cn(
                            'tabular-nums font-bold',
                            entry.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          )}
                        >
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

          <Card className="panel-glow bg-card/60 backdrop-blur-md h-fit">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                <Localize i18n_default_text="Manual mode" />
              </CardTitle>
              <p className="text-xs font-semibold text-foreground/90">
                {activeSymbol?.underlying_symbol_name ?? localize('Select a market')}
              </p>
            </CardHeader>
            <CardContent>
              {botRunning && (
                <p className="text-xs text-amber-500 bg-amber-500/10 rounded-md px-2.5 py-1.5 mb-3">
                  <Localize i18n_default_text="Manual trading is paused while the robot is running." />
                </p>
              )}
              <fieldset disabled={botRunning} className="space-y-3 border-0 p-0 m-0 min-w-0 max-w-md">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-foreground/90">
                    <Localize i18n_default_text="Trade Type" />
                  </Label>
                  <Select value={tradeType} onValueChange={(v) => setTradeType(v as TradeType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tradeTypeOptions.map((opt) => (
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
        </div>
      </div>
    </>
  );
}
