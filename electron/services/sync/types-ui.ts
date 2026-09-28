/**
 * UI-facing and device-local shapes for personal-vault sync: conflict items (7.2, 7.3),
 * candidate previews (4.9), recently deleted (4.7), epoch and unlock decisions (4.8),
 * local.json (3.2). Import through types.ts, which re-exports this file.
 */

import type { Dev, RegKey, RowKey, Sibling, SyncValue, Pmem, Tbl } from './types.js';

// ---------- Register catalog vocabulary (3.5) ----------

export type RegClass = 'prompt' | 'groupA' | 'auto' | 'special';

export type ValueKind =
  | 'life'
  | 'reqtext'
  | 'text'
  | 'int'
  | 'int0'
  | 'secret'
  | 'json'
  | 'container'
  | 'ref'
  | 'time'
  | 'flag';

/** Dynamic register families; `null` for fixed registers. */
export type RegFamily = 'config' | 'tag' | 'dismiss' | 'device';

// ---------- Conflicts (4.10, 7) ----------

export type VersionSource =
  | { readonly kind: 'device'; readonly deviceUuid: string | null; readonly deviceName: string | null }
  | { readonly kind: 'older-app' }
  | { readonly kind: 'genesis' }
  | { readonly kind: 'candidate'; readonly label: string };

export interface ConflictVersion {
  /** sibling.ts identityKey(). */
  readonly id: string;
  readonly dev: Dev;
  readonly ms: number;
  readonly c: number;
  readonly lt: number;
  readonly pseudo: boolean;
  readonly source: VersionSource;
  /** Display time: ms for app dots, lt for pseudo siblings (0 = unknown). */
  readonly timeMs: number;
  /** null when masked (secrets) or redacted. Reveal secrets with conflicts.revealSecret(). */
  readonly value: SyncValue;
  readonly masked: boolean;
  readonly vhash: string;
  /** The "in use now" value. */
  readonly provisional: boolean;
  readonly undecryptable: boolean;
  readonly redacted: boolean;
}

export interface FieldConflict {
  readonly key: RegKey;
  readonly label: string;
  readonly cls: RegClass;
  readonly secret: boolean;
  readonly versions: readonly ConflictVersion[];
  /** An older app wrote back a value this device had replaced (4.3 rule 3). */
  readonly staleRevert: boolean;
  /** Notes and document content offer [Keep both]. */
  readonly keepBothOffered: boolean;
  /** The guard kept both sides after an invariant repair (7.3 last row). */
  readonly invariantGuard: boolean;
  readonly snoozeKey: string;
}

export type ConflictItem =
  | { readonly kind: 'field'; readonly field: FieldConflict }
  | {
      readonly kind: 'appearance';
      readonly row: RowKey;
      readonly fields: readonly FieldConflict[];
      /** Preselected "Keep newest" choice per field: version id of the highest rank. */
      readonly newest: ReadonlyMap<string, string>;
      readonly snoozeKey: string;
    }
  | {
      readonly kind: 'edit-delete';
      readonly row: RowKey;
      readonly deleted: readonly ConflictVersion[];
      readonly edited: readonly ConflictVersion[];
      readonly snoozeKey: string;
    }
  | {
      readonly kind: 'folder-delete';
      readonly folder: RowKey;
      readonly deleted: readonly ConflictVersion[];
      /** Live rows inside the folder whose `_life` re-asserts the folder. */
      readonly changedItems: readonly RowKey[];
      readonly snoozeKey: string;
    }
  | { readonly kind: 'cycle'; readonly tbl: 1 | 2; readonly rowIds: readonly string[]; readonly movedToRoot: string }
  | { readonly kind: 'undecryptable'; readonly field: FieldConflict }
  | { readonly kind: 'epoch'; readonly versions: readonly ConflictVersion[] };

export interface ConflictGroup {
  readonly row: RowKey;
  /** Item name (provisional `name`), or a fixed label for vault-level items. */
  readonly title: string;
  readonly items: readonly ConflictItem[];
  readonly snoozed: boolean;
}

export type FieldChoice =
  | { readonly kind: 'version'; readonly versionId: string }
  /** A new value. For secrets pass `plaintext`; `value` is ignored then. */
  | { readonly kind: 'value'; readonly value: SyncValue; readonly plaintext?: string | null }
  /** Notes and document content only: one copy entry per other version, named by versionId. */
  | { readonly kind: 'keep-both'; readonly copyNames: ReadonlyMap<string, string> };

export type EditDeleteChoice = 'keep' | 'delete';
export type FolderDeleteChoice = 'keep-with-changed' | 'delete-all' | 'restore-all';
export type CycleChoice = { readonly kind: 'put-under'; readonly child: string; readonly parent: string } | { readonly kind: 'all-root' };
export type BulkChoice = 'keep-newest-all' | 'keep-newest-older-apps';

// ---------- Candidates (4.9) ----------

export type CandidateKind = 'replica' | 'synthetic';
export type CandidateSource = 'ios-sandbox' | 'copy' | 'leftover-wal' | 'presync-no-baseline' | 'user-picked' | 'genesis-leftovers';

export interface PreviewField {
  readonly key: RegKey;
  readonly label: string;
  readonly rowTitle: string;
  /** Current provisional value in M; secrets masked (null). */
  readonly current: SyncValue;
  readonly incoming: SyncValue;
  readonly masked: boolean;
}

export interface PreviewRow {
  readonly row: RowKey;
  readonly title: string;
}

export interface CandidatePreview {
  readonly kind: CandidateKind;
  readonly source: CandidateSource;
  readonly label: string;
  readonly changedFields: readonly PreviewField[];
  readonly onlyInCopy: readonly PreviewRow[];
  readonly missingFromCopy: readonly PreviewRow[];
  /** Replica candidates only: legacy deletes the copy would apply. */
  readonly deletions: readonly PreviewRow[];
  /** false only for replica candidates whose contribution is uncovered app dots only. */
  readonly needsReview: boolean;
}

/** One register value offered by a candidate: logical value plus its vhash under the current epoch. */
export interface CandidateValue {
  readonly value: SyncValue;
  readonly vhash: string;
  /** SIB_UNDECRYPTABLE when no key could read a secret. */
  readonly flags: number;
}

/** Register values of one candidate row, with the row time used by the newer-only filter. */
export interface CandidateRowValues {
  readonly row: RowKey;
  /** Parsed updated_at of the candidate row (ms), 0 when unknown. */
  readonly rowTimeMs: number;
  readonly values: ReadonlyMap<string, CandidateValue>;
}

/** rowKeyStr -> candidate row. */
export type CandidateRows = ReadonlyMap<string, CandidateRowValues>;

// ---------- Recently deleted (4.7) ----------

export interface DeletedItem {
  readonly row: RowKey;
  readonly title: string;
  readonly entryType: string | null;
  readonly diedMs: number;
  readonly diedDev: Dev;
  readonly redacted: boolean;
}

// ---------- Key epochs (4.8) ----------

export type EpochRelation = 'same' | 's-older' | 's-newer' | 'legacy-change' | 'concurrent';

/**
 * `needs-wrap`: the password opens S's current epoch, which descends from W's current epoch,
 * but no valid wrap links them (a legacy password change absorbed by a device without the old
 * key). The caller adds the wrap with W's current key (unlocked, or the previous password
 * entered once) and re-encrypts W up to S's epoch.
 */
export type UnlockDecision =
  | {
      readonly ok: true;
      readonly epochId: string;
      readonly via: 'w-current' | 's-newer' | 'no-w' | 'legacy-change' | 'needs-wrap';
    }
  | { readonly ok: false; readonly reason: 'wrong-password' }
  | { readonly ok: false; readonly reason: 'superseded'; readonly changedByDeviceUuid: string | null; readonly changedMs: number };

// ---------- Device-local state (local.json, 3.2) ----------

export type LocalNoticeKind = 'dropped-setting' | 'value-unrecoverable' | 'undecryptable-secrets' | 'invariant-repair' | 'mass-change' | 'candidate-dropped';

export interface LocalNotice {
  readonly id: string;
  readonly kind: LocalNoticeKind;
  readonly key: RegKey | null;
  readonly createdMs: number;
  readonly sourceSha256: string | null;
  readonly count: number;
}

/**
 * A legacy delete or stale revert held by the hold rule (4.3 rule 2). Applying it later
 * re-runs capture-legacy.applyHeld, which adds `sibling` with the same replacement rule.
 */
export interface HeldLegacyChange {
  readonly key: RegKey;
  readonly kind: 'delete' | 'stale-revert';
  readonly sibling: Sibling;
  /** identityKey of the provisional sibling the legacy app saw (w), or null. */
  readonly replaces: string | null;
  /**
   * identityKeys of the other app siblings that held w's value when the change was held; the
   * legacy app saw them too, so applying the change replaces them with w. Absent when none.
   */
  readonly replacesEqual?: readonly string[];
  readonly pmemAdd: Pmem;
  readonly sourceSha256: string;
  readonly heldAtMs: number;
}

export interface SnoozeEntry {
  readonly key: string;
  readonly createdMs: number;
}

export interface FileBinding {
  readonly sharedPath: string;
  readonly realpath: string;
  readonly fileId: string;
}

export interface SideFileTuple {
  readonly name: 'wal' | 'shm';
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface LocalJson {
  readonly version: 1;
  readonly lineageId: string;
  readonly binding: FileBinding | null;
  readonly dev: Dev;
  readonly incarnation: string;
  readonly lastMergedSha256: string | null;
  readonly lastPublished: { readonly sha256: string; readonly markerDot: { readonly dev: Dev; readonly ms: number; readonly c: number } } | null;
  readonly pendingPublish: boolean;
  readonly sideFiles: { readonly tuples: readonly SideFileTuple[]; readonly confirmedAtMs: number | null } | null;
  /**
   * When the user last confirmed side files on this device (5.5; absent in files written before
   * it existed): server side-file flags reported at or before it are covered by the confirmation.
   */
  readonly sideFilesConfirmedAtMs?: number | null;
  readonly heldLegacy: readonly HeldLegacyChange[];
  readonly snoozed: readonly SnoozeEntry[];
  readonly lastLimit: { readonly value: number; readonly atMs: number } | null;
  readonly ignoredCopies: readonly string[];
  readonly abandonedWaits: readonly string[];
  readonly notices: readonly LocalNotice[];
  /** Candidate dev -> label, so conflict versions can show "Vault 2.conduit". */
  readonly candidateLabels: Readonly<Record<string, string>>;
  readonly contentRepairShas: readonly string[];
  /**
   * 4.8: this device changed the master password and S is still under the old one until the
   * next publish; staged copies of S in incoming/ are removed after that publish (absent: false).
   */
  readonly dropStagedAfterPublish?: boolean;
  /**
   * 4.8: W moved to a new key epoch and the private copies beside it may still open with the
   * old password; the engine re-keys or removes them, now or at its next start (absent: false).
   */
  readonly sealLocalCopiesPending?: boolean;
}

// ---------- _sync register values (3.5) ----------

export interface FileHint {
  readonly file_id: string;
  readonly location: string;
  readonly file_name: string;
}

/** Value of `_sync/device/<device_uuid>`, stored as JCS text. */
export interface PresenceValue {
  readonly platform: string;
  readonly name: string;
  readonly app_version: string;
  readonly first_seen_ms: number;
  readonly last_active_ms: number;
  readonly session_open: 0 | 1;
  readonly session_since_ms: number | null;
  readonly account_hint: string | null;
  readonly file_hint: FileHint | null;
  readonly side_files_seen_ms: number | null;
}

/** Value of `_sync/owner/owner`, stored as JCS text. */
export interface OwnerClaimValue {
  readonly a: string | null;
  readonly d: string;
}

/** A catalog entry as returned by catalog.registerDef(). */
export interface RegisterDef {
  readonly tbl: Tbl;
  /** Exact register name, or the family prefix ('config.', 'tag:') for dynamic families. */
  readonly reg: string;
  readonly family: RegFamily | null;
  readonly cls: RegClass;
  readonly kind: ValueKind;
  readonly secret: boolean;
  readonly defaultValue: SyncValue;
  /** Content columns the register reads and writes (empty for rowless registers). */
  readonly columns: readonly string[];
  /** NOT NULL columns: value materialize writes when the provisional is null or redacted. */
  readonly notNullFallback: SyncValue;
  /** Rule R: the row kind this register references, if any. */
  readonly references: 'entry' | null;
  readonly label: string;
}
