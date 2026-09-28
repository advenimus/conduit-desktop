// Test-only primitives of the merge simulator (merge-sim.ts): the world and replica shapes,
// the value domain, register access inside one operation, write recording for the oracle,
// the replica clock and the replacement rules shared by app and legacy operations.
import { IMPLICIT_PMEM, LIFE_REG, regKey } from '../catalog.js';
import { identityKey, isPseudo } from '../sibling.js';
import { StateBuilder, isImplicitEquivalent, makeRegister, provisional, regKeyStr, rowLife } from '../state-view.js';
import { ZERO_PID } from '../types.js';
import type { AppDot, Pmem, RegKey, RowKey, Sibling, SyncState, SyncValue } from '../types.js';
import { fakeImplicit, vh, vhSecret } from './merge-fixtures.js';
import type { WriteRec } from './merge-oracle.js';

export const SIM_LINEAGE = 'lineage-sim';
export const SIM_GENESIS = 'genesis-sim';
export const REGS = [LIFE_REG, 'name', 'host', 'password', 'tag:x', 'config.a'] as const;
export const GENESIS_ROWS = ['g0', 'g1'] as const;
export const GENESIS_CELLS = GENESIS_ROWS.length * (REGS.length - 1);
export const EDITABLE = REGS.slice(1);
export const SECRET_REG = 'password';
export const PREV_LEN = 16;

/** Value domain per register (index 0 is the catalog default). Secrets are plaintexts. */
export const DOMAIN: Readonly<Record<string, readonly SyncValue[]>> = {
  name: ['', 'a', 'b'],
  host: [null, 'h1', 'h2'],
  password: [null, 'p1', 'p2'],
  'tag:x': [null, 1],
  'config.a': [null, '"1"', '"2"'],
};

export interface Replica {
  readonly state: SyncState;
  readonly dev: number;
  readonly hist: ReadonlyMap<string, ReadonlySet<string>>;
}

export type MergeFn = (a: SyncState, b: SyncState) => SyncState;

export interface World {
  replicas: Replica[];
  readonly snapshots: Replica[][];
  readonly writes: Map<string, Map<string, WriteRec>>;
  clock: number;
  nextDev: number;
  nextWrite: number;
  nextRow: number;
  nextNonce: number;
  readonly mergeFn: MergeFn;
  readonly reuseDevOnRestore: boolean;
}

export interface OpCtx {
  readonly world: World;
  readonly b: StateBuilder;
  readonly hist: Map<string, ReadonlySet<string>>;
}

// ---------- Values ----------

export function plaintextOf(v: SyncValue): string | null {
  if (!(v instanceof Uint8Array)) return null;
  const text = Buffer.from(v).toString('utf8');
  return text.slice(3, text.lastIndexOf(':'));
}

export function encrypt(world: World, plain: string): Uint8Array {
  return Buffer.from(`ct:${plain}:${world.nextNonce++}`, 'utf8');
}

export function valueFor(world: World, key: RegKey, choice: number): { value: SyncValue; vhash: string } {
  const domain = DOMAIN[key.reg];
  const raw = domain[choice % domain.length];
  if (key.reg !== SECRET_REG) return { value: raw, vhash: vh(key, raw) };
  const plain = typeof raw === 'string' ? raw : null;
  return { value: plain === null ? null : encrypt(world, plain), vhash: vhSecret(key, plain) };
}

// ---------- Register access inside one operation ----------

export function sibsNow(b: StateBuilder, key: RegKey): readonly Sibling[] {
  if (!b.hasRow(key)) return [];
  return b.register(key)?.sibs ?? [fakeImplicit(key)];
}

export function pmemNow(b: StateBuilder, key: RegKey): Pmem | null {
  if (!b.hasRow(key)) return null;
  const reg = b.register(key);
  return reg ? reg.pmem : IMPLICIT_PMEM;
}

export function putRegister(b: StateBuilder, key: RegKey, sibs: readonly Sibling[], pmem: Pmem | null): void {
  b.ensureRow(key);
  const reg = makeRegister(key, sibs, pmem);
  if (isImplicitEquivalent(reg)) b.removeRegister(key);
  else b.setRegister(reg);
}

export function writesOf(world: World, k: string): Map<string, WriteRec> {
  let m = world.writes.get(k);
  if (!m) {
    m = new Map();
    world.writes.set(k, m);
  }
  return m;
}

/** Replaces a register's siblings with `kept` plus `sib`, and records the write for the oracle. */
export function write(ctx: OpCtx, key: RegKey, sib: Sibling, kept: readonly Sibling[], pmem: Pmem | null): void {
  const k = regKeyStr(key);
  const regWrites = writesOf(ctx.world, k);
  const keptIds = new Set(kept.map(identityKey));
  const current = ctx.hist.get(k) ?? new Set<string>();
  const past = new Set([...current].filter((id) => !keptIds.has(regWrites.get(id)?.identity ?? '')));
  const id = `w${ctx.world.nextWrite++}`;
  const keptPseudo = new Set(isPseudo(sib) ? kept.filter(isPseudo).map(identityKey) : []);
  regWrites.set(id, { identity: identityKey(sib), vhash: sib.vhash, pseudo: isPseudo(sib), ms: sib.ms, past, keptPseudo });
  ctx.hist.set(k, new Set([...current, id]));
  putRegister(ctx.b, key, [...kept, sib], pmem);
}

export function recordImplicit(world: World, hist: Map<string, ReadonlySet<string>>, key: RegKey): void {
  const k = regKeyStr(key);
  const regWrites = writesOf(world, k);
  const empty = new Set<string>();
  regWrites.set('i', { identity: `p:0:${ZERO_PID}`, vhash: fakeImplicit(key).vhash, pseudo: true, ms: 0, past: empty, keptPseudo: empty });
  hist.set(k, new Set([...(hist.get(k) ?? []), 'i']));
}

export function tick(ctx: OpCtx, replica: Replica, index: number): AppDot {
  const prev = ctx.b.snapshot().vv.get(replica.dev);
  const ms = Math.max(ctx.world.clock, prev?.ms ?? 0);
  const c = prev && prev.ms === ms ? prev.c + 1 : 0;
  ctx.b.joinVv(replica.dev, { ms, c });
  ctx.b.addDev({ dev: replica.dev, deviceUuid: `device-${index}`, startedMs: ms });
  return { dev: replica.dev, ms, c };
}

export function prevOf(sibs: readonly Sibling[], reg: string): string | null {
  return provisional(reg, sibs)?.vhash.slice(0, PREV_LEN) ?? null;
}

// ---------- Replacement rules (4.2 step 5, 4.3 rules 3-4) ----------

/**
 * Siblings a non-interactive write keeps: all but the provisional and every sibling holding
 * its value (the writer saw them all).
 */
export function keptNonInteractive(before: readonly Sibling[], reg: string): readonly Sibling[] {
  const prov = provisional(reg, before);
  return prov === null ? before : before.filter((s) => s.vhash !== prov.vhash);
}

/** Legacy rule 4 keeps app siblings not holding w's value; a stale revert (rule 3) keeps every app sibling. */
export function keptByLegacy(before: readonly Sibling[], w: Sibling | null, stale: boolean): readonly Sibling[] {
  return before.filter((s) => !isPseudo(s) && (stale || w === null || s.vhash !== w.vhash));
}

// ---------- Row picking ----------

export function rowsWhere(state: SyncState, life: 'live' | 'dead'): RowKey[] {
  return [...state.rows.values()].map((r) => r.key).filter((k) => rowLife(state, k) === life);
}

export function pick<T>(items: readonly T[], n: number): T | undefined {
  return items.length === 0 ? undefined : items[n % items.length];
}

export function lifeKey(row: RowKey): RegKey {
  return regKey(row.tbl, row.rowId, LIFE_REG);
}
