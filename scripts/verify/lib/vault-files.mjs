// File tricks on personal vaults: provider and user copies of a shared file, a device's working
// copy (w.conduit) and its corruption, and fake -wal/-shm files next to the shared file (an older
// desktop that has it open). Never opens the shared file with SQLite in place.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isLive } from './app.mjs';
import { REPO } from './run-context.mjs';
import { withPrivateCopy } from './sync-files.mjs';

const require = createRequire(path.join(REPO, 'package.json'));
const VAULT_EXT = '.conduit';
const SHM_BYTES = 32_768;
const SIDE_SUFFIXES = ['-wal', '-shm', '-journal'];
const CORRUPT_BYTES = 4_096;

function stemOf(file) {
  const base = path.basename(file);
  if (!base.toLowerCase().endsWith(VAULT_EXT)) throw new Error(`${file} is not a ${VAULT_EXT} file`);
  return base.slice(0, -VAULT_EXT.length);
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Writes `bytes` to `target` through a temp name without the .conduit extension, then renames it in. */
function writeAtomically(target, bytes) {
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  const tmp = path.join(path.dirname(target), `.cv-copy-${crypto.randomBytes(4).toString('hex')}.part`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
  return target;
}

/** The shared file's bytes now (plain read; no SQLite open, so no side files). Keep it to copy later. */
export function snapshotSharedFile(file) {
  return fs.readFileSync(file);
}

/**
 * Provider conflict names (spec 5.8): 'dropbox' `<stem> (conflicted copy <stamp>)`, 'dropbox-named'
 * `<stem> (<owner>'s conflicted copy <stamp>)`, 'syncthing' `<stem>.sync-conflict-<stamp>-<id>`.
 */
export function providerCopyName(file, { style = 'dropbox', owner = 'Verify', date = new Date() } = {}) {
  const stem = stemOf(file);
  const s = stamp(date);
  if (style === 'dropbox') return `${stem} (conflicted copy ${s})${VAULT_EXT}`;
  if (style === 'dropbox-named') return `${stem} (${owner}'s conflicted copy ${s})${VAULT_EXT}`;
  if (style === 'syncthing') return `${stem}.sync-conflict-${s.replace(/[- ]/g, '')}-VERIFY1${VAULT_EXT}`;
  throw new Error(`Unknown provider copy style "${style}" (dropbox, dropbox-named, syncthing)`);
}

/**
 * A cloud drive's conflict copy next to `file`, from `bytes` (default: the file now; pass an
 * earlier snapshotSharedFile() to make it differ). Returns the copy's path.
 */
export function makeProviderConflictCopy(file, { bytes, ...nameOpts } = {}) {
  return writeAtomically(path.join(path.dirname(file), providerCopyName(file, nameOpts)), bytes ?? snapshotSharedFile(file));
}

/** A user's copy (Finder "Duplicate" style `<stem> 2.conduit` by default, or `name`) next to `file`. */
export function makeUserCopy(file, { name, bytes } = {}) {
  const fileName = name ?? `${stemOf(file)} 2${VAULT_EXT}`;
  if (fileName !== path.basename(fileName) || !fileName.toLowerCase().endsWith(VAULT_EXT)) throw new Error(`Bad copy name "${fileName}"`);
  return writeAtomically(path.join(path.dirname(file), fileName), bytes ?? snapshotSharedFile(file));
}

/** sync_state lineage_id of a synced vault file (read through a private copy). */
export function lineageIdOf(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => db.prepare("select value from sync_state where key = 'lineage_id'").get()?.value ?? null);
}

/** The device's syncRoot (macOS: <dataDir>/sync; Linux: XDG state). */
export function syncRootOf(device) {
  return process.platform === 'darwin'
    ? path.join(device.dataDir, 'sync')
    : path.join(device.home, '.local', 'state', 'conduit', 'conduit-dev', 'sync');
}

/** <syncRoot>/m-<hw>/<lineageId>/w.conduit of `device` (it must have opened the vault once). */
export function workingCopyPath(device, lineageId) {
  if (!lineageId) throw new Error('workingCopyPath needs a lineage id (lineageIdOf(sharedFile) or sync status.lineageId)');
  const root = syncRootOf(device);
  const found = (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .filter((n) => n.startsWith('m-'))
    .map((n) => path.join(root, n, lineageId, 'w.conduit'))
    .filter((f) => fs.existsSync(f));
  if (found.length !== 1) throw new Error(`${device.name}: expected one w.conduit for lineage ${lineageId} under ${root}, found ${found.length}`);
  return found[0];
}

/**
 * Overwrites the first 4 KiB of the device's working copy with random bytes (SQLite then reports
 * SQLITE_NOTADB, which the app treats as a damaged working copy). The device must be closed.
 * Returns {path, sha256Before}.
 */
export function corruptWorkingCopy(device, lineageId) {
  if (isLive(device)) throw new Error(`${device.name} is running; quit it before corrupting its working copy`);
  const file = workingCopyPath(device, lineageId);
  const before = fs.readFileSync(file);
  const sha256Before = crypto.createHash('sha256').update(before).digest('hex');
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, crypto.randomBytes(Math.min(CORRUPT_BYTES, before.length)), 0, Math.min(CORRUPT_BYTES, before.length), 0);
  } finally {
    fs.closeSync(fd);
  }
  return { path: file, sha256Before };
}

/** Parked damaged copies (parked/w-<ts>.conduit) of the lineage, after "Rebuild from shared file". */
export function parkedWorkingCopies(device, lineageId) {
  const dir = path.join(path.dirname(workingCopyPath(device, lineageId)), 'parked');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^w-\d+\.conduit$/.test(n)) : [];
}

/** A real WAL holding one uncheckpointed UPDATE of `entryId` (what an older desktop leaves unsaved). */
function walWithEdit(file, scratchDir, { entryId, patch }) {
  const cols = Object.keys(patch ?? {});
  if (!entryId || cols.length === 0 || cols.some((c) => !/^[a-z_]+$/.test(c))) throw new Error(`Bad side-file edit ${JSON.stringify({ entryId, patch })}`);
  fs.mkdirSync(scratchDir, { recursive: true });
  const copy = path.join(scratchDir, `wal-src-${crypto.randomBytes(4).toString('hex')}.conduit`);
  fs.copyFileSync(file, copy);
  const Database = require('better-sqlite3');
  const db = new Database(copy, { timeout: 5_000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    const set = [...cols.map((c) => `${c} = @${c}`), 'updated_at = @updated_at'].join(', ');
    const res = db.prepare(`update entries set ${set} where id = @id`).run({ ...patch, updated_at: new Date().toISOString(), id: entryId });
    if (res.changes !== 1) throw new Error(`side-file edit changed ${res.changes} rows (entry ${entryId})`);
    return { wal: fs.readFileSync(`${copy}-wal`), shm: fs.readFileSync(`${copy}-shm`) };
  } finally {
    db.close();
    for (const s of ['', ...SIDE_SUFFIXES]) fs.rmSync(`${copy}${s}`, { force: true });
  }
}

/**
 * Puts -wal and -shm next to the shared file like an older desktop that has it open. wal: 'empty'
 * (default, size 0) or 'edit' with {edit: {entryId, patch}, scratchDir} for a real non-empty WAL.
 * Returns {wal, shm} paths. Remove them with removeSideFiles() before the scenario ends: the sync
 * suite's side-file watch counts any -wal/-shm under the cloud folder as a violation.
 */
export function placeSideFiles(file, { wal = 'empty', edit, scratchDir, shm = true } = {}) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  let bytes = { wal: Buffer.alloc(0), shm: Buffer.alloc(SHM_BYTES) };
  if (wal === 'edit') {
    if (!scratchDir) throw new Error("placeSideFiles({wal: 'edit'}) needs a scratchDir");
    bytes = walWithEdit(file, scratchDir, edit ?? {});
  } else if (wal !== 'empty') {
    throw new Error(`Unknown wal kind "${wal}" (empty, edit)`);
  }
  const out = { wal: `${file}-wal`, shm: shm ? `${file}-shm` : null };
  fs.writeFileSync(out.wal, bytes.wal);
  if (out.shm) fs.writeFileSync(out.shm, bytes.shm);
  return out;
}

/** Removes -wal / -shm / -journal next to `file`; returns the names removed. */
export function removeSideFiles(file) {
  const removed = [];
  for (const s of SIDE_SUFFIXES) {
    if (!fs.existsSync(`${file}${s}`)) continue;
    fs.rmSync(`${file}${s}`, { force: true });
    removed.push(`${path.basename(file)}${s}`);
  }
  return removed;
}
