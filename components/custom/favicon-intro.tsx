'use client';

/**
 * Ultra-short "intro before the intro" — plays once on mount, before the
 * full IntroSplash (emblem + hero background). Shows only the favicon mark,
 * split into two stacked layers so the wreath can orbit independently:
 *
 *  - favicon-orbit-base.png   — black circle + helmet silhouette (static)
 *  - favicon-orbit-wreath.png — just the two laurel branches (rotates)
 *
 * The soldier stays perfectly still while the wreath completes three full
 * 360° rotations over 6s (one every 2s, ease-in-out), landing back exactly
 * on its starting position — then the whole overlay fades out. Always
 * plays at full length, regardless of the visitor's OS/browser
 * reduce-motion preference.
 */

import { useEffect, useState } from 'react';
import Image from 'next/image';

const HOLD_DURATION_MS = 6_000;
const FADE_OUT_MS = 500;

export function FaviconIntro({ onFinished }: { onFinished: () => void }) {
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    const duration = HOLD_DURATION_MS;

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
      className={`fixed inset-0 z-[110] flex items-center justify-center bg-black transition-opacity ease-out ${
        fadingOut ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
    >
      <div className="favicon-intro-glow absolute h-[40vmin] w-[40vmin] rounded-full" />
      <div className="relative h-28 w-28 sm:h-36 sm:w-36">
        <Image
          src="/favicon-orbit-base.png"
          alt=""
          fill
          priority
          className="favicon-intro-base select-none"
        />
        <Image
          src="/favicon-orbit-wreath.png"
          alt=""
          fill
          priority
          className="favicon-intro-wreath select-none"
        />
      </div>
    </div>
  );
}
