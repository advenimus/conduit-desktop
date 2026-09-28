/**
 * The rollback stack of the open sequence, which makes a failed open leave nothing half open
 * (spec 6.3). Host-timer bounds on its steps use sync-engine-timers.raceTimeout.
 */

import { SESSION_LOG_PREFIX, type SyncLogger } from '../sync/host.js';
import { errCode } from './open-staging.js';

interface RollbackStep {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

/** Undo steps of a partly done open, run in reverse order; each failure is logged and the rest still run. */
export class Rollback {
  private readonly steps: RollbackStep[] = [];

  constructor(private readonly logger: SyncLogger) {}

  push(label: string, run: () => void | Promise<void>): void {
    this.steps.push({ label, run });
  }

  async run(): Promise<void> {
    for (const step of [...this.steps].reverse()) {
      try {
        await step.run();
      } catch (err) {
        this.logger.error(`${SESSION_LOG_PREFIX} open: rollback step failed`, { step: step.label, code: errCode(err) });
      }
    }
    this.steps.length = 0;
  }
}
