/**
 * Shared vocabulary of the conflict queue (spec 4.10, 7): the context shape, fixed labels,
 * the walk over conflicted registers in a stable order, rank helpers and version lookup.
 * Import through conflicts.ts.
 */

import { CONTAINER_REG, LIFE_REG, fixedRegisters, isContentTbl, registerDef } from './catalog.js';
import { isConflict } from './merge.js';
import { compareRank, compareStr, identityKey, isEligible, isRedacted, isUndecryptable } from './sibling.js';
import { getRegister, rowLife } from './state-view.js';
import type {
  Dev,
  ImplicitProvider,
  KeyRing,
  RegKey,
  RegisterDef,
  RegisterState,
  RowState,
  Sibling,
  StructuralConflict,
  SyncState,
  Tbl,
} from './types.js';

export const CHANGED_BY_CONFLICT = 'conflict-resolution';
/** Title of the vault-level group holding the `_sync/key/epoch` conflict. */
export const MASTER_PASSWORD_TITLE = 'Master password';
/** Name suffix of a [Keep both] copy when the caller supplies no name for a version. */
export const COPY_NAME_SUFFIX = ' (copy)';
export const NOTES_REG = 'notes';
export const NAME_REG = 'name';
export { CONTAINER_REG, LIFE_REG };

export interface ConflictContext {
  readonly implicit: ImplicitProvider;
  /** From the last materialization. */
  readonly structural: readonly StructuralConflict[];
  /** Snooze keys from local.json (7.4). */
  readonly snoozed: ReadonlySet<string>;
  /** Synthetic candidate dev -> label (local.json candidateLabels). */
  readonly candidateLabels: ReadonlyMap<Dev, string>;
  /** regKeyStr of registers the merge guard repaired (local notices 'invariant-repair'). */
  readonly repairedKeys: ReadonlySet<string>;
  /**
   * The state's key ring (ctx.keys). Lets the stale-revert label recognize a secret written back
   * before a password change; without it only the current epoch's hashes are compared.
   */
  readonly keys?: KeyRing;
}

export interface ConflictedRegister {
  readonly row: RowState;
  readonly reg: RegisterState;
  readonly def: RegisterDef;
}

const UNLISTED_ORDER = Number.MAX_SAFE_INTEGER;
const catalogOrder = new Map<Tbl, ReadonlyMap<string, number>>();

function orderOf(tbl: Tbl, reg: string): number {
  let order = catalogOrder.get(tbl);
  if (!order) {
    order = new Map(fixedRegisters(tbl).map((d, i) => [d.reg, i]));
    catalogOrder.set(tbl, order);
  }
  return order.get(reg) ?? UNLISTED_ORDER;
}

/** Register names of a row in catalog order, dynamic families after them by name. */
export function orderedRegisterNames(row: RowState): string[] {
  const tbl = row.key.tbl;
  return [...row.regs.keys()].sort((a, b) => orderOf(tbl, a) - orderOf(tbl, b) || compareStr(a, b));
}

/**
 * Rows whose conflicts are listed: every `_sync` and vault_meta row, and content rows that are
 * not provisionally dead (a deleted item's leftover field conflicts are not shown; they come
 * back if the item is restored).
 */
export function isListedRow(state: SyncState, row: RowState): boolean {
  return !isContentTbl(row.key.tbl) || rowLife(state, row.key) !== 'dead';
}

/** Explicit registers of one row that meet the 4.5 conflict test, in catalog order. */
export function conflictedRegistersOfRow(row: RowState): ConflictedRegister[] {
  const out: ConflictedRegister[] = [];
  for (const name of orderedRegisterNames(row)) {
    const reg = row.regs.get(name);
    const def = reg ? registerDef(reg.key) : null;
    if (reg && def && isConflict(def, name, reg.sibs)) out.push({ row, reg, def });
  }
  return out;
}

/** Every explicit register that meets the 4.5 conflict test, listed rows in key order. */
export function conflictedRegisters(state: SyncState): ConflictedRegister[] {
  const out: ConflictedRegister[] = [];
  for (const k of [...state.rows.keys()].sort(compareStr)) {
    const row = state.rows.get(k);
    if (row && isListedRow(state, row)) out.push(...conflictedRegistersOfRow(row));
  }
  return out;
}

export function sortByRankDesc(sibs: readonly Sibling[]): Sibling[] {
  return [...sibs].sort((a, b) => compareRank(b, a));
}

/** "Keep newest": the highest-rank sibling that can be written back (decryptable, unredacted). */
export function highestRankEligible(sibs: readonly Sibling[]): Sibling | null {
  let top: Sibling | null = null;
  for (const s of sibs) {
    if (isEligible(s) && (top === null || compareRank(s, top) > 0)) top = s;
  }
  return top;
}

export function hasUndecryptableSibling(sibs: readonly Sibling[]): boolean {
  return sibs.some((s) => isUndecryptable(s) && !isRedacted(s));
}

/** The explicit sibling with this version id; throws when the register does not hold it. */
export function findVersion(state: SyncState, key: RegKey, versionId: string): Sibling {
  const sib = getRegister(state, key)?.sibs.find((s) => identityKey(s) === versionId);
  if (!sib) throw new Error(`conflict resolution: version ${versionId} not found in ${key.reg}`);
  return sib;
}

/** A version that can be written back with a {sibling} copy. */
export function requireWritableVersion(sib: Sibling): Sibling {
  if (!isEligible(sib)) throw new Error('conflict resolution: cannot choose an undecryptable or redacted version');
  return sib;
}

const UUID_BYTES = 16;
const UUID_VERSION_BYTE = 6;
const UUID_VARIANT_BYTE = 8;
const UUID_V4_BITS = 0x40;
const UUID_VARIANT_BITS = 0x80;
const LOW_NIBBLE = 0x0f;
const LOW_SIX_BITS = 0x3f;

/** RFC 4122 version-4 UUID from injected random bytes (new row ids for copies and history). */
export function uuidV4(random: Uint8Array): string {
  if (random.length < UUID_BYTES) throw new Error('uuidV4: need 16 random bytes');
  const b = Buffer.from(random.subarray(0, UUID_BYTES));
  b[UUID_VERSION_BYTE] = (b[UUID_VERSION_BYTE] & LOW_NIBBLE) | UUID_V4_BITS;
  b[UUID_VARIANT_BYTE] = (b[UUID_VARIANT_BYTE] & LOW_SIX_BITS) | UUID_VARIANT_BITS;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
