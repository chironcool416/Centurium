'use client';

/**
 * Floating "Contact support" button shown on the homepage, Operations and
 * Minerva. Sits bottom-right, just above the fixed footer. Hover/focus
 * reveals a "Contact support" label; clicking opens the Telegram chat in a
 * new tab.
 */

import { MessageCircle } from 'lucide-react';
import { useAppTranslations } from '@/components/custom/i18n-provider';

// Telegram chat opened by the button.
const SUPPORT_TELEGRAM_URL = 'https://t.me/nordith_007';

export function SupportButton() {
  const { localize } = useAppTranslations();

  return (
    <div className="group fixed bottom-16 right-4 z-40 sm:right-6">
      <span
        role="tooltip"
        className="pointer-events-none absolute right-full top-1/2 mr-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-md border border-border bg-card/90 px-3 py-1.5 text-sm font-medium text-foreground opacity-0 shadow-lg backdrop-blur-md transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100"
      >
        {localize('Contact support')}
      </span>
      <a
        href={SUPPORT_TELEGRAM_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={localize('Contact support')}
        className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card/60 text-foreground shadow-lg backdrop-blur-md transition-transform duration-200 hover:scale-110 hover:shadow-[0_0_24px_4px_rgba(59,130,246,0.45)] focus-visible:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MessageCircle className="h-6 w-6" />
      </a>
    </div>
  );
}
