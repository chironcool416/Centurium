'use client';

/**
 * Full-screen intro splash shown once when the homepage mounts, before the
 * Digits/Robot panels appear. Reuses the same hero background as the
 * homepage; the Centurium emblem blinks/glows on top of it for ~10s, then
 * the whole overlay fades out and unmounts.
 */

import { useEffect, useState } from 'react';
import Image from 'next/image';

const FLICKER_DURATION_MS = 10_000;
const FADE_OUT_MS = 800;
// Respect prefers-reduced-motion: skip the flicker, just hold + fade quickly.
const REDUCED_MOTION_DURATION_MS = 2_000;

export function IntroSplash({ onFinished }: { onFinished: () => void }) {
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
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-cover bg-center transition-opacity ease-out ${
        fadingOut ? 'opacity-0' : 'opacity-100'
      }`}
      style={{
        backgroundImage: "url('/hero-bg.jpg')",
        transitionDuration: `${FADE_OUT_MS}ms`,
      }}
    >
      {/* Near-black scrim so the background photo all but disappears,
          letting the emblem's glow read as the only light source. */}
      <div className="absolute inset-0 bg-black/92" />
      <div className="intro-emblem-glow absolute h-[70vmin] w-[70vmin] rounded-full" />
      <div className="relative flex flex-col items-center gap-8">
        <Image
          src="/centurium-emblem.png"
          alt="Centurium Capital"
          width={1091}
          height={1213}
          priority
          className="intro-emblem h-auto w-72 select-none sm:w-96 md:w-[28rem] lg:w-[32rem]"
        />
        <div className="intro-loading-track h-1.5 w-56 rounded-full sm:w-72">
          <div
            className="intro-loading-fill rounded-full"
            style={{ animationDuration: `${holdDuration}ms` }}
          />
        </div>
      </div>
    </div>
  );
}
