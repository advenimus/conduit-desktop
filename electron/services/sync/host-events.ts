/**
 * Renderer-facing payloads of the sync layer (spec 5.6 renderer refresh, 5.5, 5.8, 6.11, 7.2):
 * `sync:state-changed`, `sync:conflicts-changed`, `sync:notice`, and the typed emitter.
 * Re-exported by host.ts; import through host.ts. Types only.
 */

import type { FileHint, LocalNotice } from './types.js';

// ---------- Renderer events ----------

export type SyncStatusKind =
  | 'up-to-date'
  | 'syncing'
  | 'waiting'
  | 'paused'
  | 'file-not-found'
  | 'offline'
  | 'pending'
  | 'error';

export type PauseReason =
  | 'side-files'
  | 'epoch-newer'
  | 'epoch-legacy'
  | 'epoch-concurrent'
  | 'displaced'
  | 'kill-switch'
  | 'foreign-newer-format'
  | 'foreign-other-vault'
  | 'unreadable'
  | 'regression-backoff'
  | 'error-backoff';

export interface WaitingDevice {
  readonly deviceId: string;
  readonly deviceName: string;
  /** written_at of the marker being waited for. */
  readonly savedAtMs: number | null;
}

export interface WaitingState {
  /** 'first-genesis' is 4.4 G1's wait; 'stale-file' is 6.11. */
  readonly purpose: 'stale-file' | 'first-genesis';
  readonly devices: readonly WaitingDevice[];
  /** Free: a dialog (with [Open now] from the start). Pro: a non-blocking banner. */
  readonly blocking: boolean;
  /** [Stop waiting for ...] offered (after 2 minutes). */
  readonly stopOffered: boolean;
  readonly sinceMs: number;
}

export type CopyClassView = 'in-use-elsewhere' | 'nothing-new' | 'safe-provider-copy' | 'needs-review';

export interface OtherCopyView {
  readonly path: string;
  readonly name: string;
  readonly sha256: string;
  readonly cls: CopyClassView;
  readonly changes: number;
  readonly deletions: number;
}

/** Open prompts derived from the current state; `id` is stable per (kind, subject). */
export type SyncPrompt =
  | { readonly kind: 'file-missing'; readonly id: string; readonly path: string }
  | { readonly kind: 'foreign-other-vault'; readonly id: string; readonly path: string }
  | { readonly kind: 'foreign-newer-format'; readonly id: string; readonly path: string; readonly syncFormat: number }
  | { readonly kind: 'side-files'; readonly id: string; readonly upgradeWording: boolean; readonly walNonEmpty: boolean }
  | { readonly kind: 'epoch-newer'; readonly id: string; readonly changedByDeviceName: string | null; readonly changedMs: number }
  | { readonly kind: 'epoch-legacy'; readonly id: string }
  | { readonly kind: 'epoch-concurrent'; readonly id: string; readonly epochIds: readonly string[] }
  | { readonly kind: 'held-legacy'; readonly id: string; readonly deletes: number; readonly reverts: number }
  | { readonly kind: 'copy-review'; readonly id: string; readonly copy: OtherCopyView }
  | { readonly kind: 'same-device-copy'; readonly id: string; readonly copy: OtherCopyView }
  | {
      readonly kind: 'different-copies';
      readonly id: string;
      readonly deviceUuid: string;
      readonly deviceName: string;
      readonly theirs: FileHint;
      readonly ours: FileHint;
    }
  | { readonly kind: 'candidate'; readonly id: string; readonly candidateId: string; readonly label: string };

export type SessionBadge = 'offline-device-check';

/** Payload of `sync:state-changed` (feeds PersonalSyncIndicator, 5.6). */
export interface SyncStatusSnapshot {
  readonly lineageId: string;
  readonly fileName: string | null;
  readonly kind: SyncStatusKind;
  readonly pauseReason: PauseReason | null;
  readonly waiting: WaitingState | null;
  /** local.json pending_publish: edits exist only on this device. */
  readonly pendingPublish: boolean;
  /** Local operations captured since the last successful publish ("N changes not yet synced"). */
  readonly unsyncedOps: number;
  readonly conflictCount: number;
  readonly lastSyncedMs: number | null;
  readonly backoffUntilMs: number | null;
  readonly sessionBadge: SessionBadge | null;
  /** syncRoot is on a network path: W runs in DELETE mode (3.2 one-time warning). */
  readonly networkRoot: boolean;
  readonly prompts: readonly SyncPrompt[];
  readonly otherCopies: readonly OtherCopyView[];
}

export interface ConflictsChangedEvent {
  readonly lineageId: string;
  readonly count: number;
}

/** One-shot toasts; the renderer words them from `kind` and `params` (repo toast system). */
export type TransientNoticeKind =
  | 'copy-merged'
  | 'rebound'
  | 'side-files-reminder'
  | 'regression-backoff'
  | 'network-root'
  | 'dev-collision'
  | 'publish-failed'
  | 'content-repaired'
  | 'pending-at-start';

export interface TransientNotice {
  readonly id: string;
  readonly kind: TransientNoticeKind;
  readonly createdMs: number;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

export type SyncNoticeEvent =
  | { readonly lineageId: string; readonly persisted: true; readonly notice: LocalNotice }
  | { readonly lineageId: string; readonly persisted: false; readonly notice: TransientNotice };

export interface SyncEventMap {
  'sync:state-changed': SyncStatusSnapshot;
  'sync:conflicts-changed': ConflictsChangedEvent;
  'sync:notice': SyncNoticeEvent;
}

export interface RendererEmitter<M> {
  emit<K extends keyof M & string>(channel: K, payload: M[K]): void;
}

export type SyncEmitter = RendererEmitter<SyncEventMap>;
