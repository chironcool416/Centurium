/**
 * Run-length ("sequence") analysis of last digits for the Multi-market view.
 *
 * A run is a stretch of consecutive ticks whose last digit satisfies the
 * chosen condition (e.g. "Over 5" = digit 6, 7, 8 or 9). This module only
 * does the counting; it makes no claim about what a run means for the next
 * tick.
 */

export type SequenceSide = 'over' | 'under';

export interface SequenceCondition {
  side: SequenceSide;
  barrier: number;
}

/** Dropdown order: Over 0 … Over 8, then Under 9 … Under 1. */
export const SEQUENCE_CONDITIONS: SequenceCondition[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ side: 'over' as const, barrier: i })),
  ...Array.from({ length: 9 }, (_, i) => ({ side: 'under' as const, barrier: 9 - i })),
];

export const MIN_RUN_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Runs of this length or longer share the last histogram bucket ("9+"). */
export const BASE_CAP = 9;

export function conditionKey(c: SequenceCondition): string {
  return `${c.side}-${c.barrier}`;
}

export function parseConditionKey(key: string): SequenceCondition {
  const [side, barrier] = key.split('-');
  return { side: side === 'under' ? 'under' : 'over', barrier: Number(barrier) };
}

export function conditionLabel(c: SequenceCondition): string {
  return `${c.side === 'over' ? 'Over' : 'Under'} ${c.barrier}`;
}

export function isHit(digit: number, c: SequenceCondition): boolean {
  return c.side === 'over' ? digit > c.barrier : digit < c.barrier;
}

/** Probability a single (uniform) last digit satisfies the condition. */
export function hitProbability(c: SequenceCondition): number {
  return c.side === 'over' ? (9 - c.barrier) / 10 : c.barrier / 10;
}

export interface SequenceAnalysis {
  ticks: number;
  hits: number;
  /** Length of the run still in progress at the newest tick (0 if the newest digit is a miss). */
  currentRun: number;
  /** Longest run seen, counting the one in progress. */
  longestRun: number;
  /** Lengths of runs that have ended and whose start is inside the window. */
  completedRuns: number[];
}

export function analyzeSequences(digits: number[], c: SequenceCondition): SequenceAnalysis {
  const completedRuns: number[] = [];
  let run = 0;
  let leading = false; // run touching the window's first tick: true start unknown
  let hits = 0;

  for (let i = 0; i < digits.length; i++) {
    if (isHit(digits[i], c)) {
      if (run === 0 && i === 0) leading = true;
      run++;
      hits++;
    } else {
      if (run > 0 && !leading) completedRuns.push(run);
      run = 0;
      leading = false;
    }
  }

  const longestCompleted = completedRuns.length > 0 ? Math.max(...completedRuns) : 0;
  return {
    ticks: digits.length,
    hits,
    currentRun: run,
    longestRun: Math.max(longestCompleted, run),
    completedRuns,
  };
}

export interface SequenceBin {
  /** First length in the bin. */
  from: number;
  /** True for the open-ended last bin ("9+"). */
  open: boolean;
  label: string;
}

/** Histogram buckets: one per length from `min` up to the cap, last one open-ended. */
export function buildBins(min: number): SequenceBin[] {
  const cap = Math.max(BASE_CAP, min);
  const bins: SequenceBin[] = [];
  for (let len = min; len < cap; len++) bins.push({ from: len, open: false, label: String(len) });
  bins.push({ from: cap, open: true, label: `${cap}+` });
  return bins;
}

export function countInBin(runs: number[], bin: SequenceBin): number {
  let n = 0;
  for (const r of runs) {
    if (bin.open ? r >= bin.from : r === bin.from) n++;
  }
  return n;
}

/**
 * Expected number of completed runs in a bin for `ticks` independent ticks
 * with per-tick hit probability `p` (what you'd see from pure chance).
 * Exactly length k: n(1-p)^2 p^k. At least k: n(1-p) p^k.
 */
export function expectedInBin(ticks: number, p: number, bin: SequenceBin): number {
  if (bin.open) return ticks * (1 - p) * Math.pow(p, bin.from);
  return ticks * (1 - p) * (1 - p) * Math.pow(p, bin.from);
}
