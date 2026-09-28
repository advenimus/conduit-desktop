// @vitest-environment node
// 4.4 G2 step 3 / 4.9: while publishing stays blocked over a pre-sync S, every unlock reads the
// same S again before engine.start() loads the candidate queue; the pre-sync copy is still
// queued once, not once per unlock.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_TABLES } from '../schema.js';
import { assembleSyncEngine, nullSessionSignals, type SyncEngine } from '../sync-engine.js';
import { flushAsync, makeTempRoot } from './host-fakes.js';
import { bindingFor, makeDevice, newVaultSeed, open } from './replica-fixtures.js';

let root: string;

beforeEach(() => {
  root = makeTempRoot('presync-dedupe');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pre-sync candidate across unlocks', () => {
  it('queues one candidate for the same pre-sync S however many sessions read it first', async () => {
    const sharedPath = path.join(root, 'cloud', 'Vault.conduit');
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    const d = makeDevice(root, { hw8: 'aaaaaaaa' });
    const nv = newVaultSeed(d);
    const r = (await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(sharedPath))).replica;
    let e: SyncEngine = assembleSyncEngine({ host: d.t.host, replica: r, session: nullSessionSignals(), realpath: sharedPath });
    expect(await e.publishInitial()).toBe(true);
    const db = new Database(sharedPath);
    for (const t of SYNC_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.prepare("DELETE FROM vault_meta WHERE key = 'sync_format'").run();
    db.pragma('journal_mode = DELETE');
    db.close();
    fs.writeFileSync(`${sharedPath}-wal`, Buffer.alloc(0));
    fs.writeFileSync(`${sharedPath}-shm`, Buffer.alloc(32768));
    const candDir = path.join(r.paths.dir, 'candidates');
    try {
      for (let session = 0; session < 3; session++) {
        e = assembleSyncEngine({ host: d.t.host, replica: r, session: nullSessionSignals(), realpath: sharedPath });
        await e.runCycle('unlock');
        e.start();
        await flushAsync(20);
        await e.whenIdle();
        expect(e.parts().candidates.list()).toHaveLength(1);
        expect(fs.readdirSync(candDir).filter((n) => !n.endsWith('.json'))).toHaveLength(1);
        await e.stop();
      }
    } finally {
      await e.stop();
      r.close();
    }
  });
});
