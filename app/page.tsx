'use client';

/**
 * Minerva panel. Placeholder page — the shell (header, footer, background)
 * matches Digits/Robot so the panel is ready to receive real content later.
 */

import { Localize } from '@deriv-com/translations';
import { Shield } from 'lucide-react';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';

export default function MinervaPage() {
  const logoSrc = useLogoSrc();
  const { auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  return (
    <main className="relative flex flex-col bg-background/30 max-lg:h-dvh max-lg:overflow-y-auto lg:min-h-dvh">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center"
        style={{ backgroundImage: "url('/home-bg.jpg')" }}
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
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Shield className="h-7 w-7" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-wide text-foreground sm:text-3xl">
          <Localize i18n_default_text="Minerva" />
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground sm:text-base">
          <Localize i18n_default_text="This panel is empty for now — content coming soon." />
        </p>
      </div>

      {/* Fixed footer */}
      <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm">
        <Footer />
      </div>
    </main>
  );
}
