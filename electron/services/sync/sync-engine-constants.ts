/**
 * Timings of the sync loop (spec 5.6, 6.2, 6.3 step 7), in a leaf module so the engine's parts
 * and the cycle can import them without an import cycle. Re-exported by sync-engine.ts.
 */

/** 5.6 local-edit trigger: 2 s after the last edit, at most 10 s after the first. */
export const LOCAL_EDIT_IDLE_MS = 2_000;
export const LOCAL_EDIT_MAX_MS = 10_000;
/** 5.6 safety poll. */
export const SAFETY_POLL_MS = 60_000;
/** 5.6 attempts per cycle (CAS lost) and per commitMerge (generation changed). */
export const CYCLE_ATTEMPTS = 3;
export const COMMIT_ATTEMPTS = 3;
/** 5.6 "backoff 5 s doubling to 10 min". */
export const ERROR_BACKOFF_START_MS = 5_000;
export const ERROR_BACKOFF_MAX_MS = 10 * 60 * 1000;
/** 5.6 / 6.2: final cycle caps. */
export const FINAL_CYCLE_CAP_MS = 3_000;
export const DISPLACED_FINAL_CYCLE_CAP_MS = 15_000;
/** 6.3 step 7: the unlock cycle's budget (the open continues after it; the cycle is not aborted). */
export const UNLOCK_CYCLE_BUDGET_MS = 3_000;
