// Backup files as other tools see them: a local backup (.enc) decrypted the way the app does it
// (electron/services/vault/local-backup-crypto.ts), the SQLite bytes inside it (header, freelist,
// lineage, entries, password history) read through a private copy, the backup folder listing, and
// a user's cloud backup objects in the local storage bucket "vaults" (storage.objects), and waits
// for a local backup with some content or a new cloud backup object.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listLocalBackups } from './backup-flows.mjs';
import { withPrivateCopy } from './sync-files.mjs';
import { sqlJson } from './supabase.mjs';
import { waitFor } from './ui.mjs';

const LOCAL_VERSION = 0x01;
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITERATIONS = 600_000;
const LOCAL_KDF_CONTEXT = Buffer.from('conduit-local-backup-v1');
const SQLITE_MAGIC = 'SQLite format 3\0';
const STRAY_FILE = /(-wal|-shm|-journal|\.tmp)$/;
export const CLOUD_BUCKET = 'vaults';

/** The SQLite bytes of a local backup file; throws on a wrong password or a damaged file. */
export function decryptLocalBackup(file, password) {
  const blob = fs.readFileSync(file);
  if (blob.length < 1 + SALT_LEN + NONCE_LEN + TAG_LEN) throw new Error(`${file}: too short for a local backup`);
  if (blob[0] !== LOCAL_VERSION) throw new Error(`${file}: unknown local backup version ${blob[0]}`);
  const salt = blob.subarray(1, 1 + SALT_LEN);
  const nonce = blob.subarray(1 + SALT_LEN, 1 + SALT_LEN + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(1 + SALT_LEN + NONCE_LEN, blob.length - TAG_LEN);
  const key = crypto.pbkdf2Sync(password, Buffer.concat([salt, LOCAL_KDF_CONTEXT]), PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error(`${file}: could not decrypt (${err.message})`);
  } finally {
    key.fill(0);
  }
}

function headerOf(bytes) {
  return {
    magicOk: bytes.toString('latin1', 0, 16) === SQLITE_MAGIC,
    writeVersion: bytes[18],
    readVersion: bytes[19],
    freelistPages: bytes.readUInt32BE(36),
  };
}

/**
 * What a vault file's bytes hold: {header: {magicOk, writeVersion, readVersion, freelistPages},
 * quickCheck, lineageId, vaultId, entries: [{id, name, host, port, username}], history: [{id,
 * entry_id, changed_by}]}. Read through private copies under `scratchDir`.
 */
export function inspectVaultBytes(bytes, scratchDir) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const file = path.join(scratchDir, `backup-${crypto.randomBytes(4).toString('hex')}.conduit`);
  fs.writeFileSync(file, bytes);
  try {
    const content = withPrivateCopy(file, scratchDir, (db) => ({
      quickCheck: db.pragma('quick_check', { simple: true }),
      lineageId: db.prepare("select value from sync_state where key = 'lineage_id'").get()?.value ?? null,
      vaultId: db.prepare("select value from vault_meta where key = 'vault_id'").get()?.value ?? null,
      entries: db.prepare('select id, name, host, port, username from entries order by name').all(),
      history: db.prepare('select id, entry_id, changed_by from password_history order by changed_at').all(),
    }));
    return { header: headerOf(bytes), ...content };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** A vault file on disk, inspected like inspectVaultBytes (never opened in place). */
export function inspectVaultFile(file, scratchDir) {
  return inspectVaultBytes(fs.readFileSync(file), scratchDir);
}

/** File names in `dir` that are not finished backups: -wal, -shm, -journal and .tmp leftovers. */
export function strayFilesIn(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => STRAY_FILE.test(n)) : [];
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** storage.objects of `userId` in the "vaults" bucket: [{name, created_at, updated_at, size}], oldest first. */
export function cloudObjects(userId) {
  return sqlJson(
    `select name, created_at, updated_at, (metadata->>'size')::bigint as size
       from storage.objects where bucket_id = :'bucket' and name like :'prefix' order by created_at, name`,
    { bucket: CLOUD_BUCKET, prefix: `${userId}/%` },
  );
}

// The backup KDF runs 600,000 rounds, so each version of a backup file is decrypted once.
const decrypted = new Map();

/** inspectVaultBytes of a local backup file (cached per path and mtime). */
export function localBackupContent(file, password, scratchDir) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!decrypted.has(key)) decrypted.set(key, inspectVaultBytes(decryptLocalBackup(file, password), scratchDir));
  return decrypted.get(key);
}

/** The newest local backup of `device` whose content satisfies `pred(info)`: {file, info}. */
export function waitForLocalBackup(device, password, scratchDir, pred, { timeoutMs = 30_000, label = 'backup' } = {}) {
  return waitFor(async () => {
    for (const b of await listLocalBackups(device)) {
      const info = localBackupContent(b.fullPath, password, scratchDir);
      if (pred(info)) return { file: b.fullPath, info };
    }
    return null;
  }, { timeoutMs, intervalMs: 1_000, label: `${device.name}: a local backup ${label}` });
}

/** The first object under `<prefix>/backups/` (prefix `<user id>/<vault id>`) that is not in `known`. */
export function waitNewCloudBackup(userId, prefix, known, { timeoutMs = 45_000, label = 'a new cloud backup' } = {}) {
  const seen = new Set(known.map((o) => o.name));
  return waitFor(async () => (await cloudObjects(userId)).find((o) => o.name.startsWith(`${prefix}/backups/`) && !seen.has(o.name)) ?? null, {
    timeoutMs,
    intervalMs: 1_000,
    label,
  });
}
