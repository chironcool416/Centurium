import { getLastDigit } from '@/lib/digit-stats';

/**
 * Pure analysis for the AI Scanner. Given a market's recent ticks it scores
 * the "Over N" and "Under (9-N)" digit contracts and decides whether either
 * is a clean enough setup to trade.
 *
 * A setup must clear several independent filters (sample size, statistical
 * edge, consistency across the window, recent behaviour, loss-streak risk).
 * Anything that fails is "noisy / low confidence" and gets blocked.
 */

export type ScanSide = 'over' | 'under';

export interface ScanCandidate {
  symbol: string;
  symbolName: string;
  side: ScanSide;
  /** Contract barrier (Over N → N, Under B → B). */
  barrier: number;
  /** Win probability if digits were uniform (e.g. 0.6). */
  theoretical: number;
  /** Observed win rate over the whole window (0-1). */
  winRate: number;
  /** Observed win rate over the most recent 20% of the window. */
  recentRate: number;
  /** Observed win rate over the last 50 ticks. */
  last50Rate: number;
  /** Win rate of each of 5 equal slices of the window, oldest → newest. */
  segmentRates: number[];
  /** z-score of the observed win rate vs. the theoretical one. */
  z: number;
  /** Longest run of losing ticks in the window. */
  maxLossStreak: number;
  /** Losing-run length we would expect by chance for this window. */
  expectedLossStreak: number;
  sampleSize: number;
  /** Rank score (higher = better); only meaningful when `passes`. */
  score: number;
  passes: boolean;
  /** Why a setup was blocked (empty when it passes). */
  blockedBy: string[];
}

export const SCAN_MIN_SAMPLE = 500;
export const SCAN_MIN_Z = 2;
export const SCAN_SEGMENTS = 5;

/** Over N wins on digits > N; Under B wins on digits < B. */
export function sideWins(side: ScanSide, barrier: number, digit: number): boolean {
  return side === 'over' ? digit > barrier : digit < barrier;
}

export function theoreticalWinRate(side: ScanSide, barrier: number): number {
  return side === 'over' ? (9 - barrier) / 10 : barrier / 10;
}

function rate(wins: boolean[], from: number, to: number): number {
  const slice = wins.slice(from, to);
  if (slice.length === 0) return 0;
  let w = 0;
  for (const x of slice) if (x) w++;
  return w / slice.length;
}

export function analyseSide(
  symbol: string,
  symbolName: string,
  digits: number[],
  side: ScanSide,
  barrier: number
): ScanCandidate {
  const n = digits.length;
  const p0 = theoreticalWinRate(side, barrier);
  const wins = digits.map((d) => sideWins(side, barrier, d));

  const winRate = rate(wins, 0, n);
  const recentRate = rate(wins, Math.floor(n * 0.8), n);
  const last50Rate = rate(wins, Math.max(0, n - 50), n);

  const segSize = Math.floor(n / SCAN_SEGMENTS);
  const segmentRates: number[] = [];
  for (let i = 0; i < SCAN_SEGMENTS; i++) {
    segmentRates.push(rate(wins, i * segSize, i === SCAN_SEGMENTS - 1 ? n : (i + 1) * segSize));
  }

  let maxLossStreak = 0;
  let run = 0;
  for (const w of wins) {
    run = w ? 0 : run + 1;
    if (run > maxLossStreak) maxLossStreak = run;
  }
  const expectedLossStreak =
    n > 1 ? Math.ceil(Math.log(n) / -Math.log(1 - p0)) : 0;

  const se = Math.sqrt((p0 * (1 - p0)) / Math.max(n, 1));
  const z = se > 0 ? (winRate - p0) / se : 0;

  const blockedBy: string[] = [];
  if (n < SCAN_MIN_SAMPLE) blockedBy.push('not enough ticks');
  if (z < SCAN_MIN_Z) blockedBy.push('edge not significant');
  if (segmentRates.some((r) => r < p0)) blockedBy.push('inconsistent across the window');
  if (recentRate < p0) blockedBy.push('edge fading recently');
  if (last50Rate < p0 - 0.05) blockedBy.push('weak last 50 ticks');
  if (maxLossStreak > expectedLossStreak + 2) blockedBy.push('long losing runs');

  const minSeg = segmentRates.length ? Math.min(...segmentRates) : 0;
  const score = z + (minSeg - p0) * 20 + (recentRate - p0) * 10 - Math.max(0, maxLossStreak - expectedLossStreak) * 0.25;

  return {
    symbol,
    symbolName,
    side,
    barrier,
    theoretical: p0,
    winRate,
    recentRate,
    last50Rate,
    segmentRates,
    z,
    maxLossStreak,
    expectedLossStreak,
    sampleSize: n,
    score,
    passes: blockedBy.length === 0,
    blockedBy,
  };
}

/** Over `overBarrier` and Under `9 - overBarrier` for one market. */
export function analyseMarket(
  symbol: string,
  symbolName: string,
  prices: number[],
  pipSize: number,
  overBarrier: number
): ScanCandidate[] {
  const digits = prices.map((p) => getLastDigit(p, pipSize));
  return [
    analyseSide(symbol, symbolName, digits, 'over', overBarrier),
    analyseSide(symbol, symbolName, digits, 'under', 9 - overBarrier),
  ];
}
