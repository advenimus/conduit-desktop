// Private copies a device keeps beside W (spec 3.2), planted before a password change and
// checked after it (4.8): nothing there may open with the old key.
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { openSecret, verifyKey } from '../../key-epoch.js';
import { SNAPSHOT_DB_FILE } from '../../snapshots.js';
import { decodeValue, type EncodedValue } from '../../value-codec.js';
import { withCopy } from './vault-ops.js';
import type { HarnessDevice } from './harness-device.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** genesis.conduit, a quarantined copy and a sidefiles folder, all copies of S as it is now. */
export function plantCopies(d: HarnessDevice): void {
  const { paths } = d.replica;
  fs.copyFileSync(d.sharedPath, paths.genesis);
  fs.mkdirSync(paths.quarantine, { recursive: true });
  fs.copyFileSync(d.sharedPath, path.join(paths.quarantine, `${d.now()}-abcdef12.conduit`));
  const side = path.join(paths.dir, `sidefiles-${d.now()}`);
  fs.mkdirSync(side, { recursive: true });
  fs.copyFileSync(d.sharedPath, path.join(side, 'Vault.conduit-wal'));
}

export function isSqlite(file: string): boolean {
  return fs.readFileSync(file).subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

/** Vault files in `dir` whose vault_meta verification the key opens. */
export function openedBy(dir: string, key: Buffer, scratch: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.conduit') && isSqlite(path.join(dir, name)))
    .filter((name) =>
      withCopy(path.join(dir, name), scratch, (db) => {
        const row = db.prepare("SELECT value FROM vault_meta WHERE key = 'verification'").get() as { value: string } | undefined;
        return row !== undefined && verifyKey(key, row.value);
      }),
    );
}

export function plain(enc: EncodedValue | undefined, key: Buffer): string | null {
  const ct = decodeValue(enc ?? null);
  if (!(ct instanceof Uint8Array)) throw new Error('expected a ciphertext');
  return openSecret(ct, key)?.toString('utf8') ?? null;
}

/** Nothing in the lineage's private folders opens with `oldKey`; W, local.json and S stay. */
export async function expectSealed(d: HarnessDevice, oldKey: Buffer, scratch: string): Promise<void> {
  const { paths } = d.replica;
  expect(fs.existsSync(paths.genesis)).toBe(false);
  expect(fs.existsSync(paths.quarantine) ? fs.readdirSync(paths.quarantine) : []).toEqual([]);
  expect(fs.readdirSync(paths.dir).filter((n) => n.startsWith('sidefiles-'))).toEqual([]);
  expect(openedBy(paths.incoming, oldKey, scratch)).toEqual([]);
  const store = d.engine.parts().snapshots;
  for (const snap of await store.list()) {
    expect(fs.existsSync(path.join(snap.dir, SNAPSHOT_DB_FILE))).toBe(false);
    expect(snap.meta.epochId).toBe(d.replica.ring().current.epochId);
    const { diff } = await store.loadDiff(snap.id);
    for (const r of diff.deleted) {
      if (r.values.password !== undefined) expect(plain(r.values.password, oldKey)).toBeNull();
    }
  }
  expect(d.replica.local().sealLocalCopiesPending ?? false).toBe(false);
  expect(fs.existsSync(paths.working)).toBe(true);
  expect(fs.existsSync(paths.local)).toBe(true);
  expect(fs.existsSync(d.sharedPath)).toBe(true);
}
