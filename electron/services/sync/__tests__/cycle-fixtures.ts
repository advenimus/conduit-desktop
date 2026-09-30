// A device with a real replica and a real, not started, engine (assembleSyncEngine) over a
// shared folder in a temp root, for the cycle, absorb, epoch and candidate tests.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SyncEngine, assembleSyncEngine, nullSessionSignals } from '../sync-engine.js';
import { loadFile } from '../state-store.js';
import { SYNC_TABLES } from '../schema.js';
import type { ReplicaPort } from '../replica.js';
import type { SessionSignals } from '../host.js';
import { TBL, type LoadedFile } from '../types.js';
import { makeTempRoot, type TestWorkingCopy } from './host-fakes.js';
import { bindingFor, makeDevice, newVaultSeed, open, sha256, type TestDevice } from './replica-fixtures.js';

const ISO = '2026-09-25T12:00:00.000Z';

export interface CycleDev {
  readonly d: TestDevice;
  readonly replica: ReplicaPort;
  readonly wc: TestWorkingCopy;
  readonly engine: SyncEngine;
  readonly sharedPath: string;
  readonly root: string;
  readonly key: Buffer;
}

export class CycleWorld {
  readonly roots: string[] = [];
  readonly devs: CycleDev[] = [];

  /** A new vault published to <root>/cloud/Vault.conduit (the engine is not started). */
  async solo(label: string, session: SessionSignals = nullSessionSignals()): Promise<CycleDev> {
    const root = makeTempRoot(label);
    this.roots.push(root);
    const sharedPath = path.join(root, 'cloud', 'Vault.conduit');
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    const d = makeDevice(root);
    const nv = newVaultSeed(d);
    const replica = (await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(sharedPath))).replica;
    const engine = assembleSyncEngine({ host: d.t.host, replica, session, realpath: sharedPath });
    const dev: CycleDev = { d, replica, wc: d.t.workingCopy.last(), engine, sharedPath, root, key: nv.key };
    this.devs.push(dev);
    if (!(await engine.publishInitial())) throw new Error('first publish failed');
    return dev;
  }

  /** A second device adopting `a`'s S. */
  async join(a: CycleDev, hw8 = 'bbbbbbbb'): Promise<CycleDev> {
    const d = makeDevice(a.root, { hw8 });
    const bytes = fs.readFileSync(a.sharedPath);
    const seed = { kind: 'adopt', sharedBytes: bytes, sharedSha256: sha256(bytes), sharedMtimeMs: fs.statSync(a.sharedPath).mtimeMs, holdLegacy: false } as const;
    const replica = (await open(d, a.replica.lineageId, a.key, seed, bindingFor(a.sharedPath, a.replica.local().binding?.fileId))).replica;
    const engine = assembleSyncEngine({ host: d.t.host, replica, session: nullSessionSignals(), realpath: a.sharedPath });
    const dev: CycleDev = { d, replica, wc: d.t.workingCopy.last(), engine, sharedPath: a.sharedPath, root: a.root, key: a.key };
    this.devs.push(dev);
    return dev;
  }

  async dispose(): Promise<readonly string[]> {
    const unprefixed: string[] = [];
    for (const x of this.devs.splice(0)) {
      await x.engine.stop();
      x.replica.close();
      unprefixed.push(...x.d.t.logger.unprefixed());
    }
    for (const r of this.roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
    return unprefixed;
  }
}

export function insert(x: CycleDev, ids: readonly string[]): void {
  x.wc.mutate(
    (db) => {
      const stmt = db.prepare(`INSERT INTO entries (id, name, entry_type, config, created_at, updated_at) VALUES (?, ?, 'ssh', '{}', ?, ?)`);
      for (const id of ids) stmt.run(id, `Server ${id}`, ISO, ISO);
    },
    { rows: ids.map((rowId) => ({ tbl: TBL.entries, rowId })), interactive: true },
  );
}

/** Loads a vault file through a private copy (never in place). */
export function loadVault(file: string, scratch: string): LoadedFile {
  fs.mkdirSync(scratch, { recursive: true });
  const copy = path.join(scratch, `v-${Math.random().toString(16).slice(2)}.conduit`);
  fs.copyFileSync(file, copy);
  const db = new Database(copy);
  try {
    return loadFile(db);
  } finally {
    db.close();
    fs.rmSync(copy, { force: true });
  }
}

/** Rewrites `file` as a pre-sync vault (no sync tables, no sync_format), optionally with new key meta. */
export function toPresync(file: string, meta: { readonly salt: string; readonly verification: string } | null = null): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    for (const t of SYNC_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.prepare(`DELETE FROM vault_meta WHERE key = 'sync_format'`).run();
    if (meta !== null) {
      db.prepare(`UPDATE vault_meta SET value = ? WHERE key = 'salt'`).run(meta.salt);
      db.prepare(`UPDATE vault_meta SET value = ? WHERE key = 'verification'`).run(meta.verification);
    }
  } finally {
    db.close();
  }
}
