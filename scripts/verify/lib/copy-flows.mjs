// Helpers for copies of a personal vault (spec 5.5, 5.8, 5.10): a copy edited by desktop 0.17
// (built on a private copy, so it appears next to the shared file in one rename), folders over IPC,
// a device's lineage folder with its sidefiles-<ts> folders, pre-merge snapshots, sync status waits.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { refreshEntries } from './flows.mjs';
import { REPO } from './run-context.mjs';
import { invoke, readSyncState, waitFor } from './ui.mjs';
import { withPrivateCopy } from './sync-files.mjs';
import { workingCopyPath } from './vault-files.mjs';

const require = createRequire(path.join(REPO, 'package.json'));
const COLUMN = /^[a-z_]+$/;
const SIDEFILES_DIR = /^sidefiles-\d+$/;

function checkPatch(id, patch) {
  const cols = Object.keys(patch ?? {});
  if (!id || cols.length === 0 || cols.some((c) => !COLUMN.test(c))) throw new Error(`Bad legacy patch ${JSON.stringify({ id, patch })}`);
  return cols;
}

/**
 * The bytes of `file` after a desktop 0.17 session on a private copy: WAL open with foreign keys on
 * (as 0.17 opens a vault), `DELETE FROM entries` for each id in `deletes`, an UPDATE with a fresh
 * updated_at for each `{id: patch}` in `patches`, the TRUNCATE checkpoint 0.17 runs after every
 * mutation, and a clean close. Put them next to the shared file with vault-files makeUserCopy or
 * makeProviderConflictCopy ({bytes}).
 */
export function legacyEditedBytes(file, scratchDir, { deletes = [], patches = {} } = {}) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const copy = path.join(scratchDir, `legacy-${crypto.randomBytes(4).toString('hex')}.conduit`);
  fs.copyFileSync(file, copy);
  const Database = require('better-sqlite3');
  const db = new Database(copy, { timeout: 5_000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const del = db.prepare('delete from entries where id = ?');
    for (const id of deletes) {
      const res = del.run(id);
      if (res.changes !== 1) throw new Error(`Legacy delete removed ${res.changes} rows (entry ${id})`);
    }
    for (const [id, patch] of Object.entries(patches)) {
      const cols = checkPatch(id, patch);
      const set = [...cols.map((c) => `${c} = @${c}`), 'updated_at = @updated_at'].join(', ');
      const res = db.prepare(`update entries set ${set} where id = @id`).run({ ...patch, updated_at: new Date().toISOString(), id });
      if (res.changes !== 1) throw new Error(`Legacy edit changed ${res.changes} rows (entry ${id})`);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  try {
    return fs.readFileSync(copy);
  } finally {
    for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${copy}${s}`, { force: true });
  }
}

export function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `<syncRoot>/m-<hw>/<lineage>/` of `device` (it must have opened the vault). */
export function lineageDir(device, lineageId) {
  return path.dirname(workingCopyPath(device, lineageId));
}

/** sidefiles-<ts> folders of the lineage, newest last: [{name, files: [{name, size}]}]. */
export function sideFilesFolders(device, lineageId) {
  const dir = lineageDir(device, lineageId);
  return fs.readdirSync(dir).filter((n) => SIDEFILES_DIR.test(n)).sort().map((name) => ({
    name,
    files: fs.readdirSync(path.join(dir, name)).sort().map((f) => ({ name: f, size: fs.statSync(path.join(dir, name, f)).size })),
  }));
}

/** The pre-merge snapshots (sync_list_snapshots): [{id, createdMs, noticeId, deleted, changedRows, byDeviceName}]. */
export function listSnapshots(device) {
  return invoke(device, 'sync_list_snapshots');
}

/** The undo preview of a snapshot (sync_undo_preview): {snapshotId, rows: [{row, title, stillDeleted}], fields}. */
export function undoPreview(device, snapshotId) {
  return invoke(device, 'sync_undo_preview', { snapshotId });
}

/** Waits until the engine status (sync_get_state status) satisfies `pred`; returns it. */
export async function waitForStatus(device, pred, { timeoutMs = 30_000, label = 'sync status' } = {}) {
  let last = null;
  try {
    return await waitFor(async () => {
      last = (await readSyncState(device)).status ?? null;
      return last && pred(last) ? last : null;
    }, { timeoutMs, intervalMs: 500, label: `${device.name}: ${label}` });
  } catch (err) {
    const seen = last ? { kind: last.kind, pauseReason: last.pauseReason, pendingPublish: last.pendingPublish, prompts: last.prompts.map((p) => p.kind) } : null;
    throw new Error(`${err.message} (last status: ${JSON.stringify(seen)})`);
  }
}

export async function createFolder(device, name, parentId = null) {
  const folder = await invoke(device, 'folder_create', { name, parent_id: parentId });
  await refreshEntries(device);
  return folder;
}

/** folder_delete: the folder, its subfolders and every entry in them (the app's recursive delete). */
export async function deleteFolder(device, id) {
  await invoke(device, 'folder_delete', { id });
  await refreshEntries(device);
}

export function listFolders(device) {
  return invoke(device, 'folder_list');
}

/** Device uuids with a presence register (`_sync` row `device/<uuid>`) in `file`, read through a private copy. */
export function presenceDevicesIn(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) =>
    db.prepare("select row_id from sync_rowkey where row_id like 'device/%'").all().map((r) => r.row_id.slice('device/'.length)).sort());
}

/** The user's session rows with their file hints: [{device_id, status, file_id, file_name, location}]. */
export function sessionFileHints(ctx, email) {
  return ctx.sqlJson(
    `select s.device_id, s.status, s.file_id, s.file_name, s.location
       from public.personal_vault_sessions s join auth.users u on u.id = s.user_id
      where u.email = :'email' order by s.acquired_at`,
    { email },
  );
}
