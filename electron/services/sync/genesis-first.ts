/**
 * G1 first genesis (spec 4.4): a deterministic state from the bytes of a legacy file, and the
 * first state of a brand-new vault. Import through genesis.ts.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { parseLegacyTime } from './canonical.js';
import {
  CONTENT_TBLS,
  epochRegKey,
  isDefaultValue,
  metaRegKey,
  readContentRow,
  readMetaRegisters,
  regKey,
  registerDef,
  rowKey,
} from './catalog.js';
import {
  baseRefOf,
  pidOf,
  rawHash,
  vaultIdFor,
  vhashOfSecret,
  vhashOfValue,
  vhashUndecryptable,
  vrefPlain,
  vrefSecret,
} from './hashing.js';
import { encryptSecret, readSecret } from './key-epoch.js';
import { rowKeyStr, rowOf } from './state-view.js';
import {
  PSEUDO_DEV,
  SIB_UNDECRYPTABLE,
  TBL,
  type AppDot,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type DevRecord,
  type EntryRow,
  type EpochKeys,
  type EpochRecord,
  type HistoryRow,
  type KeyRing,
  type LocalNotice,
  type RegKey,
  type RegisterState,
  type RowCache,
  type RowCacheEntry,
  type RowState,
  type Sibling,
  type SyncState,
  type SyncValue,
} from './types.js';

export const GENESIS_MS = 0;
const META_SALT_KEY = 'salt';
const META_VERIFICATION_KEY = 'verification';
const VAULT_ID_REG = 'vault_id';

export interface GenesisInput {
  readonly content: ContentSnapshot;
  /** genesis_id = hashing.genesisIdOf(file bytes). */
  readonly genesisId: string;
  /** hashing.lineageIdFromSalt(salt) for a legacy file, or the binding's lineage. */
  readonly lineageId: string;
  /** Keys of the file's current password (E0). */
  readonly k0: EpochKeys;
  /** Older keys for stale-key secrets found at genesis (optional). */
  readonly ring?: KeyRing;
  /** Nonces for re-encrypting stale-key secrets under E0 (default: node crypto). */
  readonly randomBytes?: (n: number) => Buffer;
  /** Clock for notice timestamps only (default: Date.now). Never enters the state. */
  readonly now?: () => number;
}

export interface GenesisResult {
  readonly state: SyncState;
  /** sync_row for the genesis content: every row materialized with its raw_hash. */
  readonly cache: RowCache;
  /** Secrets no key could read, kept as undecryptable siblings. */
  readonly undecryptable: number;
  readonly notices: readonly LocalNotice[];
}

export interface NewVaultInput {
  readonly lineageId: string;
  readonly genesisId: string;
  readonly k0: EpochKeys;
  readonly salt: string;
  readonly verification: string;
  readonly createdMs: number;
  /** Dot for the epoch and vault_id registers of a brand-new vault. */
  readonly dot: { readonly dev: number; readonly ms: number; readonly c: number };
  readonly vaultId: string;
  /** When given, the dot's dev is recorded in sync_dev with this install's uuid. */
  readonly deviceUuid?: string;
}

/** A register value ready to become a genesis pseudo sibling. */
interface GenesisValue {
  readonly value: SyncValue;
  readonly vhash: string;
  readonly vref: Uint8Array;
  readonly flags: number;
}

interface GenesisEnv {
  readonly k0: EpochKeys;
  readonly ring: KeyRing;
  readonly baseRef: Buffer;
  readonly randomBytes: (n: number) => Buffer;
  undecryptable: number;
}

/** Parsed legacy row time (4.3): updated_at for entries and folders, changed_at for history. */
export function contentRowTime(tbl: ContentTbl, row: ContentRow): number {
  if (tbl === TBL.history) return parseLegacyTime((row as HistoryRow).changed_at);
  return parseLegacyTime((row as EntryRow).updated_at);
}

/** Calls fn for every row of the three content tables, in table order. */
export function forEachContentRow(content: ContentSnapshot, fn: (tbl: ContentTbl, row: ContentRow) => void): void {
  for (const tbl of CONTENT_TBLS) {
    for (const row of contentTable(content, tbl).values()) fn(tbl, row);
  }
}

export function contentTable(content: ContentSnapshot, tbl: ContentTbl): ReadonlyMap<string, ContentRow> {
  if (tbl === TBL.entries) return content.entries;
  return tbl === TBL.folders ? content.folders : content.history;
}

/** G1: pseudo siblings (ms 0, c 0, lt = row updated_at, base_ref 0x00) for every non-default register. */
export function genesisFromContent(input: GenesisInput): GenesisResult {
  const env: GenesisEnv = {
    k0: input.k0,
    ring: ringWithCurrent(input.k0, input.ring),
    baseRef: baseRefOf(null),
    randomBytes: input.randomBytes ?? nodeRandomBytes,
    undecryptable: 0,
  };
  const rows = new Map<string, RowState>();
  const cache = new Map<string, RowCacheEntry>();
  forEachContentRow(input.content, (tbl, row) => {
    const key = rowKey(tbl, row.id);
    const k = rowKeyStr(key);
    rows.set(k, { key, regs: genesisRowRegisters(tbl, row, env), grave: null });
    cache.set(k, { materialized: true, rawHash: rawHash(tbl, row) });
  });
  addRowlessRegisters(rows, input, env);
  const state: SyncState = {
    lineageId: input.lineageId,
    genesisId: input.genesisId,
    createdMs: GENESIS_MS,
    vv: new Map(),
    devs: new Map(),
    rows,
    epochs: new Map([[input.k0.epochId, genesisEpochRecord(input)]]),
    wraps: new Map(),
  };
  const notices = undecryptableNotices(env.undecryptable, input);
  return { state, cache, undecryptable: env.undecryptable, notices };
}

function ringWithCurrent(k0: EpochKeys, ring: KeyRing | undefined): KeyRing {
  const byEpoch = new Map<string, EpochKeys>(ring?.byEpoch ?? []);
  if (ring) byEpoch.set(ring.current.epochId, ring.current);
  byEpoch.set(k0.epochId, k0);
  return { current: k0, byEpoch };
}

function genesisEpochRecord(input: GenesisInput): EpochRecord {
  return {
    epochId: input.k0.epochId,
    parent: null,
    salt: input.content.meta.get(META_SALT_KEY) ?? null,
    verification: input.content.meta.get(META_VERIFICATION_KEY) ?? null,
    createdMs: GENESIS_MS,
  };
}

function genesisRowRegisters(tbl: ContentTbl, row: ContentRow, env: GenesisEnv): Map<string, RegisterState> {
  const regs = new Map<string, RegisterState>();
  const lt = contentRowTime(tbl, row);
  for (const [reg, v] of readContentRow(tbl, row).values) {
    const key = regKey(tbl, row.id, reg);
    const gv = genesisValue(key, v, env);
    if (gv) regs.set(reg, genesisRegister(key, gv, lt, env));
  }
  return regs;
}

/** vault_meta registers (vault_id derived when missing) and `_sync/key/epoch`, all with lt 0. */
function addRowlessRegisters(rows: Map<string, RowState>, input: GenesisInput, env: GenesisEnv): void {
  const metaValues = new Map(readMetaRegisters(input.content.meta));
  const vaultId = metaValues.get(VAULT_ID_REG);
  if (vaultId === null || vaultId === undefined || vaultId === '') {
    metaValues.set(VAULT_ID_REG, vaultIdFor(input.lineageId));
  }
  const metaRegs = new Map<string, RegisterState>();
  for (const [reg, v] of metaValues) {
    const key = metaRegKey(reg as 'vault_id' | 'cloud_sync_enabled');
    const gv = genesisValue(key, v, env);
    if (gv) metaRegs.set(reg, genesisRegister(key, gv, GENESIS_MS, env));
  }
  putRow(rows, metaRegKey('vault_id'), metaRegs);

  const epochKey = epochRegKey();
  const epochValue = plainValue(epochKey, input.k0.epochId);
  putRow(rows, epochKey, new Map([[epochKey.reg, genesisRegister(epochKey, epochValue, GENESIS_MS, env)]]));
}

function putRow(rows: Map<string, RowState>, anyKey: RegKey, regs: Map<string, RegisterState>): void {
  const key = rowOf(anyKey);
  rows.set(rowKeyStr(key), { key, regs, grave: null });
}

function genesisValue(key: RegKey, v: SyncValue, env: GenesisEnv): GenesisValue | null {
  const def = registerDef(key);
  if (!def) return null;
  if (def.secret) return v instanceof Uint8Array && v.length > 0 ? secretValue(key, v, env) : null;
  return isDefaultValue(def, v) ? null : plainValue(key, v);
}

function plainValue(key: RegKey, v: SyncValue): GenesisValue {
  return { value: v, vhash: vhashOfValue(key, v), vref: vrefPlain(key, v), flags: 0 };
}

/**
 * Stale-key rule (4.8): E0 first, then every ring key. The pid's vref is over the STORED
 * ciphertext so every device computes the same pid, even when the value is re-encrypted.
 */
function secretValue(key: RegKey, ct: Uint8Array, env: GenesisEnv): GenesisValue | null {
  const vref = vrefSecret(ct);
  const read = readSecret(ct, env.ring);
  if (read.kind === 'undecryptable') {
    env.undecryptable += 1;
    return { value: ct, vhash: vhashUndecryptable(ct), vref, flags: SIB_UNDECRYPTABLE };
  }
  if (read.plaintext.length === 0) return null;
  const value = read.kind === 'current' ? ct : encryptSecret(read.plaintext, env.k0, env.randomBytes);
  return { value, vhash: vhashOfSecret(key, read.plaintext, env.k0.kSync), vref, flags: 0 };
}

function genesisRegister(key: RegKey, gv: GenesisValue, lt: number, env: GenesisEnv): RegisterState {
  const pid = pidOf(key, gv.vref, env.baseRef, env.k0.kPid);
  const sib: Sibling = {
    dev: PSEUDO_DEV,
    ms: GENESIS_MS,
    c: 0,
    pid,
    lt,
    vhash: gv.vhash,
    flags: gv.flags,
    value: gv.value,
    prevVhash: null,
  };
  return { key, sibs: [sib], pmem: { ms: GENESIS_MS, ids: [pid] } };
}

function undecryptableNotices(count: number, input: GenesisInput): LocalNotice[] {
  if (count === 0) return [];
  const now = input.now ?? Date.now;
  return [
    {
      id: `genesis-undecryptable:${input.genesisId}`,
      kind: 'undecryptable-secrets',
      key: null,
      createdMs: now(),
      sourceSha256: input.genesisId,
      count,
    },
  ];
}

// ---------- New vault ----------

/** A brand-new vault created by a new build: random lineage and genesis, E0, app-dot registers. */
export function newVaultState(input: NewVaultInput): SyncState {
  const dot = input.dot;
  if (!Number.isInteger(dot.dev) || dot.dev <= 0) throw new Error('newVaultState: dot.dev must be a positive integer');
  const epochKey = epochRegKey();
  const vaultKey = metaRegKey('vault_id');
  const rows = new Map<string, RowState>();
  putRow(rows, epochKey, new Map([[epochKey.reg, appRegister(epochKey, dot, input.k0.epochId)]]));
  putRow(rows, vaultKey, new Map([[vaultKey.reg, appRegister(vaultKey, dot, input.vaultId)]]));
  const devs = new Map<number, DevRecord>();
  if (input.deviceUuid) devs.set(dot.dev, { dev: dot.dev, deviceUuid: input.deviceUuid, startedMs: input.createdMs });
  const epoch: EpochRecord = {
    epochId: input.k0.epochId,
    parent: null,
    salt: input.salt,
    verification: input.verification,
    createdMs: input.createdMs,
  };
  return {
    lineageId: input.lineageId,
    genesisId: input.genesisId,
    createdMs: input.createdMs,
    vv: new Map([[dot.dev, { ms: dot.ms, c: dot.c }]]),
    devs,
    rows,
    epochs: new Map([[epoch.epochId, epoch]]),
    wraps: new Map(),
  };
}

/** A register written on an unknown row: one app sibling, no replaced value, empty pseudo memory. */
function appRegister(key: RegKey, dot: AppDot, value: string): RegisterState {
  const sib: Sibling = {
    dev: dot.dev,
    ms: dot.ms,
    c: dot.c,
    pid: '',
    lt: 0,
    vhash: vhashOfValue(key, value),
    flags: 0,
    value,
    prevVhash: null,
  };
  return { key, sibs: [sib], pmem: null };
}
