/**
 * Decorators the engine puts around ports it hands to the cycle: the session tap records the
 * state of every S read (lastSharedState, the covers check that settles the regression
 * back-off), and the notices tap shows the 5.7 back-off toast once per back-off and the
 * publish-failed toast once per failure episode (5.6 back-off), whichever module asks for it.
 */

import type { NoticesPort } from './notices.js';
import { isSettled } from './sync-engine-outcome.js';
import type { CycleOutcome } from './sync-engine-types.js';
import type { SessionSignals, TransientNotice } from './host.js';
import type { SyncState } from './types.js';

export function tapSession(inner: SessionSignals, onSharedRead: (state: SyncState) => void): SessionSignals {
  return {
    softLocked: () => inner.softLocked(),
    serverSideFilesFlagRecent: (nowMs) => inner.serverSideFilesFlagRecent(nowMs),
    sessions: () => inner.sessions(),
    sessionOpen: () => inner.sessionOpen(),
    afterMerge: (state) => inner.afterMerge(state),
    published: (marker) => inner.published(marker),
    sharedRead: (state) => {
      onSharedRead(state);
      inner.sharedRead(state);
    },
    sideFilesChanged: (present) => inner.sideFilesChanged(present),
  };
}

/**
 * One toast per episode, whoever asks: 5.7 "OneDrive keeps restoring an older copy" per
 * back-off, and "publish failed" until a cycle settles or the user asks for "Sync now" (a
 * folder that refuses writes must not toast on every retry of the 5.6 back-off).
 */
export class EpisodeToastGate {
  private regressionShown: TransientNotice | null = null;
  private publishFailedShown: TransientNotice | null = null;
  /** The notices port handed to the cycle (duplicate episode toasts are swallowed). */
  readonly port: NoticesPort;

  constructor(inner: NoticesPort) {
    this.port = {
      add: (input) => inner.add(input),
      addFromCapture: (notices) => inner.addFromCapture(notices),
      dismiss: (id) => inner.dismiss(id),
      list: () => inner.list(),
      remindDue: (key, intervalMs) => inner.remindDue(key, intervalMs),
      toast: (kind, params) => {
        if (kind === 'regression-backoff') {
          this.regressionShown ??= inner.toast(kind, params);
          return this.regressionShown;
        }
        if (kind === 'publish-failed') {
          this.publishFailedShown ??= inner.toast(kind, params);
          return this.publishFailedShown;
        }
        return inner.toast(kind, params);
      },
    };
  }

  /** After each cycle: toast when publishing is backed off; a cycle outside any back-off or a settled one ends its episode. */
  afterCycle(o: CycleOutcome, blockedUntilMs: number | null, fileName: string | null): void {
    if (o.kind === 'merged-not-published' && o.reason === 'regression-backoff') {
      this.port.toast('regression-backoff', { fileName, untilMs: blockedUntilMs });
    } else if (blockedUntilMs === null) {
      this.regressionShown = null;
    }
    if (isSettled(o)) this.publishFailedShown = null;
  }

  /** "Sync now" is an explicit request: its failure is reported again. */
  userRetry(): void {
    this.publishFailedShown = null;
  }
}
