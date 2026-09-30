// Vault lifecycle flows: rename from the Vault menu, answer an unlock dialog the app opened by
// itself (after [Open it]), Recently deleted over IPC for polling, and the idle auto-lock's inputs
// (system idle time and the OS screen lock) driven from the device's main process.

import { bodyText, clickSelector, invoke, mainEval, typeInto, waitFor, waitForText } from './ui.mjs';
import { clickMenuItem, toastLog, toastMark } from './ui-forms.mjs';
import { waitForUnlockOutcome } from './flows.mjs';

const RENAME_DIALOG_TEXT = 'Change the display name of this vault';
const RENAME_INPUT = 'input[placeholder="Enter new vault name"]';
const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const SUBMIT = '[data-dialog-content] form button[type=submit]';

/**
 * Vault menu > Rename Vault..., types `newName` and submits. Resolves with the toast
 * ('Vault renamed to "<name>"'); throws with the dialog's error text when the rename fails.
 */
export async function renameVaultFromMenu(device, newName, { timeoutMs = 30_000 } = {}) {
  const mark = await toastMark(device);
  await clickMenuItem(device, 'Rename Vault...');
  await waitForText(device, RENAME_DIALOG_TEXT, { timeoutMs: 15_000 });
  await typeInto(device, RENAME_INPUT, newName);
  await clickSelector(device, SUBMIT);
  return waitFor(async () => {
    const done = (await toastLog(device)).slice(mark).find((t) => t.title === `Vault renamed to "${newName}"`);
    if (done) return done;
    const text = await bodyText(device);
    const at = text.indexOf(RENAME_DIALOG_TEXT);
    if (at >= 0 && /Failed to rename|already exists|Invalid vault name/.test(text)) throw new Error(`rename refused: ${text.slice(at, at + 300)}`);
    return null;
  }, { timeoutMs, label: `${device.name}: rename to ${newName}` });
}

/** Types `password` into the unlock dialog the app opened itself (for example after [Open it]). */
export async function unlockShownDialog(device, password) {
  await waitForText(device, 'Unlock Vault', { timeoutMs: 20_000 });
  await typeInto(device, PASSWORD_INPUT, password);
  await clickSelector(device, SUBMIT);
  return waitForUnlockOutcome(device);
}

/** sync_recently_deleted as the panel loads it: [{row, title, entryType, diedMs, deviceName, redacted}]. */
export function recentlyDeletedIpc(device, { showAll = false } = {}) {
  return invoke(device, 'sync_recently_deleted', { showAll });
}

/** Polls sync_recently_deleted until `pred(items)` holds; returns the items. */
export function waitRecentlyDeleted(device, pred, { timeoutMs = 30_000, label = 'Recently deleted' } = {}) {
  let last = null;
  return waitFor(async () => {
    last = await recentlyDeletedIpc(device);
    return pred(last) ? last : null;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: ${label}` }).catch((err) => {
    throw new Error(`${err.message} (last: ${JSON.stringify(last?.map((i) => ({ title: i.title, redacted: i.redacted })))})`);
  });
}

/**
 * Replaces powerMonitor.getSystemIdleTime in the device's main process with a fixed `seconds`.
 * The idle auto-lock (ipc/vault-idle.js) and the session host both read it; calls are counted
 * per caller from the stack. Returns the idle-lock checks that read it so far.
 */
export function stubSystemIdle(device, seconds) {
  return mainEval(device, ({ powerMonitor }, s) => {
    const probe = (globalThis.__cvIdle ??= { seconds: 0, idleLock: 0, other: 0 });
    probe.seconds = s;
    powerMonitor.getSystemIdleTime = () => {
      if (/[\\/]vault-idle\.js:/.test(new Error().stack ?? '')) probe.idleLock += 1;
      else probe.other += 1;
      return probe.seconds;
    };
    return probe.idleLock;
  }, seconds, { label: 'stub system idle time' });
}

/** Idle auto-lock checks that read the stubbed idle time (0 before stubSystemIdle). */
export function idleChecks(device) {
  return mainEval(device, () => globalThis.__cvIdle?.idleLock ?? 0, undefined, { label: 'read idle checks' });
}

/** The OS screen lock as powerMonitor reports it. */
export function emitLockScreen(device) {
  return mainEval(device, ({ powerMonitor }) => {
    powerMonitor.emit('lock-screen');
  }, undefined, { label: 'emit lock-screen' });
}

