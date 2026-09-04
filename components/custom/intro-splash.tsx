'use client';

/**
 * Full-screen intro splash shown once when the homepage mounts, before the
 * Digits/Robot panels appear. Reuses the same hero background as the
 * homepage; the Centurium emblem blinks/glows on top of it for ~10s, then
 * the whole overlay fades out and unmounts.
 *
 * Same two-layer technique as FaviconIntro, but in true 3D: the laurel
 * wreath (centurium-orbit-wreath.png) and the ring+helmet base
 * (centurium-orbit-base.png) are fused into one rigid "coin" that spins
 * together in place on its vertical axis, counterclockwise, as a two-sided
 * flip card (front/back faces, each stacking base+wreath) so the same
 * emblem reappears on the other side as it turns, looped for the whole
 * hold instead of a fixed cycle count.
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
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-opacity ease-out ${
        fadingOut ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
    >
      {/* Background sits on its own heavily blurred/scaled layer so the
          hero photo's own emblem and text read as an out-of-focus backdrop
          rather than a second logo competing with the orbit emblem above. */}
      <div
        aria-hidden
        className="absolute inset-0 scale-110 bg-cover bg-center blur-2xl"
        style={{ backgroundImage: "url('/hero-bg.jpg')" }}
      />
      {/* Near-black scrim so the background photo all but disappears,
          letting the emblem's glow read as the only light source. */}
      <div className="absolute inset-0 bg-black/95" />
      <div className="intro-emblem-glow absolute h-[70vmin] w-[70vmin] rounded-full" />
      <div className="relative flex flex-col items-center gap-8">
        <div className="intro-emblem relative h-72 w-72 select-none sm:h-96 sm:w-96 md:h-[28rem] md:w-[28rem] lg:h-[32rem] lg:w-[32rem]">
          <div className="intro-emblem-coin-scene">
            <div className="intro-emblem-coin">
              {/* Front face: base beneath, wreath layered on top, both
                  sharing the identity (unrotated) transform so they appear
                  and disappear together as the coin turns. */}
              <Image
                src="/centurium-orbit-base.png"
                alt="Centurium Capital"
                fill
                priority
                className="intro-emblem-coin-face intro-emblem-coin-face-front object-contain"
              />
              <Image
                src="/centurium-orbit-wreath.png"
                alt=""
                fill
                priority
                className="intro-emblem-coin-face intro-emblem-coin-face-front object-contain"
              />
              {/* Back face: same pair, mirrored via rotateY(180deg) scaleX(-1)
                  so the reveal reads as "the other side" of one solid coin. */}
              <Image
                src="/centurium-orbit-base.png"
                alt=""
                fill
                priority
                className="intro-emblem-coin-face intro-emblem-coin-face-back object-contain"
              />
              <Image
                src="/centurium-orbit-wreath.png"
                alt=""
                fill
                priority
                className="intro-emblem-coin-face intro-emblem-coin-face-back object-contain"
              />
            </div>
          </div>
        </div>
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
