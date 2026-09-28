// The restyle scenarios that need more than one app state per mode: the signed-in side bar (a Free
// user with the trial card, the account row and its sign-out confirm, the Pro trial strip, a team
// vault, cached mode behind a cut Supabase link) and the six-pack sheets of owner gate 1.

import fs from 'node:fs';
import path from 'node:path';
import { currentScreen, signIn, openVault, waitForScreen } from './flows.mjs';
import { createTeamVault } from './team.mjs';
import { openTeamVaultInUi } from './team-flows.mjs';
import { createRestyleSession } from './restyle-session.mjs';
import { SCENARIOS, screen } from './restyle-screens.mjs';
import { writeSheet } from './restyle-reference.mjs';
import { captureWindow, cropCapture } from './window-capture.mjs';
import {
  childWindowRegion,
  clearToasts,
  closeMenus,
  closePicker,
  iconPackAttributes,
  launchInMode,
  menuItemIcon,
  openMenu,
  openPicker,
  pickerGlyphResult,
  pickerIconMarkup,
  referenceMain,
  regions,
  showReferenceToasts,
} from './restyle-flows.mjs';
import { ACME, TREE_MENU_X, VAULT_PASSWORD, clickInTopDialog, createAcme, expandFolders, rightClick, selectEntry, setSidebar, vaultDir, vaultPath } from './restyle-data.mjs';
import { openSettings, saveSettings } from './settings-flows.mjs';
import { clickSelector, clickText, invoke, sleep, waitFor, waitForText, withTimeout } from './ui.mjs';

const MODES = ['dark', 'light'];
const SIDEBAR = '[data-sidebar-panel]';

/** Sets the signed-in user's plan to a 14-day Pro trial, the way billing would. */
function startProTrial(ctx, user) {
  return ctx.sql(
    `update public.user_profiles set tier_id = (select id from public.tiers where name = 'pro'), subscription_status = 'trialing',
       trial_ends_at = now() + interval '14 days', has_used_trial = true where id = :'uid' returning id`,
    { uid: user.id },
  );
}

async function refreshProfile(device) {
  await invoke(device, 'auth_refresh', undefined, { timeoutMs: 30_000 });
  await sleep(800);
}

function reloadTeam(device) {
  return withTimeout(device.page.evaluate(async () => {
    const { useTeamStore } = await import('/src/stores/teamStore.ts');
    await useTeamStore.getState().loadTeam();
    await useTeamStore.getState().loadTeamVaults();
    return true;
  }), 30_000, `${device.name}: reload the team`);
}

async function signedInMode(ctx, mode, rs, { testSite }) {
  const user = await ctx.createUser('free');
  const proxy = await ctx.supabaseProxy();
  const name = `rss-${mode[0]}`;
  let d = await launchInMode(ctx, 'rss', mode, { env: proxy.env });
  const dirs = () => [vaultDir(d)];
  await waitForScreen(d, 'auth');
  await signIn(d, user);
  const ids = await createAcme(d, { siteUrl: (await testSite(ctx)).url });
  await waitForScreen(d, 'main');
  await setSidebar(d, 'docked');
  await expandFolders(d);
  await selectEntry(d, ids.web);

  await waitForText(d, 'Try Pro free for 30 days', { timeoutMs: 20_000 });
  await rs.shot(d, mode, '48-sidebar-trial-card');
  await rs.inventory(d, mode, screen('sidebar-trial-card'), { vaultDirs: dirs() });
  await rs.check(d, mode, 'trial-card');
  await clickSelector(d, `${SIDEBAR} button[title="Dismiss"]`);
  await waitFor(async () => !(await ctx.ui.bodyText(d)).includes('Try Pro free for 30 days'), { timeoutMs: 10_000, label: 'trial card dismissed' });
  await rs.shot(d, mode, '44-sidebar-signed-in');
  await rs.inventory(d, mode, screen('sidebar-signed-in'), { vaultDirs: dirs() });
  await rs.check(d, mode, 'signed-in');
  await clickSelector(d, `${SIDEBAR} button[title="Sign Out"]`);
  await waitForText(d, 'Confirm');
  await rs.shot(d, mode, '45-sidebar-sign-out-confirm');
  await rs.inventory(d, mode, screen('sidebar-sign-out-confirm'), { vaultDirs: dirs() });
  await clickText(d, 'Cancel', { exact: true, selector: `${SIDEBAR} button` });

  await startProTrial(ctx, user);
  await refreshProfile(d);
  await waitForText(d, 'Pro Trial', { timeoutMs: 20_000 });
  await rs.shot(d, mode, '49-sidebar-trial-strip');
  await rs.inventory(d, mode, screen('sidebar-trial-strip'), { vaultDirs: dirs() });
  await rs.check(d, mode, 'trial-strip');

  await ctx.setTier(user.id, 'team');
  const team = await ctx.createTeam(user, { name: 'Acme Team' });
  await refreshProfile(d);
  const vault = await createTeamVault(d, team, 'Acme Team Vault');
  // The app loads the team when the user signs in; this user joined a team after that.
  await reloadTeam(d);
  await openTeamVaultInUi(d, vault);
  await setSidebar(d, 'docked');
  await clickText(d, 'Acme Team Vault', { selector: `${SIDEBAR} button` });
  await waitForText(d, 'Create Team Vault...', { timeoutMs: 20_000 });
  await rs.shot(d, mode, '47-sidebar-team-vault');
  await rs.inventory(d, mode, screen('sidebar-team-vault'), { vaultDirs: dirs() });
  await rs.check(d, mode, 'team-vault');
  await ctx.ui.pressKey(d, 'Escape');

  await ctx.quitDevice(d);
  proxy.cut();
  d = await ctx.launchDevice(name, { env: proxy.env });
  const auth = await waitFor(async () => {
    const s = await invoke(d, 'auth_get_state', undefined, { timeoutMs: 10_000 });
    return s?.authMode ? s : null;
  }, { timeoutMs: 60_000, label: `${name}: auth state after the offline relaunch` });
  if (auth.authMode !== 'cached') throw new Error(`${name}: relaunched offline in ${auth.authMode} mode, not cached`);
  const res = await openVault(d, vaultPath(d, ACME), VAULT_PASSWORD);
  if (res.outcome !== 'unlocked') throw new Error(`${name}: the Acme vault did not open offline (${res.outcome})`);
  await setSidebar(d, 'docked');
  await expandFolders(d);
  await selectEntry(d, ids.web);
  await waitForText(d, 'offline');
  await rs.shot(d, mode, '46-sidebar-cached-offline');
  await rs.inventory(d, mode, screen('sidebar-cached-offline'), { vaultDirs: dirs() });
  await rs.check(d, mode, 'cached-offline');
  await ctx.quitDevice(d);
  proxy.restore();
}

/** Scenario sidebar-signed-in (shots 44 to 49). */
export function signedInScenario(deps) {
  return async (ctx) => {
    const rs = createRestyleSession(ctx, 'sidebar-signed-in', SCENARIOS['sidebar-signed-in']);
    for (const mode of MODES) await signedInMode(ctx, mode, rs, deps);
    rs.finish();
  };
}

// ---------- packs (owner gate 1) ----------

const PICKER_ROWS = ['appearance', 'sidebar', 'tabbars', 'menu', 'toast', 'picker'];

async function packCards(device) {
  return withTimeout(device.page.evaluate(() => [...document.querySelectorAll('[data-cv-appearance="icon-pack"] [data-cv-choice]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.getAttribute('data-cv-choice'))), 10_000, `${device.name}: icon pack cards`);
}

async function capturePackRow(device, dir, pack, rs, mode) {
  const shots = {};
  const file = (row) => path.join(dir, `${mode}-${pack}-${row}.png`);
  shots.appearance = (await captureWindow(device, file('appearance'))).file;
  await saveSettings(device);
  await waitFor(async () => (await iconPackAttributes(device)).main === pack, { timeoutMs: 15_000, label: `${device.name}: main window on ${pack}` });
  const full = await captureWindow(device, file('full'));
  const r = await regions(device);
  shots.sidebar = await cropCapture(full, { ...r.panel, x: r.panel.x, y: 0, height: Math.min(r.panel.height + r.panel.y, 420) }, file('sidebar'));
  shots.tabbars = await cropCapture(full, r.tabbars, file('tabbars'));
  await openMenu(device, () => rightClick(device, SIDEBAR, 'web-01', { x: TREE_MENU_X }));
  const editIcon = await menuItemIcon(device, 'Edit');
  const withMenu = await captureWindow(device, file('menu-full'));
  shots.menu = await cropCapture(withMenu, await childWindowRegion(device, 'menu', { zoom: 1 }), file('menu'));
  await closeMenus(device);
  await showReferenceToasts(device);
  const withToasts = await captureWindow(device, file('toast-full'), { overlays: ['overlay'] });
  shots.toast = await cropCapture(withToasts, await childWindowRegion(device, 'overlay', { padX: 0, padY: 0, zoom: 1 }), file('toast'));
  const overlayPack = (await iconPackAttributes(device)).overlay;
  await clearToasts(device);
  await openPicker(device);
  const withPicker = await captureWindow(device, file('picker-full'), { overlays: ['picker'] });
  shots.picker = await cropCapture(withPicker, await childWindowRegion(device, 'picker', { padX: 0, padY: 0, zoom: 1 }), file('picker'));
  const pickerPack = (await iconPackAttributes(device)).picker;
  const pickerIcons = await pickerIconMarkup(device);
  await closePicker(device);
  for (const f of ['full', 'menu-full', 'toast-full', 'picker-full']) fs.rmSync(file(f), { force: true });
  const ok = overlayPack === pack && pickerPack === pack && Boolean(editIcon);
  rs.record(mode, `pack ${pack}`, { rule: 'packs', status: ok ? 'pass' : 'fail', detail: `main ${pack}, overlay ${overlayPack}, picker ${pickerPack}, menu Edit icon ${editIcon ? 'present' : 'missing'}` });
  return { shots, editIcon, pickerIcons };
}

async function packsMode(ctx, mode, rs, { testSite }) {
  const d = await launchInMode(ctx, 'rsp', mode);
  await referenceMain(d, { siteUrl: (await testSite(ctx)).url });
  await openSettings(d, 'appearance');
  const packs = await packCards(d);
  if (packs.length === 0) {
    rs.record(mode, 'packs', { rule: 'packs', status: 'pending', detail: 'Settings > Appearance has no [data-cv-appearance="icon-pack"] cards yet' });
    await clickInTopDialog(d, 'Cancel');
    await ctx.quitDevice(d);
    return;
  }
  const dir = path.join(ctx.run.runDir, 'restyle', 'packs');
  fs.mkdirSync(dir, { recursive: true });
  const columns = [];
  for (const pack of packs) {
    await openSettings(d, 'appearance').catch(() => {});
    await clickSelector(d, `[data-cv-appearance="icon-pack"] [data-cv-choice="${pack}"]`);
    await sleep(700);
    columns.push({ pack, ...(await capturePackRow(d, dir, pack, rs, mode)) });
  }
  const icons = new Set(columns.map((c) => c.editIcon));
  rs.record(mode, 'menu icons', { rule: 'packs', status: icons.size === columns.length ? 'pass' : 'fail', detail: `${icons.size} distinct Edit icons for ${columns.length} packs` });
  rs.record(mode, 'picker icons', pickerGlyphResult(columns.map((c) => c.pickerIcons)));
  const rows = PICKER_ROWS.map((row) => columns.map((c) => ({ file: c.shots[row], label: `${c.pack} ${row}` })));
  const sheet = await writeSheet(rows, path.join(dir, `${mode}-packs.png`), { title: `Icon packs, ${mode}: ${packs.join(', ')}` });
  ctx.step(`packs sheet ${path.relative(ctx.run.runDir, sheet)}`);
  const saved = packs[packs.length - 1];
  await ctx.quitDevice(d);
  const again = await launchInMode(ctx, 'rsp', mode);
  // Any rendered screen will do: the pack applies at boot, and a local-mode relaunch can land on the
  // hub or, through a known startup race, on sign-in. A relaunch that renders nothing throws here.
  const landed = await waitFor(async () => {
    const s = await currentScreen(again);
    return s === 'loading' ? null : s;
  }, { timeoutMs: 60_000, label: `${again.name}: a screen after the restart` });
  // A pack other than Lucide loads lazily after the first render.
  const after = await waitFor(async () => {
    const a = await iconPackAttributes(again);
    return a.main === saved ? a : null;
  }, { timeoutMs: 20_000, label: `${again.name}: ${saved} after the restart` }).catch(() => iconPackAttributes(again));
  rs.record(mode, 'pack after restart', { rule: 'packs', status: after.main === saved ? 'pass' : 'fail', detail: `saved ${saved}, after restart ${after.main} (${landed} screen)` });
  await ctx.quitDevice(again);
}

/** Scenario packs: the six-pack sheets of owner gate 1, pending until the Icon pack picker exists. */
export function packsScenario(deps) {
  return async (ctx) => {
    const rs = createRestyleSession(ctx, 'packs', SCENARIOS.packs);
    for (const mode of MODES) await packsMode(ctx, mode, rs, deps);
    rs.finish();
  };
}
