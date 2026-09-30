// @vitest-environment node
// candidate-queue.ts on real files (spec 4.9): pending candidates persist under
// {lineage}/candidates/ and are rediscovered, corrupt entries and orphans are parked (never
// deleted), a replica copy with only app dots merges without review, a synthetic copy lists
// its differences and never deletes, [Delete them too] deletes interactively, [Don't merge]
// ignores a copy's SHA, and G3 rows queued before a password change still preview and merge.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANDIDATES_DIR, CandidateQueue } from '../candidate-queue.js';
import { candidateRowsFromContent } from '../candidates.js';
import { encryptSecret, readSecret } from '../key-epoch.js';
import { loadContent } from '../state-store.js';
import { getRegister, rowLife } from '../state-view.js';
import { TBL } from '../types.js';
import { CycleWorld, insert, toPresync, type CycleDev } from './cycle-fixtures.js';
import { editInPlace } from './replica-fixtures.js';

let world: CycleWorld;

afterEach(async () => {
  expect(await world.dispose()).toEqual([]);
});

function queueOf(x: CycleDev): CandidateQueue {
  const p = x.engine.parts();
  return new CandidateQueue({ replica: x.replica, shared: p.shared, notices: p.notices, host: x.d.t.host });
}

/** A private VACUUM INTO copy of `x`'s W. */
function copyOfW(x: CycleDev, name: string): string {
  fs.mkdirSync(x.replica.paths.tmp, { recursive: true });
  const file = path.join(x.replica.paths.tmp, name);
  x.engine.parts().shared.vacuumInto(x.replica.database(), file);
  return file;
}

function live(x: CycleDev, id: string): boolean {
  return rowLife(x.replica.state(), { tbl: TBL.entries, rowId: id }) === 'live';
}

describe('CandidateQueue persistence', () => {
  it('moves the private copy in, persists it, and a new queue rediscovers it', async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-persist');
    const q = queueOf(a);
    const src = copyOfW(a, 'copy.conduit');
    const c = await q.addFile({ path: src, source: 'copy', label: 'Vault 2.conduit', staleByNature: false });
    expect(fs.existsSync(src)).toBe(false);
    expect(c).toMatchObject({ kind: 'replica', source: 'copy', label: 'Vault 2.conduit' });
    const again = queueOf(a);
    await again.load();
    expect(again.list()).toEqual([c]);
  });

  it('parks a corrupt entry and an orphan payload instead of deleting them', async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-park');
    const dir = path.join(a.replica.paths.dir, CANDIDATES_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const bad = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, `${bad}.json`), '{ not json');
    const orphan = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, `${orphan}.rows.json`), '{}');
    const q = queueOf(a);
    await q.load();
    expect(q.list()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
    const parked = fs.readdirSync(a.replica.paths.parked).join(' ');
    expect(parked).toContain(`${bad}.json`);
    expect(parked).toContain(`${orphan}.rows.json`);
  });

  it('refuses a file that is not a Conduit vault and parks it', async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-refuse');
    fs.mkdirSync(a.replica.paths.tmp, { recursive: true });
    const junk = path.join(a.replica.paths.tmp, 'junk.conduit');
    fs.writeFileSync(junk, 'not a database');
    await expect(queueOf(a).addFile({ path: junk, source: 'user-picked', label: 'junk', staleByNature: false })).rejects.toThrow('[sync]');
    expect(fs.readdirSync(a.replica.paths.parked).some((n) => n.endsWith('.conduit'))).toBe(true);
  });
});

describe('CandidateQueue previews and merges', () => {
  it('a replica copy with only app dots needs no review and merges', async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-replica');
    const b = await world.join(a);
    insert(b, ['from-b']);
    const q = queueOf(a);
    const c = await q.addFile({ path: copyOfW(b, 'b.conduit'), source: 'user-picked', label: 'MacBook copy', staleByNature: false });
    const preview = await q.preview(c.id);
    expect(preview).toMatchObject({ kind: 'replica', needsReview: false, deletions: [] });
    await q.apply(c.id, { deleteMissing: [] });
    expect(live(a, 'from-b')).toBe(true);
    expect(q.list()).toEqual([]);
    expect(fs.existsSync(c.payload.path)).toBe(false);
  });

  it('a synthetic copy lists its differences, never deletes, and [Delete them too] deletes interactively', async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-synthetic');
    insert(a, ['keep', 'gone']);
    const copy = copyOfW(a, 'presync.conduit');
    toPresync(copy);
    editInPlace(copy, (db) => {
      db.prepare(`DELETE FROM entries WHERE id = 'gone'`).run();
      db.prepare(`INSERT INTO entries (id, name, entry_type, created_at, updated_at) VALUES ('only', 'Only here', 'ssh', ?, ?)`).run('2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    });
    const q = queueOf(a);
    const c = await q.addFile({ path: copy, source: 'copy', label: 'Old copy', staleByNature: false });
    expect(c.kind).toBe('synthetic');
    const preview = await q.preview(c.id);
    expect(preview.onlyInCopy.map((r) => r.row.rowId)).toEqual(['only']);
    expect(preview.missingFromCopy.map((r) => r.row.rowId)).toEqual(['gone']);
    expect(preview.deletions).toEqual([]);
    await q.apply(c.id, { deleteMissing: preview.missingFromCopy.map((r) => r.row) });
    expect(live(a, 'only')).toBe(true);
    expect(live(a, 'gone')).toBe(false);
    expect(live(a, 'keep')).toBe(true);
    expect(Object.values(a.replica.local().candidateLabels)).toEqual(['Old copy']);
  });

  it("[Don't merge] on a copy puts its SHA-256 into ignoredCopies", async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-discard');
    const q = queueOf(a);
    const c = await q.addFile({ path: copyOfW(a, 'x.conduit'), source: 'copy', label: 'x', staleByNature: false });
    await q.discard(c.id);
    expect(a.replica.local().ignoredCopies).toEqual([c.payload.kind === 'file' ? c.payload.sha256 : '']);
    expect(q.list()).toEqual([]);
  });

  it('G3 rows queued before a password change still preview and merge under the new key', async () => {
    world = new CycleWorld();
    const a = await world.solo('cand-rows');
    insert(a, ['e1']);
    const ctx = a.replica.context();
    const content = loadContent(a.replica.database());
    const entry = content.entries.get('e1')!;
    const secret = encryptSecret('from the old copy', a.replica.ring().current, ctx.randomBytes);
    const rows = candidateRowsFromContent({ ...content, entries: new Map([['e1', { ...entry, password_encrypted: secret, updated_at: '2030-01-01T00:00:00.000Z' }]]) }, ctx);
    const q = queueOf(a);
    const c = await q.addRows({ rows, epochId: a.replica.ring().current.epochId, source: 'genesis-leftovers', label: 'Leftovers' });
    a.replica.changePassword('pw', 'pw2', false);
    const preview = await q.preview(c.id);
    expect(preview.changedFields.map((f) => f.key.reg)).toContain('password');
    await q.apply(c.id, { deleteMissing: [] });
    const reg = getRegister(a.replica.state(), { tbl: TBL.entries, rowId: 'e1', reg: 'password' });
    const readable = (reg?.sibs ?? []).map((s) => (s.value instanceof Uint8Array ? readSecret(s.value, a.replica.ring()) : null));
    expect(readable.some((r) => r?.kind === 'current' && r.plaintext === 'from the old copy')).toBe(true);
  });
});
