// @vitest-environment node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIR_EVENT_SETTLE_MS,
  HASH_POLL_MS,
  STAT_POLL_MS,
  SharedFileWatcher,
  signatureOf,
  signaturesDiffer,
  type ChangeReason,
  type FileWatchHost,
  type FileWatchListener,
} from '../file-watch.js';
import type { SyncFs, WatchEventType } from '../host.js';
import type { SideFileTuple } from '../types.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';

interface FakeWatchEntry {
  readonly dir: string;
  readonly onEvent: (type: WatchEventType, fileName: string | null) => void;
  readonly onError: (err: Error) => void;
  closed: boolean;
}

class FakeWatch {
  readonly entries: FakeWatchEntry[] = [];
  failNext = false;

  readonly watchDir: SyncFs['watchDir'] = (dir, onEvent, onError) => {
    if (this.failNext) {
      this.failNext = false;
      throw Object.assign(new Error('ENOENT: watch'), { code: 'ENOENT' });
    }
    const entry: FakeWatchEntry = { dir, onEvent, onError, closed: false };
    this.entries.push(entry);
    return { close: () => (entry.closed = true) };
  };

  active(): FakeWatchEntry {
    const e = [...this.entries].reverse().find((x) => !x.closed);
    if (e === undefined) throw new Error('no active watch');
    return e;
  }
}

class Recorder implements FileWatchListener {
  readonly changes: ChangeReason[] = [];
  readonly tuples: SideFileTuple[][] = [];
  readonly dirs: (string | null)[] = [];
  readonly errors: Error[] = [];
  sharedChanged(reason: ChangeReason): void {
    this.changes.push(reason);
  }
  sideFilesObserved(tuples: readonly SideFileTuple[]): void {
    this.tuples.push([...tuples]);
  }
  directoryChanged(fileName: string | null): void {
    this.dirs.push(fileName);
  }
  watchError(err: Error): void {
    this.errors.push(err);
  }
}

let root: string;
let t: TestSyncHost;
let watch: FakeWatch;
let rec: Recorder;
let host: FileWatchHost;
let sharedDir: string;
let sharedPath: string;
let watcher: SharedFileWatcher;

beforeEach(() => {
  root = makeTempRoot('file-watch');
  t = makeTestSyncHost(root);
  watch = new FakeWatch();
  const fsx: SyncFs = { ...t.fs, watchDir: watch.watchDir };
  host = { fs: fsx, timers: t.clock, clock: t.clock, logger: t.logger };
  rec = new Recorder();
  sharedDir = path.join(root, 'cloud');
  fs.mkdirSync(sharedDir, { recursive: true });
  sharedPath = path.join(sharedDir, 'Vault.conduit');
  fs.writeFileSync(sharedPath, crypto.randomBytes(4096));
  watcher = new SharedFileWatcher(sharedPath, host, rec);
});

afterEach(() => {
  watcher.stop();
  expect(t.clock.pending()).toBe(0);
  expect(t.logger.unprefixed()).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function acknowledgeCurrent(): Promise<void> {
  watcher.acknowledge(signatureOf(await t.fs.stat(sharedPath)), sha(sharedPath));
}

function setMtime(p: string, ms: number): void {
  fs.utimesSync(p, ms / 1000, ms / 1000);
}

describe('signatures', () => {
  it('compares size, mtime and ino with != and treats null versus non-null as different', () => {
    const a = { size: 1, mtimeMs: 2, ino: '3' };
    expect(signaturesDiffer(a, { ...a })).toBe(false);
    expect(signaturesDiffer(a, { ...a, mtimeMs: 1 })).toBe(true);
    expect(signaturesDiffer(a, { ...a, ino: '4' })).toBe(true);
    expect(signaturesDiffer(a, null)).toBe(true);
    expect(signaturesDiffer(null, null)).toBe(false);
    expect(signatureOf(null)).toBeNull();
  });
});

describe('SharedFileWatcher', () => {
  it('detects a rename-replace with an OLDER mtime through the 3 s stat poll (ino change)', async () => {
    watcher.start();
    await acknowledgeCurrent();
    const before = fs.statSync(sharedPath);
    const replacement = path.join(sharedDir, '.~Vault.conduit.abc.tmp');
    fs.writeFileSync(replacement, crypto.randomBytes(before.size));
    setMtime(replacement, before.mtimeMs - 3_600_000);
    fs.renameSync(replacement, sharedPath);
    await t.clock.advance(STAT_POLL_MS);
    await watcher.settled();
    expect(rec.changes).toEqual(['stat']);
  });

  it('detects equal size and mtime with new content only through the 60 s hash poll', async () => {
    watcher.start();
    await acknowledgeCurrent();
    const before = fs.statSync(sharedPath);
    const fd = fs.openSync(sharedPath, 'r+');
    fs.writeSync(fd, crypto.randomBytes(before.size), 0, before.size, 0);
    fs.closeSync(fd);
    setMtime(sharedPath, before.mtimeMs);
    await watcher.pollNow();
    expect(rec.changes).toEqual([]);
    await t.clock.advance(HASH_POLL_MS);
    await watcher.settled();
    expect(rec.changes).toEqual(['hash']);
  });

  it('does not report an acknowledged publish', async () => {
    watcher.start();
    await acknowledgeCurrent();
    const tmp = path.join(sharedDir, '.~Vault.conduit.def.tmp');
    fs.writeFileSync(tmp, crypto.randomBytes(8192));
    fs.renameSync(tmp, sharedPath);
    await acknowledgeCurrent();
    await watcher.pollNow();
    await watcher.hashNow();
    expect(rec.changes).toEqual([]);
  });

  it('records the first stat and the first hash silently when nothing was acknowledged', async () => {
    await watcher.pollNow();
    await watcher.hashNow();
    expect(rec.changes).toEqual([]);
    fs.writeFileSync(sharedPath, crypto.randomBytes(100));
    await watcher.pollNow();
    await watcher.hashNow();
    expect(rec.changes).toEqual(['stat', 'hash']);
  });

  it('reports vanished and appeared, and an acknowledged absence is quiet', async () => {
    await acknowledgeCurrent();
    fs.rmSync(sharedPath);
    await watcher.pollNow();
    expect(rec.changes).toEqual(['vanished']);
    await watcher.pollNow();
    expect(rec.changes).toEqual(['vanished', 'vanished']);
    watcher.acknowledge(null, null);
    await watcher.pollNow();
    expect(rec.changes).toHaveLength(2);
    fs.writeFileSync(sharedPath, 'back');
    await watcher.pollNow();
    expect(rec.changes).toEqual(['vanished', 'vanished', 'appeared']);
  });

  it('acknowledgeObserved quiets the stat and hash seen so far; a later change is reported', async () => {
    await acknowledgeCurrent();
    fs.writeFileSync(sharedPath, crypto.randomBytes(100));
    await watcher.pollNow();
    await watcher.hashNow();
    expect(rec.changes).toEqual(['stat', 'hash']);
    watcher.acknowledgeObserved();
    await watcher.pollNow();
    await watcher.hashNow();
    expect(rec.changes).toHaveLength(2);
    fs.rmSync(sharedPath);
    await watcher.pollNow();
    watcher.acknowledgeObserved();
    await watcher.pollNow();
    expect(rec.changes).toEqual(['stat', 'hash', 'vanished']);
    fs.writeFileSync(sharedPath, 'back');
    await watcher.pollNow();
    expect(rec.changes).toEqual(['stat', 'hash', 'vanished', 'appeared']);
  });

  it('reports the S-wal and S-shm tuples on every poll', async () => {
    watcher.start();
    await t.clock.advance(STAT_POLL_MS);
    await watcher.settled();
    fs.writeFileSync(`${sharedPath}-wal`, Buffer.alloc(32));
    await t.clock.advance(STAT_POLL_MS);
    await watcher.settled();
    expect(rec.tuples).toHaveLength(2);
    expect(rec.tuples[0]).toEqual([
      { name: 'wal', exists: false, size: 0, mtimeMs: 0 },
      { name: 'shm', exists: false, size: 0, mtimeMs: 0 },
    ]);
    expect(rec.tuples[1]?.[0]).toMatchObject({ name: 'wal', exists: true, size: 32 });
    expect(rec.tuples[1]?.[1]).toEqual({ name: 'shm', exists: false, size: 0, mtimeMs: 0 });
  });

  it('coalesces folder events for S into one dir-event after the settle time', async () => {
    watcher.start();
    await acknowledgeCurrent();
    fs.writeFileSync(sharedPath, crypto.randomBytes(10));
    const w = watch.active();
    w.onEvent('rename', 'Vault.conduit');
    w.onEvent('change', 'Vault.conduit');
    w.onEvent('rename', '.~Vault.conduit.x1.tmp');
    expect(rec.changes).toEqual([]);
    await t.clock.advance(DIR_EVENT_SETTLE_MS);
    await watcher.settled();
    expect(rec.changes).toEqual(['dir-event']);
    expect(rec.dirs).toEqual([]);
  });

  it('passes other .conduit names to directoryChanged and ignores temps and other files', async () => {
    watcher.start();
    await acknowledgeCurrent();
    const w = watch.active();
    w.onEvent('rename', 'Vault (conflicted copy).conduit');
    w.onEvent('rename', 'Vault (conflicted copy).conduit');
    w.onEvent('rename', 'notes.txt');
    w.onEvent('rename', 'Vault.conduit-wal');
    await t.clock.advance(DIR_EVENT_SETTLE_MS);
    await watcher.settled();
    expect(rec.dirs).toEqual(['Vault (conflicted copy).conduit']);
    expect(rec.changes).toEqual([]);
  });

  it('keeps polling after a watch error and re-creates the watch on the next poll', async () => {
    watcher.start();
    await acknowledgeCurrent();
    watch.active().onError(Object.assign(new Error('EPERM: watch'), { code: 'EPERM' }));
    expect(rec.errors).toHaveLength(1);
    expect(watch.entries[0]?.closed).toBe(true);
    fs.writeFileSync(sharedPath, crypto.randomBytes(7));
    await t.clock.advance(STAT_POLL_MS);
    await watcher.settled();
    expect(rec.changes).toEqual(['stat']);
    expect(watch.entries).toHaveLength(2);
    expect(watch.active()).toBe(watch.entries[1]);
  });

  it('reports a watch that cannot start and still polls', async () => {
    watch.failNext = true;
    watcher.start();
    expect(rec.errors).toHaveLength(1);
    await t.clock.advance(STAT_POLL_MS);
    await watcher.settled();
    expect(watch.entries).toHaveLength(1);
    expect(rec.tuples).toHaveLength(1);
  });

  it('follows a new shared path and forgets the old acknowledgment', async () => {
    watcher.start();
    await acknowledgeCurrent();
    const otherDir = path.join(root, 'moved');
    fs.mkdirSync(otherDir);
    const moved = path.join(otherDir, 'Vault.conduit');
    fs.copyFileSync(sharedPath, moved);
    watcher.setSharedPath(moved);
    expect(watch.entries[0]?.closed).toBe(true);
    expect(watch.active().dir).toBe(otherDir);
    await watcher.pollNow();
    expect(rec.changes).toEqual([]);
  });

  it('stop cancels every timer, closes the watch and is idempotent', async () => {
    watcher.start();
    watch.active().onEvent('rename', 'Vault.conduit');
    expect(t.clock.pending()).toBe(3);
    watcher.stop();
    watcher.stop();
    expect(t.clock.pending()).toBe(0);
    expect(watch.entries.every((e) => e.closed)).toBe(true);
    fs.writeFileSync(sharedPath, 'changed');
    await watcher.pollNow();
    expect(rec.changes).toEqual([]);
  });
});
