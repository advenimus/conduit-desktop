/**
 * One run of the cycle body (spec 5.6): the alive check every await is followed by (engine
 * stopped, the cycle's own deadline, the final cycle's cap), and the mapping of an aborted or
 * failed body to its outcome, so a body error never escapes the lane.
 */

import { CycleAborted, type CycleEnv } from './sync-cycle.js';
import { errMeta } from './sync-engine-local.js';
import type { CycleOutcome, SyncEngineSeams, SyncTrigger } from './sync-engine-types.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';

export const STOPPED: CycleOutcome = { kind: 'skipped', reason: 'stopped' };

export type CycleBody = NonNullable<SyncEngineSeams['runCycleBody']>;

export interface AliveInput {
  readonly stopped: boolean;
  readonly nowMs: number;
  readonly deadlineMs: number | undefined;
  readonly finalDeadlineMs: number | null;
}

/** Throws CycleAborted when the engine stopped or a deadline passed. */
export function checkCycleAlive(input: AliveInput): void {
  if (input.stopped) throw new CycleAborted('stopped');
  if (input.deadlineMs !== undefined && input.nowMs >= input.deadlineMs) throw new CycleAborted('deadline');
  if (input.finalDeadlineMs !== null && input.nowMs >= input.finalDeadlineMs) throw new CycleAborted('deadline');
}

export async function runCycleBody(body: CycleBody, env: CycleEnv, reason: SyncTrigger, logger: SyncLogger): Promise<CycleOutcome> {
  try {
    return await body(env, reason);
  } catch (err) {
    if (err instanceof CycleAborted) {
      logger.debug(`${SYNC_LOG_PREFIX} cycle aborted`, { reason, why: err.why });
      return STOPPED;
    }
    logger.error(`${SYNC_LOG_PREFIX} cycle failed`, { reason, ...errMeta(err) });
    return { kind: 'error', message: errMeta(err).name };
  }
}
