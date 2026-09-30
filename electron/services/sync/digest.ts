/**
 * State comparison for the sync loop (spec 5.6, 5.7): a canonical dump and SHA-256 digest of
 * the logical state ("nothing changed" test, compared only on one device), and covers(S, P),
 * the check that a publish P survived in the shared file S.
 *
 * canonicalDump(state) is exactly jcs() of
 *   {h: [lineageId, genesisId, createdMs],
 *    vv: [[dev, ms, c]] by dev, devs: [[dev, deviceUuid, startedMs]] by dev,
 *    rows: [[rowKeyStr, grave, [[reg, pmem, [[identityKey, lt, vhash, flags]]]]]] by rowKeyStr,
 *    epochs: [[id, parent, salt, verification, createdMs]] by id, wraps: [wrapKeyStr] sorted}
 * with grave = [diedMs, diedC, diedDev, redacted 0|1] or null, pmem = [ms, ids] or null,
 * registers by name (implicit-equivalent ones skipped) and siblings in compareIdentity order.
 * Values, prevVhash, mat, the row cache and file_id are excluded. It is built as text
 * directly (no intermediate object tree) to stay cheap at 50,000 registers.
 */

import crypto from 'node:crypto';
import { IMPLICIT_PMEM, SYNC_ROW } from './catalog.js';
import {
  compareIdentity,
  compareNum,
  compareStr,
  identityKey,
  isRedacted,
  pmemCovers,
  pmemEquals,
  pmemJoin,
  vvCovers,
  vvDominates,
} from './sibling.js';
import { isImplicitEquivalent, wrapKeyStr } from './state-view.js';
import { PSEUDO_DEV, TBL, ZERO_PID, ZERO_VHASH } from './types.js';
import type { EpochRecord, Grave, Pmem, RegisterState, RowState, Sibling, SyncState } from './types.js';

type Sink = (chunk: string) => void;

const str = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s));
const num = (n: number): string => JSON.stringify(n);

function sortedByKey<T>(entries: Iterable<readonly [string, T]>): Array<readonly [string, T]> {
  return [...entries].sort((a, b) => compareStr(a[0], b[0]));
}

function sortedByDev<T>(entries: Iterable<readonly [number, T]>): Array<readonly [number, T]> {
  return [...entries].sort((a, b) => compareNum(a[0], b[0]));
}

function dumpSibling(s: Sibling): string {
  return `[${str(identityKey(s))},${num(s.lt)},${str(s.vhash)},${num(s.flags)}]`;
}

function dumpPmem(pm: Pmem | null): string {
  if (pm === null) return 'null';
  const ids = pm.ids.length > 1 ? [...pm.ids].sort(compareStr) : pm.ids;
  return `[${num(pm.ms)},[${ids.map(str).join(',')}]]`;
}

function dumpRegister(reg: RegisterState): string {
  const sibs = reg.sibs.length > 1 ? [...reg.sibs].sort(compareIdentity) : reg.sibs;
  return `[${str(reg.key.reg)},${dumpPmem(reg.pmem)},[${sibs.map(dumpSibling).join(',')}]]`;
}

function dumpGrave(g: Grave | null): string {
  if (g === null) return 'null';
  return `[${num(g.diedMs)},${num(g.diedC)},${num(g.diedDev)},${g.redacted ? 1 : 0}]`;
}

function dumpRow(key: string, row: RowState): string {
  const regs: string[] = [];
  for (const [, reg] of sortedByKey(row.regs)) {
    if (!isImplicitEquivalent(reg)) regs.push(dumpRegister(reg));
  }
  return `[${str(key)},${dumpGrave(row.grave)},[${regs.join(',')}]]`;
}

function dumpEpoch(e: EpochRecord): string {
  return `[${str(e.epochId)},${str(e.parent)},${str(e.salt)},${str(e.verification)},${num(e.createdMs)}]`;
}

/** Streams the dump in chunks (one per row) so digestState need not hold the whole text. */
function dumpInto(state: SyncState, sink: Sink): void {
  const devs = sortedByDev(state.devs).map(([, d]) => `[${num(d.dev)},${str(d.deviceUuid)},${num(d.startedMs)}]`);
  const epochs = sortedByKey(state.epochs).map(([, e]) => dumpEpoch(e));
  sink(`{"devs":[${devs.join(',')}],"epochs":[${epochs.join(',')}],`);
  sink(`"h":[${str(state.lineageId)},${str(state.genesisId)},${num(state.createdMs)}],"rows":[`);
  let first = true;
  for (const [key, row] of sortedByKey(state.rows)) {
    sink(first ? dumpRow(key, row) : `,${dumpRow(key, row)}`);
    first = false;
  }
  const vv = sortedByDev(state.vv).map(([dev, h]) => `[${num(dev)},${num(h.ms)},${num(h.c)}]`);
  const wraps = [...state.wraps.values()].map(wrapKeyStr).sort(compareStr);
  sink(`],"vv":[${vv.join(',')}],"wraps":[${wraps.map(str).join(',')}]}`);
}

/** Canonical sorted text dump of everything the digest covers (tests and debugging). */
export function canonicalDump(state: SyncState): string {
  const chunks: string[] = [];
  dumpInto(state, (c) => chunks.push(c));
  return chunks.join('');
}

/** Lowercase hex SHA-256 of canonicalDump(state). */
export function digestState(state: SyncState): string {
  const h = crypto.createHash('sha256');
  dumpInto(state, (c) => h.update(c, 'utf8'));
  return h.digest('hex');
}

// ---------- covers (5.7) ----------

/** Stands in for the implicit genesis sibling where only its identity matters. */
const IMPLICIT_IDENTITY: Sibling = Object.freeze({
  dev: PSEUDO_DEV,
  ms: 0,
  c: 0,
  pid: ZERO_PID,
  lt: 0,
  vhash: ZERO_VHASH,
  flags: 0,
  value: null,
  prevVhash: null,
});
const IMPLICIT_SIBS: readonly Sibling[] = Object.freeze([IMPLICIT_IDENTITY]);

interface RegView {
  readonly sibs: readonly Sibling[];
  readonly pmem: Pmem | null;
}

function viewOf(reg: RegisterState | undefined): RegView {
  return reg ?? { sibs: IMPLICIT_SIBS, pmem: IMPLICIT_PMEM };
}

function sameIdentity(a: Sibling, b: Sibling): boolean {
  if (a.dev !== b.dev || a.ms !== b.ms) return false;
  return a.dev === PSEUDO_DEV ? a.pid === b.pid : a.c === b.c;
}

/** covered(X, k, s) of 4.5 for one register view of X. */
function coveredBy(s: SyncState, view: RegView, sib: Sibling): boolean {
  return sib.dev === PSEUDO_DEV ? pmemCovers(view.pmem, sib) : vvCovers(s.vv, sib.dev, sib);
}

function siblingSurvives(s: SyncState, sView: RegView, pSib: Sibling): boolean {
  const match = sView.sibs.find((x) => sameIdentity(x, pSib));
  if (match === undefined) return coveredBy(s, sView, pSib);
  return !isRedacted(pSib) || isRedacted(match);
}

/** Every identity of p's register survives in s, and s's pseudo memory includes p's. */
function registerCovered(s: SyncState, sReg: RegisterState | undefined, pReg: RegisterState | undefined): boolean {
  if (sReg === pReg) return true;
  const sView = viewOf(sReg);
  const pView = viewOf(pReg);
  if (!pView.sibs.every((x) => siblingSurvives(s, sView, x))) return false;
  return pmemEquals(pmemJoin(sView.pmem, pView.pmem), sView.pmem);
}

function rowCovered(s: SyncState, sRow: RowState, pRow: RowState): boolean {
  if (sRow === pRow) return true;
  if (pRow.grave?.redacted === true && sRow.grave?.redacted !== true) return false;
  for (const [reg, pReg] of pRow.regs) {
    if (!registerCovered(s, sRow.regs.get(reg), pReg)) return false;
  }
  for (const [reg, sReg] of sRow.regs) {
    if (!pRow.regs.has(reg) && !registerCovered(s, sReg, undefined)) return false;
  }
  return true;
}

/** Merging p's record into s's (null wins for salt and verification, non-null parent, min createdMs) changes nothing. */
function epochCovered(sRec: EpochRecord | undefined, pRec: EpochRecord): boolean {
  if (sRec === undefined) return false;
  if (pRec.salt === null && sRec.salt !== null) return false;
  if (pRec.verification === null && sRec.verification !== null) return false;
  if (pRec.parent !== null && sRec.parent === null) return false;
  return sRec.createdMs <= pRec.createdMs;
}

function headerCovered(s: SyncState, p: SyncState): boolean {
  return s.lineageId === p.lineageId && s.genesisId === p.genesisId && s.createdMs <= p.createdMs;
}

function metadataCovered(s: SyncState, p: SyncState): boolean {
  for (const dev of p.devs.keys()) {
    if (!s.devs.has(dev)) return false;
  }
  for (const [id, rec] of p.epochs) {
    if (!epochCovered(s.epochs.get(id), rec)) return false;
  }
  for (const key of p.wraps.keys()) {
    if (!s.wraps.has(key)) return false;
  }
  return true;
}

/**
 * covers(S, P) of 5.7: S.vv >= P.vv and every register identity in P (explicit or implicit)
 * is present in S or covered by S. Also requires what a merge of P into S would otherwise
 * add: P's rows, devs, epochs (with their redactions), wraps, redacted graves and siblings,
 * and pseudo memory.
 */
export function covers(s: SyncState, p: SyncState): boolean {
  if (s === p) return true;
  if (!headerCovered(s, p) || !vvDominates(s.vv, p.vv) || !metadataCovered(s, p)) return false;
  for (const [key, pRow] of p.rows) {
    const sRow = s.rows.get(key);
    if (sRow === undefined || !rowCovered(s, sRow, pRow)) return false;
  }
  return true;
}

/** Presence and the owner claim say who had a file open; they are nothing a user wrote. */
function isBookkeepingRow(row: RowState): boolean {
  return row.key.tbl === TBL.sync && (row.key.rowId === SYNC_ROW.device || row.key.rowId === SYNC_ROW.owner);
}

/**
 * 5.8 class 2 "nothing new": covers(S, P) without P's presence and owner-claim registers, and so
 * without the devs and version-vector entries only those carry. A copy another device merely had
 * open adds its presence, which is not a change the user could review. Content, deletes, graves,
 * epochs and wraps must still be covered.
 */
export function coversIgnoringPresence(s: SyncState, p: SyncState): boolean {
  if (s === p) return true;
  if (!headerCovered(s, p)) return false;
  for (const [id, rec] of p.epochs) {
    if (!epochCovered(s.epochs.get(id), rec)) return false;
  }
  for (const key of p.wraps.keys()) {
    if (!s.wraps.has(key)) return false;
  }
  for (const [key, pRow] of p.rows) {
    if (isBookkeepingRow(pRow)) continue;
    const sRow = s.rows.get(key);
    if (sRow === undefined || !rowCovered(s, sRow, pRow)) return false;
  }
  return true;
}
