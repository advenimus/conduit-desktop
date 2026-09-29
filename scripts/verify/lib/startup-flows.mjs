// Startup vault and automatic unlock flows (docs/AUTO_UNLOCK.md): turn it on from the unlock
// dialog, read the sealed entries on disk, close and show the main window like the Dock or tray,
// watch a relaunch until it settles, and pick a row's context menu item without the native popup.

import fs from 'node:fs';
import path from 'node:path';
import { bodyText, clickSelector, clickText, invoke, mainEval, stubFileDialogs, typeInto, waitFor, waitForText } from './ui.mjs';
import { setCheckbox } from './ui-forms.mjs';
import { currentScreen, waitForScreen, waitForUnlockOutcome } from './flows.mjs';

const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const SUBMIT = '[data-dialog-content] form button[type=submit]';
export const CHECKBOX_TEXT = 'Unlock automatically at startup';
export const KEEP_TEXT = 'Keep unlocking automatically at startup';
export const AFTER_LOCK_LINE = 'Automatic unlock runs when Conduit starts.';
export const HOLD_MESSAGE = 'Waiting for you to use Conduit';

/** The sealed entries: {dataDir}/auto-unlock/*.auto.enc (macOS and Linux). */
export function autoUnlockFiles(device) {
  const dir = path.join(device.dataDir, 'auto-unlock');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.auto.enc'));
}

export function vaultName(file) {
  return path.basename(file).replace(/\.conduit$/i, '');
}

/** Types the password with the checkbox ticked, then Turn On in the warning. Ends unlocked. */
export async function submitWithAutoUnlock(device, password, { name }) {
  await typeInto(device, PASSWORD_INPUT, password);
  await setCheckbox(device, CHECKBOX_TEXT, true, { scope: '[data-dialog-content] form' });
  await clickSelector(device, SUBMIT);
  await waitForText(device, `Unlock ${name} automatically?`, { timeoutMs: 60_000 });
  await clickText(device, 'Turn On', { exact: true, selector: '[data-dialog-content] button' });
  const res = await waitForUnlockOutcome(device);
  if (res.outcome !== 'unlocked') throw new Error(`${device.name}: turning on automatic unlock did not unlock (${res.outcome})`);
  await waitFor(() => autoUnlockFiles(device).length === 1, { timeoutMs: 15_000, label: `${device.name}: a sealed entry` });
}

/** Hub "Open Vault File" with the unlock dialog's checkbox ticked (spec 2.1). */
export async function openVaultWithAutoUnlock(device, file, password) {
  await waitForScreen(device, 'hub');
  await stubFileDialogs(device, file);
  await clickText(device, 'Open Vault File', { exact: true, selector: 'button' });
  await waitForText(device, 'Unlock Vault');
  await submitWithAutoUnlock(device, password, { name: vaultName(file) });
}

/** The window's close button: the app locks, then hides to the tray or Dock. Resolves once it hid. */
export async function closeWindow(device) {
  const url = device.page.url();
  const before = await mainEval(device, ({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url);
    if (!win) return -1;
    if (!win.__cvHideCount) {
      const hide = win.hide.bind(win);
      win.__cvHideCount = 0;
      win.hide = () => {
        win.__cvHideCount += 1;
        hide();
      };
    }
    const n = win.__cvHideCount;
    win.close();
    return n;
  }, url, { label: 'close main window' });
  if (before < 0) throw new Error(`${device.name}: no main window to close`);
  await waitFor(() => mainEval(device, ({ BrowserWindow }, { n, url }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url);
    return (win?.__cvHideCount ?? 0) > n;
  }, { n: before, url }), { timeoutMs: 15_000, label: `${device.name}: window hidden after its close handler` });
}

/**
 * Reopening from the Dock or tray. A quiet device shows with showInactive as an accessory app, and
 * macOS does not always report that as 'show'; then the event is sent as a real show sends it.
 * Resolves true when Electron emitted it by itself.
 */
export async function showWindow(device) {
  return mainEval(device, async ({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url);
    if (!win) throw new Error('no main window');
    let emitted = false;
    win.once('show', () => {
      emitted = true;
    });
    win.show();
    await new Promise((r) => setTimeout(r, 500));
    if (!emitted) win.emit('show');
    return emitted;
  }, device.page.url(), { label: 'show main window' });
}

/**
 * Samples the screen from right after a launch until `done` holds; returns every screen seen.
 * The hub counts as seen only without a dialog on top.
 */
export async function watchScreens(device, done, { timeoutMs = 90_000, intervalMs = 100 } = {}) {
  const seen = [];
  const texts = [];
  await waitFor(async () => {
    const [screen, text] = await Promise.all([currentScreen(device), bodyText(device, { timeoutMs: 10_000 })]);
    if (seen[seen.length - 1] !== screen) seen.push(screen);
    texts.push(text);
    return done(screen, text);
  }, { timeoutMs, intervalMs, label: `${device.name}: startup settles` });
  return { seen, texts };
}

/** Waits until the personal vault is open and its open has finished (sync_get_state names it). */
export function waitUnlocked(device, { timeoutMs = 90_000 } = {}) {
  return waitFor(async () => (await invoke(device, 'vault_is_unlocked')) && (await invoke(device, 'sync_get_state'))?.vault ? true : null, {
    timeoutMs,
    label: `${device.name}: vault unlocked`,
  });
}

/**
 * Right-clicks the recent-vault row `file` on the hub and answers the popup with item `id`
 * ('start', 'stop', 'off', 'remove', 'copy'), the same path the native popup takes.
 */
export async function recentRowMenu(device, file, id) {
  await mainEval(device, ({ ipcMain }, answer) => {
    ipcMain.removeHandler('show_context_menu_popup');
    ipcMain.handle('show_context_menu_popup', async () => answer);
  }, id, { label: 'stub the popup menu' });
  await waitFor(() => device.page.evaluate((f) => {
    const row = [...document.querySelectorAll('button[title]')].find((b) => b.title === f);
    if (!row) return false;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 }));
    return true;
  }, file), { timeoutMs: 15_000, label: `${device.name}: row menu of ${path.basename(file)}` });
}

/** The renderer's store module from the dev server, for UI states a test cannot reach by clicking. */
export function withStartupStore(device, fn, arg) {
  return device.page.evaluate(async ({ body, arg: a }) => {
    const mod = await import('/src/stores/startupVaultStore.ts');
    // eslint-disable-next-line no-new-func
    return new Function('mod', 'arg', body)(mod, a);
  }, { body: fn, arg });
}

/** The main log text since launch. */
export function mainLogText(device) {
  return fs.existsSync(device.mainLog) ? fs.readFileSync(device.mainLog, 'utf8') : '';
}
