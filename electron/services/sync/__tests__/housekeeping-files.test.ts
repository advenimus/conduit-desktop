// @vitest-environment node
// Scratch folders never grow without bound (5.2 quarantine, 5.3 step 2, 12 fault injection):
// tmp/ leftovers and stale peek copies go after an hour, quarantine/ keeps the newest few for
// 30 days, a torn S is quarantined once, and a failed VACUUM INTO leaves no output behind.
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUARANTINE_KEEP, QUARANTINE_MAX_AGE_MS, SCRATCH_MAX_AGE_MS, cleanupScratch, pruneQuarantine } from '../housekeeping-files.js';
import { createSharedFile, vacuumInto, type SharedSnapshot } from '../shared-file.js';
import { makeTempRoot, makeTestSyncHost, type TestSyncHost } from './host-fakes.js';

let root: string;
let t: TestSyncHost;
let dir: string;

beforeEach(() => {
  root = makeTempRoot('housekeeping-files');
  t = makeTestSyncHost(root);
  dir = path.join(root, 'scratch');
  fs.mkdirSync(dir);
});

afterEach(() => {
  expect(t.logger.unprefixed()).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

function fileAged(name: string, ageMs: number, bytes = 'x'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  const at = (t.clock.now() - ageMs) / 1000;
  fs.utimesSync(p, at, at);
  return p;
}

describe('cleanupScratch', () => {
  it('removes files and folders older than an hour and keeps newer ones', async () => {
    fileAged('publish-old.conduit', SCRATCH_MAX_AGE_MS + 1000);
    fileAged('publish-new.conduit', 1000);
    const sub = path.join(dir, 'workdir-old');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'inner'), 'y');
    const at = (t.clock.now() - 2 * SCRATCH_MAX_AGE_MS) / 1000;
    fs.utimesSync(sub, at, at);
    expect(await cleanupScratch(dir, t.clock.now(), t.host)).toBe(2);
    expect(fs.readdirSync(dir)).toEqual(['publish-new.conduit']);
  });

  it('treats a missing folder as empty', async () => {
    expect(await cleanupScratch(path.join(root, 'nope'), t.clock.now(), t.host)).toBe(0);
  });
});

describe('pruneQuarantine', () => {
  it('keeps the newest copies within 30 days', async () => {
    for (let i = 0; i < QUARANTINE_KEEP + 2; i++) fileAged(`${i}-aaaaaaaa.conduit`, (i + 1) * 60_000);
    fileAged('old-bbbbbbbb.conduit', QUARANTINE_MAX_AGE_MS + 1);
    expect(await pruneQuarantine(dir, t.clock.now(), t.host)).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual(['0-aaaaaaaa.conduit', '1-aaaaaaaa.conduit', '2-aaaaaaaa.conduit', '3-aaaaaaaa.conduit', '4-aaaaaaaa.conduit']);
  });
});

describe('quarantine', () => {
  it('copies one torn SHA once, however often it is called', async () => {
    const shared = createSharedFile(t.host);
    const bytes = Buffer.from('torn bytes of the shared file');
    const stat = { size: bytes.length, mtimeMs: 0, ino: '1', isFile: true, isDirectory: false, isSymbolicLink: false };
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const real: SharedSnapshot = { path: path.join(root, 'Vault.conduit'), bytes, sha256, stat, stagedPath: '' };
    const q = path.join(root, 'quarantine');
    const first = await shared.quarantine(real, q);
    await t.clock.advance(60_000);
    expect(await shared.quarantine(real, q)).toBe(first);
    await t.clock.advance(60_000);
    expect(await shared.quarantine(real, q)).toBe(first);
    expect(fs.readdirSync(q)).toHaveLength(1);
    const other = { ...real, bytes: Buffer.from('other torn bytes'), sha256: 'cd'.repeat(32) };
    expect(await shared.quarantine(other, q)).not.toBe(first);
    expect(fs.readdirSync(q)).toHaveLength(2);
  });
});

describe('vacuumInto', () => {
  it('removes the partial output of a VACUUM INTO that fails', () => {
    const target = path.join(dir, 'publish-x.conduit');
    const failing = {
      inTransaction: false,
      prepare: () => ({
        run: (p: string) => {
          fs.writeFileSync(p, 'partial pages');
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
        },
      }),
    } as unknown as Database.Database;
    expect(() => vacuumInto(failing, target, t.logger)).toThrow('database or disk is full');
    expect(fs.existsSync(target)).toBe(false);
    expect(t.logger.messages('error').some((m) => m.includes('VACUUM INTO failed'))).toBe(true);
  });

  it('never removes a file that was already there', () => {
    const target = fileAged('existing.conduit', 0, 'not ours');
    const failing = {
      inTransaction: false,
      prepare: () => ({
        run: () => {
          throw Object.assign(new Error('output file already exists'), { code: 'SQLITE_ERROR' });
        },
      }),
    } as unknown as Database.Database;
    expect(() => vacuumInto(failing, target, t.logger)).toThrow('output file already exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('not ours');
  });
});
