'use client';

import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useScannerBot } from '@/hooks/use-scanner-bot';
import type { ActiveSymbol, DerivWS } from '@deriv/core';

const PAIRS = [
  { over: 1, label: 'Over 1 / Under 8' },
  { over: 2, label: 'Over 2 / Under 7' },
  { over: 3, label: 'Over 3 / Under 6' },
] as const;

interface ScannerViewProps {
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  symbols: ActiveSymbol[];
  currency: string;
  balance: number | null;
}

const STORAGE_KEY = 'centurium:scanner-settings';

interface SavedSettings {
  over: number;
  ticks: string;
  stake: string;
  multiplier: string;
  maxSteps: string;
  takeProfit: string;
  stopLoss: string;
  rescanDelay: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function ScannerView({ ws, isConnected, isAuthenticated, symbols, currency, balance }: ScannerViewProps) {
  const [over, setOver] = useState<number>(3);
  const [ticks, setTicks] = useState('3000');
  const [stake, setStake] = useState('1');
  const [multiplier, setMultiplier] = useState('2');
  const [maxSteps, setMaxSteps] = useState('5');
  const [takeProfit, setTakeProfit] = useState('5');
  const [stopLoss, setStopLoss] = useState('20');
  const [rescanDelay, setRescanDelay] = useState('5');
  const [loaded, setLoaded] = useState(false);

  // Restore saved settings once on mount (kept out of the initial state so
  // server and client render the same markup).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<SavedSettings>;
        if (d.over === 1 || d.over === 2 || d.over === 3) setOver(d.over);
        if (typeof d.ticks === 'string') setTicks(d.ticks);
        if (typeof d.stake === 'string') setStake(d.stake);
        if (typeof d.multiplier === 'string') setMultiplier(d.multiplier);
        if (typeof d.maxSteps === 'string') setMaxSteps(d.maxSteps);
        if (typeof d.takeProfit === 'string') setTakeProfit(d.takeProfit);
        if (typeof d.stopLoss === 'string') setStopLoss(d.stopLoss);
        if (typeof d.rescanDelay === 'string') setRescanDelay(d.rescanDelay);
      }
    } catch {
      // Corrupt or unavailable storage — fall back to defaults.
    }
    setLoaded(true);
  }, []);

  // Save whenever a setting changes (after the initial restore).
  useEffect(() => {
    if (!loaded) return;
    try {
      const data: SavedSettings = { over, ticks, stake, multiplier, maxSteps, takeProfit, stopLoss, rescanDelay };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Non-fatal — settings just won't persist this time.
    }
  }, [loaded, over, ticks, stake, multiplier, maxSteps, takeProfit, stopLoss, rescanDelay]);

  const bot = useScannerBot({ ws, isConnected, isAuthenticated, symbols, currency, balance });
  const scanning = bot.phase === 'scanning';
  const pair = PAIRS.find((p) => p.over === over)!;
  const sel = bot.selected;

  const settings = () => ({
    initialStake: parseFloat(stake),
    multiplier: Math.max(1, parseFloat(multiplier) || 1),
    maxSteps: Math.floor(parseFloat(maxSteps) || 0),
    takeProfit: parseFloat(takeProfit) || 0,
    stopLoss: parseFloat(stopLoss) || 0,
  });

  const busy = scanning || bot.running || bot.auto;
  const canStart = !!sel && !busy && isAuthenticated;

  const runAuto = () => {
    void bot.autoRun(over, parseInt(ticks, 10), settings(), parseFloat(rescanDelay) || 5);
  };

  const progressPct = bot.progress.total ? (bot.progress.index / bot.progress.total) * 100 : 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <Card className="panel-glow bg-card/40 backdrop-blur-md">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Radar className="h-5 w-5 text-primary" /> AI Scanner
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Scans every volatility market for the cleanest {pair.label} setup — repeating until one appears — then trades it with a recovery flow. Your settings are saved on this device.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ToggleGroup
            type="single"
            value={String(over)}
            onValueChange={(v) => v && !busy && setOver(Number(v))}
            className="rounded-full bg-muted/60 p-1"
          >
            {PAIRS.map((p) => (
              <ToggleGroupItem
                key={p.over}
                value={String(p.over)}
                className="flex-1 rounded-full text-xs font-semibold data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {p.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs uppercase text-muted-foreground">Ticks to scan</Label>
              <Input value={ticks} onChange={(e) => setTicks(e.target.value)} inputMode="numeric" disabled={busy} />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs uppercase text-muted-foreground">Selected market</Label>
              <div className="flex h-9 items-center rounded-md border bg-background/50 px-3 text-sm">
                {sel ? sel.symbolName : 'Scan to find the best market'}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs uppercase text-muted-foreground">Trade type</Label>
              <div className="flex h-9 items-center rounded-md border bg-background/50 px-3 text-sm">
                {sel ? `${sel.side === 'over' ? 'Over' : 'Under'} ${sel.barrier}` : 'Waiting for scan'}
              </div>
            </div>
          </div>

          {scanning && (
            <div className="flex flex-col gap-2 rounded-lg border bg-background/40 p-3">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{bot.progress.name}</span>
                <span className="font-semibold text-foreground">{bot.progress.index}/{bot.progress.total}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-sm font-medium">Scanning {bot.progress.name} ({bot.progress.index}/{bot.progress.total})…</p>
            </div>
          )}
          {bot.auto && !scanning && (
            <p className="rounded-lg border bg-background/40 p-3 text-sm font-medium">
              Auto scan round {bot.round}: no clean setup yet. Rescanning in {bot.countdown}s…
            </p>
          )}
          {!scanning && !bot.auto && bot.message && (
            <p className="rounded-lg border bg-background/40 p-3 text-sm font-medium">{bot.message}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Button disabled={!isConnected || !isAuthenticated || busy} onClick={runAuto}>
              {bot.auto ? `Auto scanning (round ${bot.round})…` : 'Auto Scan & Trade'}
            </Button>
            <Button variant="outline" disabled={!isConnected || busy} onClick={() => bot.scan(over, parseInt(ticks, 10))}>
              {scanning && !bot.auto ? 'Scanning Markets…' : 'Scan Once'}
            </Button>
            <Button variant="destructive" disabled={!(bot.auto || scanning || bot.running)} onClick={bot.stop}>
              Stop
            </Button>
          </div>
          {!isAuthenticated && (
            <p className="text-xs text-muted-foreground">Log in to trade. Scan Once works without an account.</p>
          )}
        </CardContent>
      </Card>

      {bot.ranking.length > 0 && (
        <Card className="bg-card/40 backdrop-blur-md">
          <CardHeader className="pb-2"><CardTitle className="text-base">Scan results</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {bot.ranking.map((c) => (
              <div key={`${c.symbol}-${c.side}`} className={cn('rounded-lg border p-3 text-sm', c.passes ? 'border-primary/60' : 'opacity-70')}>
                <div className="flex justify-between font-semibold">
                  <span>{c.symbolName} · {c.side === 'over' ? 'Over' : 'Under'} {c.barrier}</span>
                  <span>{c.passes ? 'Clean' : 'Blocked'}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Win {pct(c.winRate)} vs {pct(c.theoretical)} expected · recent {pct(c.recentRate)} · z {c.z.toFixed(2)} · longest loss run {c.maxLossStreak}
                  {!c.passes && ` · ${c.blockedBy.join(', ')}`}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card/40 backdrop-blur-md">
        <CardHeader className="pb-2"><CardTitle className="text-base">Recovery &amp; limits</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Stake', stake, setStake],
              ['Multiplier', multiplier, setMultiplier],
              ['Max steps', maxSteps, setMaxSteps],
              ['Take profit', takeProfit, setTakeProfit],
              ['Stop loss', stopLoss, setStopLoss],
              ['Rescan every (s)', rescanDelay, setRescanDelay],
            ].map(([label, value, set]) => (
              <div key={label as string} className="flex flex-col gap-1">
                <Label className="text-xs uppercase text-muted-foreground">{label as string}</Label>
                <Input
                  value={value as string}
                  onChange={(e) => (set as (v: string) => void)(e.target.value)}
                  inputMode="decimal"
                  disabled={busy}
                />
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Button variant="outline" disabled={!canStart} onClick={() => sel && bot.start(sel, settings())}>
              Trade selected setup{sel ? ` (${sel.side === 'over' ? 'Over' : 'Under'} ${sel.barrier})` : ''}
            </Button>
            <Button variant="destructive" disabled={!bot.running} onClick={bot.stop}>Stop trading</Button>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center text-sm">
            <div><div className="text-xs text-muted-foreground">Wins</div><b>{bot.stats.wins}</b></div>
            <div><div className="text-xs text-muted-foreground">Losses</div><b>{bot.stats.losses}</b></div>
            <div><div className="text-xs text-muted-foreground">P/L</div><b className={bot.stats.profit >= 0 ? 'text-green-500' : 'text-red-500'}>{bot.stats.profit.toFixed(2)} {currency}</b></div>
            <div><div className="text-xs text-muted-foreground">Next stake</div><b>{bot.stats.nextStake ? bot.stats.nextStake.toFixed(2) : '—'}</b></div>
          </div>
          {bot.log.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-lg border bg-background/40 p-2 text-xs">
              {bot.log.map((l) => (
                <div key={l.id} className={cn(l.kind === 'win' && 'text-green-500', l.kind === 'loss' && 'text-red-500', l.kind === 'error' && 'text-amber-500')}>
                  {new Date(l.time).toLocaleTimeString()} — {l.text}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
