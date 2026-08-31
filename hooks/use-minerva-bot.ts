'use client';

/**
 * Minerva's automated bot hook. Minerva runs the same "Eye of Ra" strategy
 * as Operations (see `use-ra-bot.ts` for the full detection/execution
 * writeup) — nothing here changes the logic, this file just gives Minerva
 * its own import path so future Minerva-specific behavior can diverge
 * without touching Operations' Ra bot.
 */
export {
  useRaBot as useMinervaBot,
  type RaSide as MinervaSide,
  type RaTradingMode as MinervaTradingMode,
  type RaRunStrategy as MinervaRunStrategy,
  type RaStopReason as MinervaStopReason,
  type RaPhase as MinervaPhase,
  type RaBurstOutcome as MinervaBurstOutcome,
  type RaLogEntry as MinervaLogEntry,
} from './use-ra-bot';
