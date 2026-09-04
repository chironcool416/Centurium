'use client';

/**
 * Full-screen intro splash shown once when the Minerva page mounts, before
 * the MinervaView panel appears. Same flicker/glow technique as the
 * homepage's `IntroSplash`, but held for 8s instead of 10s, re-themed
 * bronze/gold to match the Automaton Minerva emblem, and with no dark scrim
 * behind it — the emblem PNG is already transparent, so it glows directly
 * over the page's own background. Always plays at full length, regardless
 * of the visitor's OS/browser reduce-motion preference.
 */

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

const FLICKER_DURATION_MS = 8_000;
const FADE_OUT_MS = 800;

export function MinervaSplash({ onFinished }: { onFinished: () => void }) {
  const [fadingOut, setFadingOut] = useState(false);
  const holdDuration = FLICKER_DURATION_MS;

  // The Minerva page re-renders constantly (live WS ticks, balance updates),
  // which would otherwise recreate `onFinished` every render. Stashing it in
  // a ref lets the timer effect below run exactly once on mount instead of
  // restarting the 20s countdown on every parent re-render.
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    const duration = FLICKER_DURATION_MS;

    const fadeTimer = setTimeout(() => setFadingOut(true), duration);
    const doneTimer = setTimeout(() => onFinishedRef.current(), duration + FADE_OUT_MS);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
