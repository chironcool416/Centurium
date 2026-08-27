'use client';

/**
 * Public homepage. Simple welcome screen with entry points into the two
 * functional apps (Digits manual trading and the Robot/analysis view).
 * Doesn't require auth — Header shows Log in / Sign up until the user
 * authenticates from inside one of the apps.
 */

import Link from 'next/link';
import { Localize } from '@deriv-com/translations';
import { LineChart, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { brandDisplay } from '@/lib/fonts';

function resolveAppName(): string {
  return process.env.NEXT_PUBLIC_DERIV_APP_NAME?.trim() || 'Deriv Trading';
}

export default function HomePage() {
  const logoSrc = useLogoSrc();
  const { localize } = useAppTranslations();
  const { auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;
  const appName = resolveAppName();

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

        <div className="mt-10 grid w-full max-w-2xl gap-4 sm:grid-cols-2">
          <Card className="panel-glow bg-card/30 backdrop-blur-md text-left">
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
              <Button asChild className="mt-1 w-full">
                <Link href="/digits">
                  <Localize i18n_default_text="Open Digits" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="panel-glow bg-card/30 backdrop-blur-md text-left">
            <CardContent className="flex flex-col gap-3 pt-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Zap className="h-5 w-5" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                <Localize i18n_default_text="Robot" />
              </h2>
              <p className="text-sm text-muted-foreground">
                <Localize i18n_default_text="Digit frequency analysis, recent ticks and trade history alongside manual controls." />
              </p>
              <Button asChild variant="outline" className="mt-1 w-full">
                <Link href="/robot">
                  <Localize i18n_default_text="Open Robot" />
                </Link>
              </Button>
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
