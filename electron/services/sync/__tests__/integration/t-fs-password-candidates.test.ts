// @vitest-environment node
// 4.8 / 4.9: copies waiting for review in candidates/ after a password change on this device. A
// file copy is sealed (AES-GCM of the whole file) under the new epoch key, so the old password
// cannot open it and [Merge and review] still works; G3 rows are re-encrypted under the new
// epoch. A copy that no key this device holds can open any more is dropped with a notice.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidateRowsFromContent } from '../../candidates.js';
import { encryptSecret, openSecret, sealSecretBytes } from '../../key-epoch.js';
import { loadContent } from '../../state-store.js';
import { SyncHarness } from './sync-harness.js';
import { isSqlite, plain } from './local-copies-helpers.js';
import { SCENARIO_TIMEOUT_MS } from './scenario-helpers.js';
import type { HarnessDevice } from './harness-device.js';

let h: SyncHarness;

afterEach(async () => {
  for (const d of h.devices) expect(d.logger.unprefixed()).toEqual([]);
  expect(await h.dispose()).toEqual([]);
});

function secret(d: HarnessDevice, id: string): string | null {
  const ct = (d.row(id)?.password_encrypted as Buffer | null) ?? null;
  return ct === null ? null : (openSecret(ct, d.replica.ring().current.kEpoch)?.toString('utf8') ?? null);
}

/** A holds a pending copy of B's file with an item A does not have yet. */
async function pendingCopyOnA(label: string): Promise<{ a: HarnessDevice; id: string; file: string }> {
  h = new SyncHarness(label);
  const a = await h.create({ name: 'mac', start: false });
  a.insert({ id: 'e1', password: 'shared' });
  await h.syncAll();
  const b = await h.join({ name: 'pc', start: false });
  b.insert({ id: 'from-b', password: 'b-secret' });
  expect((await b.sync()).kind).toBe('published');
  fs.mkdirSync(a.replica.paths.tmp, { recursive: true });
  const copy = path.join(a.replica.paths.tmp, 'picked.conduit');
  fs.copyFileSync(b.sharedPath, copy);
  const c = await a.engine.parts().candidates.addFile({ path: copy, source: 'user-picked', label: 'Vault from pc', staleByNature: false });
  if (c.payload.kind !== 'file') throw new Error('expected a file candidate');
  return { a, id: c.id, file: c.payload.path };
}

describe('pending review copies after a password change (4.8, 4.9)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('a file copy is sealed under the new key and still merges', async () => {
    const { a, id, file } = await pendingCopyOnA('cand-seal-file');
    const oldKey = a.replica.ring().current.kEpoch;
    const mtime = fs.statSync(file).mtimeMs;
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    const bytes = fs.readFileSync(file);
    expect(isSqlite(file)).toBe(false);
    expect(openSecret(bytes, oldKey)).toBeNull();
    expect(openSecret(bytes, a.replica.ring().current.kEpoch)?.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    expect(Math.abs(fs.statSync(file).mtimeMs - mtime)).toBeLessThan(1);
    const candidates = a.engine.parts().candidates;
    expect((await candidates.preview(id)).onlyInCopy.map((r) => r.row.rowId)).toContain('from-b');
    await candidates.apply(id, { deleteMissing: [] });
    expect(a.live('from-b')).toBe(true);
    expect(secret(a, 'from-b')).toBe('b-secret');
    expect(secret(a, 'e1')).toBe('shared');
  });

  it('a sealed copy is sealed again under the next password', async () => {
    const { a, id, file } = await pendingCopyOnA('cand-seal-twice');
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    const midKey = a.replica.ring().current.kEpoch;
    await a.engine.changePassword('pw2', 'pw3', false);
    await h.idle();
    expect(openSecret(fs.readFileSync(file), midKey)).toBeNull();
    await a.engine.parts().candidates.apply(id, { deleteMissing: [] });
    expect(secret(a, 'from-b')).toBe('b-secret');
  });

  it('G3 rows are re-encrypted under the new epoch and still merge', async () => {
    h = new SyncHarness('cand-rows');
    const a = await h.create({ name: 'mac', start: false });
    a.insert({ id: 'e1', password: 'mine' });
    expect((await a.sync()).kind).toBe('published');
    const oldKey = a.replica.ring().current.kEpoch;
    const ctx = a.replica.context();
    const content = loadContent(a.replica.database());
    const entry = content.entries.get('e1');
    if (entry === undefined) throw new Error('no e1');
    const leftover = encryptSecret('from the leftovers', a.replica.ring().current, ctx.randomBytes);
    const rows = candidateRowsFromContent({ ...content, entries: new Map([['e1', { ...entry, password_encrypted: leftover, updated_at: '2030-01-01T00:00:00.000Z' }]]) }, ctx);
    const candidates = a.engine.parts().candidates;
    const c = await candidates.addRows({ rows, epochId: a.replica.ring().current.epochId, source: 'genesis-leftovers', label: 'Leftovers' });
    if (c.payload.kind !== 'rows') throw new Error('expected rows');
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    const ring = a.replica.ring();
    const stored = JSON.parse(fs.readFileSync(c.payload.path, 'utf8')) as { rows: [string, { values: [string, { value: never }][] }][] };
    const password = stored.rows[0][1].values.find(([reg]) => reg === 'password')?.[1].value;
    expect(plain(password, oldKey)).toBeNull();
    expect(plain(password, ring.current.kEpoch)).toBe('from the leftovers');
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(c.payload.path), `${c.id}.json`), 'utf8')) as { payload: { epochId: string } };
    expect(meta.payload.epochId).toBe(ring.current.epochId);
    expect(candidates.list().find((x) => x.id === c.id)?.payload).toMatchObject({ epochId: ring.current.epochId });
    expect((await candidates.preview(c.id)).changedFields.map((f) => f.key.reg)).toContain('password');
  });

  it('a copy no key on this device opens any more is dropped with a notice', async () => {
    const { a, id, file } = await pendingCopyOnA('cand-drop');
    await a.engine.changePassword('pw', 'pw2', false);
    await h.idle();
    const inner = openSecret(fs.readFileSync(file), a.replica.ring().current.kEpoch);
    if (inner === null) throw new Error('not sealed');
    fs.writeFileSync(file, sealSecretBytes(inner, crypto.randomBytes(32), (n) => crypto.randomBytes(n)));
    a.engine.parts().status.setPrompt({ kind: 'candidate', id: `candidate:${id}`, candidateId: id, label: 'Vault from pc' });
    await a.engine.changePassword('pw2', 'pw3', false);
    await h.idle();
    expect(a.engine.parts().candidates.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(a.replica.local().notices.filter((n) => n.kind === 'candidate-dropped')).toEqual([expect.objectContaining({ count: 1 })]);
    expect(a.engine.parts().status.snapshot().prompts.map((p) => p.id)).not.toContain(`candidate:${id}`);
  });
});
