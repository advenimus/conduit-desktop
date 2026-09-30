// Test-only fixtures for merge and conflicts tests: fake hashes, sibling builders, a canonical
// dump (stand-in for digest.canonicalDump plus values and prev) and deep clones.
import { createHash } from 'node:crypto';
import { implicitSiblingOf, requireDef } from '../catalog.js';
import { compareIdentity, identityKey } from '../sibling.js';
import { isImplicitEquivalent, wrapKeyStr } from '../state-view.js';
import {
  type Grave,
  type ImplicitProvider,
  type Pmem,
  type RegKey,
  type RegisterState,
  type RowState,
  type Sibling,
  type SyncState,
  type SyncValue,
} from '../types.js';

export function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function valueRepr(v: SyncValue): unknown {
  return v instanceof Uint8Array ? { b: Buffer.from(v).toString('hex') } : v;
}

/** Fake vhash (32 hex): a stand-in for hashing.vhashOfValue, one hash per logical value. */
export function vh(key: RegKey, value: SyncValue): string {
  return md5(JSON.stringify([key.tbl, key.rowId, key.reg, valueRepr(value)]));
}

/** Fake keyed vhash of a secret plaintext. */
export function vhSecret(key: RegKey, plaintext: string | null): string {
  return md5(JSON.stringify(['sec', key.tbl, key.rowId, key.reg, plaintext ?? '']));
}

export const fakeImplicit: ImplicitProvider = (key) => {
  const def = requireDef(key);
  return implicitSiblingOf(key, def.secret ? vhSecret(key, null) : vh(key, def.defaultValue));
};

export function appSib(dev: number, ms: number, c: number, value: SyncValue, vhash: string, extra: Partial<Sibling> = {}): Sibling {
  return { dev, ms, c, pid: '', lt: 0, vhash, flags: 0, value, prevVhash: null, ...extra };
}

export function pseudoSib(ms: number, pid: string, value: SyncValue, vhash: string, extra: Partial<Sibling> = {}): Sibling {
  return { dev: 0, ms, c: 0, pid, lt: 0, vhash, flags: 0, value, prevVhash: null, ...extra };
}

export function pidOfText(text: string): string {
  return md5(`pid:${text}`);
}

// ---------- Canonical dump (digest.ts format, plus values and prev) ----------

function hex(v: SyncValue): unknown {
  return v instanceof Uint8Array ? `x${Buffer.from(v).toString('hex')}` : v;
}

function dumpSibling(s: Sibling): unknown[] {
  return [identityKey(s), s.lt, s.vhash, s.flags, hex(s.value), s.prevVhash];
}

function dumpPmem(p: Pmem | null): unknown {
  return p === null ? null : [p.ms, [...p.ids]];
}

function dumpGrave(g: Grave | null): unknown {
  return g === null ? null : [g.diedMs, g.diedC, g.diedDev, g.redacted ? 1 : 0];
}

function dumpRow(k: string, row: RowState): unknown[] {
  const regs = [...row.regs.entries()]
    .filter(([, reg]) => !isImplicitEquivalent(reg))
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([name, reg]) => [name, dumpPmem(reg.pmem), [...reg.sibs].sort(compareIdentity).map(dumpSibling)]);
  return [k, dumpGrave(row.grave), regs];
}

const byFirst = (x: unknown[], y: unknown[]): number => {
  const a = String(x[0]);
  const b = String(y[0]);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Canonical text of everything merge must agree on (logical state plus values and prev). */
export function dumpState(s: SyncState): string {
  return JSON.stringify({
    h: [s.lineageId, s.genesisId, s.createdMs],
    vv: [...s.vv.entries()].sort((x, y) => x[0] - y[0]).map(([d, h]) => [d, h.ms, h.c]),
    devs: [...s.devs.values()].sort((x, y) => x.dev - y.dev).map((r) => [r.dev, r.deviceUuid, r.startedMs]),
    rows: [...s.rows.entries()].map(([k, row]) => dumpRow(k, row)).sort(byFirst),
    epochs: [...s.epochs.values()]
      .map((e) => [e.epochId, e.parent, e.salt, e.verification, e.createdMs])
      .sort(byFirst),
    wraps: [...s.wraps.values()].map(wrapKeyStr).sort(),
  });
}

// ---------- Deep clone (defeats reference fast paths) ----------

export interface CloneOptions {
  /** Drop prevVhash on non-head siblings, as a save and reload does. */
  readonly dropNonHeadPrev?: boolean;
  readonly head?: (reg: string, sibs: readonly Sibling[]) => Sibling | null;
}

function cloneSibling(s: Sibling, dropPrev: boolean): Sibling {
  const value = s.value instanceof Uint8Array ? Uint8Array.from(s.value) : s.value;
  return { ...s, value, prevVhash: dropPrev ? null : s.prevVhash };
}

function cloneRegister(reg: RegisterState, opts: CloneOptions): RegisterState {
  const head = opts.dropNonHeadPrev && opts.head ? opts.head(reg.key.reg, reg.sibs) : null;
  const sibs = reg.sibs.map((s) => cloneSibling(s, Boolean(opts.dropNonHeadPrev) && s !== head));
  const pmem = reg.pmem === null ? null : { ms: reg.pmem.ms, ids: [...reg.pmem.ids] };
  return reg.mat ? { key: { ...reg.key }, sibs, pmem, mat: { value: reg.mat.value } } : { key: { ...reg.key }, sibs, pmem };
}

export function cloneState(s: SyncState, opts: CloneOptions = {}): SyncState {
  const rows = new Map<string, RowState>();
  for (const [k, row] of s.rows) {
    const regs = new Map<string, RegisterState>();
    for (const [name, reg] of row.regs) regs.set(name, cloneRegister(reg, opts));
    rows.set(k, { key: { ...row.key }, regs, grave: row.grave ? { ...row.grave } : null });
  }
  return {
    lineageId: s.lineageId,
    genesisId: s.genesisId,
    createdMs: s.createdMs,
    vv: new Map([...s.vv].map(([d, h]) => [d, { ...h }])),
    devs: new Map([...s.devs].map(([d, r]) => [d, { ...r }])),
    rows,
    epochs: new Map([...s.epochs].map(([id, e]) => [id, { ...e }])),
    wraps: new Map([...s.wraps].map(([k, w]) => [k, { ...w }])),
  };
}

