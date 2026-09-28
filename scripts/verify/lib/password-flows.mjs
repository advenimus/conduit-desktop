// Master-password change checks (docs/MULTI_DEVICE_SYNC.md 4.7, 4.8): the shared file's key epochs,
// wraps and graves (read through a private copy, so no side files appear), entries and decrypted
// secrets as a device shows them, Recently deleted over IPC, and the unlock dialog's error line.

import { listEntries } from './flows.mjs';
import { withPrivateCopy } from './sync-files.mjs';
import { clickText, exists, invoke, waitFor, withTimeout } from './ui.mjs';

const UNLOCK_INPUT = 'input[placeholder="Enter master password"]';
const UNLOCK_ERROR = '[data-dialog-content] p.text-red-400';
const COMPARED_FIELDS = ['id', 'name', 'entry_type', 'folder_id', 'parent_entry_id', 'host', 'port', 'username', 'domain', 'notes', 'credential_type'];

/**
 * Key material of the shared file: vault_meta salt, key epochs oldest first
 * ([{epochId, parent, hasSalt, hasVerification}]) and the number of key wraps.
 */
export function sharedKeyState(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => ({
    salt: db.prepare("select value from vault_meta where key = 'salt'").get()?.value ?? null,
    epochs: db.prepare('select epoch_id, parent_epoch, salt, verification from sync_key_epoch order by created_ms').all().map((r) => ({
      epochId: r.epoch_id,
      parent: r.parent_epoch,
      hasSalt: r.salt !== null,
      hasVerification: r.verification !== null,
    })),
    wraps: db.prepare('select count(*) as n from sync_key_wrap').get().n,
  }));
}

/** The grave of row `rowId` in the shared file ({redacted, hasRowJson}), or null when it has none. */
export function sharedGrave(file, scratchDir, rowId) {
  return withPrivateCopy(file, scratchDir, (db) => {
    const g = db.prepare('select g.redacted, g.row_json from sync_grave g join sync_rowkey k on k.rid = g.rid where k.row_id = ?').get(rowId);
    return g ? { redacted: g.redacted === 1, hasRowJson: g.row_json !== null } : null;
  });
}

/** Plaintext secrets of `ids` as the entry editor loads them (entry_get_full): {id: {password, private_key, totp_secret}}. */
export async function entrySecrets(device, ids) {
  const out = {};
  for (const id of ids) {
    const e = await invoke(device, 'entry_get_full', { id });
    out[id] = { password: e?.password ?? null, private_key: e?.private_key ?? null, totp_secret: e?.totp_secret ?? null };
  }
  return out;
}

/** The device's entries without timestamps or sort order, sorted by id. */
export async function entrySnapshot(device) {
  const rows = await listEntries(device);
  return rows
    .map((e) => Object.fromEntries(COMPARED_FIELDS.map((k) => [k, e[k] ?? null])))
    .sort((x, y) => x.id.localeCompare(y.id));
}

/** Recently deleted as its panel loads it (sync_recently_deleted): [{title, redacted}]. */
export async function recentlyDeletedList(device, { showAll = true } = {}) {
  const items = await invoke(device, 'sync_recently_deleted', { showAll });
  return items.map((i) => ({ title: i.title, redacted: i.redacted === true }));
}

/** The unlock dialog's error line, or null. */
export function unlockErrorLine(device) {
  return withTimeout(device.page.evaluate((sel) => document.querySelector(sel)?.innerText?.trim() ?? null, UNLOCK_ERROR), 10_000, `${device.name}: read unlock error`);
}

/** [Cancel] on the unlock dialog (after a refused password); waits until it has closed. */
export async function cancelUnlockDialog(device) {
  await clickText(device, 'Cancel', { exact: true, selector: '[data-dialog-content] button' });
  await waitFor(async () => !(await exists(device, UNLOCK_INPUT)), { timeoutMs: 10_000, label: `${device.name}: unlock dialog closed` });
}
