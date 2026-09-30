/**
 * Byte-level encodings used by state-store for the sync tables (spec 3.3): 16-byte hashes and
 * pids, 8-byte prev_vhash, pmem columns (derived versus explicit), and SyncValue <-> SQLite
 * cell conversion that keeps each value's natural storage class. Import through state-store.ts.
 */

import { pmemEquals } from './sibling.js';
import {
  HASH16_HEX_LEN,
  PREV_HEX_LEN,
  PSEUDO_DEV,
  SyncCoreError,
  type Pmem,
  type Sibling,
  type SqlValue,
  type SyncValue,
} from './types.js';

export const HASH16_BYTES = HASH16_HEX_LEN / 2;
export const PREV_BYTES = PREV_HEX_LEN / 2;
const LOWER_HEX = /^[0-9a-f]*$/;
const EMPTY_BLOB = Buffer.alloc(0);

export function corrupt(message: string): SyncCoreError {
  return new SyncCoreError('CORRUPT_STATE', `state-store: ${message}`);
}

export function invariant(message: string): SyncCoreError {
  return new SyncCoreError('INVARIANT', `state-store: ${message}`);
}

// ---------- Hex and blobs ----------

/** Save side: a hex string of exactly `bytes` bytes, lowercase. */
export function hexToBlob(hex: string, bytes: number, what: string): Buffer {
  if (hex.length !== bytes * 2 || !LOWER_HEX.test(hex)) throw invariant(`bad ${what}: expected ${bytes} bytes of lowercase hex`);
  return Buffer.from(hex, 'hex');
}

/** Load side: a BLOB of exactly `bytes` bytes (any length when `bytes` is null). */
export function blobToHex(v: unknown, bytes: number | null, what: string): string {
  if (!(v instanceof Uint8Array) || (bytes !== null && v.length !== bytes)) throw corrupt(`bad ${what} blob`);
  return toBuffer(v).toString('hex');
}

export function toBuffer(v: Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function num(v: unknown, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw corrupt(`${what} is not an integer`);
}

export function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw corrupt(`${what} is not text`);
  return v;
}

// ---------- Siblings ----------

/** sync_reg.pid / sync_sibling.pid on disk: 16 bytes for pseudo siblings; app siblings have none. */
export function pidToBlob(s: Sibling): Buffer | null {
  return s.dev === PSEUDO_DEV ? hexToBlob(s.pid, HASH16_BYTES, 'pid') : null;
}

/** Load side: a column selected as lower(hex(col)); '' stands for NULL or an empty blob. */
export function hexCell(v: unknown, bytes: number, what: string): string {
  if (typeof v !== 'string' || v.length !== bytes * 2) throw corrupt(`bad ${what}`);
  return v;
}

export function pidFromHexCell(dev: number, v: unknown): string {
  if (dev !== PSEUDO_DEV) {
    if (v === '') return '';
    throw corrupt('app sibling carries a pid');
  }
  return hexCell(v, HASH16_BYTES, 'pid');
}

export function prevToBlob(prev: string | null): Buffer | null {
  return prev === null ? null : hexToBlob(prev, PREV_BYTES, 'prev_vhash');
}

export function sameIdentity(a: Sibling, dev: number, ms: number, c: number, pid: string): boolean {
  return a.dev === dev && a.ms === ms && a.c === c && a.pid === pid;
}

// ---------- Pseudo memory ----------

/** The pmem a sync_reg row implies when pmem_ms and pmem_ids are NULL. */
export function derivedPmem(head: Pick<Sibling, 'dev' | 'ms' | 'pid'>): Pmem | null {
  return head.dev === PSEUDO_DEV ? { ms: head.ms, ids: [head.pid] } : null;
}

export interface PmemColumns {
  readonly ms: number | null;
  readonly ids: Buffer | null;
}

const DERIVED_COLUMNS: PmemColumns = { ms: null, ids: null };

/**
 * NULL columns when the memory equals the derived one. An empty memory under a pseudo head
 * violates I2 but is still stored losslessly as (NULL, x'').
 */
export function encodePmem(pmem: Pmem | null, head: Sibling): PmemColumns {
  if (pmemEquals(pmem, derivedPmem(head))) return DERIVED_COLUMNS;
  if (pmem === null) return { ms: null, ids: EMPTY_BLOB };
  const ids = [...new Set(pmem.ids)].sort().map((id) => hexToBlob(id, HASH16_BYTES, 'pmem id'));
  return { ms: pmem.ms, ids: Buffer.concat(ids) };
}

export function decodePmem(ms: unknown, ids: unknown, head: Pick<Sibling, 'dev' | 'ms' | 'pid'>): Pmem | null {
  if (ms === null) {
    if (ids === null) return derivedPmem(head);
    if (ids instanceof Uint8Array && ids.length === 0) return null;
    throw corrupt('pmem_ids without pmem_ms');
  }
  const memMs = num(ms, 'pmem_ms');
  if (ids === null) return { ms: memMs, ids: [] };
  if (!(ids instanceof Uint8Array) || ids.length % HASH16_BYTES !== 0) throw corrupt('bad pmem_ids blob');
  const buf = toBuffer(ids);
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += HASH16_BYTES) out.push(buf.toString('hex', i, i + HASH16_BYTES));
  return { ms: memMs, ids: [...new Set(out)].sort() };
}

// ---------- Values ----------

export type BindValue = null | bigint | number | string | Buffer;

/**
 * better-sqlite3 binds every JS number as REAL, which a TEXT column would store as "5.0" and
 * an untyped column as REAL. Safe integers bind as bigint so they keep the INTEGER class.
 */
export function bindValue(v: SyncValue | SqlValue | undefined): BindValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : v;
  if (typeof v === 'string' || typeof v === 'bigint') return v;
  return toBuffer(v);
}

/** A sync_sibling.value cell back to a SyncValue (the column has no affinity; classes survive). */
export function cellToValue(v: unknown): SyncValue {
  if (v === null || typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return toBuffer(v);
  throw corrupt('unsupported sibling value');
}
