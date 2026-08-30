'use client';

/**
 * Public homepage. Simple welcome screen with entry points into the three
 * functional apps (Digits manual trading, the Operations/analysis view,
 * and the Minerva automated bot).
 * Doesn't require auth — Header shows Log in / Sign up until the user
 * authenticates from inside one of the apps.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Localize } from '@deriv-com/translations';
import { LineChart, Zap, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import { IntroSplash } from '@/components/custom/intro-splash';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { brandDisplay } from '@/lib/fonts';

function resolveAppName(): string {
  return process.env.NEXT_PUBLIC_DERIV_APP_NAME?.trim() || 'Deriv Trading';
}

type HomeCardKey = 'digits' | 'robot' | 'minerva';

/**
 * Premium hover micro-interaction for the two entry cards below.
 *
 * A plain CSS :hover can't dim the *other* card, so the hovered key is
 * tracked in React state and used to compute each card's transform/opacity.
 * The existing `.panel-glow` breathing animation is left completely alone
 * (swapping its keyframes on hover would make the glow jump instead of
 * smoothly intensify) — instead an absolutely-positioned overlay with its
 * own brighter glow fades in/out on top of it via a plain opacity
 * transition, which is what actually reads as "the glow gets brighter".
 */
function useHomeCardHover() {
  const [hovered, setHovered] = useState<HomeCardKey | null>(null);

  function cardProps(key: HomeCardKey) {
    const isHovered = hovered === key;
    const isDimmed = hovered !== null && hovered !== key;
    return {
      onMouseEnter: () => setHovered(key),
      onMouseLeave: () =>
        setHovered((current: HomeCardKey | null) => (current === key ? null : current)),
      onFocus: () => setHovered(key),
      onBlur: () =>
        setHovered((current: HomeCardKey | null) => (current === key ? null : current)),
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

  return cardProps;
}

export default function HomePage() {
  const [showIntro, setShowIntro] = useState(true);
  const logoSrc = useLogoSrc();
  const { localize } = useAppTranslations();
  const { auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;
  const appName = resolveAppName();
  const getHomeCardProps = useHomeCardHover();
  const digitsCard = getHomeCardProps('digits');
  const robotCard = getHomeCardProps('robot');
  const minervaCard = getHomeCardProps('minerva');

  return (
    <>
      {showIntro && <IntroSplash onFinished={() => setShowIntro(false)} />}
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
        <div className={authState === 'authenticated' ? 'h-[76px] shrink-0' : 'h-[66px] shrink-0'} />

        <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
          <h1
            className={`${brandDisplay.className} text-3xl font-semibold tracking-wide text-foreground sm:text-4xl`}
          >
            {localize('Welcome to {{appName}}', { appName })}
          </h1>
          <p className="mt-3 max-w-md text-sm text-muted-foreground sm:text-base">
            <Localize i18n_default_text="Trade digit contracts manually, or open the analysis view to track live ticks and place trades from one panel." />
          </p>

          <div className="mt-10 grid w-full max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div style={{ animation: 'home-panel-in 600ms cubic-bezier(0.16, 1, 0.3, 1) 0ms both' }}>
            <Card
              className={`panel-glow bg-card/30 backdrop-blur-md text-left ${digitsCard.className}`}
              style={digitsCard.style}
              onMouseEnter={digitsCard.onMouseEnter}
              onMouseLeave={digitsCard.onMouseLeave}
              onFocus={digitsCard.onFocus}
              onBlur={digitsCard.onBlur}
            >
              <div aria-hidden className={digitsCard.overlayClassName} />
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <LineChart className="h-5 w-5" />
                </div>
                <h2 className="text-base font-semibold text-foreground">
                  <Localize i18n_default_text="Digits" />
                </h2>
                <p className="text-sm text-muted-foreground">
                  <Localize i18n_default_text="Manual digit trading — pick your market, prediction and stake, and trade live." />
                </p>
                <Button
                  asChild
                  variant="outline"
                  className="mt-1 w-full hover:border-primary hover:bg-primary hover:text-primary-foreground"
                >
                  <Link href="/digits">
                    <Localize i18n_default_text="Open Digits" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
            </div>

            <div style={{ animation: 'home-panel-in 600ms cubic-bezier(0.16, 1, 0.3, 1) 130ms both' }}>
            <Card
              className={`panel-glow bg-card/30 backdrop-blur-md text-left ${robotCard.className}`}
              style={robotCard.style}
              onMouseEnter={robotCard.onMouseEnter}
              onMouseLeave={robotCard.onMouseLeave}
              onFocus={robotCard.onFocus}
              onBlur={robotCard.onBlur}
            >
              <div aria-hidden className={robotCard.overlayClassName} />
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Zap className="h-5 w-5" />
                </div>
                <h2 className="text-base font-semibold text-foreground">
                  <Localize i18n_default_text="Operations" />
                </h2>
                <p className="text-sm text-muted-foreground">
                  <Localize i18n_default_text="Digit frequency analysis, recent ticks and trade history alongside manual controls." />
                </p>
                <Button
                  asChild
                  variant="outline"
                  className="mt-1 w-full hover:border-primary hover:bg-primary hover:text-primary-foreground"
                >
                  <Link href="/robot">
                    <Localize i18n_default_text="Open Operations" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
            </div>

            <div style={{ animation: 'home-panel-in 600ms cubic-bezier(0.16, 1, 0.3, 1) 260ms both' }}>
            <Card
              className={`panel-glow bg-card/30 backdrop-blur-md text-left ${minervaCard.className}`}
              style={minervaCard.style}
              onMouseEnter={minervaCard.onMouseEnter}
              onMouseLeave={minervaCard.onMouseLeave}
              onFocus={minervaCard.onFocus}
              onBlur={minervaCard.onBlur}
            >
              <div aria-hidden className={minervaCard.overlayClassName} />
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Shield className="h-5 w-5" />
                </div>
                <h2 className="text-base font-semibold text-foreground">
                  <Localize i18n_default_text="Minerva" />
                </h2>
                <p className="text-sm text-muted-foreground">
                  <Localize i18n_default_text="Automated signal-based bot — arms on a digit streak, confirms, then trades until its take-profit or stop-loss." />
                </p>
                <Button
                  asChild
                  variant="outline"
                  className="mt-1 w-full hover:border-primary hover:bg-primary hover:text-primary-foreground"
                >
                  <Link href="/minerva">
                    <Localize i18n_default_text="Open Minerva" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
            </div>
          </div>
        </div>

        {/* Fixed footer */}
        <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm">
          <Footer />
        </div>
      </main>
    </>
  );
}
