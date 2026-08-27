'use client';

/**
 * The presentational shell for the Digits app: header (logo/app name/auth),
 * connection/error/loading states, and the trading panel. All of the actual
 * control rendering (trade type, symbol, tick, digit stats, contract mode,
 * stake, duration, prediction, buy) is delegated to
 * <ConfigurableDigitsControls>, which already implements every style variant
 * and the no-code edit/rearrange modes — this view just supplies the default
 * config (variant 'a' for every block, in the default order) when no
 * `appConfig` is provided, so the app renders exactly the same whether or not
 * a no-code config exists.
 *
 * Panel glow: the trading card below uses the shared `.panel-glow` class
 * (keyframes + styles defined once in app/custom.css) for the soft, breathing
 * blue glow around the panel.
 */

import { Localize } from '@deriv-com/translations';
import { Card, CardContent } from '@/components/ui/card';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import { ConfigurableDigitsControls } from '@/components/configurable-digits-controls';
import { DEFAULT_APP_CONFIG } from '@/lib/app-config';
import type { ControlKey, DigitsAppConfig } from '@/lib/app-config';
import type {
  ActiveSymbol,
  Tick,
  AuthState,
  DerivAccount,
  DurationLimits,
  ProposalInfo,
  BuyResult,
} from '@deriv/core';
import type { ContractMode, TradeType, DigitStats } from '@/lib/types';

export interface DigitsViewProps {
  // Auth / header
  authState: AuthState;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  onLogin: () => Promise<void>;
  onSignUp: () => Promise<void>;
  onLogout: () => void;
  onSwitchAccount: (accountId: string) => Promise<void>;
  logoSrc?: string;
  appName?: string;
  showAppName?: boolean;

  // Connection / market data
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  symbols: ActiveSymbol[];
  activeSymbol: ActiveSymbol | null;
  selectSymbol: (symbol: string) => void;
  currentTick: Tick | null;
  lastDigit: number | null;
  digitStats: DigitStats;
  pipSize: number;

  // Trade controls
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

  // No-code config (optional — falls back to the default layout/styles)
  appConfig?: DigitsAppConfig;
  editMode?: boolean;
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  rearrangeMode?: boolean;
  onReorder?: (order: DigitsAppConfig['order']) => void;
}

export function DigitsView({
  authState,
  accounts,
  activeAccount,
  onLogin,
  onSignUp,
  onLogout,
  onSwitchAccount,
  logoSrc,
  appName,
  showAppName,
  isConnected,
  isLoading,
  error,
  symbols,
  activeSymbol,
  selectSymbol,
  currentTick,
  lastDigit,
  digitStats,
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
  appConfig,
  editMode,
  onSelect,
  selectedKey,
  rearrangeMode,
  onReorder,
}: DigitsViewProps) {
  const isAuthenticated = authState === 'authenticated';
  const config = appConfig ?? DEFAULT_APP_CONFIG;

  return (
    <main className="relative flex flex-col bg-background/30 max-lg:h-dvh max-lg:overflow-y-auto lg:min-h-dvh">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center"
        style={{ backgroundImage: "url('/hero-bg.jpg')" }}
      >
        <div className="absolute inset-0 bg-background/65" />
      </div>

      <Header
        authState={authState}
        accounts={accounts}
        activeAccount={activeAccount}
        onLogin={onLogin}
        onSignUp={onSignUp}
        onLogout={onLogout}
        onSwitchAccount={onSwitchAccount}
        logoSrc={logoSrc}
        appName={appName}
        showAppName={showAppName}
        actions={<ThemeToggle />}
      />

      {/* Spacer to push content below the fixed header */}
      <div className={isAuthenticated ? 'h-[76px] shrink-0' : 'h-[66px] shrink-0'} />

      <div className="flex-1 pb-16">
        <div className="w-full max-w-md mx-auto px-3 py-4 sm:px-4">
          <Card className="panel-glow bg-card/30 backdrop-blur-md">
            <CardContent className="pt-6 space-y-4">
              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              {isLoading && !activeSymbol ? (
                <div className="flex items-center justify-center py-16">
                  <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <ConfigurableDigitsControls
                  config={config}
                  symbols={symbols}
                  activeSymbol={activeSymbol}
                  selectSymbol={selectSymbol}
                  currentTick={currentTick}
                  lastDigit={lastDigit}
                  digitStats={digitStats}
                  pipSize={pipSize}
                  tradeType={tradeType}
                  onTradeTypeChange={setTradeType}
                  contractMode={contractMode}
                  onContractModeChange={setContractMode}
                  selectedDigit={selectedDigit}
                  onDigitSelect={setSelectedDigit}
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
                  isConnected={isConnected}
                  isAuthenticated={isAuthenticated}
                  editMode={editMode}
                  onSelect={onSelect as ((key: ControlKey) => void) | undefined}
                  selectedKey={selectedKey}
                  rearrangeMode={rearrangeMode}
                  onReorder={onReorder}
                />
              )}

              {!isConnected && !isLoading && !error && (
                <p className="text-center text-xs text-muted-foreground">
                  <Localize i18n_default_text="Connecting…" />
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Fixed footer */}
      <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm">
        <Footer />
      </div>
    </main>
  );
}
