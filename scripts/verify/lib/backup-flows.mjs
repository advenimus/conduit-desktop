// Settings > Backup: local backup (enable with a folder, Backup Now, list), the local restore (IPC
// only: the app has no screen for it), cloud backup (Pro: enable, Back Up Now) and the Backup
// Manager restore, which shows the "Restore from backup" preview for a synced vault
// (sync-panels.mjs rollBackFromPreview / restoreAsNewVaultFromPreview).

import { clickText, invoke, typeInto, waitFor, withTimeout } from './ui.mjs';
import { retryUntil, stubDialogs } from './ui-forms.mjs';
import { openSettings, settingsOpen } from './settings-flows.mjs';
import { SELECTORS, clickIn, evaluateIn } from './selectors.mjs';

const SETTINGS_ROOT = '[data-cv-settings]';
const MANAGER_ROOT = '[data-cv-backup-manager]';

/** B22 and B39: the toggle of the row whose title label reads `label`. */
export function clickToggleInPage({ root, label }, cv) {
  const scope = document.querySelector(root);
  const el = [...(scope?.querySelectorAll('label') ?? [])].find((l) => l.innerText.trim() === label);
  const button = el ? cv.pickOne(cv.pickClosest(el, scope, cv.S.toggleRow), cv.S.toggle) : null;
  if (!button) return el ? 'no toggle' : 'no label';
  if (button.disabled) return 'disabled';
  button.click();
  return 'clicked';
}

function clickToggle(device, label) {
  const attempt = () => evaluateIn(device, clickToggleInPage, { root: SETTINGS_ROOT, label }, { label: `toggle ${label}` });
  return retryUntil(attempt, 'clicked', { timeoutMs: 15_000, label: `${device.name}: "${label}" toggle` });
}

async function backupTab(device) {
  if (!(await settingsOpen(device))) await openSettings(device, 'backup');
  else await clickIn(device, 'Backup', SELECTORS.settingsNavButton, { scope: SETTINGS_ROOT, exact: true });
}

/** local_backup_get_state: {enabled, backupPath, retentionDays, status, lastBackedUpAt, error}. */
export const localBackupState = (device) => invoke(device, 'local_backup_get_state');

/** local_backup_list: [{name, fullPath, created_at, size}], newest first as the app lists them. */
export const listLocalBackups = (device) => invoke(device, 'local_backup_list');

/**
 * Settings > Backup > Local Backup toggle with the folder picker answering `folder`; waits until the
 * state is enabled on that folder and the first backup file exists. Returns the state.
 */
export async function enableLocalBackup(device, folder, { timeoutMs = 60_000 } = {}) {
  await backupTab(device);
  const before = await localBackupState(device);
  if (before?.enabled && before.backupPath === folder) return before;
  if (before?.enabled) throw new Error(`${device.name}: local backup is already on in another folder (${before.backupPath})`);
  await stubDialogs(device, { open: folder });
  await clickToggle(device, 'Local Backup');
  return waitFor(async () => {
    const s = await localBackupState(device);
    const files = s?.enabled && s.backupPath === folder ? await listLocalBackups(device) : [];
    return files.length > 0 ? s : null;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: local backup on in ${folder} with a first backup` });
}

/**
 * Settings > Backup > [Backup Now]; resolves with the backup list once a newer backup finished.
 * Files are named to the second, so a backup in the same second replaces the previous file.
 */
export async function localBackupNow(device, { timeoutMs = 60_000 } = {}) {
  await backupTab(device);
  const before = (await localBackupState(device))?.lastBackedUpAt ?? null;
  await clickText(device, 'Backup Now', { exact: true, selector: `${SETTINGS_ROOT} button` });
  await waitFor(async () => {
    const s = await localBackupState(device);
    if (s?.status === 'error') throw new Error(`local backup failed: ${s.error}`);
    return s?.status === 'backed-up' && s.lastBackedUpAt !== before;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: a newer local backup` });
  return listLocalBackups(device);
}

function readBackupRowsInPage(root, cv) {
  const { S } = cv;
  const scope = document.querySelector(root);
  const label = [...(scope?.querySelectorAll('label') ?? [])].find((l) => /^Backup Files \(\d+\)$/.test(l.innerText.trim()));
  const list = cv.usesHook(scope, S.backupFiles) ? scope.querySelector(S.backupFiles.hook) : label?.parentElement;
  const read = (row, p) => cv.pickOne(row, p)?.innerText?.trim() ?? '';
  return cv.pickAll(list, S.backupRow).map((r) => ({ name: read(r, S.backupName), meta: read(r, S.backupMeta) }));
}

/** The "Backup Files (N)" list as the Backup tab shows it: [{name, meta}]. */
export async function localBackupRows(device) {
  await backupTab(device);
  return evaluateIn(device, readBackupRowsInPage, SETTINGS_ROOT, { label: 'read backup rows' });
}

/**
 * local_backup_restore (IPC; no UI in the app). mode: undefined (preview for a synced vault, else a
 * whole-file replace), 'rollback' or 'new-vault' (with targetPath). Returns the RestoreResult:
 * {mode: 'preview', preview} | {mode: 'rollback', applied} | {mode: 'new-vault', path} | {mode: 'replaced', path}.
 */
export function restoreLocalBackup(device, backupFilePath, masterPassword, { mode, targetPath, backupPassword } = {}) {
  const args = { backupFilePath, masterPassword, ...(mode ? { mode } : {}), ...(targetPath ? { targetPath } : {}), ...(backupPassword ? { backupPassword } : {}) };
  return invoke(device, 'local_backup_restore', args, { timeoutMs: 90_000 });
}

/**
 * Opens the app's own "Restore from backup" preview for a local backup: local_backup_restore
 * answers a synced vault with a preview, handed to the renderer hook vaultStore uses for cloud
 * restores (showRestorePreview); its buttons re-run local_backup_restore as a rollback or a new
 * vault. The app has no local-restore screen, so this stands in for one. Returns the preview.
 */
export async function openLocalRestorePreview(device, backupFilePath, masterPassword) {
  const res = await withTimeout(device.page.evaluate(async (args) => {
    const hooks = await import('/src/stores/vault-sync-hooks.ts');
    const result = await window.electron.invoke('local_backup_restore', args);
    const rerun = (mode, targetPath) => window.electron.invoke('local_backup_restore', { ...args, mode, targetPath });
    return { opened: hooks.showRestorePreview(result, rerun), result };
  }, { backupFilePath, masterPassword }), 90_000, `${device.name}: local restore preview`);
  if (!res.opened) throw new Error(`${device.name}: local_backup_restore did not answer with a preview: ${JSON.stringify(res.result).slice(0, 300)}`);
  return res.result.preview;
}

function readCloudSectionInPage(root, cv) {
  const { S } = cv;
  const scope = document.querySelector(root);
  const label = [...(scope?.querySelectorAll('label') ?? [])].find((l) => l.innerText.trim() === 'Cloud Backup');
  const section = label ? cv.pickClosest(label, scope, S.cloudBackupSection) : null;
  if (!section) return null;
  const toggle = cv.pickOne(cv.pickClosest(label, scope, S.toggleRow), S.toggle);
  return {
    badge: cv.pickOne(scope, S.cloudBackupBadge, label.parentElement)?.innerText?.trim() ?? null,
    toggleDisabled: toggle?.disabled ?? null,
    text: section.innerText,
  };
}

/** Settings > Backup > Cloud Backup as shown: {badge, toggleDisabled, text} (null when the section is hidden). */
export async function cloudBackupSection(device) {
  await backupTab(device);
  return waitFor(() => evaluateIn(device, readCloudSectionInPage, SETTINGS_ROOT, { label: 'read Cloud Backup' }), {
    timeoutMs: 15_000,
    label: `${device.name}: Cloud Backup section`,
  });
}

/** Clicks the Cloud Backup toggle once, whatever its state; returns 'clicked', 'disabled', 'no label' or 'no toggle'. */
export async function pressCloudBackupToggle(device) {
  await backupTab(device);
  return evaluateIn(device, clickToggleInPage, { root: SETTINGS_ROOT, label: 'Cloud Backup' }, { label: 'press Cloud Backup' });
}

/** Settings > Backup > Cloud Backup toggle off (when on); waits until cloud backup is off. */
export async function disableCloudBackup(device, { timeoutMs = 30_000 } = {}) {
  await backupTab(device);
  if (!(await cloudBackupState(device))?.enabled) return cloudBackupState(device);
  await clickToggle(device, 'Cloud Backup');
  return waitFor(async () => {
    const s = await cloudBackupState(device);
    return s && !s.enabled ? s : null;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: cloud backup off` });
}

/** cloud_sync_get_state as the Backup tab reads it. */
export const cloudBackupState = (device) => invoke(device, 'cloud_sync_get_state');

/**
 * Settings > Backup > Cloud Backup toggle (Pro and Team); waits until cloud backup is on. Pro and
 * Team vaults usually have it on already after unlock; then nothing is clicked.
 */
export async function enableCloudBackup(device, { timeoutMs = 60_000 } = {}) {
  await backupTab(device);
  const before = await cloudBackupState(device);
  if (before?.enabled) return before;
  await clickToggle(device, 'Cloud Backup');
  return waitFor(async () => {
    const s = await cloudBackupState(device);
    return s?.enabled ? s : null;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: cloud backup on` });
}

/** Settings > Backup > [Back Up Now]; waits for a newer upload (status synced, later lastSyncedAt). */
export async function cloudBackupNow(device, { timeoutMs = 90_000 } = {}) {
  await backupTab(device);
  const before = (await cloudBackupState(device))?.lastSyncedAt ?? null;
  await clickText(device, 'Back Up Now', { exact: true, selector: `${SETTINGS_ROOT} button` });
  return waitFor(async () => {
    const s = await cloudBackupState(device);
    const newer = s?.lastSyncedAt && s.lastSyncedAt !== before;
    return s?.status === 'synced' && newer ? s : null;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: a newer cloud backup upload` });
}

/** cloud_backup_list_all: [{path, vaultId, vaultName, created_at, size}]. */
export const listCloudBackups = (device) => invoke(device, 'cloud_backup_list_all');

/** B25: W3-VAULT puts data-cv-backup-manager on the panel; until then the harness marks it. */
function markManagerInPage() {
  if (document.querySelector('[data-cv-backup-manager]')) return true;
  const root = [...document.querySelectorAll('[data-dialog-content]')].find((el) => el.querySelector('h2')?.innerText?.trim() === 'Backup Manager');
  if (!root) return false;
  root.setAttribute('data-cv-backup-manager', '');
  return true;
}

/** Settings > Backup > [Manage Backups...] (shown once a cloud backup exists). */
export async function openBackupManager(device) {
  await backupTab(device);
  await clickText(device, 'Manage Backups...', { exact: true, selector: `${SETTINGS_ROOT} button` });
  await waitFor(() => withTimeout(device.page.evaluate(markManagerInPage), 10_000, 'find Backup Manager'), { timeoutMs: 15_000, label: `${device.name}: Backup Manager` });
}

/**
 * In the Backup Manager: [Restore] on the index-th backup (newest first), the master password,
 * [Confirm]. For a synced vault the "Restore from backup" preview opens next.
 */
export async function restoreFromBackupManager(device, masterPassword, { index = 0 } = {}) {
  await clickText(device, 'Restore', { exact: true, selector: `${MANAGER_ROOT} button`, index });
  await typeInto(device, `${MANAGER_ROOT} input[placeholder="Master password"]`, masterPassword);
  await clickText(device, 'Confirm', { exact: true, selector: `${MANAGER_ROOT} button` });
}

export async function closeBackupManager(device) {
  await clickText(device, 'Close', { exact: true, selector: `${MANAGER_ROOT} button` });
}
