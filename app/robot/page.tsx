'use client';

import { useDigitsTrading } from '../../hooks/use-digits-trading';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import { TradeRobotView } from '@/components/custom/trade-robot-view';

export default function RobotPage() {
  const logoSrc = useLogoSrc();
  const { ws, isConnected, isExhausted, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;
  const trading = useDigitsTrading({
    ws,
    isConnected,
    isExhausted,
    isAuthenticated: !!auth.wsUrl,
    onAuthWSFailed: logout,
  });

  const isAuthenticated = authState === 'authenticated';
  const balanceLabel =
    isAuthenticated && activeAccount
      ? `${Number(activeAccount.balance).toFixed(2)} ${activeAccount.currency}`
      : null;

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
        onLogin={login}
        onSignUp={signUp}
        onLogout={logout}
        onSwitchAccount={switchAccount}
        logoSrc={logoSrc}
        actions={<ThemeToggle />}
      />

      {/* Spacer to push content below the fixed header */}
      <div className={isAuthenticated ? 'h-[76px] shrink-0' : 'h-[66px] shrink-0'} />

      <div className="flex-1 pb-16">
        <TradeRobotView
          isConnected={trading.isConnected}
          isAuthenticated={isAuthenticated}
          balanceLabel={balanceLabel}
          symbols={trading.symbols}
          activeSymbol={trading.activeSymbol}
          selectSymbol={trading.selectSymbol}
          currentTick={trading.currentTick}
          pipSize={trading.pipSize}
          tradeType={trading.tradeType}
          setTradeType={trading.setTradeType}
          contractMode={trading.contractMode}
          setContractMode={trading.setContractMode}
          selectedDigit={trading.selectedDigit}
          setSelectedDigit={trading.setSelectedDigit}
          stake={trading.stake}
          setStake={trading.setStake}
          duration={trading.duration}
          setDuration={trading.setDuration}
          durationLimits={trading.durationLimits}
          proposal={trading.proposal}
          isProposalLoading={trading.isProposalLoading}
          buyContract={trading.buyContract}
          isBuying={trading.isBuying}
          buyResult={trading.buyResult}
          buyError={trading.buyError}
          clearBuyResult={trading.clearBuyResult}
          openPositions={trading.openPositions}
          closedPositions={trading.closedPositions}
          sellContract={trading.sellContract}
          sellingId={trading.sellingId}
          sellError={trading.sellError}
          clearSellError={trading.clearSellError}
        />
      </div>

      {/* Fixed footer */}
      <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm">
        <Footer />
      </div>
    </main>
  );
}
