/**
 * What a cycle outcome means for the status model and the next attempt (spec 5.6 status and
 * back-off, 5.2 torn retries, 5.7 regression back-off, 5.9 missing-file debounce), and whether
 * the safety poll waits for the error back-off. Pure.
 */

import { MISSING_DEBOUNCE_MS } from './file-binding.js';
import type { PauseReason } from './host.js';
import type { CycleOutcome } from './sync-engine-types.js';

/** 5.9: while S is missing but not yet debounced, look again once the debounce can have elapsed. */
export const MISSING_RECHECK_MS = MISSING_DEBOUNCE_MS;

export interface OutcomeFacts {
  readonly pauseReason: PauseReason | null;
  readonly fileMissing: boolean;
  readonly unreachable: boolean;
  readonly lastError: boolean;
}

const CLEAR: OutcomeFacts = { pauseReason: null, fileMissing: false, unreachable: false, lastError: false };

/** The status facts a finished cycle establishes; null when it says nothing (the engine stopped). */
export function factsForOutcome(o: CycleOutcome): OutcomeFacts | null {
  switch (o.kind) {
    case 'up-to-date':
    case 'published':
    case 'backoff':
      return CLEAR;
    case 'merged-not-published':
    case 'paused':
      return { ...CLEAR, pauseReason: o.reason };
    case 'missing':
      return { ...CLEAR, fileMissing: o.debounced };
    case 'unreachable':
      return { ...CLEAR, unreachable: true };
    case 'unreadable':
      return { ...CLEAR, pauseReason: o.retryAtMs === null ? null : 'unreadable' };
    case 'error':
      return { ...CLEAR, lastError: true };
    case 'skipped':
      if (o.reason === 'kill-switch') return { ...CLEAR, pauseReason: 'kill-switch' };
      if (o.reason === 'soft-locked') return { ...CLEAR, pauseReason: 'displaced' };
      return null;
  }
}

/** S holds everything W had when the cycle ended (the final cycle may clear pending_publish). */
export function isSettled(o: CycleOutcome | null): boolean {
  return o !== null && (o.kind === 'up-to-date' || o.kind === 'published');
}

/**
 * 5.6: while the error back-off's retry is scheduled, it decides the next attempt; the 60 s
 * safety poll must not turn "5 s doubling to 10 min" into one failed publish per minute.
 */
export function inErrorBackoff(last: CycleOutcome | null, retryAtMs: number | null): boolean {
  const failed = last?.kind === 'error' || last?.kind === 'backoff';
  return failed && retryAtMs !== null;
}

export interface PlanInputs {
  readonly nowMs: number;
  /** Error back-off: the next delay (doubles on every call). */
  readonly nextErrorDelayMs: () => number;
  /** End of the regression publish back-off, or null. */
  readonly regressionBlockedUntil: () => number | null;
}

export interface CyclePlan {
  /** Absolute time of the next attempt; null clears the retry slot. */
  readonly retryAtMs: number | null;
  readonly backoffUntilMs: number | null;
  readonly resetErrorBackoff: boolean;
}

const NOTHING: CyclePlan = { retryAtMs: null, backoffUntilMs: null, resetErrorBackoff: false };

export function planAfter(o: CycleOutcome, inp: PlanInputs): CyclePlan {
  switch (o.kind) {
    case 'up-to-date':
    case 'published':
      return { ...NOTHING, resetErrorBackoff: true };
    case 'merged-not-published': {
      if (o.reason !== 'regression-backoff') return NOTHING;
      const until = inp.regressionBlockedUntil();
      return { ...NOTHING, retryAtMs: until, backoffUntilMs: until };
    }
    case 'missing':
      return o.debounced ? NOTHING : { ...NOTHING, retryAtMs: inp.nowMs + MISSING_RECHECK_MS };
    case 'unreadable':
      return { ...NOTHING, retryAtMs: o.retryAtMs };
    case 'backoff': {
      const at = o.untilMs > inp.nowMs ? o.untilMs : inp.nowMs + inp.nextErrorDelayMs();
      return { ...NOTHING, retryAtMs: at, backoffUntilMs: at };
    }
    case 'error': {
      const at = inp.nowMs + inp.nextErrorDelayMs();
      return { ...NOTHING, retryAtMs: at, backoffUntilMs: at };
    }
    case 'paused':
    case 'unreachable':
    case 'skipped':
      return NOTHING;
  }
}
