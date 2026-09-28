// Settings flows: open the Settings dialog on a tab, save or cancel it, the Security tab's idle
// lock, the Sync tab (status, Sync now, review tools, devices, notices), and the master password
// change (Vault menu > Change Password...).

import { bodyText, clickSelector, clickText, dispatchDocumentEvent, typeInto, waitFor, withTimeout } from './ui.mjs';
import { clickMenuItem, selectOption, setCheckbox } from './ui-forms.mjs';
import { SELECTORS, clickIn, evaluateIn, existsIn, textIn } from './selectors.mjs';

/** Settings dialog tab ids (src/components/settings/SettingsNav.tsx). */
export const SETTINGS_TABS = ['general', 'appearance', 'security', 'sessions/terminal', 'sessions/ssh', 'sessions/rdp', 'sessions/vnc', 'sessions/web', 'ai/agent', 'backup', 'sync', 'mobile', 'team', 'account'];
const SETTINGS_ROOT = '[data-cv-settings]';
const IDLE_LOCK_SELECT = 'select[aria-label="Lock the vault when idle"]';
const SYNC_TOOL_BUTTONS = ['Review changes', 'Recently deleted', 'Other copies'];
const CHANGE_PW_TITLE = 'Change Password';
export const ERASE_DELETED_TEXT = 'Also permanently delete items in Recently deleted';

/** B1: W3-SETTINGS puts data-cv-settings on the panel; until then the harness marks it. */
function markSettingsInPage() {
  if (document.querySelector('[data-cv-settings]')) return true;
  const root = [...document.querySelectorAll('[data-dialog-content]')].find((el) => el.querySelector('h2')?.innerText?.trim() === 'Settings');
  if (!root) return false;
  root.setAttribute('data-cv-settings', '');
  return true;
}

export async function settingsOpen(device) {
  return withTimeout(device.page.evaluate(markSettingsInPage), 10_000, `${device.name}: find Settings`);
}

/**
 * The dialog loads settings.json after it mounts and then replaces its form state, so an edit made
 * before that is lost. A settings_get issued now is answered after the dialog's own (IPC replies keep
 * their order); two frames later React has committed the loaded values.
 */
function settingsLoadedInPage() {
  return window.electron.invoke('settings_get').then(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  }));
}

/** Opens Settings on `tab` (the conduit:settings event the sidebar and menu send), loaded and editable. */
export async function openSettings(device, tab = 'general') {
  if (!SETTINGS_TABS.includes(tab)) throw new Error(`Unknown settings tab "${tab}". Use one of ${SETTINGS_TABS.join(', ')}`);
  await dispatchDocumentEvent(device, 'conduit:settings', { tab });
  await waitFor(() => settingsOpen(device), { timeoutMs: 15_000, label: `${device.name}: Settings dialog` });
  await withTimeout(device.page.evaluate(settingsLoadedInPage), 10_000, `${device.name}: Settings loaded`);
}

/** Clicks a Settings nav item by its label (General, Security, Backup, Sync, ...). */
export function switchSettingsTab(device, label) {
  return clickIn(device, label, SELECTORS.settingsNavButton, { scope: SETTINGS_ROOT, exact: true });
}

async function closeSettingsWith(device, label) {
  await clickIn(device, label, SELECTORS.settingsFooterButton, { scope: SETTINGS_ROOT, exact: true });
  await waitFor(async () => !(await settingsOpen(device)), { timeoutMs: 15_000, label: `${device.name}: Settings closed` });
}

/** [Save] (writes settings.json) and waits for the dialog to close. */
export const saveSettings = (device) => closeSettingsWith(device, 'Save');
export const cancelSettings = (device) => closeSettingsWith(device, 'Cancel');

/** Security tab: "Lock the vault when idle" to `minutes` (0, 5, 15, 30 or 60), then Save. */
export async function setIdleLockMinutes(device, minutes) {
  await openSettings(device, 'security');
  await selectOption(device, `${SETTINGS_ROOT} ${IDLE_LOCK_SELECT}`, minutes);
  const shown = await withTimeout(device.page.evaluate((sel) => document.querySelector(sel)?.value, `${SETTINGS_ROOT} ${IDLE_LOCK_SELECT}`), 10_000, 'read idle select');
  if (shown !== String(minutes)) throw new Error(`${device.name}: idle lock select shows ${shown} after choosing ${minutes}`);
  await saveSettings(device);
}

function readSyncTabInPage(root, cv) {
  const { S } = cv;
  const el = document.querySelector(root);
  if (!el) return null;
  const read = (node) => node?.innerText?.trim() ?? null;
  const sections = [...el.querySelectorAll('h3')].map((h) => h.innerText.trim());
  const statusBox = cv.pickOne(el, S.syncStatus);
  const plans = cv.pickAll(el, S.syncPlan).map((p) => p.innerText.trim());
  const plan = (cv.usesHook(el, S.syncPlan) ? plans[0] : plans.find((t) => t.startsWith('Your plan:'))) ?? null;
  const devices = cv.pickAll(el, S.deviceRow).map((row) => ({
    name: read(cv.pickOne(row, S.deviceName)) ?? '',
    line: read(cv.pickOne(row, S.deviceLine)) ?? '',
  }));
  const notices = cv.pickAll(el, S.syncNotice).map((n) => ({
    text: read(cv.pickOne(n, S.syncNoticeText)) ?? '',
    actions: [...n.querySelectorAll('button')].map((b) => b.innerText.trim()),
  }));
  const paused = cv.pickAll(el, S.syncPaused).map((p) => p.innerText.trim());
  return {
    sections,
    status: read(cv.pickOne(statusBox, S.syncStatusLabel)),
    detail: read(cv.pickOne(statusBox, S.syncStatusDetail)),
    plan,
    devices,
    notices,
    paused,
    text: el.innerText,
  };
}

/** Opens Settings > Sync and reads it: {sections, status, detail, plan, devices, notices, paused, text}. */
export async function readSyncTab(device, { reopen = true } = {}) {
  if (reopen || !(await settingsOpen(device))) await openSettings(device, 'sync');
  return waitFor(async () => {
    const tab = await evaluateIn(device, readSyncTabInPage, SETTINGS_ROOT, { label: 'read Sync tab' });
    return tab?.sections.includes('Multi-device sync') ? tab : null;
  }, { timeoutMs: 15_000, label: `${device.name}: Sync tab` });
}

/** Settings > Sync > [Sync now]; waits until the button reads "Sync now" again. */
export async function syncNowFromSettings(device) {
  await readSyncTab(device);
  await clickText(device, 'Sync now', { exact: true, selector: `${SETTINGS_ROOT} button` });
  await waitFor(async () => (await bodyText(device)).includes('Sync now'), { timeoutMs: 30_000, label: `${device.name}: Sync now finished` });
}

/**
 * Settings > Sync > one of the review tools: 'Review changes', 'Recently deleted', 'Other copies'.
 * The panel opens above Settings, which stays open underneath (cancelSettings after the panel).
 */
export async function openSyncTool(device, tool) {
  if (!SYNC_TOOL_BUTTONS.includes(tool)) throw new Error(`Unknown sync tool "${tool}". Use ${SYNC_TOOL_BUTTONS.join(', ')}`);
  await readSyncTab(device);
  await clickText(device, tool, { selector: `${SETTINGS_ROOT} button` });
}

/** Clicks [Review] or [OK] on the Sync tab notice whose text includes `text`. */
export async function syncTabNoticeAction(device, text, label) {
  await readSyncTab(device);
  const done = await evaluateIn(device, ({ root, text, label }, cv) => {
    const notice = cv.find(root, cv.S.syncNotice).find((n) => (n.innerText ?? '').includes(text));
    const button = [...(notice?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === label);
    if (!button) return notice ? 'no button' : 'no notice';
    button.click();
    return 'clicked';
  }, { root: SETTINGS_ROOT, text, label }, { label: `notice [${label}]` });
  if (done !== 'clicked') throw new Error(`${device.name}: Sync tab notice "${text}" [${label}]: ${done}`);
}

/**
 * Vault menu > Change Password..., fills the three fields and submits. Resolves {ok: true} when the
 * dialog closes, {ok: false, error} when it shows an error. {eraseRecentlyDeleted: true} ticks "Also
 * permanently delete items in Recently deleted" (shown only for a synced vault) first.
 */
export async function changeMasterPassword(device, currentPassword, newPassword, { timeoutMs = 60_000, eraseRecentlyDeleted = false } = {}) {
  await clickMenuItem(device, 'Change Password...');
  await waitFor(async () => (await bodyText(device)).includes('Update the master password for this vault'), { timeoutMs: 15_000, label: `${device.name}: Change Password dialog` });
  await typeInto(device, 'input[placeholder="Enter current password"]', currentPassword);
  await typeInto(device, 'input[placeholder="Enter new password"]', newPassword);
  await typeInto(device, 'input[placeholder="Confirm new password"]', newPassword);
  if (eraseRecentlyDeleted) await setCheckbox(device, ERASE_DELETED_TEXT, true, { scope: '[data-dialog-content] form' });
  await clickSelector(device, '[data-dialog-content] form button[type=submit]');
  return waitFor(async () => {
    const text = await bodyText(device);
    if (!text.includes('Update the master password for this vault')) return { ok: true };
    const scope = { scope: '[data-dialog-content]' };
    if (await existsIn(device, SELECTORS.dialogError, scope)) {
      const error = (await textIn(device, SELECTORS.dialogError, scope)) ?? '';
      return { ok: false, error };
    }
    return null;
  }, { timeoutMs, label: `${device.name}: ${CHANGE_PW_TITLE} result` });
}
