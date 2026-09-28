// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeSyncFs } from '../host-node.js';
import { FakeClock, FaultyFs, makeTempRoot, makeTestSyncHost } from './host-fakes.js';
import type { VaultMutationInfo } from '../host.js';

const roots: string[] = [];

function tempRoot(): string {
  const r = makeTempRoot('host-fakes');
  roots.push(r);
  return r;
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('FakeClock', () => {
  it('fires timeouts and intervals in time order and resolves sleep', async () => {
    const clock = new FakeClock(1_000);
    const seen: string[] = [];
    clock.setTimeout(() => seen.push(`t500@${clock.now()}`), 500);
    const every = clock.setInterval(() => seen.push(`i300@${clock.now()}`), 300);
    const slept = clock.sleep(700).then(() => seen.push(`sleep@${clock.now()}`));
    await clock.advance(1_000);
    await slept;
    every.cancel();
    expect(seen).toEqual(['i300@1300', 't500@1500', 'i300@1600', 'sleep@1700', 'i300@1900']);
    expect(clock.now()).toBe(2_000);
    expect(clock.pending()).toBe(0);
  });

  it('cancelled timers never fire', async () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => (fired = true), 10).cancel();
    await clock.advance(100);
    expect(fired).toBe(false);
  });
});

describe('FaultyFs and the node adapter', () => {
  it('injects errno failures for matching calls only, the given number of times', async () => {
    const root = tempRoot();
    const file = path.join(root, 'Vault.conduit');
    const f = new FaultyFs();
    await f.writeFile(file, 'x');
    f.inject({ op: 'rename', match: /Vault\.conduit$/, code: 'EPERM', times: 2 });
    await expect(f.rename(file, `${file}.b`)).rejects.toMatchObject({ code: 'EPERM' });
    await expect(f.rename(file, `${file}.b`)).rejects.toMatchObject({ code: 'EPERM' });
    await f.rename(file, `${file}.b`);
    expect(fs.existsSync(`${file}.b`)).toBe(true);
    expect(f.calls.filter((c) => c.op === 'rename')).toHaveLength(3);
  });

  it('stat returns null for a missing file and exact inode text', async () => {
    const root = tempRoot();
    const nodeFs = createNodeSyncFs();
    expect(await nodeFs.stat(path.join(root, 'nope'))).toBeNull();
    const p = path.join(root, 'a');
    await nodeFs.writeFileDurable(p, 'abc');
    const st = await nodeFs.stat(p);
    expect(st).toMatchObject({ size: 3, isFile: true, isDirectory: false });
    expect(st?.ino).toMatch(/^[0-9]+$/);
    await nodeFs.utimes(p, 5_000, 7_000);
    expect((await nodeFs.stat(p))?.mtimeMs).toBe(7_000);
  });
});

describe('TestWorkingCopyHost', () => {
  it('opens one connection with the app schema and runs hooks around a mutation', () => {
    const root = tempRoot();
    const t = makeTestSyncHost(root);
    const handle = t.workingCopy.open({ path: path.join(root, 'w.conduit'), key: Buffer.alloc(32, 1), journalMode: 'wal', create: true });
    const seen: string[] = [];
    handle.setHooks({
      captureInTransaction: (m: VaultMutationInfo) => seen.push(`capture:${handle.db.inTransaction}:${m.rows.length}`),
      afterCommit: () => seen.push(`after:${handle.db.inTransaction}`),
      requestFullPass: () => undefined,
    });
    handle.mutate((db) => db.prepare("INSERT INTO folders(id, name, created_at, updated_at) VALUES ('f1', 'A', 'x', 'x')").run(), {
      rows: [{ tbl: 2, rowId: 'f1' }],
      interactive: true,
    });
    expect(seen).toEqual(['capture:true:1', 'after:false']);
    expect(handle.db.pragma('journal_mode', { simple: true })).toBe('wal');
    handle.close();
    expect(handle.closed).toBe(true);
  });
});
