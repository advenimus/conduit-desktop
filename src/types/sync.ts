/**
 * Renderer-side types of personal-vault sync (spec 5, 6, 7; channel list in 11.1).
 * MIRROR of electron/services/sync/app-sync-dto.ts: the text between the
 * MIRROR markers must stay identical in both files. Plain JSON payloads only.
 */

// ---- MIRROR START (keep identical to src/types/sync.ts) ----

// ---------- Keys ----------

/** 1 entries, 2 folders, 3 password history, 4 vault_meta, 9 sync internals. */
export type SyncTable = 1 | 2 | 3 | 4 | 9;

export interface SyncRowKey {
  readonly tbl: SyncTable;
  readonly rowId: string;
}

export interface SyncRegKey {
  readonly tbl: SyncTable;
  readonly rowId: string;
  readonly reg: string;
}

// ---------- Status (sync:state-changed) ----------

export type SyncStatusKind = 'up-to-date' | 'syncing' | 'waiting' | 'paused' | 'file-not-found' | 'offline' | 'pending' | 'error';

export type SyncPauseReason =
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
  readonly savedAtMs: number | null;
}

/** 6.11 stale file ("Getting the latest version from MacBook") or 4.4 G1 first-genesis wait. */
export interface WaitingForDriveState {
  readonly purpose: 'stale-file' | 'first-genesis';
  readonly devices: readonly WaitingDevice[];
  /** Free: a dialog with [Open now] from the start. Pro: a banner. */
  readonly blocking: boolean;
  /** [Stop waiting for X] is offered (after 2 minutes). */
  readonly stopOffered: boolean;
  readonly sinceMs: number;
}

export type CopyClass = 'in-use-elsewhere' | 'nothing-new' | 'safe-provider-copy' | 'needs-review';

export interface CopyInfo {
  readonly path: string;
  readonly name: string;
  readonly sha256: string;
  readonly cls: CopyClass;
  readonly changes: number;
  readonly deletions: number;
}

export interface FileHint {
  readonly file_id: string;
  readonly location: string;
  readonly file_name: string;
}

export type SyncPrompt =
  | { readonly kind: 'file-missing'; readonly id: string; readonly path: string }
  | { readonly kind: 'foreign-other-vault'; readonly id: string; readonly path: string }
  | { readonly kind: 'foreign-newer-format'; readonly id: string; readonly path: string; readonly syncFormat: number }
  | { readonly kind: 'side-files'; readonly id: string; readonly upgradeWording: boolean; readonly walNonEmpty: boolean }
  | { readonly kind: 'epoch-newer'; readonly id: string; readonly changedByDeviceName: string | null; readonly changedMs: number }
  | { readonly kind: 'epoch-legacy'; readonly id: string }
  | { readonly kind: 'epoch-concurrent'; readonly id: string; readonly epochIds: readonly string[] }
  | { readonly kind: 'held-legacy'; readonly id: string; readonly deletes: number; readonly reverts: number }
  | { readonly kind: 'copy-review'; readonly id: string; readonly copy: CopyInfo }
  | { readonly kind: 'same-device-copy'; readonly id: string; readonly copy: CopyInfo }
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

/** Payload of `sync:state-changed`; also `status` in sync_get_state. */
export interface SyncStatus {
  readonly lineageId: string;
  readonly fileName: string | null;
  readonly kind: SyncStatusKind;
  readonly pauseReason: SyncPauseReason | null;
  readonly waiting: WaitingForDriveState | null;
  /** Edits exist only on this device (local.json pending_publish). */
  readonly pendingPublish: boolean;
  /** "N changes not yet synced". */
  readonly unsyncedOps: number;
  readonly conflictCount: number;
  readonly lastSyncedMs: number | null;
  readonly backoffUntilMs: number | null;
  readonly sessionBadge: SessionBadge | null;
  /** The working copy lives on a network path (one-time warning). */
  readonly networkRoot: boolean;
  readonly prompts: readonly SyncPrompt[];
  readonly otherCopies: readonly CopyInfo[];
}

/** Payload of `sync:conflicts-changed`. */
export interface ConflictsChangedEvent {
  readonly lineageId: string;
  readonly count: number;
}

// ---------- Notices (sync:notice) ----------

export type LocalNoticeKind = 'dropped-setting' | 'value-unrecoverable' | 'undecryptable-secrets' | 'invariant-repair' | 'mass-change' | 'candidate-dropped';

/** Persisted per device; dismiss with sync_dismiss_notice. 'mass-change' pairs with sync_list_snapshots. */
export interface LocalNotice {
  readonly id: string;
  readonly kind: LocalNoticeKind;
  readonly key: SyncRegKey | null;
  readonly createdMs: number;
  readonly sourceSha256: string | null;
  readonly count: number;
}

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

/** A one-shot toast; the renderer words it from kind and params. */
export interface TransientNotice {
  readonly id: string;
  readonly kind: TransientNoticeKind;
  readonly createdMs: number;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

/** Payload of `sync:notice`. */
export type SyncNoticeEvent =
  | { readonly lineageId: string; readonly persisted: true; readonly notice: LocalNotice }
  | { readonly lineageId: string; readonly persisted: false; readonly notice: TransientNotice };

// ---------- Device sessions (vault:session-*) ----------

export type DisplacementReason =
  | 'takeover'
  | 'plan_limit'
  | 'device_cap'
  | 'not_owner'
  | 'update_required'
  | 'owner_claim'
  | 'superseded'
  | 'reconnect_unanswered'
  | 'yielded';

/** A device that has the vault open (take-over dialog, reconnect conflict). */
export interface TakeoverHolder {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly lastActiveMs: number | null;
  readonly busySessions: number;
  readonly busyJobs: number;
  /** Device-cap lists: personal vaults this device has open. */
  readonly vaults?: number | null;
}

/** Payload of `vault:session-ownership`: the confirmed owner answer changed; read sync_get_state again. */
export interface OwnershipChangedEvent {
  readonly lineageId: string;
}

/** Payload of `vault:session-displacing`: vault access is blocked while the last changes save. */
export interface DisplacingEvent {
  readonly lineageId: string;
  readonly reason: DisplacementReason;
  readonly byDeviceName: string | null;
}

/** Payload of `vault:session-displaced` (soft lock: connections keep running). */
export interface DisplacedEvent {
  readonly lineageId: string;
  readonly reason: DisplacementReason;
  readonly byDeviceName: string | null;
  readonly openConnections: number;
  readonly runningJobs: number;
  /** false: the last changes stay on this device and sync at the next unlock. */
  readonly changesSaved: boolean;
  readonly fileName: string | null;
  /** update_required: the minimum version. */
  readonly minVersion: string | null;
  /** not_owner: this account released the vault earlier. */
  readonly released: boolean;
  /** device_cap: the account's device cap as last confirmed, else null. */
  readonly deviceCap: number | null;
}

/** Payload of `vault:session-conflict`: [Use here instead] [Lock here]; soft lock at answerByMs. */
export interface SessionConflictEvent {
  readonly lineageId: string;
  readonly holders: readonly TakeoverHolder[];
  readonly answerByMs: number;
  /** 'device_cap': too many devices; holders[0] is the device that would lock. */
  readonly cause: 'vault_limit' | 'device_cap';
  readonly deviceCap: number | null;
}

/** Payload of `sync:open-waiting` (a wait inside an unlock, before the vault is open). */
export interface OpenWaitingEvent {
  readonly waiting: WaitingForDriveState | null;
}

// ---------- Unlock errors (Error.message is this JSON) ----------

export type OpenErrorCode =
  | 'VAULT_OPEN_ELSEWHERE'
  | 'VAULT_PASSWORD_CHANGED_ELSEWHERE'
  | 'VAULT_FILE_UNREADABLE'
  | 'VAULT_FOREIGN_FILE'
  | 'VAULT_WORKING_COPY_DAMAGED'
  | 'VAULT_NOT_OWNER'
  | 'VAULT_SIGN_IN_REQUIRED'
  | 'VAULT_UPDATE_REQUIRED';

export type OpenErrorPayload =
  | {
      readonly code: 'VAULT_OPEN_ELSEWHERE';
      readonly holders: readonly TakeoverHolder[];
      readonly limit: number;
      readonly fileName: string;
      readonly locationDiffers: boolean;
      readonly via: 'server' | 'claim';
      /** 'device_cap': too many devices; holders are the account's devices. */
      readonly cause: 'vault_limit' | 'device_cap';
      readonly deviceCap: number | null;
      /** device_cap: the device a take-over locks. */
      readonly displaceDeviceName: string | null;
      /** The take-over also locks this device for the device cap; '' when unnamed. */
      readonly alsoLockDeviceName: string | null;
    }
  | {
      readonly code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE';
      readonly changedByDeviceName: string | null;
      readonly changedMs: number;
      /** Ask for the previous password and unlock again with previousPassword. */
      readonly needsPreviousPassword: boolean;
      /** Main already deleted the stale biometric entry. */
      readonly deleteBiometric: boolean;
    }
  | { readonly code: 'VAULT_FILE_UNREADABLE'; readonly fileName: string; readonly reason: string }
  | {
      readonly code: 'VAULT_FOREIGN_FILE';
      readonly fileName: string;
      readonly kind: 'newer-format' | 'other-vault';
      readonly syncFormat: number | null;
    }
  | {
      readonly code: 'VAULT_WORKING_COPY_DAMAGED';
      readonly fileName: string;
      /** Unlock again with recoverWorkingCopy: true to rebuild it from the shared file. */
      readonly recoverable: boolean;
    }
  | {
      readonly code: 'VAULT_NOT_OWNER';
      readonly fileName: string;
      /** Refused offline by the owner tag: no copy can be made yet. */
      readonly offline: boolean;
      readonly graceEndedMs: number | null;
      /** This account released the vault earlier. */
      readonly released: boolean;
      /** Pass to sync_make_own_copy; null when no copy can be made. */
      readonly copyTicket: string | null;
      /** The original's folder: where the Save dialog opens. */
      readonly copyDir: string | null;
    }
  | { readonly code: 'VAULT_SIGN_IN_REQUIRED'; readonly fileName: string }
  | { readonly code: 'VAULT_UPDATE_REQUIRED'; readonly fileName: string; readonly minVersion: string };

// ---------- sync_get_state ----------

export interface SideFileTuple {
  readonly name: 'wal' | 'shm';
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export type DeviceLimitSource = 'server' | 'local-json' | 'tier-cache' | 'default' | 'dev-override';

export interface DeviceLimit {
  /** -1 unlimited. */
  readonly limit: number;
  readonly source: DeviceLimitSource;
}

export interface OpenVaultInfo {
  readonly lineageId: string;
  readonly path: string;
  readonly fileName: string;
  /** false: a private vault in the app folder, opened in place. */
  readonly shared: boolean;
  /** The merge engine runs for this vault (shared and "Multi-device sync" on). */
  readonly engine: boolean;
}

export interface PendingVault {
  readonly lineageId: string;
  readonly sharedPath: string | null;
  readonly fileName: string | null;
}

/** Who owns the open personal vault; 'unknown' signed out or without a confirmed answer. */
export type VaultOwnership =
  | { readonly kind: 'owner'; readonly releaseAfterMs: number | null; readonly sharedUntilMs: number | null }
  | { readonly kind: 'grace'; readonly untilMs: number }
  | { readonly kind: 'unowned' }
  | { readonly kind: 'unknown' };

export interface SyncStateResponse {
  /** Multi-device sync on this device (settings personal_sync_enabled; no UI, support only). */
  readonly enabled: boolean;
  /** Server kill switch personal_sync = 'paused'. */
  readonly killSwitch: boolean;
  readonly vault: OpenVaultInfo | null;
  /** null when no engine runs (locked, private vault, or sync turned off). */
  readonly status: SyncStatus | null;
  readonly deviceLimit: DeviceLimit | null;
  /** Current side-file tuples; echo them in sync_confirm_side_files. */
  readonly sideFiles: readonly SideFileTuple[];
  readonly notices: readonly LocalNotice[];
  /** Vaults with changes that exist only on this device (VaultHub, 5.11). */
  readonly pendingVaults: readonly PendingVault[];
  /** Displaced: the vault is locked here, connections keep running. */
  readonly softLocked: boolean;
  /** null with no personal vault open. */
  readonly ownership: VaultOwnership | null;
  /** account_max_active_devices from the last confirmed answer (-1 no cap), else null. */
  readonly deviceCap: number | null;
}

// ---------- Devices ----------

export interface SyncDeviceInfo {
  readonly deviceUuid: string;
  readonly name: string;
  readonly platform: string;
  readonly appVersion: string | null;
  readonly thisDevice: boolean;
  readonly sessionOpen: boolean;
  readonly lastActiveMs: number | null;
  readonly fileHint: FileHint | null;
  /** From the server's session list when signed in; null otherwise. */
  readonly server: {
    readonly status: 'active' | 'released' | 'expired' | 'displaced';
    readonly lastActiveMs: number | null;
    readonly busySessions: number;
    readonly busyJobs: number;
    readonly pendingChanges: boolean;
  } | null;
}

// ---------- Actions ----------

export type CopyAction = 'trash' | 'ignore' | 'review' | 'merge' | 'separate';

export interface CopyActionResult {
  /** 'review' and 'merge' queue a candidate: open sync_candidate_preview with it. */
  readonly candidateId: string | null;
}

export type ConfirmSideFilesResult =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'held-open' }
  | { readonly kind: 'review-first' }
  | { readonly kind: 'changed' };

export interface ForkResultDto {
  readonly path: string;
  readonly lineageId: string;
}

export type SyncNowResult = { readonly outcome: string | null };

/** sync_release_ownership; 'unconfirmed' is a transport or server problem. */
export type ReleaseOwnershipResult =
  | { readonly released: true }
  | { readonly released: false; readonly reason: 'too_soon'; readonly retryAfterMs: number }
  | { readonly released: false; readonly reason: 'not_owner' }
  | { readonly released: false; readonly reason: 'unconfirmed' };

export type SetEnabledResult =
  | { readonly ok: true; readonly enabled: boolean }
  | {
      readonly ok: false;
      readonly reason: 'pending';
      readonly pendingVaults: readonly PendingVault[];
      readonly heldChanges: number;
    };

export type PasswordFlowResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'wrong-password' | 'superseded' | 'needs-previous-password' };

// ---------- Conflicts (7.2, 7.3) ----------

/** Secrets and binary values are masked (value null, masked true); reveal with sync_reveal_secret. */
export type SyncValueDto = string | number | null;

export type VersionSource =
  | { readonly kind: 'device'; readonly deviceUuid: string | null; readonly deviceName: string | null }
  | { readonly kind: 'older-app' }
  | { readonly kind: 'genesis' }
  | { readonly kind: 'candidate'; readonly label: string };

export interface ConflictVersion {
  readonly id: string;
  readonly source: VersionSource;
  /** 0 = unknown. */
  readonly timeMs: number;
  readonly value: SyncValueDto;
  readonly masked: boolean;
  /** The value in use now. */
  readonly provisional: boolean;
  readonly undecryptable: boolean;
  readonly redacted: boolean;
  readonly olderApp: boolean;
}

export interface FieldConflict {
  readonly key: SyncRegKey;
  readonly label: string;
  readonly cls: 'prompt' | 'groupA' | 'auto' | 'special';
  readonly secret: boolean;
  readonly versions: readonly ConflictVersion[];
  readonly staleRevert: boolean;
  readonly keepBothOffered: boolean;
  readonly invariantGuard: boolean;
  readonly snoozeKey: string;
}

export type ConflictItem =
  | { readonly kind: 'field'; readonly field: FieldConflict }
  | {
      readonly kind: 'appearance';
      readonly row: SyncRowKey;
      readonly fields: readonly FieldConflict[];
      /** Register name -> version id preselected by "Keep newest". */
      readonly newest: Readonly<Record<string, string>>;
      readonly snoozeKey: string;
    }
  | {
      readonly kind: 'edit-delete';
      readonly row: SyncRowKey;
      readonly deleted: readonly ConflictVersion[];
      readonly edited: readonly ConflictVersion[];
      readonly snoozeKey: string;
    }
  | {
      readonly kind: 'folder-delete';
      readonly folder: SyncRowKey;
      readonly deleted: readonly ConflictVersion[];
      readonly changedItems: readonly SyncRowKey[];
      readonly snoozeKey: string;
    }
  | { readonly kind: 'cycle'; readonly tbl: 1 | 2; readonly rowIds: readonly string[]; readonly movedToRoot: string }
  | { readonly kind: 'undecryptable'; readonly field: FieldConflict }
  | { readonly kind: 'epoch'; readonly versions: readonly ConflictVersion[] };

export interface ConflictGroup {
  readonly row: SyncRowKey;
  readonly title: string;
  readonly items: readonly ConflictItem[];
  readonly snoozed: boolean;
}

export type FieldChoiceDto =
  | { readonly kind: 'version'; readonly versionId: string }
  /** A new value; for secrets pass plaintext. */
  | { readonly kind: 'value'; readonly value: SyncValueDto; readonly plaintext?: string | null }
  /** Notes and documents: versionId -> name of the copy entry. */
  | { readonly kind: 'keep-both'; readonly copyNames: Readonly<Record<string, string>> };

export type ResolveRequest =
  | { readonly kind: 'field'; readonly key: SyncRegKey; readonly choice: FieldChoiceDto }
  | { readonly kind: 'edit-delete'; readonly row: SyncRowKey; readonly choice: 'keep' | 'delete' }
  | { readonly kind: 'folder-delete'; readonly folder: SyncRowKey; readonly choice: 'keep-with-changed' | 'delete-all' | 'restore-all' }
  | {
      readonly kind: 'cycle';
      readonly tbl: 1 | 2;
      readonly rowIds: readonly string[];
      readonly choice: { readonly kind: 'put-under'; readonly child: string; readonly parent: string } | { readonly kind: 'all-root' };
    }
  | { readonly kind: 'undecryptable-discard'; readonly key: SyncRegKey };

export type ResolveGroupRequest =
  | { readonly kind: 'appearance'; readonly row: SyncRowKey; readonly choices: 'keep-newest' | Readonly<Record<string, string>> }
  | { readonly kind: 'bulk'; readonly choice: 'keep-newest-all' | 'keep-newest-older-apps' };

export interface ResolveResult {
  /** Conflict items left (non-snoozed). */
  readonly conflictCount: number;
}

// ---------- Candidates (4.9) ----------

export type CandidateSource = 'ios-sandbox' | 'copy' | 'leftover-wal' | 'presync-no-baseline' | 'user-picked' | 'genesis-leftovers';

export interface CandidateSummary {
  readonly id: string;
  readonly source: CandidateSource;
  readonly label: string;
  readonly kind: 'replica' | 'synthetic';
  readonly createdMs: number;
}

export interface CandidatePreviewField {
  readonly key: SyncRegKey;
  readonly label: string;
  readonly rowTitle: string;
  readonly current: SyncValueDto;
  readonly incoming: SyncValueDto;
  readonly masked: boolean;
}

export interface CandidatePreviewRow {
  readonly row: SyncRowKey;
  readonly title: string;
}

export interface CandidatePreview {
  readonly id: string;
  readonly kind: 'replica' | 'synthetic';
  readonly source: CandidateSource;
  readonly label: string;
  readonly changedFields: readonly CandidatePreviewField[];
  readonly onlyInCopy: readonly CandidatePreviewRow[];
  readonly missingFromCopy: readonly CandidatePreviewRow[];
  readonly deletions: readonly CandidatePreviewRow[];
  readonly needsReview: boolean;
}

// ---------- Undo (5.10) and Recently deleted (4.7) ----------

export interface SnapshotSummary {
  readonly id: string;
  readonly createdMs: number;
  readonly noticeId: string;
  readonly deleted: number;
  readonly changedRows: number;
  readonly byDeviceName: string | null;
}

export interface UndoPreview {
  readonly snapshotId: string;
  readonly rows: readonly { readonly row: SyncRowKey; readonly title: string; readonly stillDeleted: boolean }[];
  readonly fields: readonly { readonly key: SyncRegKey; readonly label: string; readonly stillMerged: boolean; readonly secret: boolean }[];
}

export interface UndoApplyResult {
  /** Rows re-created plus fields reverted, as the user chose them (not register writes). */
  readonly applied: number;
}

export interface RecentlyDeletedItem {
  readonly row: SyncRowKey;
  readonly title: string;
  readonly entryType: string | null;
  readonly diedMs: number;
  readonly deviceName: string | null;
  /** "Delete permanently" already ran: only the record is left. */
  readonly redacted: boolean;
}

// ---------- Backup restore (5.10) ----------

export interface RollbackPreview {
  readonly deletions: readonly CandidatePreviewRow[];
  readonly restorations: readonly CandidatePreviewRow[];
  readonly replacements: readonly CandidatePreviewField[];
  readonly unreadableSecrets: number;
}

export type RestoreMode = 'preview' | 'rollback' | 'new-vault';

export type RestoreResult =
  | { readonly mode: 'preview'; readonly preview: RollbackPreview }
  | { readonly mode: 'rollback'; readonly applied: number }
  | { readonly mode: 'new-vault'; readonly path: string; readonly lineageId: string }
  /** Private vault or sync off: the old whole-file restore ran. */
  | { readonly mode: 'replaced'; readonly path: string };

// ---- MIRROR END ----

// ---------- Helpers (renderer only) ----------

const OPEN_ERROR_CODES: ReadonlySet<string> = new Set<OpenErrorCode>([
  'VAULT_OPEN_ELSEWHERE',
  'VAULT_PASSWORD_CHANGED_ELSEWHERE',
  'VAULT_FILE_UNREADABLE',
  'VAULT_FOREIGN_FILE',
  'VAULT_WORKING_COPY_DAMAGED',
  'VAULT_NOT_OWNER',
  'VAULT_SIGN_IN_REQUIRED',
  'VAULT_UPDATE_REQUIRED',
]);

/** A structured unlock error from Error.message, or null for plain messages like "Invalid master password". */
export function parseOpenErrorMessage(message: string): OpenErrorPayload | null {
  if (!message.startsWith('{')) return null;
  try {
    const raw: unknown = JSON.parse(message);
    if (typeof raw !== 'object' || raw === null) return null;
    const code = (raw as { code?: unknown }).code;
    return typeof code === 'string' && OPEN_ERROR_CODES.has(code) ? (raw as OpenErrorPayload) : null;
  } catch {
    return null;
  }
}
