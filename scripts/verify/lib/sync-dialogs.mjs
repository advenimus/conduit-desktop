// Sync dialogs and banners (src/components/sync): the unlock-time "Master password changed" and
// "This computer's copy is damaged" dialogs, the running "Syncing paused" password prompt, the
// side-files banner, the file-not-found banner (Locate / Save a new copy here), the two-copies
// dialog and the same-device-copy banner. Titles and labels come from the components.

import { exists, readSyncState, waitFor } from './ui.mjs';
import { clickBannerAction, clickInDialog, dialogSelector, stubDialogs, typeIntoLabeled, waitForBanner } from './ui-forms.mjs';
import { dialogDetails, unlockOutcome, waitForDialog } from './sync-flows.mjs';

export const PASSWORD_CHANGED_TITLE = 'Master password changed';
export const DAMAGED_TITLE = "This computer's copy is damaged";
export const EPOCH_TITLE = 'Syncing paused';
export const TWO_COPIES_TITLE = 'Two copies of this vault';
export const SIDE_FILES_TEXT = /older version of Conduit may have this vault open|files left by the previous version/;
export const SIDE_FILES_ACTIONS = ['Conduit is closed on my other computers', 'Continue', 'Review unsaved changes first'];
export const FILE_MISSING_TEXT = /^Vault file not found at /;
export const DEFERRED_PASSWORD_TEXT = 'Syncing is paused until you enter the master password set on another device.';

/** Prompt kinds of the running engine (sync_get_state status.prompts), e.g. ['side-files']. */
export async function promptKinds(device) {
  return ((await readSyncState(device)).status?.prompts ?? []).map((p) => p.kind);
}

/** Waits until the engine raises a prompt of `kind`; returns the prompt. */
export function waitForPrompt(device, kind, { timeoutMs = 30_000 } = {}) {
  return waitFor(async () => ((await readSyncState(device)).status?.prompts ?? []).find((p) => p.kind === kind) ?? null, {
    timeoutMs,
    intervalMs: 500,
    label: `${device.name}: sync prompt ${kind}`,
  });
}

/**
 * In "Master password changed" (unlock with an old password): the new password and, when the
 * dialog asks, the previous one; [Unlock]. Returns the unlock outcome (sync-flows unlockOutcome).
 */
export async function submitPasswordChanged(device, newPassword, { previousPassword } = {}) {
  const dialog = await waitForDialog(device, PASSWORD_CHANGED_TITLE);
  const scope = dialogSelector(PASSWORD_CHANGED_TITLE);
  await typeIntoLabeled(device, 'New master password', newPassword, { scope });
  if (dialog.text.includes('Previous master password')) {
    if (!previousPassword) throw new Error(`${device.name}: "${PASSWORD_CHANGED_TITLE}" asks for the previous password too`);
    await typeIntoLabeled(device, 'Previous master password', previousPassword, { scope });
  }
  await clickInDialog(device, PASSWORD_CHANGED_TITLE, 'Unlock');
  return outcomeAfterDialog(device, PASSWORD_CHANGED_TITLE);
}

/**
 * After a button in an unlock-time dialog: waits until the dialog closes or shows an inline error
 * (InlineError's p.text-red-400; the danger icon is an svg), then returns sync-flows unlockOutcome().
 */
async function outcomeAfterDialog(device, title, { timeoutMs = 90_000 } = {}) {
  const sel = dialogSelector(title);
  await waitFor(async () => !(await exists(device, sel)) || exists(device, `${sel} p.text-red-400`), {
    timeoutMs,
    label: `${device.name}: "${title}" closed or showing an error`,
  });
  return unlockOutcome(device);
}

/** "This computer's copy is damaged": [Rebuild from shared file], then the unlock outcome. */
export async function rebuildDamagedCopy(device) {
  const dialog = await waitForDialog(device, DAMAGED_TITLE);
  if (!dialog.text.includes('Rebuild from shared file')) throw new Error(`${device.name}: the damaged-copy dialog offers no rebuild: ${dialog.text.slice(0, 300)}`);
  await clickInDialog(device, DAMAGED_TITLE, 'Rebuild from shared file');
  return outcomeAfterDialog(device, DAMAGED_TITLE);
}

/**
 * Running password prompt "Syncing paused" (epoch-newer / legacy / concurrent): types the password
 * (label "New master password" or "Other device's password"), picks `keep` for a concurrent change
 * ('this-device' or 'other'), answers "Previous master password" when asked, [Continue].
 * Resolves {ok: true} when the dialog closes, {ok: false, error} on an inline error.
 */
export async function answerEpochPrompt(device, password, { previousPassword, keep } = {}) {
  const dialog = await waitForDialog(device, EPOCH_TITLE);
  const scope = dialogSelector(EPOCH_TITLE);
  const label = dialog.text.includes("Other device's password") ? "Other device's password" : 'New master password';
  await typeIntoLabeled(device, label, password, { scope });
  if (keep) await clickRadio(device, scope, keep === 'this-device' ? 'The one I use on this device' : "The other device's password");
  for (let attempt = 0; attempt < 2; attempt++) {
    await clickInDialog(device, EPOCH_TITLE, 'Continue');
    const res = await epochResult(device);
    if (res.ok || !res.error.includes('previous password') || !previousPassword) return res;
    await typeIntoLabeled(device, 'Previous master password', previousPassword, { scope });
  }
  return epochResult(device);
}

function epochResult(device) {
  return waitFor(async () => {
    const d = (await dialogDetails(device)).find((x) => x.title === EPOCH_TITLE);
    if (!d) return { ok: true };
    if (d.text.includes('Checking...')) return null;
    const error = d.text.split('\n').find((l) => /didn't work|older password|previous password too|Could not/.test(l));
    return error ? { ok: false, error } : null;
  }, { timeoutMs: 60_000, label: `${device.name}: "${EPOCH_TITLE}" result` });
}

async function clickRadio(device, scope, text) {
  const res = await device.page.evaluate(({ scope, text }) => {
    const label = [...document.querySelectorAll(`${scope} label`)].find((l) => (l.innerText ?? '').trim() === text);
    const radio = label?.querySelector('input[type=radio]');
    if (!radio) return 'missing';
    radio.click();
    return 'clicked';
  }, { scope, text });
  if (res !== 'clicked') throw new Error(`${device.name}: radio "${text}" ${res}`);
}

/** [Later] on "Syncing paused"; the deferred banner then offers [Enter password]. */
export const deferEpochPrompt = (device) => clickInDialog(device, EPOCH_TITLE, 'Later');

/** The side-files banner (5.5): {text, actions}; actions[0] is the confirm label shown. */
export const waitForSideFilesBanner = (device, opts) => waitForBanner(device, SIDE_FILES_TEXT, opts);

/**
 * Clicks the side-files banner's button ([Conduit is closed on my other computers], [Continue] or
 * [Review unsaved changes first]); returns the label clicked.
 */
export async function confirmSideFilesBanner(device) {
  const banner = await waitForSideFilesBanner(device);
  const label = banner.actions.find((a) => SIDE_FILES_ACTIONS.includes(a));
  if (!label) throw new Error(`${device.name}: side-files banner has no known action: ${JSON.stringify(banner)}`);
  await clickBannerAction(device, SIDE_FILES_TEXT, label);
  return label;
}

/** The file-not-found banner: {text, actions} (Locate..., Keep working on this device, Save a new copy here). */
export const waitForFileMissingBanner = (device, opts) => waitForBanner(device, FILE_MISSING_TEXT, opts);

/** [Locate...] with the open dialog answering `filePath`. */
export async function locateMissingVault(device, filePath) {
  await stubDialogs(device, { open: filePath });
  await clickBannerAction(device, FILE_MISSING_TEXT, 'Locate...');
}

/** [Save a new copy here] with the save dialog answering `filePath`. */
export async function saveNewCopyHere(device, filePath) {
  await stubDialogs(device, { save: filePath });
  await clickBannerAction(device, FILE_MISSING_TEXT, 'Save a new copy here');
}

/** [Keep working on this device]: puts the file-not-found banner off until the next unlock. */
export const keepWorkingHere = (device) => clickBannerAction(device, FILE_MISSING_TEXT, 'Keep working on this device');

/** "Two copies of this vault": [Keep separate] with the save dialog answering `targetPath`. */
export async function keepCopiesSeparate(device, targetPath) {
  await waitForDialog(device, TWO_COPIES_TITLE);
  await stubDialogs(device, { save: targetPath });
  await clickInDialog(device, TWO_COPIES_TITLE, 'Keep separate');
}

/** "Two copies of this vault": [Merge them...] with the open dialog answering `copyPath` (opens the candidate). */
export async function mergeTwoCopies(device, copyPath) {
  await waitForDialog(device, TWO_COPIES_TITLE);
  await stubDialogs(device, { open: copyPath });
  await clickInDialog(device, TWO_COPIES_TITLE, 'Merge them...');
}

/**
 * Same-device-copy banner "'<copy>' is a copy of '<open file>'." (after opening another file of a
 * vault this device already syncs, <copy> is the file it synced before): 'separate' ([Use as a
 * separate vault], save dialog answering `targetPath`), 'merge' ([It's the same vault, merge]) or
 * 'ignore'. `copyName` narrows the match to that first name.
 */
export async function answerSameDeviceCopy(device, choice, { copyName = null, targetPath } = {}) {
  const text = copyName === null ? / is a copy of '/ : `'${copyName}' is a copy of '`;
  const labels = { separate: 'Use as a separate vault', merge: "It's the same vault, merge", ignore: 'Ignore' };
  if (!labels[choice]) throw new Error(`Unknown choice "${choice}" (separate, merge, ignore)`);
  if (choice === 'separate') {
    if (!targetPath) throw new Error('answerSameDeviceCopy(separate) needs {targetPath}');
    await stubDialogs(device, { save: targetPath });
  }
  await clickBannerAction(device, text, labels[choice]);
}
