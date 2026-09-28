// Fixtures for snapshot and restore tests: real epoch keys, two devices' contexts, a helper that
// applies interactive writes under one dot, a seeded state of entries with passwords, and a
// scratch SQLite file for VACUUM INTO.
import Database from 'better-sqlite3';
import path from 'node:path';
import { regKey } from '../catalog.js';
import { applyLocalWrites, prepareWrite } from '../capture-local.js';
import { readSecret } from '../key-epoch.js';
import { emptyState, provisional, provisionalValue, rowLife } from '../state-view.js';
import { TBL, type LocalWrite, type RegKey, type RowKey, type SyncContext, type SyncState, type SyncValue } from '../types.js';
import { GENESIS, LINEAGE, NOW_MS, implicitFor, keysFor, makeCtx, ringOf } from './conflicts-fixtures.js';

export { LINEAGE, NOW_MS };

export const KEYS = keysFor('master', 'salt-1');
export const RING = ringOf(KEYS);
export const ME: SyncContext = makeCtx(RING, 1);
export const MAC: SyncContext = { ...makeCtx(RING, 2), dev: 77, deviceUuid: 'device-mac' };
export const PC: SyncContext = { ...makeCtx(RING, 3), dev: 88, deviceUuid: 'device-pc' };
export const IMPLICIT = implicitFor(ME);
export const FOLDER_ID = 'f1';
export const HOUR_MS = 60 * 60 * 1000;

export const entry = (id: string): RowKey => ({ tbl: TBL.entries, rowId: id });
export const ek = (id: string, reg: string): RegKey => regKey(TBL.entries, id, reg);
export const entryId = (i: number): string => `e${String(i).padStart(3, '0')}`;

export function write(key: RegKey, value: SyncValue, ctx: SyncContext): LocalWrite {
  return prepareWrite(key, { value }, ctx, 'replace-all');
}

export function secretWrite(key: RegKey, plaintext: string | null, ctx: SyncContext): LocalWrite {
  return prepareWrite(key, { plaintext }, ctx, 'replace-all');
}

/** One interactive operation of `ctx`'s device at `ms`. */
export function apply(state: SyncState, writes: readonly LocalWrite[], ctx: SyncContext, ms: number): SyncState {
  const att = { kind: 'local', dot: { dev: ctx.dev, ms, c: 0 }, interactive: true } as const;
  return applyLocalWrites(state, writes, att, ctx, IMPLICIT).state;
}

/** Folder f1 with `n` entries e000.. (name, host, container, password pw-<i>), written by ME. */
export function seedEntries(n: number, ms = NOW_MS - 10 * HOUR_MS): SyncState {
  const writes: LocalWrite[] = [
    write(regKey(TBL.folders, FOLDER_ID, '_life'), 'live', ME),
    write(regKey(TBL.folders, FOLDER_ID, 'name'), 'Servers', ME),
  ];
  for (let i = 0; i < n; i++) {
    const id = entryId(i);
    writes.push(
      write(ek(id, '_life'), 'live', ME),
      write(ek(id, 'name'), `server ${i}`, ME),
      write(ek(id, 'entry_type'), 'ssh', ME),
      write(ek(id, 'host'), `10.0.0.${i}`, ME),
      write(ek(id, 'container'), `f:${FOLDER_ID}`, ME),
      secretWrite(ek(id, 'password'), `pw-${i}`, ME),
    );
  }
  return apply(emptyState(LINEAGE, GENESIS, 0), writes, ME, ms);
}

export function deleteWrites(ids: readonly string[], ctx: SyncContext): LocalWrite[] {
  return ids.map((id) => write(ek(id, '_life'), 'dead', ctx));
}

export function passwordOf(state: SyncState, id: string): string | null {
  const reg = state.rows.get(`1:${id}`)?.regs.get('password');
  const p = reg ? provisional('password', reg.sibs) : null;
  if (!(p?.value instanceof Uint8Array)) return null;
  const read = readSecret(p.value, RING);
  return read.kind === 'undecryptable' ? null : read.plaintext;
}

export function hostOf(state: SyncState, id: string): SyncValue | undefined {
  return provisionalValue(state, ek(id, 'host'), null);
}

export function isLive(state: SyncState, id: string): boolean {
  return rowLife(state, entry(id)) === 'live';
}

/** A small SQLite file standing in for W (VACUUM INTO needs a real connection). */
export function scratchDb(dir: string): Database.Database {
  const db = new Database(path.join(dir, 'w-source.conduit'));
  db.exec('CREATE TABLE t (x TEXT); INSERT INTO t VALUES (\'hello\')');
  return db;
}
