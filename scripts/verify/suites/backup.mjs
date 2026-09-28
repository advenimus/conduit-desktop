// Local and cloud backups of synced personal vaults (docs/MULTI_DEVICE_SYNC.md 5.10, 8.1, 8.2),
// live: a local backup is a WAL-header snapshot of the working copy; [Roll this vault back] brings a
// deleted entry and an older password back (the newer one goes to password history) and syncs to a
// second device; [Restore as a new vault...] forks a new lineage; cloud backup is Pro and Team only,
// uploads under <user id>/<vault id>/, restores through the preview, and stops after a downgrade.
// Each scenario uses its own folder <cloud>/<scenario>/ and devices named after it.

import fs from 'node:fs';
import path from 'node:path';
import {
  closeBackupManager, cloudBackupSection, cloudBackupState, disableCloudBackup, enableCloudBackup, enableLocalBackup, listCloudBackups,
  listLocalBackups, localBackupNow, openBackupManager, openLocalRestorePreview, pressCloudBackupToggle, restoreFromBackupManager,
} from '../lib/backup-flows.mjs';
import { cloudObjects, inspectVaultFile, sha256File, strayFilesIn, waitForLocalBackup, waitNewCloudBackup } from '../lib/backup-files.mjs';
import { cancelSettings } from '../lib/settings-flows.mjs';
import { sharedEntries } from '../lib/sync-files.mjs';
import { waitForEntry } from '../lib/sync-flows.mjs';
import { restoreAsNewVaultFromPreview, restorePreviewDetails, rollBackFromPreview } from '../lib/sync-panels.mjs';
import { clickToastAction, toastMark, waitForToast } from '../lib/ui-forms.mjs';
import { lineageIdOf } from '../lib/vault-files.mjs';

const PW = 'verify-backup-password-1';
const ORIGINAL_SECRET = 'backup-secret-original';
const NEWER_SECRET = 'backup-secret-newer';
const CONVERGE_MS = 30_000;
const BACKUP_WAIT_MS = 30_000;
const UPLOAD_WAIT_MS = 45_000;
// A Pro edit reached the bucket 5.2 s later (5 s debounce); nothing may arrive within about three times that.
const QUIET_MS = 15_000;
const PLAN_MESSAGE = 'Cloud backup needs the Pro or Team plan.';
const RESTORE_PLAN_MESSAGE = 'Cloud backup restore needs the Pro or Team plan.';
const FREE_UPSELL = 'Upgrade to Pro or Team to back up your vault to the cloud.';
const NEW_VAULT_TOAST = 'Backup restored as a new vault.';
const ROLLED_BACK_TOAST = /^Rolled back \d+ changes?\.$/;

const scratch = (ctx) => path.join(ctx.run.runDir, 'scratch');
const rel = (ctx, p) => path.relative(ctx.run.runDir, p);

function vaultFor(ctx, scenario, name = 'Vault.conduit') {
  const dir = path.join(ctx.cloudDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

const row = (e) => ({ id: e.id, name: e.name, host: e.host ?? null, port: e.port ?? null });
const rows = (list) => list.map(row).sort((x, y) => x.name.localeCompare(y.name));

async function signedIn(ctx, role, names) {
  const user = await ctx.createUser(role);
  const devices = await Promise.all(names.map((n) => ctx.launchDevice(n)));
  const who = await Promise.all(devices.map((d) => ctx.flows.signIn(d, user)));
  ctx.checkEqual(who.map((w) => w.tier), names.map(() => role), `${names.join(', ')} signed in on the ${role} plan`);
  ctx.step(`${names.join(', ')} signed in as ${role} user ${user.email}`);
  return { user, devices };
}

function waitShared(ctx, file, pred, label, timeoutMs = CONVERGE_MS) {
  return ctx.waitFor(async () => {
    const list = sharedEntries(file, scratch(ctx));
    return pred(list) ? list : null;
  }, { timeoutMs, intervalMs: 500, label: `shared file: ${label}` });
}

function waitUpToDate(ctx, d) {
  return ctx.waitFor(async () => (await ctx.ui.readSyncState(d)).status?.kind === 'up-to-date', { timeoutMs: CONVERGE_MS, label: `${d.name}: up to date` });
}

const waitForBackup = (ctx, d, pred, label, timeoutMs = BACKUP_WAIT_MS) => waitForLocalBackup(d, PW, scratch(ctx), pred, { timeoutMs, label });

const hasEntries = (ids) => (info) => ids.every((id) => info.entries.some((e) => e.id === id));

/**
 * Creates <cloud>/<scenario>/Vault.conduit, turns local backup on (Settings > Backup) into a folder
 * under the run dir, adds two SSH entries and waits for the backup those edits make on their own.
 */
async function vaultWithBackup(ctx, d, scenario) {
  const vault = vaultFor(ctx, scenario);
  await ctx.flows.createVault(d, vault, PW);
  const folder = path.join(ctx.run.runDir, 'local-backups', scenario);
  await enableLocalBackup(d, folder);
  const first = (await listLocalBackups(d)).map((b) => b.name);
  await cancelSettings(d);
  ctx.step(`local backup on in ${rel(ctx, folder)}; first backup ${first.join(', ')}`);
  const keep = await ctx.flows.addEntry(d, { name: `${scenario} web server`, host: '10.60.0.1', username: 'admin', password: ORIGINAL_SECRET });
  const gone = await ctx.flows.addEntry(d, { name: `${scenario} db server`, host: '10.60.0.2', username: 'dba', password: 'db-secret' });
  const t0 = Date.now();
  const { file, info } = await waitForBackup(ctx, d, hasEntries([keep.id, gone.id]), 'with both new entries');
  ctx.check(!first.includes(path.basename(file)), `the edits made a new backup file (${path.basename(file)})`);
  ctx.step(`${path.basename(file)} holds both entries ${((Date.now() - t0) / 1000).toFixed(1)} s after the edits`);
  return { vault, folder, keep, gone, file, info };
}

function checkBackupFile(ctx, { vault, folder, file, info }) {
  ctx.checkEqual(info.header, { magicOk: true, writeVersion: 2, readVersion: 2, freelistPages: 0 }, 'the backup holds a WAL-header SQLite file with no free pages (a VACUUM INTO output)');
  ctx.checkEqual(info.quickCheck, 'ok', 'the backup passes quick_check');
  ctx.checkEqual(info.lineageId, lineageIdOf(vault, scratch(ctx)), 'the backup is of this vault (same lineage)');
  ctx.checkEqual(strayFilesIn(folder), [], `no -wal, -shm, -journal or .tmp next to ${path.basename(file)}`);
}

async function diverge(ctx, d, { keep, gone }) {
  await ctx.flows.updateEntry(d, keep.id, { password: NEWER_SECRET });
  await ctx.flows.deleteEntry(d, gone.id);
  ctx.step(`changed the password of "${keep.name}" and deleted "${gone.name}"`);
}

/** The local restore preview and its dialog, then [Roll this vault back]. */
async function previewAndRollBack(ctx, d, { file, keep, gone }) {
  const preview = await openLocalRestorePreview(d, file, PW);
  ctx.checkEqual(preview.restorations.map((r) => r.title), [gone.name], 'the preview brings the deleted entry back');
  ctx.checkEqual(preview.deletions, [], 'the preview deletes nothing (no entry was created since the backup)');
  const replaced = preview.replacements.map((f) => ({ row: f.rowTitle, label: f.label, masked: f.masked }));
  ctx.check(replaced.some((f) => f.row === keep.name && f.label === 'Password' && f.masked), `the preview replaces "${keep.name}"'s password, masked: ${JSON.stringify(replaced)}`);
  const shown = await restorePreviewDetails(d);
  ctx.checkEqual({ restorations: shown.restorations, deletions: shown.deletions }, { restorations: 1, deletions: 0 }, 'the dialog lists one entry that comes back');
  const n = preview.replacements.length;
  ctx.check(shown.text.includes(gone.name) && shown.text.includes(`${n} newer value${n === 1 ? '' : 's'} will be replaced`), `the dialog names the entry and the replaced values:\n${shown.text}`);
  await ctx.shot(d, 'restore-preview');
  const mark = await toastMark(d);
  await rollBackFromPreview(d);
  const toast = await waitForToast(d, ROLLED_BACK_TOAST, { after: mark });
  const changes = preview.restorations.length + preview.deletions.length + n;
  ctx.checkEqual(toast.title, `Rolled back ${changes} change${changes === 1 ? '' : 's'}.`, 'the toast counts the items and values rolled back, not register writes');
  ctx.step(`preview: ${JSON.stringify(replaced)}; [Roll this vault back]: "${toast.title}"`);
}

async function passwordOf(ctx, d, id) {
  return (await ctx.ui.invoke(d, 'entry_get_full', { id })).password ?? null;
}

async function checkRolledBack(ctx, d, { keep, gone, info }, { changedBy }) {
  const back = await waitForEntry(d, gone.id, (e) => e !== null, { timeoutMs: CONVERGE_MS, label: `"${gone.name}" back` });
  ctx.checkEqual(row(back), row(gone), `${d.name}: "${gone.name}" is back as it was`);
  await ctx.waitFor(async () => (await passwordOf(ctx, d, keep.id)) === ORIGINAL_SECRET, { timeoutMs: CONVERGE_MS, label: `${d.name}: the backup password of "${keep.name}"` });
  const history = await ctx.ui.invoke(d, 'password_history_list', { entry_id: keep.id });
  const byRollback = history.filter((h) => h.changed_by === 'rollback').map((h) => h.password);
  ctx.checkEqual(byRollback, [NEWER_SECRET], `${d.name}: the replaced password is in password history with changed_by "rollback"`);
  if (changedBy) ctx.check(history.some((h) => h.changed_by === changedBy && h.password === ORIGINAL_SECRET), `${d.name}: the earlier change stays in history: ${JSON.stringify(history.map((h) => h.changed_by))}`);
  ctx.checkEqual(rows(await ctx.flows.listEntries(d)), rows(info.entries), `${d.name}: the vault holds exactly the backup's entries`);
}

// ---------- B1: local backup and rollback (Free) ----------

/**
 * With the shared folder read-only nothing can be published, so an entry added now exists only in
 * the working copy. A backup that holds it was made from the working copy, not the shared file.
 */
async function backupComesFromWorkingCopy(ctx, d, { vault }) {
  const dir = path.dirname(vault);
  const writable = () => {
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(vault, 0o644);
  };
  ctx.onClose('make the shared folder writable', writable);
  fs.chmodSync(vault, 0o444);
  fs.chmodSync(dir, 0o555);
  let probe;
  try {
    probe = await ctx.flows.addEntry(d, { name: 'working copy only', host: '10.60.0.99' });
    await ctx.sleep(3_000);
    ctx.check(!sharedEntries(vault, scratch(ctx)).some((e) => e.id === probe.id), 'the read-only shared file does not have the new entry');
    await localBackupNow(d);
    const { file, info } = await waitForBackup(ctx, d, hasEntries([probe.id]), 'with the unpublished entry', 10_000);
    ctx.checkEqual(info.header.writeVersion, 2, 'that backup has the WAL header too');
    ctx.step(`${path.basename(file)} holds the entry only the working copy has: backups read the working copy`);
    await cancelSettings(d);
  } finally {
    writable();
  }
  await waitShared(ctx, vault, (list) => list.some((e) => e.id === probe.id), 'published once the folder is writable again', 60_000);
}

async function localBackupRollback(ctx) {
  const { user, devices: [d] } = await signedIn(ctx, 'free', ['b1']);
  const base = await vaultWithBackup(ctx, d, 'b1');
  checkBackupFile(ctx, base);
  await diverge(ctx, d, base);
  await waitShared(ctx, base.vault, (list) => !list.some((e) => e.id === base.gone.id), 'the delete is published');
  await previewAndRollBack(ctx, d, base);
  await checkRolledBack(ctx, d, base, { changedBy: user.email });
  await waitShared(ctx, base.vault, (list) => JSON.stringify(rows(list)) === JSON.stringify(rows(base.info.entries)), 'the rollback is published');
  await ctx.shot(d, 'rolled-back');
  await backupComesFromWorkingCopy(ctx, d, base);
}

// ---------- B1 Pro: the rollback reaches a second device ----------

async function rollbackSyncs(ctx) {
  const { user, devices: [a, b] } = await signedIn(ctx, 'pro', ['b2a', 'b2b']);
  const base = await vaultWithBackup(ctx, a, 'b2');
  await ctx.flows.openVault(b, base.vault, PW, { expect: 'unlocked' });
  await waitForEntry(b, base.gone.id, (e) => e !== null, { timeoutMs: CONVERGE_MS, label: `"${base.gone.name}" on b` });
  await diverge(ctx, a, base);
  await waitForEntry(b, base.gone.id, (e) => e === null, { timeoutMs: CONVERGE_MS, label: 'the delete on b' });
  await ctx.waitFor(async () => (await passwordOf(ctx, b, base.keep.id)) === NEWER_SECRET, { timeoutMs: CONVERGE_MS, label: 'the newer password on b' });
  ctx.step('b2b has the delete and the newer password');
  await previewAndRollBack(ctx, a, base);
  const t0 = Date.now();
  await checkRolledBack(ctx, a, base, { changedBy: user.email });
  await checkRolledBack(ctx, b, base, { changedBy: user.email });
  ctx.step(`b2b has the rolled-back vault and the "rollback" history row ${((Date.now() - t0) / 1000).toFixed(1)} s after the rollback`);
  await ctx.flows.refreshEntries(b);
  await ctx.ui.waitForText(b, base.gone.name, { timeoutMs: 15_000 });
  await ctx.shot(b, 'rollback-synced');
}

// ---------- B2: restore as a new vault ----------

async function unlockFromDialog(ctx, d) {
  await ctx.ui.waitForText(d, 'Unlock Vault');
  await ctx.ui.typeInto(d, 'input[placeholder="Enter master password"]', PW);
  await ctx.ui.clickSelector(d, '[data-dialog-content] form button[type=submit]');
  const res = await ctx.flows.waitForUnlockOutcome(d);
  ctx.checkEqual(res.outcome, 'unlocked', `${d.name}: the new vault unlocks with the same password (${res.dialogs?.join(', ') ?? ''})`);
}

async function restoreAsNewVault(ctx) {
  const { devices: [d] } = await signedIn(ctx, 'free', ['b3']);
  const base = await vaultWithBackup(ctx, d, 'b3');
  const later = await ctx.flows.addEntry(d, { name: 'b3 added after the backup', host: '10.62.0.9' });
  await waitShared(ctx, base.vault, (list) => list.some((e) => e.id === later.id), 'the later entry is published');
  await waitUpToDate(ctx, d);
  const content = () => {
    const i = inspectVaultFile(base.vault, scratch(ctx));
    return { lineage: i.lineageId, vaultId: i.vaultId, entries: rows(i.entries), history: i.history };
  };
  const original = content();
  const sha = sha256File(base.vault);

  const preview = await openLocalRestorePreview(d, base.file, PW);
  ctx.checkEqual(preview.deletions.map((r) => r.title), [later.name], 'a rollback would delete the later entry');
  const target = vaultFor(ctx, 'b3', 'Restored.conduit');
  const mark = await toastMark(d);
  await restoreAsNewVaultFromPreview(d, target);
  await waitForToast(d, NEW_VAULT_TOAST, { after: mark });
  const restored = inspectVaultFile(target, scratch(ctx));
  ctx.checkEqual(sha256File(base.vault), sha, 'the restore did not write the original shared file');
  ctx.check(typeof restored.lineageId === 'string' && restored.lineageId !== original.lineage, `the new file has a new lineage (${restored.lineageId} vs ${original.lineage})`);
  ctx.checkEqual(rows(restored.entries), rows(base.info.entries), 'the new file holds the backup\'s entries');
  ctx.checkEqual({ write: restored.header.writeVersion, read: restored.header.readVersion }, { write: 2, read: 2 }, 'the new file has the WAL header');
  ctx.step(`${rel(ctx, target)} written with lineage ${restored.lineageId}`);

  await clickToastAction(d, NEW_VAULT_TOAST, 'Open it');
  await unlockFromDialog(ctx, d);
  const open = (await ctx.ui.readSyncState(d)).vault;
  ctx.checkEqual({ path: open?.path && fs.realpathSync(open.path), lineage: open?.lineageId }, { path: fs.realpathSync(target), lineage: restored.lineageId }, 'the new vault is the one open');
  ctx.checkEqual(rows(await ctx.flows.listEntries(d)), rows(base.info.entries), 'it shows the backup\'s entries');
  await ctx.shot(d, 'new-vault-open');

  // "Open it" locked the original, and a lock publishes session_open = 0 (spec 6.4): content, not bytes.
  ctx.checkEqual(content(), original, 'the original keeps its lineage, vault id, entries (the later one included) and history');
}

// ---------- B3: cloud backup plan gate ----------

async function freeRefused(ctx) {
  const { user, devices: [d] } = await signedIn(ctx, 'free', ['b4f']);
  await ctx.flows.createVault(d, vaultFor(ctx, 'b4f'), PW);
  await ctx.flows.addEntry(d, { name: 'b4f server', host: '10.63.0.1' });
  const section = await cloudBackupSection(d);
  ctx.checkEqual({ badge: section.badge, disabled: section.toggleDisabled }, { badge: 'Pro and Team', disabled: true }, 'Free: the Cloud Backup toggle is off limits and badged');
  ctx.check(section.text.includes(FREE_UPSELL), `Free: the section says "${FREE_UPSELL}"`);
  ctx.checkEqual(await pressCloudBackupToggle(d), 'disabled', 'Free: the toggle cannot be pressed');
  await ctx.shot(d, 'cloud-backup-free');
  await cancelSettings(d);
  const enable = await ctx.ui.invokeResult(d, 'cloud_sync_enable');
  ctx.check(!enable.ok && enable.error.includes(PLAN_MESSAGE), `cloud_sync_enable is refused with "${PLAN_MESSAGE}": ${JSON.stringify(enable)}`);
  const restore = await ctx.ui.invokeResult(d, 'cloud_backup_restore', { storagePath: `${user.id}/none/backups/vault_none.enc`, masterPassword: PW });
  ctx.check(!restore.ok && restore.error.includes(RESTORE_PLAN_MESSAGE), `cloud_backup_restore is refused with "${RESTORE_PLAN_MESSAGE}": ${JSON.stringify(restore)}`);
  ctx.checkEqual((await cloudBackupState(d)).enabled, false, 'Free: cloud backup stays off');
  await ctx.flows.addEntry(d, { name: 'b4f later', host: '10.63.0.2' });
  await ctx.sleep(QUIET_MS);
  ctx.checkEqual(await cloudObjects(user.id), [], 'Free: nothing in the "vaults" bucket for this user');
  ctx.step('Free: toggle disabled, both IPC channels refused, no storage objects');
}

const waitNewBackupObject = (ctx, userId, prefix, known, label) => waitNewCloudBackup(userId, prefix, known, { timeoutMs: UPLOAD_WAIT_MS, label });

function waitCloudIdle(ctx, d) {
  return ctx.waitFor(async () => {
    const s = await cloudBackupState(d);
    return s.enabled && s.status === 'synced' ? s : null;
  }, { timeoutMs: UPLOAD_WAIT_MS, label: `${d.name}: cloud backup on and idle` });
}

/** Signed in as Pro, then downgraded: the toggle is still offered, and pressing it is refused. */
async function downgradedToggleRefused(ctx, d, user) {
  await disableCloudBackup(d);
  const before = await cloudObjects(user.id);
  await ctx.setTier(user.id, 'free');
  const mark = await toastMark(d);
  ctx.checkEqual(await pressCloudBackupToggle(d), 'clicked', 'the toggle still shows the plan read at sign-in');
  const toast = await waitForToast(d, 'Could not change cloud backup', { after: mark });
  ctx.checkEqual({ type: toast.type, message: toast.message }, { type: 'error', message: PLAN_MESSAGE }, 'the refusal toast names the plan');
  await ctx.shot(d, 'downgraded-toggle-refused');
  await ctx.sleep(QUIET_MS);
  ctx.checkEqual((await cloudBackupState(d)).enabled, false, 'cloud backup stays off');
  ctx.checkEqual(await cloudObjects(user.id), before, 'nothing uploaded after the refusal');
  ctx.step(`downgraded to Free while open: toggle pressed, toast "${toast.title}: ${toast.message}", nothing uploaded`);
}

async function proBackupAndRestore(ctx) {
  const { user, devices: [d] } = await signedIn(ctx, 'pro', ['b4p']);
  const vault = vaultFor(ctx, 'b4p');
  await ctx.flows.createVault(d, vault, PW);
  const keep = await ctx.flows.addEntry(d, { name: 'b4p web server', host: '10.64.0.1' });
  const gone = await ctx.flows.addEntry(d, { name: 'b4p db server', host: '10.64.0.2' });
  const vaultId = inspectVaultFile(vault, scratch(ctx)).vaultId;
  const prefix = `${user.id}/${vaultId}`;
  await waitCloudIdle(ctx, d);
  ctx.step('Pro: cloud backup came on with the new vault (the create form\'s default)');

  await disableCloudBackup(d);
  ctx.checkEqual((await cloudBackupState(d)).enabled, false, 'Pro: the toggle turned cloud backup off');
  const before = await cloudObjects(user.id);
  const t0 = Date.now();
  await enableCloudBackup(d);
  const fresh = await waitNewBackupObject(ctx, user.id, prefix, before, 'an upload after turning cloud backup on');
  ctx.step(`Pro: toggled on; ${fresh.name} landed ${((Date.now() - t0) / 1000).toFixed(1)} s later`);
  const objs = await cloudObjects(user.id);
  ctx.check(objs.some((o) => o.name === `${prefix}/vault.enc`), `the bucket has ${prefix}/vault.enc: ${JSON.stringify(objs.map((o) => o.name))}`);
  ctx.check(objs.every((o) => o.name === `${user.id}/manifest.json` || o.name.startsWith(`${prefix}/`)), 'every object is under <user id>/<vault id>/ (plus the manifest)');
  const listed = await ctx.ui.invoke(d, 'cloud_backup_list');
  ctx.check(listed.some((b) => b.path === fresh.name), `cloud_backup_list shows ${fresh.name}`);
  ctx.check((await listCloudBackups(d)).some((b) => b.path === fresh.name && b.vaultId === vaultId), 'cloud_backup_list_all shows it for this vault');
  await ctx.shot(d, 'cloud-backup-on');
  await cancelSettings(d);

  await ctx.flows.deleteEntry(d, gone.id);
  await waitNewBackupObject(ctx, user.id, prefix, objs, 'the upload after the delete');
  await waitCloudIdle(ctx, d);
  const all = await ctx.ui.invoke(d, 'cloud_backup_list');
  const index = all.findIndex((b) => b.path === fresh.name);
  ctx.check(index > 0, `the backup with both entries is listed after newer ones (index ${index} of ${all.length})`);
  await openBackupManager(d);
  await ctx.shot(d, 'backup-manager');
  await restoreFromBackupManager(d, PW, { index });
  const shown = await restorePreviewDetails(d);
  ctx.checkEqual({ restorations: shown.restorations, deletions: shown.deletions }, { restorations: 1, deletions: 0 }, 'the cloud restore preview brings the deleted entry back');
  ctx.check(shown.text.includes(gone.name), `the preview names "${gone.name}"`);
  await ctx.shot(d, 'cloud-restore-preview');
  const mark = await toastMark(d);
  await rollBackFromPreview(d);
  await waitForToast(d, ROLLED_BACK_TOAST, { after: mark });
  const back = await waitForEntry(d, gone.id, (e) => e !== null, { timeoutMs: CONVERGE_MS, label: `"${gone.name}" back from the cloud backup` });
  ctx.checkEqual(row(back), row(gone), 'the rolled-back entry is as it was');
  ctx.check((await ctx.flows.listEntries(d)).some((e) => e.id === keep.id), 'the other entry is still there');
  ctx.step(`Pro: restored ${fresh.name} through the Backup Manager preview; "${gone.name}" is back`);
  await closeBackupManager(d);
  await downgradedToggleRefused(ctx, d, user);
}

// ---------- B4: a downgraded account stops uploading ----------

async function downgradedStops(ctx) {
  const { user, devices: [d] } = await signedIn(ctx, 'pro', ['b5']);
  const vault = vaultFor(ctx, 'b5');
  await ctx.flows.createVault(d, vault, PW);
  const prefix = `${user.id}/${inspectVaultFile(vault, scratch(ctx)).vaultId}`;
  const t0 = Date.now();
  await ctx.flows.addEntry(d, { name: 'b5 server', host: '10.65.0.1' });
  await waitNewBackupObject(ctx, user.id, prefix, await cloudObjects(user.id), 'the upload after an edit on Pro');
  ctx.step(`Pro: an edit reached the bucket ${((Date.now() - t0) / 1000).toFixed(1)} s later`);
  await waitCloudIdle(ctx, d);

  await ctx.flows.lockVault(d);
  await ctx.sleep(2_000);
  const before = await cloudObjects(user.id);
  await ctx.setTier(user.id, 'free');
  ctx.step(`locked; plan set to free with ${before.length} objects in the bucket`);
  await ctx.flows.openVault(d, vault, PW, { expect: 'unlocked' });
  await ctx.flows.addEntry(d, { name: 'b5 after downgrade', host: '10.65.0.2' });
  await ctx.sleep(QUIET_MS);
  const state = await cloudBackupState(d);
  const after = await cloudObjects(user.id);
  ctx.checkEqual(after, before, `no new or updated storage objects ${QUIET_MS / 1000} s after an edit on the downgraded account`);
  ctx.checkEqual(state.enabled, false, `cloud backup is off after the unlock: ${JSON.stringify(state)}`);
  await ctx.shot(d, 'downgraded');
}

export default {
  id: 'backup',
  title: 'Local and cloud backups of synced vaults',
  scenarios: [
    { id: 'local-backup-rollback', title: 'Free: a local backup snapshots the working copy; [Roll this vault back] restores an entry and a password, keeping the newer one in history', run: localBackupRollback },
    { id: 'rollback-syncs', title: 'Pro: a rollback on one device reaches the second device', run: rollbackSyncs },
    { id: 'restore-as-new-vault', title: 'A backup restored as a new vault gets a new lineage and opens; the original is untouched', run: restoreAsNewVault },
    { id: 'cloud-backup-plan-gate', title: 'Free cannot turn cloud backup on; Pro uploads under <user>/<vault>/ and restores through the preview; a downgrade while open is refused with a toast', run: async (ctx) => { await freeRefused(ctx); await proBackupAndRestore(ctx); } },
    { id: 'downgraded-backup-stops', title: 'Pro to Free: the next unlock does not resume cloud uploads', run: downgradedStops },
  ],
};
