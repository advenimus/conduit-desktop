// File-level checks on personal vaults in the run's cloud folder: read a shared file through a
// private copy (never in place, so no side files appear next to it), the SQLite header, the open
// that shipped iOS 1.0.5 does, a desktop 0.17 style in-place edit, device ids, and a background
// watch for -wal / -shm / -journal files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './run-context.mjs';

const require = createRequire(path.join(REPO, 'package.json'));
const SIDE_FILE = /-(wal|shm|journal)$/;
const SQLITE_MAGIC = 'SQLite format 3\0';

function openDb(file) {
  const Database = require('better-sqlite3');
  return new Database(file, { timeout: 5_000 });
}

function removeWithSideFiles(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true });
}

/** Runs `fn(db)` on a private copy of `file` under `scratchDir`; the copy is removed afterwards. */
export function withPrivateCopy(file, scratchDir, fn) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const copy = path.join(scratchDir, `copy-${crypto.randomBytes(4).toString('hex')}.conduit`);
  fs.copyFileSync(file, copy);
  let db = null;
  try {
    db = openDb(copy);
    return fn(db);
  } finally {
    db?.close();
    removeWithSideFiles(copy);
  }
}

/** Content rows of the shared file as other apps see them: [{id, name, host, port}]. */
export function sharedEntries(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => db.prepare('select id, name, host, port from entries order by name').all());
}

/** Magic check plus header bytes 18/19 (file format write/read version: 1 rollback journal, 2 WAL). */
export function sqliteHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(100);
    fs.readSync(fd, buf, 0, 100, 0);
    return { magicOk: buf.toString('latin1', 0, 16) === SQLITE_MAGIC, writeVersion: buf[18], readVersion: buf[19] };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The open of shipped iOS 1.0.5 (VaultDatabase.open), on a private copy: PRAGMA journal_mode = WAL
 * inside a write transaction, which SQLite refuses for a rollback-journal file.
 */
export function openLikeIos105(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => {
    db.exec('BEGIN IMMEDIATE');
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    db.exec('COMMIT');
    return {
      journalMode,
      quickCheck: db.pragma('quick_check', { simple: true }),
      schemaVersion: db.prepare("select value from vault_meta where key = 'schema_version'").get()?.value ?? null,
    };
  });
}

/**
 * Desktop 0.17 editing the shared file in place: WAL open, one UPDATE with a fresh updated_at,
 * the TRUNCATE checkpoint 0.17 runs after every mutation, then a clean close (which removes the
 * -wal and -shm files). Returns the side files still present afterwards (should be none).
 */
export function legacyEditInPlace(file, entryId, patch) {
  const cols = Object.keys(patch);
  if (cols.length === 0 || cols.some((c) => !/^[a-z_]+$/.test(c))) throw new Error(`Bad legacy patch ${JSON.stringify(patch)}`);
  const db = openDb(file);
  try {
    db.pragma('journal_mode = WAL');
    const set = [...cols.map((c) => `${c} = @${c}`), 'updated_at = @updated_at'].join(', ');
    const res = db.prepare(`update entries set ${set} where id = @id`).run({ ...patch, updated_at: new Date().toISOString(), id: entryId });
    if (res.changes !== 1) throw new Error(`Legacy edit changed ${res.changes} rows (entry ${entryId})`);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return sideFilesNextTo(file);
}

/** -wal / -shm / -journal files next to `file`. */
export function sideFilesNextTo(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return fs.readdirSync(dir).filter((n) => n.startsWith(base) && SIDE_FILE.test(n));
}

/** device.json's device_uuid under the device's syncRoot (macOS: <dataDir>/sync; Linux: XDG state). */
export function deviceUuid(device) {
  const root = process.platform === 'darwin'
    ? path.join(device.dataDir, 'sync')
    : path.join(device.home, '.local', 'state', 'conduit', 'conduit-dev', 'sync');
  const ids = fs.readdirSync(root)
    .filter((n) => n.startsWith('m-'))
    .map((n) => path.join(root, n, 'device.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).device_uuid);
  if (ids.length !== 1) throw new Error(`${device.name}: expected one device.json under ${root}, found ${ids.length}`);
  return ids[0];
}

function listSideFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).filter((rel) => SIDE_FILE.test(String(rel))).map(String);
}

/**
 * Polls `root` (recursively) for SQLite side files. Anything seen outside an expect() window is a
 * violation; the first sighting of each file is recorded with its time.
 */
export function createSideFileWatch(root, { intervalMs = 200 } = {}) {
  const violations = [];
  const expected = [];
  const seen = new Set();
  let expectDepth = 0;
  let polls = 0;

  const poll = () => {
    polls += 1;
    let files;
    try {
      files = listSideFiles(root);
    } catch {
      return;
    }
    for (const rel of files) {
      const key = `${expectDepth > 0 ? 'x' : 'v'}:${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (expectDepth > 0 ? expected : violations).push({ file: rel, at: new Date().toISOString() });
    }
    if (files.length === 0) seen.clear();
  };
  const timer = setInterval(poll, intervalMs);
  timer.unref();

  return {
    root,
    violations: () => [...violations],
    expectedSightings: () => [...expected],
    polls: () => polls,
    /** Side files seen while `fn` runs (and one poll after) are expected, not violations. */
    async expect(fn) {
      expectDepth += 1;
      try {
        return await fn();
      } finally {
        poll();
        expectDepth -= 1;
      }
    },
    stop: () => clearInterval(timer),
  };
}
