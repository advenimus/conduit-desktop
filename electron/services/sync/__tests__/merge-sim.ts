// Test-only replica simulator for merge property tests. Replicas hold whole SyncStates and a
// per-register history of write ids for the oracle. Operations mirror capture semantics
// (spec 4.2, 4.3, 4.7): app writes (interactive and not) with rule R, inserts, deletes and
// revivals (interactive and not), restores, legacy edits and deletes with legacy rule R,
// redaction, re-encryption, stale-key copies, snapshots and restores (with a new dev, or the
// broken reuse-dev variant). Primitives live in merge-sim-core.ts.
import { LIFE_DEAD, LIFE_LIVE, LIFE_REG, regKey, rowKey } from '../catalog.js';
import { identityKey, isEligible, isPseudo, pmemJoin } from '../sibling.js';
import { StateBuilder, emptyState, provisional, regKeyStr } from '../state-view.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, TBL, ZERO_VHASH } from '../types.js';
import type { AppDot, RegKey, RowKey, Sibling, SyncValue } from '../types.js';
import { appSib, md5, pidOfText, pseudoSib, vh } from './merge-fixtures.js';
import { applyGraves, clonedSnapshot } from './merge-sim-graves.js';
import {
  DOMAIN,
  EDITABLE,
  GENESIS_ROWS,
  PREV_LEN,
  SECRET_REG,
  SIM_GENESIS,
  SIM_LINEAGE,
  encrypt,
  keptByLegacy,
  keptNonInteractive,
  lifeKey,
  pick,
  plaintextOf,
  pmemNow,
  prevOf,
  putRegister,
  recordImplicit,
  rowsWhere,
  sibsNow,
  tick,
  valueFor,
  write,
  writesOf,
  type OpCtx,
  type Replica,
  type World,
} from './merge-sim-core.js';

export {
  GENESIS_CELLS,
  GENESIS_ROWS,
  REGS,
  SIM_GENESIS,
  SIM_LINEAGE,
  plaintextOf,
  type MergeFn,
  type Replica,
  type World,
} from './merge-sim-core.js';

const MAX_SNAPSHOTS = 3;
const LT_SPREAD = 5;

// ---------- Genesis ----------

function genesisRegister(ctx: OpCtx, key: RegKey, choice: number): void {
  const { value, vhash } = valueFor(ctx.world, key, choice);
  const domain = DOMAIN[key.reg];
  if (choice % domain.length === 0) {
    recordImplicit(ctx.world, ctx.hist, key);
    return;
  }
  const pid = pidOfText(`g|${regKeyStr(key)}|${vhash}`);
  const sib = pseudoSib(0, pid, value, vhash, { lt: parseInt(vhash.slice(0, 2), 16) % LT_SPREAD });
  const k = regKeyStr(key);
  const empty = new Set<string>();
  writesOf(ctx.world, k).set(`g|${pid}`, { identity: identityKey(sib), vhash, pseudo: true, ms: 0, past: empty, keptPseudo: empty });
  ctx.hist.set(k, new Set([`g|${pid}`]));
  putRegister(ctx.b, key, [sib], { ms: 0, ids: [pid] });
}

export function genesisReplica(world: World, dev: number, cells: readonly number[]): Replica {
  const ctx: OpCtx = { world, b: new StateBuilder(emptyState(SIM_LINEAGE, SIM_GENESIS, 0)), hist: new Map() };
  GENESIS_ROWS.forEach((rowId, r) => {
    ctx.b.ensureRow(rowKey(TBL.entries, rowId));
    recordImplicit(world, ctx.hist, regKey(TBL.entries, rowId, LIFE_REG));
    EDITABLE.forEach((reg, i) => genesisRegister(ctx, regKey(TBL.entries, rowId, reg), cells[r * EDITABLE.length + i] ?? 0));
  });
  return { state: ctx.b.build(), dev, hist: ctx.hist };
}

// ---------- Operations ----------

export interface SimOp {
  readonly kind: OpKind;
  readonly r: number;
  readonly j: number;
  readonly row: number;
  readonly reg: number;
  readonly value: number;
  readonly hint: number;
  readonly flag: boolean;
}

export type OpKind =
  | 'app'
  | 'insert'
  | 'delete'
  | 'revive'
  | 'legacy'
  | 'legacy-delete'
  | 'merge'
  | 'redact'
  | 'reencrypt'
  | 'stale-key'
  | 'snapshot'
  | 'restore'
  | 'tick';

function reassertLive(ctx: OpCtx, row: RowKey, dot: AppDot): void {
  const key = lifeKey(row);
  const before = sibsNow(ctx.b, key);
  const kept = before.filter((s) => s.value === LIFE_DEAD);
  const sib = appSib(dot.dev, dot.ms, dot.c, LIFE_LIVE, vh(key, LIFE_LIVE), { prevVhash: prevOf(before, LIFE_REG) });
  write(ctx, key, sib, kept, pmemNow(ctx.b, key));
}

function appEdit(ctx: OpCtx, rep: Replica, index: number, op: SimOp): void {
  const row = pick(rowsWhere(ctx.b.snapshot(), 'live'), op.row);
  if (!row) return;
  const dot = tick(ctx, rep, index);
  const regs = [EDITABLE[op.reg % EDITABLE.length], EDITABLE[(op.reg >> 3) % EDITABLE.length]];
  for (const reg of new Set(regs)) {
    const key = regKey(row.tbl, row.rowId, reg);
    const before = sibsNow(ctx.b, key);
    const { value, vhash } = valueFor(ctx.world, key, op.value + reg.length);
    const sib = appSib(dot.dev, dot.ms, dot.c, value, vhash, { prevVhash: prevOf(before, reg) });
    write(ctx, key, sib, op.flag ? [] : keptNonInteractive(before, reg), pmemNow(ctx.b, key));
  }
  reassertLive(ctx, row, dot);
}

function insertRow(ctx: OpCtx, rep: Replica, index: number, op: SimOp): void {
  const row = rowKey(TBL.entries, `n${ctx.world.nextRow++}`);
  const dot = tick(ctx, rep, index);
  const life = lifeKey(row);
  write(ctx, life, appSib(dot.dev, dot.ms, dot.c, LIFE_LIVE, vh(life, LIFE_LIVE)), [], null);
  for (const reg of EDITABLE) {
    const key = regKey(row.tbl, row.rowId, reg);
    const choice = op.value + reg.length * (op.reg + 1);
    if (choice % DOMAIN[reg].length === 0) {
      recordImplicit(ctx.world, ctx.hist, key);
      continue;
    }
    const { value, vhash } = valueFor(ctx.world, key, choice);
    write(ctx, key, appSib(dot.dev, dot.ms, dot.c, value, vhash), [], null);
  }
}

/** A delete or revival: interactive (flag) replaces every sibling, otherwise only the provisional value. */
function setLife(ctx: OpCtx, rep: Replica, index: number, op: SimOp, from: 'live' | 'dead'): void {
  const row = pick(rowsWhere(ctx.b.snapshot(), from), op.row);
  if (!row) return;
  const dot = tick(ctx, rep, index);
  const key = lifeKey(row);
  const value = from === 'live' ? LIFE_DEAD : LIFE_LIVE;
  const before = sibsNow(ctx.b, key);
  const kept = op.flag ? [] : keptNonInteractive(before, LIFE_REG);
  write(ctx, key, appSib(dot.dev, dot.ms, dot.c, value, vh(key, value), { prevVhash: prevOf(before, LIFE_REG) }), kept, pmemNow(ctx.b, key));
}

/** A legacy change of one register (4.3 rules 3 and 4): returns the new pseudo ms, or null. */
function legacyChange(ctx: OpCtx, key: RegKey, value: SyncValue, vhash: string, op: SimOp): number | null {
  const before = sibsNow(ctx.b, key);
  const w = provisional(key.reg, before);
  if (w && w.vhash === vhash) return null;
  const pm = pmemNow(ctx.b, key);
  const ms = Math.max(op.hint, (pm?.ms ?? -1) + 1);
  const pid = pidOfText(`${regKeyStr(key)}|${vhash}|${w ? identityKey(w) : 'none'}`);
  const stale = op.flag && w !== null && !isPseudo(w) && w.prevVhash === vhash.slice(0, PREV_LEN);
  const kept = keptByLegacy(before, w, stale);
  write(ctx, key, pseudoSib(ms, pid, value, vhash, { lt: op.hint }), kept, pmemJoin(pm, { ms, ids: [pid] }));
  return ms;
}

function legacyReassert(ctx: OpCtx, row: RowKey, minMs: number, hint: number): void {
  const key = lifeKey(row);
  const before = sibsNow(ctx.b, key);
  const w = provisional(LIFE_REG, before);
  const pm = pmemNow(ctx.b, key);
  const ms = Math.max(minMs, (pm?.ms ?? -1) + 1);
  const vhash = vh(key, LIFE_LIVE);
  const pid = pidOfText(`${regKeyStr(key)}|${vhash}|${w ? identityKey(w) : 'none'}`);
  const kept = before.filter((s) => s.value === LIFE_DEAD);
  write(ctx, key, pseudoSib(ms, pid, LIFE_LIVE, vhash, { lt: hint }), kept, pmemJoin(pm, { ms, ids: [pid] }));
}

function legacyEdit(ctx: OpCtx, op: SimOp): void {
  const row = pick(rowsWhere(ctx.b.snapshot(), 'live'), op.row);
  if (!row) return;
  const key = regKey(row.tbl, row.rowId, EDITABLE[op.reg % EDITABLE.length]);
  const { value, vhash } = valueFor(ctx.world, key, op.value);
  const ms = legacyChange(ctx, key, value, vhash, op);
  if (ms !== null) legacyReassert(ctx, row, ms, op.hint);
}

function legacyDelete(ctx: OpCtx, op: SimOp): void {
  const row = pick(rowsWhere(ctx.b.snapshot(), 'live'), op.row);
  if (!row) return;
  const key = lifeKey(row);
  legacyChange(ctx, key, LIFE_DEAD, vh(key, LIFE_DEAD), { ...op, flag: false });
}

function redactRow(ctx: OpCtx, op: SimOp): void {
  const row = pick(rowsWhere(ctx.b.snapshot(), 'dead'), op.row);
  const state = row ? ctx.b.row(row) : undefined;
  if (!row || !state) return;
  for (const reg of state.regs.values()) {
    if (reg.key.reg === LIFE_REG) continue;
    const sibs = reg.sibs.map((s) => ({ ...s, value: null, vhash: ZERO_VHASH, flags: s.flags | SIB_REDACTED, prevVhash: null }));
    ctx.b.setRegister({ key: reg.key, sibs, pmem: reg.pmem });
  }
  const died = provisional(LIFE_REG, sibsNow(ctx.b, lifeKey(row)));
  const g = state.grave ?? (died ? { diedMs: died.ms, diedC: died.c, diedDev: died.dev, redacted: false } : null);
  if (g) ctx.b.setGrave(row, { ...g, redacted: true });
}

function mapSecretSiblings(ctx: OpCtx, only: RowKey | null, f: (s: Sibling) => Sibling): void {
  for (const row of ctx.b.snapshot().rows.values()) {
    if (only && row.key.rowId !== only.rowId) continue;
    const reg = row.regs.get(SECRET_REG);
    if (!reg) continue;
    const sibs = reg.sibs.map((s) => (isEligible(s) && s.value instanceof Uint8Array ? f(s) : s));
    if (sibs.some((s, i) => s !== reg.sibs[i])) ctx.b.setRegister({ key: reg.key, sibs, pmem: reg.pmem });
  }
}

function reencrypt(ctx: OpCtx): void {
  mapSecretSiblings(ctx, null, (s) => ({ ...s, value: encrypt(ctx.world, plaintextOf(s.value) ?? '') }));
}

function staleKey(ctx: OpCtx, op: SimOp): void {
  const row = pick([...ctx.b.snapshot().rows.values()].map((r) => r.key), op.row);
  if (!row) return;
  mapSecretSiblings(ctx, row, (s) => ({
    ...s,
    flags: s.flags | SIB_UNDECRYPTABLE,
    vhash: md5(`cvhx:${Buffer.from(s.value as Uint8Array).toString('hex')}`),
  }));
}

function mergeReplicas(world: World, a: Replica, b: Replica, clone: boolean): Replica {
  const other = clone ? clonedSnapshot(b.state) : b.state;
  const hist = new Map(a.hist);
  for (const [k, ids] of b.hist) hist.set(k, new Set([...(hist.get(k) ?? []), ...ids]));
  return { state: applyGraves(world.mergeFn(a.state, other)), dev: a.dev, hist };
}

function restore(world: World, i: number, op: SimOp): void {
  const snap = pick(world.snapshots[i], op.row);
  if (!snap) return;
  const dev = world.reuseDevOnRestore ? world.replicas[i].dev : world.nextDev++;
  world.replicas[i] = { ...snap, dev };
}

function localOp(ctx: OpCtx, rep: Replica, i: number, op: SimOp): void {
  switch (op.kind) {
    case 'app':
      return appEdit(ctx, rep, i, op);
    case 'insert':
      return insertRow(ctx, rep, i, op);
    case 'delete':
      return setLife(ctx, rep, i, op, 'live');
    case 'revive':
      return setLife(ctx, rep, i, op, 'dead');
    case 'legacy':
      return legacyEdit(ctx, op);
    case 'legacy-delete':
      return legacyDelete(ctx, op);
    case 'redact':
      return redactRow(ctx, op);
    case 'reencrypt':
      return reencrypt(ctx);
    case 'stale-key':
      return staleKey(ctx, op);
    default:
      return undefined;
  }
}

/** Applies one operation to the world. */
export function applyOp(world: World, op: SimOp): void {
  const n = world.replicas.length;
  const i = op.r % n;
  const rep = world.replicas[i];
  if (op.kind === 'tick') {
    world.clock += 1 + (op.flag ? 1 : 0);
  } else if (op.kind === 'merge') {
    world.replicas[i] = mergeReplicas(world, rep, world.replicas[op.j % n], op.flag);
  } else if (op.kind === 'snapshot') {
    world.snapshots[i] = [...world.snapshots[i], rep].slice(-MAX_SNAPSHOTS);
  } else if (op.kind === 'restore') {
    restore(world, i, op);
  } else {
    const ctx: OpCtx = { world, b: new StateBuilder(rep.state), hist: new Map(rep.hist) };
    localOp(ctx, rep, i, op);
    world.replicas[i] = { state: applyGraves(ctx.b.build()), dev: rep.dev, hist: ctx.hist };
  }
}
