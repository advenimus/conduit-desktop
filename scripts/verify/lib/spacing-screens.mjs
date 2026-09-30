// The screens capture-spacing.mjs walks through on one device: sign-in, the Vault Hub with four recent
// vaults, unlock with automatic unlock, the side bar, panes and tab bars, the AI panel, popup menus,
// entry dialogs, every Settings tab, the sync panels, toasts, then the hub again with the Startup
// badge and the automatic unlock fallbacks. Each section is captured on its own, so a section that
// fails is reported and the rest still run.

import fs from 'node:fs';
import path from 'node:path';
import { captureWindow, cropCapture } from './window-capture.mjs';
import { clearToasts, closeMenus, childWindowRegion, hoverMenuItem, launchInMode, openMenu, regions, scrollSettings, showReferenceToasts } from './restyle-flows.mjs';
import {
  clickInTopDialog,
  closeAllSessions,
  createVaultShowing,
  expandFolders,
  fillAcme,
  openEntry,
  openReferenceSessions,
  rightClick,
  selectEntry,
  setSidebar,
  TREE_MENU_X,
  vaultDir,
  VAULT_PASSWORD,
  waitForDialogs,
  withStores,
} from './restyle-data.mjs';
import { SETTINGS_TABS } from './restyle-screens.mjs';
import { cancelSettings, openSettings, switchSettingsTab } from './settings-flows.mjs';
import { CHECKBOX_TEXT } from './startup-flows.mjs';
import { selectOption, setCheckbox } from './ui-forms.mjs';
import { clickSelector, clickText, dispatchDocumentEvent, exists, mainEval, pressKey, sleep, typeInto, waitFor, waitForText, withTimeout } from './ui.mjs';

const DIALOG = '[data-dialog-content]';
const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const STARTUP_VAULT = 'CloudWise';
// Created oldest first, so the hub lists them newest first with the startup vault on top.
const VAULTS = Object.freeze(['Test2', 'Test', 'Personal', STARTUP_VAULT]);
// Long iCloud-style folders, so the hub truncates the paths the way it does on the owner's machine.
const ICLOUD_DIRS = Object.freeze(['Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Sync', 'Conduit']);
const SETTLE_MS = 400;
const CROP_PAD = 8;

function recorder(d, mode, outDir) {
  let seq = 0;
  const shots = [];
  /** Captures the window (menus and toasts laid over it) as <mode>-<nn>-<name>.png, or a crop of it. */
  return {
    shots,
    async shot(name, what, { crop, overlays } = {}) {
      seq += 1;
      const file = `${mode}-${String(seq).padStart(2, '0')}-${name}.png`;
      const out = path.join(outDir, file);
      await sleep(SETTLE_MS);
      const full = crop ? `${out}.full.png` : out;
      const capture = await captureWindow(d, full, { method: 'page', ...(overlays ? { overlays } : {}) });
      if (crop) {
        const region = await crop();
        await cropCapture(capture, region, out, { zoom: region.zoom ?? 1 });
        fs.rmSync(full, { force: true });
      }
      shots.push({ file, what: `${what} (${mode})` });
      console.log(`[spacing] saved ${file}`);
    },
  };
}

const padded = (r, zoom) => ({ x: Math.max(0, r.x - CROP_PAD), y: Math.max(0, r.y - CROP_PAD), width: r.width + 2 * CROP_PAD, height: r.height + 2 * CROP_PAD, zoom });

function recentVaultsRegion(d, vaultPath) {
  return withTimeout(d.page.evaluate((p) => {
    let el = [...document.querySelectorAll('[title]')].find((e) => e.getAttribute('title') === p) ?? null;
    while (el && !el.innerText.includes('Clear All')) el = el.parentElement;
    return el ? el.getBoundingClientRect().toJSON() : null;
  }, vaultPath), 10_000, `${d.name}: recent vaults region`);
}

/** A test device has no Touch ID enrollment: the hub's per-vault check answers yes for `vaultPath`. */
function showFingerprintFor(d, vaultPath) {
  return mainEval(d, ({ ipcMain }, p) => {
    ipcMain.removeHandler('biometric_enabled_for_path');
    ipcMain.handle('biometric_enabled_for_path', (_e, args) => args?.vaultPath === p);
    return true;
  }, vaultPath, { label: 'answer the hub fingerprint check' });
}

/** Quick Unlock shown as on for the open vault (Settings > Security); off again before any unlock dialog. */
async function quickUnlockShown(d, on) {
  await mainEval(d, ({ ipcMain }, value) => {
    ipcMain.removeHandler('biometric_enabled');
    ipcMain.handle('biometric_enabled', () => value);
    return true;
  }, on, { label: 'answer the Quick Unlock check' });
  await withStores(d, async (_, s) => {
    await s.vault.getState().checkBiometric();
    return true;
  }, null, { label: 'recheck Quick Unlock' });
}

function focusPane(d, side) {
  return withStores(d, (which, s) => {
    const layout = s.layout.getState();
    const edge = (n) => (n.type === 'leaf' ? n : edge(n.children[which === 'left' ? 0 : 1]));
    layout.setFocusedPane(edge(layout.root).id);
    return true;
  }, side, { label: `focus the ${side} pane` });
}

async function cancelTopDialog(d) {
  await clickInTopDialog(d, 'Cancel');
  await sleep(300);
}

async function hubAndUnlock(ctx, d, rec, env) {
  await ctx.flows.waitForScreen(d, 'auth');
  await rec.shot('sign-in', 'Sign-in screen');
  await ctx.flows.signIn(d, env.user);
  await ctx.flows.waitForScreen(d, 'hub');
  await rec.shot('vault-hub-empty', 'Vault Hub signed in, no recent vaults (Team Vaults upgrade card)');
  for (const name of VAULTS) {
    if (name === VAULTS[0]) await createVaultShowing(d, env.paths[name], { onDialog: () => rec.shot('create-vault-dialog', 'Create vault dialog, passwords typed') });
    else await ctx.flows.createVault(d, env.paths[name], VAULT_PASSWORD);
    if (name === STARTUP_VAULT) env.ids = await fillAcme(d, { siteUrl: env.siteUrl });
    await ctx.flows.lockVault(d);
  }
  await showFingerprintFor(d, env.paths[STARTUP_VAULT]);
  await sleep(1_200);
  await rec.shot('vault-hub-recent-vaults', 'Vault Hub with four recent vaults, CloudWise with the fingerprint (no Startup badge yet)');
  await clickSelector(d, `button[title="${env.paths[STARTUP_VAULT]}"]`);
  await waitForText(d, 'Unlock Vault');
  await rec.shot('unlock-dialog', 'Unlock Vault dialog');
  await typeInto(d, PASSWORD_INPUT, VAULT_PASSWORD);
  await setCheckbox(d, CHECKBOX_TEXT, true, { scope: `${DIALOG} form` });
  await rec.shot('unlock-dialog-auto-unlock-checked', 'Unlock Vault dialog, password typed, "Unlock automatically at startup" checked');
  await clickSelector(d, `${DIALOG} form button[type=submit]`);
  await waitForText(d, `Unlock ${STARTUP_VAULT} automatically?`, { timeoutMs: 60_000 });
  await rec.shot('auto-unlock-warning', 'Automatic unlock warning after the unlock');
  await clickText(d, 'Turn On', { exact: true, selector: `${DIALOG} button` });
  await ctx.flows.waitForUnlockOutcome(d);
  await ctx.flows.waitForScreen(d, 'main');
}

async function sidebar(ctx, d, rec, env) {
  const header = async () => ({ ...(await regions(d)).header, zoom: 2 });
  const footer = async () => ({ ...(await regions(d)).footer, zoom: 2 });
  await setSidebar(d, 'floating');
  await expandFolders(d);
  await selectEntry(d, env.ids.web);
  await waitFor(() => exists(d, '[data-cv-auto-unlock-indicator]'), { timeoutMs: 10_000, label: 'automatic unlock indicator' });
  await rec.shot('sidebar-floating', 'Home dashboard with the side bar floating: header, tree, footer');
  await rec.shot('zoom-sidebar-header-floating', 'Zoom 2x: floating side bar header (close, pin, vault name, open-lock indicator, chevron, star, +, new folder, search)', { crop: header });
  await setSidebar(d, 'docked');
  await rec.shot('sidebar-docked', 'Home dashboard with the side bar docked');
  await rec.shot('zoom-sidebar-header-docked', 'Zoom 2x: docked side bar header with the open-lock indicator', { crop: header });
  await rec.shot('zoom-sidebar-footer', 'Zoom 2x: side bar footer, signed in', { crop: footer });
  await clickSelector(d, '[data-cv-vault-switcher]');
  await waitForText(d, 'Lock Current Vault');
  await rec.shot('vault-switcher-menu', 'Vault switcher menu open (recent vaults, automatic unlock indicator)');
  await pressKey(d, 'Escape');
  if ((await ctx.ui.bodyText(d)).includes('Lock Current Vault')) await clickSelector(d, '[data-cv-vault-switcher]');
  await typeInto(d, '[data-sidebar-panel] input[placeholder="Search entries..."]', 'web');
  await waitFor(async () => !(await ctx.ui.bodyText(d)).includes('db-01'), { timeoutMs: 10_000, label: 'search filters the tree' });
  await rec.shot('sidebar-search', 'Side bar search "web" active');
  await clickSelector(d, '[data-sidebar-panel] button[title="Clear search"]');
  await clickSelector(d, '[data-sidebar-panel] button[title="Show favorites only"]');
  await waitForText(d, '2 favorites');
  await rec.shot('sidebar-favorites', 'Side bar favorites only');
  await clickSelector(d, '[data-sidebar-panel] button[title="Show all entries"]');
}

async function panes(ctx, d, rec, env) {
  const tabbars = async () => ({ ...(await regions(d)).tabbars, zoom: 1.5 });
  await openReferenceSessions(d, env.ids);
  await selectEntry(d, env.ids.web);
  await focusPane(d, 'right');
  await rec.shot('split-panes-sidebar-docked', 'Two panes (Terminal, Runbook, web-01 | Intranet Status), side bar docked');
  await rec.shot('zoom-tabbars', 'Zoom 1.5x: both pane tab bars', { crop: tabbars });
  await setSidebar(d, 'hidden');
  await rec.shot('split-panes-sidebar-hidden', 'Two panes, side bar hidden');
  await rec.shot('zoom-tabbars-sidebar-hidden', 'Zoom 1.5x: both tab bars, side bar hidden', { crop: tabbars });
  await setSidebar(d, 'docked');
  await clickSelector(d, 'button[title="Toggle AI Panel"]');
  await waitFor(() => exists(d, 'button[title="New conversation"]'), { timeoutMs: 20_000, label: 'AI panel open' });
  await sleep(1_500);
  await rec.shot('ai-panel', 'AI panel open beside the panes');
  await clickSelector(d, 'button[title="Switch engine for this session"]');
  await waitForText(d, 'GitHub Copilot');
  await rec.shot('ai-engine-menu', 'AI panel engine menu open');
  await clickSelector(d, 'button[title="Switch engine for this session"]');
  await clickSelector(d, 'button[title="Toggle AI Panel"]');
}

async function documentTab(ctx, d, rec, env) {
  await closeAllSessions(d);
  await openEntry(d, env.ids.runbook);
  await selectEntry(d, env.ids.runbook);
  await waitForText(d, 'words');
  await rec.shot('document-runbook', 'Document tab (Runbook), no other session open');
}

async function menus(ctx, d, rec, env) {
  const popup = () => childWindowRegion(d, 'menu');
  await openMenu(d, () => clickSelector(d, '[data-tabbar] button[title="New Local Shell"]', { index: 1 }));
  await rec.shot('menu-plus-popup', 'Tab bar + popup menu');
  await rec.shot('zoom-menu-plus-popup', 'Zoom: + popup menu', { crop: popup });
  await closeMenus(d);
  await openMenu(d, () => rightClick(d, '[data-tabbar]', 'Terminal'));
  await rec.shot('menu-tab', 'Right-click menu on a tab');
  await closeMenus(d);
  await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'web-01', { x: TREE_MENU_X }));
  await rec.shot('menu-tree-entry', 'Right-click menu on a tree entry (web-01)');
  await rec.shot('zoom-menu-tree-entry', 'Zoom: tree entry menu', { crop: popup });
  await hoverMenuItem(d, 'Open With');
  await rec.shot('menu-open-with-submenu', 'Tree entry menu, Open With submenu');
  await hoverMenuItem(d, 'Auto-type');
  await rec.shot('menu-autotype-submenu', 'Tree entry menu, Auto-type submenu');
  await closeMenus(d);
  await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'Production', { x: TREE_MENU_X }));
  await rec.shot('menu-tree-folder', 'Right-click menu on a tree folder (Production)');
  await closeMenus(d);
}

async function dialogs(ctx, d, rec, env) {
  await dispatchDocumentEvent(d, 'conduit:new-entry');
  await waitForText(d, 'New Entry');
  await rec.shot('dialog-new-entry', 'New Entry dialog (type picker)');
  await clickInTopDialog(d, 'SSH');
  await waitForText(d, 'New SSH Entry');
  await rec.shot('dialog-new-ssh-entry', 'New SSH Entry form');
  await cancelTopDialog(d);
  await waitForDialogs(d, 0);
  await dispatchDocumentEvent(d, 'conduit:edit-entry', env.ids.dc);
  await waitForText(d, 'Edit RDP Entry');
  for (const tab of ['General', 'Credentials', 'Information', 'Display', 'Resources', 'Security']) {
    await clickInTopDialog(d, tab);
    await rec.shot(`dialog-edit-rdp-${tab.toLowerCase()}`, `Edit RDP Entry (DC-01), ${tab} tab`);
  }
  await cancelTopDialog(d);
  await waitForDialogs(d, 0);
  await dispatchDocumentEvent(d, 'conduit:new-folder');
  await waitForText(d, 'Folder Name');
  await rec.shot('dialog-new-folder', 'New Folder dialog');
  await cancelTopDialog(d);
  await waitForDialogs(d, 0);
  await dispatchDocumentEvent(d, 'conduit:quick-connect');
  await waitForText(d, 'Stored Credential');
  await rec.shot('dialog-quick-connect', 'Quick Connect dialog');
  await cancelTopDialog(d);
  await waitForDialogs(d, 0);
  await selectEntry(d, env.ids.db);
  await dispatchDocumentEvent(d, 'conduit:delete-selected');
  await waitForText(d, 'Are you sure you want to delete');
  await rec.shot('dialog-confirm-delete', 'Delete confirm dialog (db-01)');
  await cancelTopDialog(d);
  await waitForDialogs(d, 0);
}

async function settings(ctx, d, rec) {
  await quickUnlockShown(d, true);
  try {
    await settingsTabs(d, rec);
  } finally {
    await quickUnlockShown(d, false);
  }
}

async function settingsTabs(d, rec) {
  await openSettings(d, 'general');
  for (const [label, suffix, parts] of SETTINGS_TABS) {
    if (label === 'Sessions') await switchSettingsTab(d, 'Sessions');
    await switchSettingsTab(d, label === 'Sessions' ? 'Terminal' : label);
    await sleep(300);
    await scrollSettings(d, 'top');
    await rec.shot(`settings-${suffix}`, `Settings > ${label === 'Sessions' ? 'Sessions > Terminal' : label}`);
    for (const extra of parts.slice(1)) {
      if (extra.endsWith('-navscrolled')) {
        await scrollSettings(d, 'bottom', { target: 'nav' });
        await rec.shot(`settings-${suffix}-nav-scrolled`, `Settings > ${label}, left nav scrolled to the bottom`);
        await scrollSettings(d, 'top', { target: 'nav' });
        continue;
      }
      const middle = extra.endsWith('-part2') && parts.length > 2;
      await scrollSettings(d, middle ? 'middle' : 'bottom');
      await rec.shot(`settings-${suffix}-${middle ? 'middle' : 'bottom'}`, `Settings > ${label}, scrolled to the ${middle ? 'middle' : 'bottom'}`);
    }
  }
  await cancelSettings(d);
}

async function autoUnlockSettings(ctx, d, rec) {
  await openSettings(d, 'general');
  await waitForText(d, 'Unlocks automatically on this computer');
  await selectOption(d, 'select[aria-label="Open at startup"]', 'hub');
  await waitForText(d, 'Turn off automatic unlock?');
  await rec.shot('confirm-change-startup', '"Turn off automatic unlock?" confirm over Settings > General');
  await cancelTopDialog(d);
  await switchSettingsTab(d, 'Security');
  await waitForText(d, 'Automatic Unlock');
  const toggle = 'button[role=switch][aria-label="Unlock automatically at startup"]';
  await clickSelector(d, toggle);
  await waitForText(d, `Open ${STARTUP_VAULT} without the master password`);
  await rec.shot('settings-security-auto-unlock-off', 'Settings > Security, Automatic Unlock switched off');
  await clickSelector(d, toggle);
  await waitForText(d, 'Enter your master password to turn this on.');
  await rec.shot('settings-security-auto-unlock-warning', 'Settings > Security, automatic unlock warning with password field');
  await typeInto(d, `[data-cv-auto-unlock-warning] ${PASSWORD_INPUT}`, VAULT_PASSWORD);
  await clickText(d, 'Turn On', { exact: true, selector: '[data-cv-auto-unlock-warning] button' });
  await waitFor(async () => !(await exists(d, '[data-cv-auto-unlock-warning]')), { timeoutMs: 15_000, label: 'warning closed' });
  await cancelSettings(d);
}

async function syncPanels(ctx, d, rec) {
  await openSettings(d, 'sync');
  await clickInTopDialog(d, 'Recently deleted');
  await waitForText(d, 'Show items deleted more than 30 days ago');
  await rec.shot('sync-recently-deleted', 'Sync > Recently deleted panel');
  await clickInTopDialog(d, 'Done');
  await waitForDialogs(d, 1);
  await clickInTopDialog(d, 'Other copies');
  await waitForText(d, 'Scan again', { timeoutMs: 30_000 });
  await rec.shot('sync-other-copies', 'Sync > Other copies panel');
  await clickInTopDialog(d, 'Done');
  await waitForDialogs(d, 1);
  await clickInTopDialog(d, 'Review changes');
  await waitFor(() => exists(d, '[role=dialog][aria-label="Review changes"]'), { timeoutMs: 15_000, label: 'review panel' });
  await rec.shot('sync-review-changes', 'Sync > Review changes panel');
  await clickSelector(d, '[role=dialog][aria-label="Review changes"] button[aria-label="Close"]');
  await waitFor(async () => !(await exists(d, '[role=dialog][aria-label="Review changes"]')), { timeoutMs: 10_000, label: 'review panel closed' });
  if (await exists(d, '[data-cv-settings], [data-dialog-content]')) await cancelSettings(d).catch(() => {});
}

async function toasts(ctx, d, rec) {
  await showReferenceToasts(d);
  await rec.shot('toasts', 'Four toasts (success, info, warning with action, error)', { overlays: ['overlay'] });
  await rec.shot('zoom-toasts', 'Zoom: the four toasts', { overlays: ['overlay'], crop: () => childWindowRegion(d, 'overlay', { padX: 100, padY: 0 }) });
  await clearToasts(d);
}

async function fallbackPrompt(d, fallback, openError) {
  await withTimeout(d.page.evaluate(async ({ fallback: f, openError: e }) => {
    const { useStartupVaultStore } = await import('/src/stores/startupVaultStore.ts');
    const { useSyncStore } = await import('/src/stores/syncStore.ts');
    useStartupVaultStore.getState().setFallback(f);
    if (e) useSyncStore.getState().setOpenError(e);
    document.dispatchEvent(new CustomEvent('conduit:unlock-vault'));
  }, { fallback, openError }), 15_000, `${d.name}: fallback prompt`);
}

async function hubAfterLock(ctx, d, rec, env) {
  const vault = env.paths[STARTUP_VAULT];
  await closeAllSessions(d);
  await ctx.flows.lockVault(d);
  await waitForText(d, 'Startup');
  await sleep(1_200);
  await rec.shot('vault-hub-startup', 'Vault Hub after lock: CloudWise with Startup badge, open lock and fingerprint, three more vaults with long paths');
  await rec.shot('zoom-vault-hub-recent-vaults', 'Zoom 2x: Recent Vaults list (folder tiles, names, paths, badges)', {
    crop: async () => padded(await recentVaultsRegion(d, vault), 2),
  });
  await clickText(d, 'Clear All', { exact: true, selector: 'button' });
  await waitForText(d, 'Clear recent vaults?');
  await rec.shot('confirm-clear-recent', '"Clear recent vaults?" confirm');
  await cancelTopDialog(d);
  await clickSelector(d, `button[title="${vault}"]`);
  await waitForText(d, 'Automatic unlock runs when Conduit starts.');
  await rec.shot('unlock-after-lock', 'Unlock dialog after a lock ("Automatic unlock runs when Conduit starts.")');
  await cancelTopDialog(d);
  const prompts = [
    ['unlock-stale', 'Unlock dialog, stale saved unlock', { kind: 'stale', name: STARTUP_VAULT }, null, "couldn't open"],
    ['unlock-unreadable', 'Unlock dialog, unreadable saved unlock', { kind: 'unreadable', name: STARTUP_VAULT }, null, "couldn't read the saved unlock"],
    ['unlock-password-changed', 'Master password changed on another device', { kind: 'saved', name: STARTUP_VAULT }, {
      code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE', changedByDeviceName: 'MacBook Air', changedMs: Date.now() - 3_600_000, needsPreviousPassword: true, deleteBiometric: false,
    }, 'Master password changed'],
  ];
  for (const [name, what, fallback, openError, text] of prompts) {
    await fallbackPrompt(d, fallback, openError);
    await waitForText(d, text);
    await rec.shot(name, what);
    await cancelTopDialog(d);
  }
  await withTimeout(d.page.evaluate(async (name) => {
    const { useStartupVaultStore } = await import('/src/stores/startupVaultStore.ts');
    useStartupVaultStore.getState().setOpening({ text: `Opening ${name}...`, cancellable: true });
  }, STARTUP_VAULT), 15_000, `${d.name}: opening screen`);
  await waitForText(d, 'Go to Vault Hub');
  await rec.shot('startup-opening', 'Startup "Opening CloudWise..." screen');
  await withTimeout(d.page.evaluate(async () => {
    const { useStartupVaultStore } = await import('/src/stores/startupVaultStore.ts');
    useStartupVaultStore.getState().setOpening(null);
  }), 15_000, `${d.name}: close opening screen`);
}

const SECTIONS = Object.freeze([
  ['hub and unlock', hubAndUnlock],
  ['side bar', sidebar],
  ['panes, tab bars and AI panel', panes],
  ['popup menus', menus],
  ['entry dialogs', dialogs],
  ['settings', settings],
  ['automatic unlock settings', autoUnlockSettings],
  ['sync panels', syncPanels],
  ['toasts', toasts],
  ['document tab', documentTab],
  ['hub after lock', hubAfterLock],
]);

async function recover(d) {
  await closeMenus(d).catch(() => {});
  for (let i = 0; i < 3; i++) await pressKey(d, 'Escape').catch(() => {});
}

/** One device in `mode`, every section in order. Returns {shots, failures}. */
export async function captureMode(ctx, { mode, outDir, siteUrl }) {
  const user = await ctx.createUser('pro');
  const d = await launchInMode(ctx, 'sp', mode, { settings: { theme: mode } });
  const dir = path.join(vaultDir(d), ...ICLOUD_DIRS);
  fs.mkdirSync(dir, { recursive: true });
  const env = { user, siteUrl, ids: null, paths: Object.fromEntries(VAULTS.map((n) => [n, path.join(dir, `${n}.conduit`)])) };
  const rec = recorder(d, mode, outDir);
  const failures = [];
  for (const [label, run] of SECTIONS) {
    try {
      await run(ctx, d, rec, env);
    } catch (err) {
      failures.push(`${mode} ${label}: ${err.message.split('\n')[0]}`);
      console.log(`[spacing] ${mode} ${label} failed: ${err.message}`);
      if (label === 'hub and unlock') break;
      await recover(d);
    }
  }
  await ctx.quitDevice(d);
  return { shots: rec.shots, failures };
}
