'use client';

import { useEffect, useState } from 'react';

interface TypewriterHeadingProps {
  /** The full line to type out. */
  text: string;
  /** Class names for the <h1> (font, size, colour, etc.). */
  className?: string;
  /** Hold off typing until this is true (e.g. until the intro splash is gone). */
  active?: boolean;
  /** Milliseconds between letters. */
  charDelayMs?: number;
  /** How long the finished line (with its blinking cursor) stays up before typing starts over. */
  restartAfterMs?: number;
}

/** Pause between the line clearing and the first letter of the next round. */
const RESTART_PAUSE_MS = 700;

/**
 * Types `text` out left to right, one letter at a time, starting at the first
 * letter and ending at the last. A cursor sits right after the last typed
 * letter: solid while typing, blinking once the line is complete. After
 * `restartAfterMs` the line clears and types itself out again, forever.
 *
 * The full text is rendered invisibly underneath so the heading takes up its
 * final size from the start, and the page doesn't jump as letters appear.
 * Screen readers get the complete sentence immediately.
 */
export function TypewriterHeading({
  text,
  className,
  active = true,
  charDelayMs = 70,
  restartAfterMs = 20_000,
}: TypewriterHeadingProps) {
  const chars = Array.from(text);
  const total = chars.length;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active || total === 0) {
      setCount(0);
      return;
    }

    // Respect "reduce motion": show the whole line with a steady cursor.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setCount(total);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    let typed = 0;

    const typeNext = () => {
      typed += 1;
      setCount(typed);
      if (typed < total) {
        timer = setTimeout(typeNext, charDelayMs);
      } else {
        // Finished: cursor blinks for `restartAfterMs`, then start over.
        timer = setTimeout(() => {
          typed = 0;
          setCount(0);
          timer = setTimeout(typeNext, RESTART_PAUSE_MS);
        }, restartAfterMs);
      }
    };

    setCount(0);
    timer = setTimeout(typeNext, charDelayMs);
    return () => clearTimeout(timer);
  }, [active, text, total, charDelayMs, restartAfterMs]);

  const isTyping = count > 0 && count < total;
  const showCaret = active;

  return (
    <h1 className={className} aria-label={text}>
      <span className="relative inline-block text-left">
        {/* Invisible full text: reserves the final width/height. */}
        <span aria-hidden className="invisible">
          {text}
        </span>
        <span aria-hidden className="absolute inset-x-0 top-0">
          {chars.slice(0, count).join('')}
          {showCaret && (
            <span
              className={`typewriter-caret${isTyping ? ' typewriter-caret--typing' : ''}`}
            />
          )}
        </span>
      </span>
    </h1>
  );
}
