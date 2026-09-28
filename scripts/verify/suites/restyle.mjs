// The restyle suite (docs/VISUAL_REDESIGN.md 8.6): rebuilds the reference screens of 3.1 in the
// current app, in dark and light, and for each writes the after shot and its before/after composite,
// compares the inventory of its controls with the reference and runs the geometry rules. Opt-in: run
// it by name (node scripts/verify/run.mjs restyle [--only <scenario>] [--strict] [--before <dir>]).

import { captureAppMenu } from '../lib/inventory.mjs';
import { TAB_MIN_WIDTH, twelveTabsInPage } from '../lib/geometry.mjs';
import { createRestyleSession } from '../lib/restyle-session.mjs';
import { SCENARIOS, SETTINGS_TABS, screen } from '../lib/restyle-screens.mjs';
import {
  childWindowRegion,
  clearToasts,
  closeMenus,
  hoverMenuItem,
  launchInMode,
  openMenu,
  referenceMain,
  regions,
  scrollSettings,
  showReferenceToasts,
} from '../lib/restyle-flows.mjs';
import {
  ACME,
  SCRATCH,
  clickInTopDialog,
  closeAllSessions,
  createVaultShowing,
  fillAcme,
  openEntry,
  openReferenceSessions,
  openHome,
  rightClick,
  selectEntry,
  setSidebar,
  startTestSite,
  vaultDir,
  vaultPath,
  waitForDialogs,
  withStores,
} from '../lib/restyle-data.mjs';
import { openSettings, cancelSettings, switchSettingsTab } from '../lib/settings-flows.mjs';
import { clickText, clickSelector, dispatchDocumentEvent, exists, sleep, typeInto, waitFor, waitForText } from '../lib/ui.mjs';
import { packsScenario, signedInScenario } from '../lib/restyle-scenarios.mjs';

export const MODES = Object.freeze(['dark', 'light']);

let site = null;
/** The run's test page for the web entry, started once. */
async function testSite(ctx) {
  site ??= await startTestSite(ctx.run);
  return site;
}

/** Runs `body(device, mode, rs)` for dark and light, each on its own device, then finish(). */
function perMode(id, prefix, body) {
  return async (ctx) => {
    const rs = createRestyleSession(ctx, id, SCENARIOS[id]);
    for (const mode of MODES) {
      const device = await launchInMode(ctx, prefix, mode);
      await body(ctx, device, mode, rs);
      await ctx.quitDevice(device);
    }
    rs.finish();
  };
}

const inv = (rs, device, mode, name, vaultDirs) => rs.inventory(device, mode, screen(name), { vaultDirs });
const tabbarCrop = (d) => async () => ({ ...(await regions(d)).tabbars, zoom: 1.5 });

async function screensBody(ctx, d, mode, rs) {
  const dirs = [vaultDir(d)];
  await ctx.flows.waitForScreen(d, 'auth');
  await rs.shot(d, mode, '00-auth-screen');
  await inv(rs, d, mode, 'auth-screen', dirs);
  await rs.check(d, mode, 'auth-screen');
  await ctx.flows.enterLocalMode(d);
  await rs.shot(d, mode, '01-vault-hub-empty');
  await inv(rs, d, mode, 'vault-hub-empty', dirs);
  await createVaultShowing(d, vaultPath(d, ACME), { onDialog: () => rs.shot(d, mode, '02-create-vault-dialog') });
  await fillAcme(d, { siteUrl: (await testSite(ctx)).url });
  await ctx.flows.lockVault(d);
  await rs.shot(d, mode, '41-vault-hub-recent-vaults');
  await inv(rs, d, mode, 'vault-hub-with-recent', dirs);
  await clickText(d, ACME, { selector: 'button' });
  await waitForText(d, 'Unlock Vault');
  await rs.shot(d, mode, '42-unlock-vault-dialog');
  await inv(rs, d, mode, 'unlock-dialog', dirs);
  await clickInTopDialog(d, 'Cancel');
  await waitForDialogs(d, 0);
  await createVaultShowing(d, vaultPath(d, SCRATCH));
  await rs.shot(d, mode, '03-main-empty-vault');
  await setSidebar(d, 'docked');
  await rs.shot(d, mode, '03-main-empty-vault-sidebar-pinned');
  await inv(rs, d, mode, 'main-empty-vault-welcome', dirs);
  await inv(rs, d, mode, 'sidebar-empty-vault-just-created', dirs);
  await rs.check(d, mode, 'main-empty-vault');
  await ctx.flows.lockVault(d);
  await inv(rs, d, mode, 'vault-hub-with-recent-2', dirs);
}

async function sidebarBody(ctx, d, mode, rs) {
  const dirs = [vaultDir(d)];
  const { ids } = await referenceMain(d, { siteUrl: (await testSite(ctx)).url, sessions: false, sidebar: 'floating', select: 'staging' });
  await rs.shot(d, mode, '04-sidebar-floating-open');
  await rs.check(d, mode, 'sidebar-floating-dashboard');
  await setSidebar(d, 'hidden');
  await openReferenceSessions(d, ids);
  await setSidebar(d, 'floating');
  await selectEntry(d, ids.web);
  await rs.shot(d, mode, '06-main-split-sidebar-floating');
  await rs.check(d, mode, 'sidebar-floating-split', { webSession: true });
  await setSidebar(d, 'docked');
  await rs.shot(d, mode, '07-main-split-sidebar-pinned');
  await rs.shot(d, mode, '08-zoom-sidebar-header', { crop: async () => ({ ...(await regions(d)).header, zoom: 2 }) });
  await rs.shot(d, mode, '09-zoom-sidebar-footer', { crop: async () => ({ ...(await regions(d)).footer, zoom: 2 }) });
  await inv(rs, d, mode, 'main-sidebar-local-mode', dirs);
  await rs.check(d, mode, 'sidebar-docked', { webSession: true });
  await clickSelector(d, `[data-sidebar-panel] button[title="${vaultPath(d, ACME)}"]`);
  await waitForText(d, 'Lock Current Vault');
  await rs.shot(d, mode, '21-vault-switcher-menu');
  await inv(rs, d, mode, 'vault-switcher-menu-open', dirs);
  await rs.check(d, mode, 'vault-switcher-menu', { webSession: true });
  await closeVaultMenu(ctx, d);
  await typeInto(d, '[data-sidebar-panel] input[placeholder="Search entries..."]', 'web');
  await waitFor(async () => !(await ctx.ui.bodyText(d)).includes('db-01'), { timeoutMs: 10_000, label: 'search filters the tree' });
  await rs.shot(d, mode, '38-sidebar-search-active');
  await inv(rs, d, mode, 'sidebar-search-active', dirs);
  await clickSelector(d, '[data-sidebar-panel] button[title="Clear search"]');
  await clickSelector(d, '[data-sidebar-panel] button[title="Show favorites only"]');
  await waitForText(d, '2 favorites');
  await rs.shot(d, mode, '39-sidebar-favorites-only');
  await inv(rs, d, mode, 'sidebar-favorites-only', dirs);
  await rs.check(d, mode, 'sidebar-favorites', { webSession: true });
  await clickSelector(d, '[data-sidebar-panel] button[title="Show all entries"]');
}

async function closeVaultMenu(ctx, d) {
  const open = async () => (await ctx.ui.bodyText(d)).includes('Lock Current Vault');
  await ctx.ui.pressKey(d, 'Escape');
  if (await open()) await clickSelector(d, `[data-sidebar-panel] button[title="${vaultPath(d, ACME)}"]`);
  await waitFor(async () => !(await open()), { timeoutMs: 10_000, label: `${d.name}: vault menu closed` });
}

async function tabsBody(ctx, d, mode, rs) {
  const dirs = [vaultDir(d)];
  const { ids } = await referenceMain(d, { siteUrl: (await testSite(ctx)).url, sidebar: 'hidden' });
  await rs.shot(d, mode, '05-main-split-sidebar-closed');
  await rs.shot(d, mode, '10b-zoom-tabbars-sidebar-closed', { crop: tabbarCrop(d) });
  await rs.check(d, mode, 'split-sidebar-hidden', { webSession: true });
  await setSidebar(d, 'floating');
  await rs.shot(d, mode, '06-main-split-sidebar-floating');
  await rs.check(d, mode, 'split-sidebar-floating', { webSession: true });
  await setSidebar(d, 'docked');
  await rs.shot(d, mode, '07-main-split-sidebar-pinned');
  await rs.shot(d, mode, '10-zoom-tabbars-split', { crop: tabbarCrop(d) });
  await inv(rs, d, mode, 'web-session-toolbar', dirs);
  await rs.check(d, mode, 'split-sidebar-docked', { webSession: true });
  await clickSelector(d, 'button[title="Toggle AI Panel"]');
  await waitFor(() => exists(d, 'button[title="New conversation"]'), { timeoutMs: 20_000, label: 'AI panel open' });
  await inv(rs, d, mode, 'main-tabbars-split-ai-open', dirs);
  await rs.check(d, mode, 'split-ai-open', { webSession: true });
  await twelveTabs(ctx, d, mode, rs);
  await clickSelector(d, 'button[title="Toggle AI Panel"]');
  await selectEntry(d, ids.db);
  await focusPane(d, 'left');
  await openHome(d);
  await waitForText(d, 'Welcome back');
  await rs.shot(d, mode, '40-home-dashboard-pinned');
  await rs.check(d, mode, 'home-dashboard-tab', { webSession: true });
  await closeAllSessions(d);
  await selectEntry(d, null);
  await waitForText(d, 'Welcome back');
  await inv(rs, d, mode, 'home-dashboard-full-window', dirs);
  await rs.check(d, mode, 'home-dashboard-full-window');
  await openEntry(d, ids.runbook);
  await selectEntry(d, ids.runbook);
  await waitForText(d, 'words');
  await rs.shot(d, mode, '43-document-view-runbook');
  await inv(rs, d, mode, 'document-view-runbook', dirs);
}

/** G10's live part: twelve tabs in the left pane of shot 18's layout, once the tabs carry data-cv-tab. */
async function twelveTabs(ctx, d, mode, rs) {
  if (!(await exists(d, '[data-cv-tab]'))) {
    rs.record(mode, 'twelve-tabs', { rule: 'G10', status: 'pending', detail: 'twelve-tab check: no [data-cv-tab]' });
    return;
  }
  await withStores(d, async (_, s) => {
    const layout = s.layout.getState();
    const first = (n) => (n.type === 'leaf' ? n : first(n.children[0]));
    layout.setFocusedPane(first(layout.root).id);
    for (let i = 0; i < 9; i++) await s.session.getState().createLocalShell();
    return true;
  }, null, { label: 'open nine more shells', timeoutMs: 60_000 });
  await sleep(800);
  const result = await d.page.evaluate(twelveTabsInPage, { minWidth: TAB_MIN_WIDTH });
  rs.record(mode, 'twelve-tabs', { rule: 'G10', ...result });
  await withStores(d, async (_, s) => {
    const shells = s.session.getState().sessions.filter((x) => x.type === 'local_shell' && x.title === 'Terminal').slice(1);
    for (const x of shells) await s.session.getState().closeSession(x.id);
    return true;
  }, null, { label: 'close the extra shells', timeoutMs: 60_000 });
}

async function aiBody(ctx, d, mode, rs) {
  await referenceMain(d, { siteUrl: (await testSite(ctx)).url });
  await clickSelector(d, 'button[title="Toggle AI Panel"]');
  await waitFor(() => exists(d, 'button[title="New conversation"]'), { timeoutMs: 20_000, label: 'AI panel open' });
  await sleep(2_500);
  await rs.shot(d, mode, '18-ai-panel-open');
  await inv(rs, d, mode, 'ai-panel');
  await rs.check(d, mode, 'ai-panel', { webSession: true });
  await clickSelector(d, 'button[title="Switch engine for this session"]');
  await waitForText(d, 'GitHub Copilot');
  await rs.shot(d, mode, '19-ai-panel-engine-menu');
  await inv(rs, d, mode, 'ai-panel-engine-menu-open');
  await rs.check(d, mode, 'ai-engine-menu', { webSession: true });
  await clickSelector(d, 'button[title="Switch engine for this session"]');
}

async function menusBody(ctx, d, mode, rs) {
  await referenceMain(d, { siteUrl: (await testSite(ctx)).url });
  await sleep(1_000);
  const popupCrop = () => childWindowRegion(d, 'menu');
  let items = await openMenu(d, () => clickSelector(d, '[data-tabbar] button[title="New Local Shell"]', { index: 1 }));
  await rs.shot(d, mode, '11-plus-newtab-popup');
  await rs.shot(d, mode, '12-zoom-plus-popup', { crop: popupCrop });
  rs.menu(mode, 'plus-popup', items);
  await rs.check(d, mode, 'plus-popup', { webSession: true });
  await closeMenus(d);
  items = await openMenu(d, () => rightClick(d, '[data-tabbar]', 'Terminal'));
  await rs.shot(d, mode, '13-context-menu-tab');
  rs.menu(mode, 'ctx-tab', items);
  await closeMenus(d);
  rs.menu(mode, 'ctx-tab-ssh-entry', await openMenu(d, () => rightClick(d, '[data-tabbar]', 'web-01')));
  await closeMenus(d);
  items = await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'web-01'));
  await rs.shot(d, mode, '14-context-menu-tree-entry');
  rs.menu(mode, 'ctx-tree-entry-ssh', items);
  rs.menu(mode, 'ctx-submenus', items.filter((i) => i.kind === 'submenu'));
  await hoverMenuItem(d, 'Open With');
  await rs.shot(d, mode, '16-context-menu-open-with-submenu');
  await hoverMenuItem(d, 'Auto-type');
  await rs.shot(d, mode, '17-context-menu-autotype-submenu');
  await closeMenus(d);
  rs.menu(mode, 'ctx-tree-entry-web', await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'Intranet Status')));
  await closeMenus(d);
  rs.menu(mode, 'ctx-tree-entry-credential', await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'Domain Admin')));
  await closeMenus(d);
  items = await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'Production'));
  await rs.shot(d, mode, '15-context-menu-tree-folder');
  rs.menu(mode, 'ctx-tree-folder', items);
  await closeMenus(d);
  rs.menu(mode, 'native-app-menu', await captureAppMenu(d));
}

async function settingsBody(ctx, d, mode, rs) {
  await referenceMain(d, { siteUrl: (await testSite(ctx)).url });
  await openSettings(d, 'general');
  for (const [label, suffix, shots] of SETTINGS_TABS) {
    // Sessions only opens its group; its first page is Terminal.
    if (label === 'Sessions') await switchSettingsTab(d, 'Sessions');
    await switchSettingsTab(d, label === 'Sessions' ? 'Terminal' : label);
    await sleep(400);
    await scrollSettings(d, 'top');
    await rs.shot(d, mode, shots[0]);
    await inv(rs, d, mode, `settings-${suffix}`);
    for (const extra of shots.slice(1)) {
      if (extra.endsWith('-navscrolled')) {
        await scrollSettings(d, 'bottom', { target: 'nav' });
        await rs.shot(d, mode, extra);
        await scrollSettings(d, 'top', { target: 'nav' });
      } else {
        await scrollSettings(d, extra.endsWith('-part2') && shots.length > 2 ? 'middle' : 'bottom');
        await rs.shot(d, mode, extra);
      }
    }
    await rs.check(d, mode, `settings-${suffix}`, { webSession: true });
  }
  await cancelSettings(d);
}

async function dialogsBody(ctx, d, mode, rs) {
  const { ids } = await referenceMain(d, { siteUrl: (await testSite(ctx)).url });
  await dispatchDocumentEvent(d, 'conduit:new-entry');
  await waitForText(d, 'New Entry');
  await rs.shot(d, mode, '22-new-entry-dialog');
  await inv(rs, d, mode, 'new-entry-dialog');
  await rs.check(d, mode, 'new-entry-dialog', { webSession: true });
  await clickInTopDialog(d, 'SSH');
  await waitForText(d, 'New SSH Entry');
  await rs.shot(d, mode, '23-new-entry-ssh-form');
  await inv(rs, d, mode, 'new-entry-ssh-form');
  await clickInTopDialog(d, 'Cancel');
  await waitForDialogs(d, 0);
  await dispatchDocumentEvent(d, 'conduit:edit-entry', ids.dc);
  await waitForText(d, 'Edit RDP Entry');
  const rdpTabs = [['General', '24-edit-entry-dialog-rdp-general', 'general'], ['Credentials', '25-edit-entry-dialog-rdp-credentials', 'credentials'], ['Information', '26-edit-entry-dialog-rdp-information', 'information'], ['Display', '27-edit-entry-dialog-rdp-display', 'display'], ['Resources', '28-edit-entry-dialog-rdp-resources', 'resources'], ['Security', '29-edit-entry-dialog-rdp-security', 'security']];
  for (const [label, shot, suffix] of rdpTabs) {
    await clickInTopDialog(d, label);
    await sleep(350);
    await rs.shot(d, mode, shot);
    await inv(rs, d, mode, `edit-entry-rdp-${suffix}`);
  }
  await clickInTopDialog(d, 'Cancel');
  await waitForDialogs(d, 0);
  await dispatchDocumentEvent(d, 'conduit:new-folder');
  await waitForText(d, 'Folder Name');
  await rs.shot(d, mode, '30-new-folder-dialog');
  await inv(rs, d, mode, 'new-folder-dialog');
  await clickInTopDialog(d, 'Cancel');
  await waitForDialogs(d, 0);
  await dispatchDocumentEvent(d, 'conduit:quick-connect');
  await waitForText(d, 'Stored Credential');
  await rs.shot(d, mode, '31-quick-connect-dialog');
  await inv(rs, d, mode, 'quick-connect-dialog');
  await clickInTopDialog(d, 'Cancel');
  await waitForDialogs(d, 0);
  await deleteConfirm(d, ids.db, async () => {
    await rs.shot(d, mode, '32-confirm-delete-dialog');
    await inv(rs, d, mode, 'confirm-delete-dialog');
    await rs.check(d, mode, 'confirm-delete', { webSession: true });
  });
  await focusPane(d, 'right');
  await deleteConfirm(d, ids.db, async () => {
    await rs.shot(d, mode, '32b-confirm-delete-dialog-BUG-webview-covers-dialog');
    await rs.check(d, mode, 'confirm-delete-web-focused', { webSession: true });
  });
  await syncPanels(ctx, d, mode, rs);
}

async function deleteConfirm(d, entryId, whileOpen) {
  await selectEntry(d, entryId);
  await dispatchDocumentEvent(d, 'conduit:delete-selected');
  await waitForText(d, 'Are you sure you want to delete');
  await whileOpen();
  await clickInTopDialog(d, 'Cancel');
  await waitForDialogs(d, 0);
}

function focusPane(d, side) {
  return withStores(d, (which, s) => {
    const layout = s.layout.getState();
    const edge = (n) => (n.type === 'leaf' ? n : edge(n.children[which === 'left' ? 0 : 1]));
    layout.setFocusedPane(edge(layout.root).id);
    return true;
  }, side, { label: `focus the ${side} pane` });
}

async function syncPanels(ctx, d, mode, rs) {
  await openSettings(d, 'sync');
  await clickInTopDialog(d, 'Recently deleted');
  await waitForText(d, 'Show items deleted more than 30 days ago');
  await sleep(400);
  await rs.shot(d, mode, '33-sync-panel-recently-deleted');
  await inv(rs, d, mode, 'sync-panel-recently-deleted');
  await clickInTopDialog(d, 'Done');
  await waitForDialogs(d, 1);
  await clickInTopDialog(d, 'Other copies');
  await waitForText(d, 'Scan again', { timeoutMs: 30_000 });
  await rs.shot(d, mode, '34-sync-panel-other-copies');
  await inv(rs, d, mode, 'sync-panel-other-copies');
  await clickInTopDialog(d, 'Done');
  await waitForDialogs(d, 1);
  await clickInTopDialog(d, 'Review changes');
  await waitFor(() => exists(d, '[role=dialog][aria-label="Review changes"]'), { timeoutMs: 15_000, label: 'review panel' });
  await sleep(600);
  await rs.shot(d, mode, '35-sync-panel-review-changes');
  await inv(rs, d, mode, 'sync-panel-review-changes');
  await rs.check(d, mode, 'review-changes', { webSession: true });
  await clickSelector(d, '[role=dialog][aria-label="Review changes"] button[aria-label="Close"]');
  await waitFor(async () => !(await exists(d, '[role=dialog][aria-label="Review changes"]')), { timeoutMs: 10_000, label: 'review panel closed' });
  if (await exists(d, '[data-cv-settings], [data-dialog-content]')) await cancelSettings(d).catch(() => {});
}

async function toastsBody(ctx, d, mode, rs) {
  const { ids } = await referenceMain(d, { siteUrl: (await testSite(ctx)).url });
  await selectEntry(d, ids.db);
  await showReferenceToasts(d);
  await rs.shot(d, mode, '36-toasts', { overlays: ['overlay'] });
  await rs.shot(d, mode, '37-zoom-toasts', { overlays: ['overlay'], crop: () => childWindowRegion(d, 'overlay', { padX: 100, padY: 0 }) });
  await rs.check(d, mode, 'toasts', { webSession: true });
  await clearToasts(d);
}

const scenario = (id, title, run, needsSupabase = false) => ({ id, title, needsSupabase, run });

export default {
  id: 'restyle',
  title: 'Layout reference: before and after composites, inventories and geometry rules',
  optIn: true,
  scenarios: [
    scenario('screens', 'Sign-in, vault hub, create and unlock dialogs, the empty vault welcome', perMode('screens', 'rsc', screensBody)),
    scenario('sidebar', 'Side bar floating and docked, header and footer, vault menu, search, favorites', perMode('sidebar', 'rsb', sidebarBody)),
    scenario('sidebar-signed-in', 'Signed-in side bar: account row, sign-out confirm, cached mode, team vault, trial card and strip', signedInScenario({ testSite }), true),
    scenario('tabs', 'Pane tab bars in every side bar mode, the web toolbar, Home dashboard, document tab', perMode('tabs', 'rst', tabsBody)),
    scenario('ai', 'AI panel and its engine menu', perMode('ai', 'rsa', aiBody)),
    scenario('menus', 'Popup menus, submenus and the application menu', perMode('menus', 'rsm', menusBody)),
    scenario('settings', 'Settings, every tab', perMode('settings', 'rse', settingsBody)),
    scenario('dialogs', 'Entry, folder, Quick Connect and delete dialogs, sync panels', perMode('dialogs', 'rsd', dialogsBody)),
    scenario('toasts', 'Four toasts in the overlay window', perMode('toasts', 'rso', toastsBody)),
    scenario('packs', 'Six-pack sheets for owner gate 1 (needs the Icon pack picker)', packsScenario({ testSite })),
  ],
};

