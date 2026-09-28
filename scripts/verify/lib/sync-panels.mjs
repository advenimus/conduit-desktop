// Sync panels (src/components/sync): Recently deleted (restore / delete permanently), Other copies
// of this vault (per-copy actions), the candidate preview "Merge '<label>'?" (merge / don't merge),
// the mass-change undo dialog, and the backup "Restore from backup" preview (roll back / new vault).
// Open the first two with settings-flows openSyncTool(); the others open from banners and toasts.

import { clickText, waitFor, withTimeout } from './ui.mjs';
import { clickInDialog, dialogSelector, setCheckbox, stubDialogs } from './ui-forms.mjs';
import { dialogDetails, waitForDialog } from './sync-flows.mjs';

export const RECENTLY_DELETED_TITLE = 'Recently deleted';
export const OTHER_COPIES_TITLE = 'Other copies of this vault';
export const CANDIDATE_TITLE = /^Merge (a copy|'.*'\?)$/;
export const MASS_CHANGE_TITLE = /^(.+ (deleted|changed) \d+ items?\.|Large change from a sync)$/;
export const RESTORE_TITLE = 'Restore from backup';
const CONFIRM_DELETE_TEXT = 'Delete permanently?';

async function waitClosed(device, title, { timeoutMs = 30_000 } = {}) {
  const matches = (t) => (title instanceof RegExp ? title.test(t) : t === title);
  await waitFor(async () => !(await dialogDetails(device)).some((d) => matches(d.title)), { timeoutMs, label: `${device.name}: "${title}" closed` });
}

// ---------- Recently deleted ----------

function readDeletedInPage(root) {
  const panel = document.querySelector(root);
  if (!panel) return null;
  if (panel.innerText.includes('Loading...')) return null;
  return [...panel.querySelectorAll('.max-h-80 label')].map((row) => ({
    title: row.querySelector('p.text-sm')?.innerText?.trim() ?? '',
    detail: row.querySelector('p.text-xs')?.innerText?.trim() ?? '',
    checked: row.querySelector('input')?.checked ?? false,
    erased: row.querySelector('input')?.disabled ?? false,
  }));
}

/** Rows of the open Recently deleted panel: [{title, detail, checked, erased}] ([] when empty). */
export function recentlyDeletedItems(device) {
  return waitFor(() => withTimeout(device.page.evaluate(readDeletedInPage, dialogSelector(RECENTLY_DELETED_TITLE)), 10_000, 'read deleted'), {
    timeoutMs: 15_000,
    label: `${device.name}: Recently deleted list`,
  });
}

/** Checks the rows whose title is in `titles` (the others are left as they are). */
export async function selectDeleted(device, titles) {
  for (const t of titles) await setCheckbox(device, t, true, { scope: dialogSelector(RECENTLY_DELETED_TITLE) });
}

async function listChanged(device, titles, gone) {
  await waitFor(async () => {
    const rows = await recentlyDeletedItems(device);
    return titles.every((t) => gone(rows.find((r) => r.title === t)));
  }, { timeoutMs: 30_000, label: `${device.name}: Recently deleted updated for ${titles.join(', ')}` });
}

/** Selects `titles`, [Restore], and waits until they leave the list. */
export async function restoreDeleted(device, titles) {
  await selectDeleted(device, titles);
  await clickInDialog(device, RECENTLY_DELETED_TITLE, 'Restore');
  await listChanged(device, titles, (row) => row === undefined);
}

/** Selects `titles`, [Delete permanently], confirms; waits until they are gone or show "Erased permanently". */
export async function deletePermanently(device, titles) {
  await selectDeleted(device, titles);
  await clickInDialog(device, RECENTLY_DELETED_TITLE, 'Delete permanently');
  await confirmPermanentDelete(device);
  await listChanged(device, titles, (row) => row === undefined || row.erased);
}

/** [Delete all permanently] and confirm. */
export async function deleteAllPermanently(device) {
  await clickInDialog(device, RECENTLY_DELETED_TITLE, 'Delete all permanently');
  await confirmPermanentDelete(device);
}

async function confirmPermanentDelete(device) {
  await waitFor(async () => (await withTimeout(device.page.evaluate((t) => [...document.querySelectorAll('[data-dialog-content] h2')].some((h) => h.innerText.trim() === t), CONFIRM_DELETE_TEXT), 10_000, 'confirm dialog')), {
    timeoutMs: 10_000,
    label: `${device.name}: "${CONFIRM_DELETE_TEXT}"`,
  });
  await clickText(device, 'Delete permanently', { exact: true, selector: '.z-\\[70\\] [data-dialog-content] button' });
}

/** Ticks "Show items deleted more than 30 days ago". */
export const showOlderDeleted = (device, on = true) => setCheckbox(device, 'Show items deleted more than 30 days ago', on, { scope: dialogSelector(RECENTLY_DELETED_TITLE) });

export async function closeRecentlyDeleted(device) {
  await clickInDialog(device, RECENTLY_DELETED_TITLE, 'Done');
  await waitClosed(device, RECENTLY_DELETED_TITLE);
}

// ---------- Other copies ----------

function readCopiesInPage(root) {
  const panel = document.querySelector(root);
  if (!panel || panel.innerText.includes('Looking for copies...')) return null;
  return [...panel.querySelectorAll('.border-b')].filter((row) => row.querySelector('p.text-sm')).map((row) => ({
    name: row.querySelector('p.text-sm')?.innerText?.trim() ?? '',
    path: row.querySelector('p.text-sm')?.getAttribute('title') ?? '',
    text: row.querySelector('p.text-xs')?.innerText?.trim() ?? '',
    actions: [...row.querySelectorAll('button')].map((b) => b.innerText.trim()),
  }));
}

/** Rows of the open Other copies panel: [{name, path, text, actions}]. */
export function otherCopies(device) {
  return waitFor(() => withTimeout(device.page.evaluate(readCopiesInPage, dialogSelector(OTHER_COPIES_TITLE)), 10_000, 'read copies'), {
    timeoutMs: 30_000,
    label: `${device.name}: Other copies list`,
  });
}

/** Waits until the panel lists a copy named `name`; [Scan again] between tries. Returns the row. */
export async function waitForCopy(device, name, { timeoutMs = 45_000 } = {}) {
  return waitFor(async () => {
    const row = (await otherCopies(device)).find((c) => c.name === name);
    if (row) return row;
    await clickInDialog(device, OTHER_COPIES_TITLE, 'Scan again', { timeoutMs: 5_000 });
    return null;
  }, { timeoutMs, intervalMs: 1_000, label: `${device.name}: copy "${name}" listed` });
}

/**
 * Clicks action `label` of copy `name` ('Merge them...', 'Keep separate', 'Move to Trash', 'Ignore',
 * 'Review...', 'Ignore this copy'). 'Keep separate' asks where to save: pass {targetPath}.
 */
export async function copyRowAction(device, name, label, { targetPath } = {}) {
  if (label === 'Keep separate') {
    if (!targetPath) throw new Error('copyRowAction(Keep separate) needs {targetPath}');
    await stubDialogs(device, { save: targetPath });
  }
  const res = await withTimeout(device.page.evaluate(({ root, name, label }) => {
    const row = [...document.querySelectorAll(`${root} p.text-sm`)].find((p) => p.innerText.trim() === name)?.closest('.flex.items-start');
    const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === label);
    if (!button) return row ? 'no button' : 'no row';
    if (button.disabled) return 'disabled';
    button.click();
    return 'clicked';
  }, { root: dialogSelector(OTHER_COPIES_TITLE), name, label }), 10_000, `${device.name}: copy action`);
  if (res !== 'clicked') throw new Error(`${device.name}: copy "${name}" [${label}]: ${res}`);
}

export async function closeOtherCopies(device) {
  await clickInDialog(device, OTHER_COPIES_TITLE, 'Done');
  await waitClosed(device, OTHER_COPIES_TITLE);
}

// ---------- Candidate preview ----------

/**
 * The open "Merge '<label>'?" preview once loaded: {title, text, sections: {title: count}}. Section
 * keys: 'Different values', 'Only in this copy', 'Deleted in this copy', 'Missing from this copy'
 * (a heading's note in parentheses, as in "Only in this copy (they will be added) (2)", is dropped).
 */
export async function candidatePreview(device, { timeoutMs = 30_000 } = {}) {
  const d = await waitFor(async () => {
    const found = (await dialogDetails(device)).find((x) => CANDIDATE_TITLE.test(x.title));
    return found && !found.text.includes('Comparing...') && found.title !== 'Merge a copy' ? found : null;
  }, { timeoutMs, label: `${device.name}: candidate preview loaded` });
  const sections = {};
  const heading = /^(Different values|Only in this copy|Deleted in this copy|Missing from this copy)(?: \([^)\n]*\))? \((\d+)\)$/gm;
  for (const m of d.text.matchAll(heading)) sections[m[1]] = Number(m[2]);
  return { title: d.title, text: d.text, sections };
}

/** [Merge] (optionally ticking "Delete the missing items from the vault too"). */
export async function mergeCandidate(device, { deleteMissing = false } = {}) {
  const { title } = await candidatePreview(device);
  if (deleteMissing) await setCheckbox(device, 'Delete the missing items from the vault too', true, { scope: dialogSelector(title) });
  await clickInDialog(device, title, 'Merge');
  await waitClosed(device, CANDIDATE_TITLE);
}

/** [Don't merge]: the copy is set aside, nothing merged. */
export async function discardCandidate(device) {
  const { title } = await candidatePreview(device);
  await clickInDialog(device, title, "Don't merge");
  await waitClosed(device, CANDIDATE_TITLE);
}

// ---------- Mass change ----------

/** The open mass-change dialog once loaded: {title, text, rows: [{title, checked, disabled}], fields}. */
export async function massChangeDetails(device, { timeoutMs = 30_000 } = {}) {
  const d = await waitFor(async () => {
    const found = (await dialogDetails(device)).find((x) => MASS_CHANGE_TITLE.test(x.title));
    return found && !found.text.includes('Loading...') ? found : null;
  }, { timeoutMs, label: `${device.name}: mass-change dialog` });
  const rows = await withTimeout(device.page.evaluate((title) => {
    const dialog = document.querySelector(`[role=dialog][aria-label="${title.replace(/"/g, '\\"')}"]`);
    return [...(dialog?.querySelectorAll('label') ?? [])].map((l) => ({
      title: l.querySelector('span.text-ink')?.innerText?.trim() ?? '',
      checked: l.querySelector('input')?.checked ?? false,
      disabled: l.querySelector('input')?.disabled ?? false,
    }));
  }, d.title), 10_000, `${device.name}: read mass change`);
  return { title: d.title, text: d.text, rows };
}

/** [Undo selected] (every still-deleted row is pre-selected); `uncheck` clears some first. */
export async function undoMassChange(device, { uncheck = [] } = {}) {
  const { title } = await massChangeDetails(device);
  for (const t of uncheck) await setCheckbox(device, t, false, { scope: dialogSelector(title) });
  await clickInDialog(device, title, 'Undo selected');
  await waitClosed(device, MASS_CHANGE_TITLE);
}

/** [Keep changes]: dismisses the notice. */
export async function keepMassChange(device) {
  const { title } = await massChangeDetails(device);
  await clickInDialog(device, title, 'Keep changes');
  await waitClosed(device, MASS_CHANGE_TITLE);
}

// ---------- Restore preview ----------

/** The open "Restore from backup" preview: {text, nothing, deletions, restorations}. */
export async function restorePreviewDetails(device) {
  const d = await waitForDialog(device, RESTORE_TITLE);
  const count = (label) => Number(d.text.match(new RegExp(`${label} \\((\\d+)\\)`))?.[1] ?? 0);
  return {
    text: d.text,
    nothing: d.text.includes('This vault already matches the backup.'),
    deletions: count('Created since the backup \\(will be deleted\\)'),
    restorations: count('Deleted since the backup \\(will come back\\)'),
  };
}

/** [Roll this vault back]. */
export async function rollBackFromPreview(device) {
  await waitForDialog(device, RESTORE_TITLE);
  await clickInDialog(device, RESTORE_TITLE, 'Roll this vault back');
  await waitClosed(device, RESTORE_TITLE, { timeoutMs: 60_000 });
}

/** [Restore as a new vault...] with the save dialog answering `targetPath`. */
export async function restoreAsNewVaultFromPreview(device, targetPath) {
  await waitForDialog(device, RESTORE_TITLE);
  await stubDialogs(device, { save: targetPath });
  await clickInDialog(device, RESTORE_TITLE, 'Restore as a new vault...');
  await waitClosed(device, RESTORE_TITLE, { timeoutMs: 60_000 });
}

export async function cancelRestorePreview(device) {
  await clickInDialog(device, RESTORE_TITLE, 'Cancel');
  await waitClosed(device, RESTORE_TITLE);
}

/** True while any of this module's panels is open. */
export async function anyPanelOpen(device) {
  const titles = (await dialogDetails(device)).map((d) => d.title);
  return titles.some((t) => [RECENTLY_DELETED_TITLE, OTHER_COPIES_TITLE, RESTORE_TITLE].includes(t) || CANDIDATE_TITLE.test(t) || MASS_CHANGE_TITLE.test(t));
}
