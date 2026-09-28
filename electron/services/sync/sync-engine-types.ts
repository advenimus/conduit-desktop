/**
 * Shapes of the sync engine's public API (spec 5.6): triggers, cycle outcomes, the final cycle
 * result, the wired ports, and the test seams. Re-exported by sync-engine.ts.
 */

import type { CandidateQueuePort } from './candidate-queue.js';
import type { SideFilesPort } from './side-files.js';
import type { CopyScannerPort } from './copy-scanner.js';
import type { DivergencePort } from './divergence.js';
import type { FileBindingPort } from './file-binding.js';
import type { FileWatcherPort, FileWatchListener } from './file-watch.js';
import type { NoticesPort } from './notices.js';
import type { ReplicaPort } from './replica.js';
import type { SharedFilePort, TornTracker } from './shared-file.js';
import type { SnapshotStorePort } from './snapshots.js';
import type { SyncStatusPort } from './sync-status.js';
import type { CycleEnv } from './sync-cycle.js';
import type { Backoff, PublishVerifier, RegressionTracker } from './sync-verify.js';
import type { PauseReason, SessionSignals, SyncHost } from './host.js';
import type { AppDot, SyncState } from './types.js';

export type SyncTrigger =
  | 'unlock'
  | 'local-edit'
  | 'full-pass'
  | 'shared-changed'
  | 'focus'
  | 'sync-now'
  | 'safety-poll'
  | 'session-hint'
  | 'verify'
  | 'retry'
  | 'final';

export type FinalKind = 'lock' | 'quit' | 'displaced';

export type CycleOutcome =
  /** digest(M) == digest(S1) and no content repair: nothing to publish. */
  | { readonly kind: 'up-to-date'; readonly merged: boolean }
  | { readonly kind: 'published'; readonly sha256: string; readonly marker: AppDot }
  /** Merged into W, publishing blocked (side files, epoch pause, foreign, regression back-off...). */
  | { readonly kind: 'merged-not-published'; readonly reason: PauseReason }
  /** Nothing merged: epoch pause, foreign file. */
  | { readonly kind: 'paused'; readonly reason: PauseReason }
  | { readonly kind: 'missing'; readonly debounced: boolean }
  | { readonly kind: 'unreachable'; readonly code: string }
  /** Torn S: next check at retryAtMs; null after quarantine and republish. */
  | { readonly kind: 'unreadable'; readonly retryAtMs: number | null }
  /** Three CAS attempts lost, or an error: next attempt after back-off. */
  | { readonly kind: 'backoff'; readonly untilMs: number }
  | { readonly kind: 'skipped'; readonly reason: 'kill-switch' | 'soft-locked' | 'stopped' }
  | { readonly kind: 'error'; readonly message: string };

export interface FinalOutcome {
  readonly published: boolean;
  /** The cap elapsed before the cycle finished (the cycle is abandoned at its next await). */
  readonly timedOut: boolean;
  /** local.json pending_publish after the final cycle. */
  readonly pendingPublish: boolean;
  /** Marker of the last successful publish of this session (release written_vv), or null. */
  readonly marker: AppDot | null;
}

export interface RunOptions {
  /** Absolute deadline (host clock) after which the cycle stops at its next await. */
  readonly deadlineMs?: number;
}

export interface SyncEngineDeps {
  readonly host: SyncHost;
  readonly replica: ReplicaPort;
  readonly shared: SharedFilePort;
  readonly binding: FileBindingPort;
  readonly sideFiles: SideFilesPort;
  readonly scanner: CopyScannerPort;
  readonly candidates: CandidateQueuePort;
  readonly divergence: DivergencePort;
  readonly snapshots: SnapshotStorePort;
  readonly status: SyncStatusPort;
  readonly notices: NoticesPort;
  readonly session: SessionSignals;
  readonly createWatcher: (sharedPath: string, listener: FileWatchListener) => FileWatcherPort;
}

/** Test seams: the cycle body and the trackers it shares with the engine (defaults are the real ones). */
export interface SyncEngineSeams {
  readonly runCycleBody?: (env: CycleEnv, reason: SyncTrigger) => Promise<CycleOutcome>;
  readonly torn?: TornTracker;
  readonly verifier?: PublishVerifier;
  readonly regressions?: RegressionTracker;
  readonly errorBackoff?: Backoff;
}

/** A direct publish (new vault, new copy) recorded like the cycle's own. */
export interface DirectPublishRecord {
  readonly sha256: string;
  readonly marker: AppDot;
  readonly state: SyncState;
}
