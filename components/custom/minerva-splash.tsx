'use client';

/**
 * Full-screen intro splash shown once when the Minerva page mounts, before
 * the MinervaView panel appears. Same flicker/glow technique as the
 * homepage's `IntroSplash`, but held for 20s instead of 10s, re-themed
 * bronze/gold to match the Automaton Minerva emblem, and with no dark scrim
 * behind it — the emblem PNG is already transparent, so it glows directly
 * over the page's own background.
 */

import { useEffect, useState } from 'react';
import Image from 'next/image';

const FLICKER_DURATION_MS = 20_000;
const FADE_OUT_MS = 800;
// Respect prefers-reduced-motion: skip the flicker, just hold + fade quickly.
const REDUCED_MOTION_DURATION_MS = 2_000;

export function MinervaSplash({ onFinished }: { onFinished: () => void }) {
  const [fadingOut, setFadingOut] = useState(false);
  const [holdDuration, setHoldDuration] = useState(FLICKER_DURATION_MS);

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = prefersReducedMotion
      ? REDUCED_MOTION_DURATION_MS
      : FLICKER_DURATION_MS;
    setHoldDuration(duration);

    const fadeTimer = setTimeout(() => setFadingOut(true), duration);
    const doneTimer = setTimeout(() => onFinished(), duration + FADE_OUT_MS);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [onFinished]);

  return (
    <div
      role="presentation"
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity ease-out ${
        fadingOut ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
    >
      <div className="minerva-emblem-glow absolute h-[70vmin] w-[70vmin] rounded-full" />
      <div className="relative flex flex-col items-center gap-8">
        <Image
          src="/minerva-emblem.png"
          alt="Automaton Minerva"
          width={1222}
          height={785}
          priority
          className="minerva-emblem h-auto w-72 select-none sm:w-96 md:w-[28rem] lg:w-[32rem]"
        />
        <p className="minerva-loading-text text-center text-sm font-medium uppercase tracking-[0.3em] text-amber-200 sm:text-base">
          Loading Automaton Minerva...
        </p>
        <div className="intro-loading-track h-1.5 w-56 rounded-full sm:w-72">
          <div
            className="minerva-loading-fill rounded-full"
            style={{ animationDuration: `${holdDuration}ms` }}
          />
        </div>
      </div>
    </div>
  );
}
