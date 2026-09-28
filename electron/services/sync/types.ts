/**
 * Shared in-memory model for personal-vault sync (docs/MULTI_DEVICE_SYNC.md sections 3 and 4).
 * Every module in electron/services/sync imports its data shapes from here. Operation shapes
 * (capture, merge, materialize) live in types-ops.ts and UI-facing and device-local shapes
 * (conflicts, candidates, epochs, local.json) in types-ui.ts; both are re-exported below.
 *
 * Encoding conventions used everywhere in memory:
 * - 16-byte hashes and pids are lowercase hex strings (32 chars); prev_vhash is 16 hex chars.
 * - Secrets are ciphertext bytes (nonce12 | ct | tag16) under the state's current key epoch,
 *   never plaintext. Plaintext exists only transiently inside capture, rekey and reveal.
 * - All state objects are immutable. A function that does not change a register or row must
 *   return the same object reference, so state-store can diff by identity.
 */


// ---------- Identifiers and constants ----------

export type Dev = number;
export const PSEUDO_DEV = 0;
export const DEV_BITS = 48;
export const HLC_MAX_COUNTER = 65535;
export const FUTURE_CAP_MS = 24 * 60 * 60 * 1000;
export const HASH16_HEX_LEN = 32;
export const PREV_HEX_LEN = 16;
export const ZERO_PID = '0'.repeat(HASH16_HEX_LEN);
export const ZERO_VHASH = '0'.repeat(HASH16_HEX_LEN);
export const SYNC_FORMAT = 1;

export const TBL = { entries: 1, folders: 2, history: 3, meta: 4, sync: 9 } as const;
export type Tbl = (typeof TBL)[keyof typeof TBL];
/** Tables whose rows are content rows with a `_life` register. */
export type ContentTbl = 1 | 2 | 3;

/** Sibling flag bits (sync_sibling.flags / sync_reg.flags). */
export const SIB_UNDECRYPTABLE = 1;
export const SIB_REDACTED = 2;
/**
 * This replica carries the sibling's identity and vhash but not its value (value is null):
 * a legacy delete or rebuild removed the only copy this device could read. Never provisional,
 * never a version in the conflict test; merge prefers any copy that carries the value.
 */
export const SIB_VALUE_UNKNOWN = 4;

// ---------- Clocks and dots (4.1) ----------

export interface Hlc {
  readonly ms: number;
  readonly c: number;
}

/** An app dot. `dev` > 0. */
export interface AppDot extends Hlc {
  readonly dev: Dev;
}

/** Version vector: dev -> highest app dot seen from that dev. */
export type VersionVector = ReadonlyMap<Dev, Hlc>;

/** Pseudo memory of one register: which pseudo siblings this state has seen. `ids` sorted, unique. */
export interface Pmem {
  readonly ms: number;
  readonly ids: readonly string[];
}

// ---------- Values ----------

/**
 * A register's LOGICAL value, typed by the catalog's ValueKind:
 * life: 'live' | 'dead'; text/reqtext/ref/time: string (time keeps the stored text);
 * int/int0: number (a non-numeric legacy text stays a string); json: JCS text;
 * container: 'r' | 'f:<id>' | 'e:<id>'; flag: 1 or null; secret: ciphertext bytes.
 * null means NULL / absent.
 */
export type SyncValue = null | number | string | Uint8Array;

/** Raw SQLite cell as better-sqlite3 returns it (BLOBs arrive as Buffer). */
export type SqlValue = null | number | bigint | string | Uint8Array;

// ---------- Registers ----------

export interface RowKey {
  readonly tbl: Tbl;
  readonly rowId: string;
}

export interface RegKey {
  readonly tbl: Tbl;
  readonly rowId: string;
  readonly reg: string;
}

/**
 * One sibling of a multi-value register. App sibling: dev > 0, pid '', lt 0.
 * Pseudo sibling: dev 0, c 0, pid = 32 hex chars, lt = legacy time hint.
 * Identity: app (dev, ms, c); pseudo (ms, pid). See sibling.ts identityKey().
 */
export interface Sibling {
  readonly dev: Dev;
  readonly ms: number;
  readonly c: number;
  readonly pid: string;
  readonly lt: number;
  /** 32 hex. Keyed over plaintext for secrets; cvhx form for undecryptable; zeros when redacted. */
  readonly vhash: string;
  readonly flags: number;
  /** Logical value (null when redacted or SIB_VALUE_UNKNOWN). Secrets: ciphertext. */
  readonly value: SyncValue;
  /** First 8 bytes (16 hex) of the vhash this app provisional replaced; null if none or lost. */
  readonly prevVhash: string | null;
}

/** Materialized value that differs from the logical provisional value (sync_reg.mat). */
export interface MatOverride {
  readonly value: SyncValue;
}

/**
 * An EXPLICIT register (has a sync_reg row). `sibs` is non-empty and sorted by
 * sibling.ts compareIdentity. `pmem` null means empty pseudo memory.
 * `mat` is set only by materialize; merge and capture may drop it (materialize recomputes).
 */
export interface RegisterState {
  readonly key: RegKey;
  readonly sibs: readonly Sibling[];
  readonly pmem: Pmem | null;
  readonly mat?: MatOverride;
}

/** Tombstone record of a dead content row (sync_grave minus row_json, which is derived). */
export interface Grave {
  readonly diedMs: number;
  readonly diedC: number;
  readonly diedDev: Dev;
  readonly redacted: boolean;
}

/**
 * A known row (present in sync_rowkey). A catalog register of a known row that is missing
 * from `regs` is IMPLICIT (3.4). A row missing from SyncState.rows is unknown: every register
 * of it is an EMPTY sibling set.
 */
export interface RowState {
  readonly key: RowKey;
  readonly regs: ReadonlyMap<string, RegisterState>;
  readonly grave: Grave | null;
}

export interface DevRecord {
  readonly dev: Dev;
  readonly deviceUuid: string;
  readonly startedMs: number;
}

export interface EpochRecord {
  readonly epochId: string;
  readonly parent: string | null;
  /** base64 as in vault_meta; null once redacted. */
  readonly salt: string | null;
  /** base64 as in vault_meta; null once redacted. */
  readonly verification: string | null;
  readonly createdMs: number;
}

export interface WrapRecord {
  /** Wrapping (newer) epoch. */
  readonly epochId: string;
  readonly targetEpoch: string;
  /** hex of nonce12 | ct | tag16. */
  readonly wrap: string;
}

/**
 * The replicated, mergeable state of one file (W, S, a candidate or an in-memory result).
 * Bookkeeping that is local to one file (sync_row, rid values, file_id) is NOT here;
 * see LoadedFile.
 */
export interface SyncState {
  readonly lineageId: string;
  readonly genesisId: string;
  readonly createdMs: number;
  readonly vv: VersionVector;
  readonly devs: ReadonlyMap<Dev, DevRecord>;
  /** Keyed by state-view.ts rowKeyStr(). */
  readonly rows: ReadonlyMap<string, RowState>;
  readonly epochs: ReadonlyMap<string, EpochRecord>;
  /** Union set keyed by state-view.ts wrapKeyStr(). */
  readonly wraps: ReadonlyMap<string, WrapRecord>;
}

/** Builds the implicit genesis sibling of a register (3.4); vhash is keyed for secrets. */
export type ImplicitProvider = (key: RegKey) => Sibling;

// ---------- Content rows (what legacy apps read) ----------

export interface EntryRow {
  readonly id: string;
  readonly name: SqlValue;
  readonly entry_type: SqlValue;
  readonly folder_id: SqlValue;
  readonly parent_entry_id: SqlValue;
  readonly sort_order: SqlValue;
  readonly host: SqlValue;
  readonly port: SqlValue;
  readonly credential_id: SqlValue;
  readonly username: SqlValue;
  readonly password_encrypted: SqlValue;
  readonly domain: SqlValue;
  readonly private_key_encrypted: SqlValue;
  readonly totp_secret_encrypted: SqlValue;
  readonly icon: SqlValue;
  readonly color: SqlValue;
  readonly credential_type: SqlValue;
  readonly config: SqlValue;
  readonly tags: SqlValue;
  readonly is_favorite: SqlValue;
  readonly notes: SqlValue;
  readonly created_at: SqlValue;
  readonly updated_at: SqlValue;
}

export interface FolderRow {
  readonly id: string;
  readonly name: SqlValue;
  readonly parent_id: SqlValue;
  readonly sort_order: SqlValue;
  readonly icon: SqlValue;
  readonly color: SqlValue;
  readonly created_at: SqlValue;
  readonly updated_at: SqlValue;
}

export interface HistoryRow {
  readonly id: string;
  readonly entry_id: SqlValue;
  readonly username: SqlValue;
  readonly password_encrypted: SqlValue;
  readonly changed_at: SqlValue;
  readonly changed_by: SqlValue;
}

export type ContentRow = EntryRow | FolderRow | HistoryRow;

/** The content tables of one file. `meta` holds every vault_meta key, synced or not. */
export interface ContentSnapshot {
  readonly entries: ReadonlyMap<string, EntryRow>;
  readonly folders: ReadonlyMap<string, FolderRow>;
  readonly history: ReadonlyMap<string, HistoryRow>;
  readonly meta: ReadonlyMap<string, string>;
}

// ---------- File-local bookkeeping ----------

/** sync_row: change-detection cache for one content row of one file. Never merged. */
export interface RowCacheEntry {
  readonly materialized: boolean;
  /** 32 hex over STORED column bytes (3.6), or null. */
  readonly rawHash: string | null;
}

export type RowCache = ReadonlyMap<string, RowCacheEntry>;

/** Everything state-store reads from one SQLite file. */
export interface LoadedFile {
  readonly state: SyncState;
  readonly content: ContentSnapshot;
  readonly cache: RowCache;
  /** sync_state.file_id, per file, never merged. */
  readonly fileId: string | null;
  readonly syncFormat: number | null;
}

// ---------- Keys and context ----------

/** Keys of one key epoch. kSync/kPid = HKDF(kEpoch, lineage_id, label) (3.6). */
export interface EpochKeys {
  readonly epochId: string;
  readonly kEpoch: Buffer;
  readonly kSync: Buffer;
  readonly kPid: Buffer;
}

/** The current epoch's keys plus every ancestor reachable through valid wraps (4.8). */
export interface KeyRing {
  readonly current: EpochKeys;
  readonly byEpoch: ReadonlyMap<string, EpochKeys>;
}

/** Per-device, per-lineage runtime context. Clock and randomness are injected for tests. */
export interface SyncContext {
  readonly deviceUuid: string;
  readonly lineageId: string;
  /** Current dev of this launch for this lineage (3.1). */
  readonly dev: Dev;
  /** 32 hex (128 bits). */
  readonly incarnation: string;
  readonly keys: KeyRing;
  readonly now: () => number;
  readonly randomBytes: (n: number) => Buffer;
}

// ---------- Errors ----------

export type SyncErrorCode =
  | 'MERGE_PRECONDITION'
  | 'INVARIANT'
  | 'CORRUPT_STATE'
  | 'CORRUPT_LOCAL_STATE'
  | 'KEY_MISMATCH'
  | 'UNSUPPORTED_FORMAT'
  | 'DEV_COLLISION';

export class SyncCoreError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncCoreError';
    this.code = code;
  }
}

export * from './types-ui.js';
export * from './types-ops.js';
