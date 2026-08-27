'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Home, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

export const TOP_NAV_RAIL_HEIGHT = 40; // px — kept in sync with header.tsx's top offset

const linkClass = (active: boolean) =>
  cn(
    'flex items-center justify-center w-8 h-8 rounded-lg transition-colors duration-300',
    active ? 'bg-teal-600' : 'bg-transparent hover:bg-teal-800/50'
  );

/**
 * Preserves the current query string (e.g. ?symbol=1HZ100V) when switching
 * between Home and Operations. Isolated in its own component so the
 * useSearchParams() call — which requires a Suspense boundary to avoid
 * breaking static prerendering — doesn't hold up the rest of the nav bar.
 */
function NavLinks({ isHome, isOperations }: { isHome: boolean; isOperations: boolean }) {
  const searchParams = useSearchParams();
  const query = searchParams?.toString();
  const suffix = query ? `?${query}` : '';

  return (
    <>
      <Link href={`/${suffix}`} title="Home" aria-current={isHome ? 'page' : undefined} className={linkClass(isHome)}>
        <Home className="w-[18px] h-[18px] text-white" strokeWidth={2} />
      </Link>
      <Link
        href={`/robot${suffix}`}
        title="Operations"
        aria-current={isOperations ? 'page' : undefined}
        className={linkClass(isOperations)}
      >
        <Zap className="w-[18px] h-[18px] text-white" strokeWidth={2} />
      </Link>
    </>
  );
}

/** Plain fallback (no query preserved yet) shown only for the first paint. */
function NavLinksFallback({ isHome, isOperations }: { isHome: boolean; isOperations: boolean }) {
  return (
    <>
      <Link href="/" title="Home" aria-current={isHome ? 'page' : undefined} className={linkClass(isHome)}>
        <Home className="w-[18px] h-[18px] text-white" strokeWidth={2} />
      </Link>
      <Link href="/robot" title="Operations" aria-current={isOperations ? 'page' : undefined} className={linkClass(isOperations)}>
        <Zap className="w-[18px] h-[18px] text-white" strokeWidth={2} />
      </Link>
    </>
  );
}

/**
 * Slim, fixed navigation rail pinned to the very top of the app, above the
 * existing per-page Header. Lets the user jump between the Home (Digits)
 * page and the Robot/Operations dashboard. Lives inside ViewportScaler's
 * measured subtree so it scales in lockstep with the rest of the page on
 * mobile instead of drifting out of alignment with the header beneath it.
 */
export function TopNavRail() {
  const pathname = usePathname();
  const isHome = pathname === '/';
  const isOperations = pathname?.startsWith('/robot') ?? false;

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-[60] flex items-center gap-1.5 px-3 bg-teal-950 border-b border-teal-900/60"
      style={{ height: TOP_NAV_RAIL_HEIGHT }}
      aria-label="Primary"
    >
      <Suspense fallback={<NavLinksFallback isHome={isHome} isOperations={isOperations} />}>
        <NavLinks isHome={isHome} isOperations={isOperations} />
      </Suspense>
    </nav>
  );
}
