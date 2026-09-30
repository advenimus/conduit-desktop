#!/usr/bin/env node
// One-off app run for the NAV package of docs/DASHBOARD.md: the pinned Home tab and the ways back to
// it. One local-mode device in dark mode, no Supabase user. Writes .verify/dashboard/nav/<nn>-<name>.png
// and INDEX.md with the checks it made. Usage: node scripts/verify/capture-dashboard-nav.mjs

import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { ACME, VAULT_PASSWORD, createAcme, startTestSite, openEntry, openHome, openTerminal, setSidebar, sidebarMode, vaultPath, withStores } from './lib/restyle-data.mjs';
import { launchInMode, regions } from './lib/restyle-flows.mjs';
import { captureWindow, cropCapture } from './lib/window-capture.mjs';
import { dispatchDocumentEvent, mainEval, sleep, waitFor, withTimeout } from './lib/ui.mjs';

const OUT_DIR = path.join(VERIFY_DIR, 'dashboard', 'nav');
const SETTLE_MS = 400;
const HOME = '__home__';

function recorder() {
  let seq = 0;
  const shots = [];
  const checks = [];
  const rec = {
    device: null,
    shots,
    checks,
    async shot(name, what, { crop } = {}) {
      seq += 1;
      const file = `${String(seq).padStart(2, '0')}-${name}.png`;
      const out = path.join(OUT_DIR, file);
      await sleep(SETTLE_MS);
      const full = crop ? `${out}.full.png` : out;
      const capture = await captureWindow(rec.device, full, { method: 'page' });
      if (crop) {
        await cropCapture(capture, await crop(), out, { zoom: 1.5 });
        fs.rmSync(full, { force: true });
      }
      shots.push({ file, what });
      console.log(`[nav] saved ${file}`);
    },
    check(what, ok, detail) {
      checks.push({ what, ok: Boolean(ok), detail: JSON.stringify(detail) });
      console.log(`[nav] ${ok ? 'ok  ' : 'FAIL'} ${what} ${JSON.stringify(detail)}`);
    },
  };
  return rec;
}

/** Tabs, panes and the active tab as the renderer sees them. */
function layoutState(d) {
  return withTimeout(d.page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-tabbar]')].map((bar) =>
      [...bar.querySelectorAll('[data-cv-tab]')].map((t) => ({
        id: t.dataset.cvTab,
        home: t.hasAttribute('data-cv-home-tab'),
        close: t.querySelector('.cv-tab-close') !== null,
        draggable: t.getAttribute('draggable'),
        title: t.getAttribute('title'),
        active: t.hasAttribute('data-active'),
      })));
    const homeViews = [...document.querySelectorAll('[data-cv-session-area]')].map((a) =>
      [...a.querySelectorAll('h1')].some((h) => h.getClientRects().length > 0 && (h.textContent ?? '').startsWith('Welcome back')));
    return { panes, homeViews };
  }), 10_000, `${d.name}: read tabs`);
}

const activeSession = (d) => withStores(d, (_, s) => s.session.getState().activeSessionId, null, { label: 'active session' });
const sessionIds = (d) => withStores(d, (_, s) => s.session.getState().sessions.map((x) => x.id), null, { label: 'session ids' });

function activate(d, id) {
  return withStores(d, (sid, s) => {
    const layout = s.layout.getState();
    const leaves = [];
    const walk = (n) => (n.type === 'leaf' ? leaves.push(n) : n.children.forEach(walk));
    walk(layout.root);
    const pane = leaves.find((l) => l.sessionIds.includes(sid));
    layout.setFocusedPane(pane.id);
    layout.setActiveSessionInPane(pane.id, sid);
    return true;
  }, id, { label: `activate ${id}` });
}

async function pressShortcut(d, key) {
  await withTimeout(d.page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }), 10_000, 'blur');
  await withTimeout(d.page.keyboard.press(key), 10_000, `${d.name}: press ${key}`);
}

async function unlockAfterLock(ctx, d) {
  await ctx.flows.lockVault(d);
  await ctx.flows.openVault(d, vaultPath(d, ACME), VAULT_PASSWORD, { expect: 'unlocked' });
  await ctx.flows.waitForScreen(d, 'main');
}

async function run(ctx, siteUrl, rec) {
  const d = await launchInMode(ctx, 'nav', 'dark', { settings: { theme: 'dark' } });
  rec.device = d;
  const tabbars = async () => (await regions(d)).tabbars;
  try {
    await ctx.flows.enterLocalMode(d);
    const ids = await createAcme(d, { siteUrl });
    await ctx.flows.waitForScreen(d, 'main');
    await setSidebar(d, 'docked');

    let s = await layoutState(d);
    rec.check('after unlock Home is the only tab, first, without a close button, not draggable', s.panes.length === 1 && s.panes[0].length === 1 && s.panes[0][0].home && !s.panes[0][0].close && s.panes[0][0].draggable === 'false', s.panes);
    rec.check('Home tab tooltip names the shortcut', s.panes[0][0]?.title === 'Home (Cmd+Shift+H)', s.panes[0][0]?.title);
    await rec.shot('home-after-unlock', 'After creating and unlocking a vault: Home is the first and only tab, no close button');
    await rec.shot('zoom-tabbar-home-only', 'Zoom 1.5x: tab bar with the Home tab alone', { crop: tabbars });

    const terminal = await openTerminal(d);
    const site = await openEntry(d, ids.site);
    await sleep(1_500);
    s = await layoutState(d);
    rec.check('two sessions open after Home, Home stays first', s.panes[0].map((t) => t.id)[0] === HOME && s.panes[0].length === 3, s.panes);
    await rec.shot('two-sessions-open', 'Terminal and Intranet Status open; the web tab is active');
    await rec.shot('zoom-tabbar-with-sessions', 'Zoom 1.5x: Home tab (house, no dot, no close) beside session tabs', { crop: tabbars });

    await pressShortcut(d, 'Meta+Shift+KeyH');
    await waitFor(async () => (await activeSession(d)) === HOME, { timeoutMs: 5_000, label: 'Home active after Cmd+Shift+H' }).catch(() => null);
    rec.check('Cmd+Shift+H makes Home the active tab', (await activeSession(d)) === HOME, await activeSession(d));
    await rec.shot('home-after-shortcut', 'After Cmd+Shift+H from the web session: Home is active');

    const before = await sessionIds(d);
    await pressShortcut(d, 'Meta+KeyW');
    await dispatchDocumentEvent(d, 'conduit:close-tab');
    await sleep(500);
    const after = await sessionIds(d);
    rec.check('Cmd+W (and conduit:close-tab) on Home closes nothing', JSON.stringify(before) === JSON.stringify(after) && (await activeSession(d)) === HOME, { before, after });
    await rec.shot('home-after-close-tab', 'After Cmd+W and conduit:close-tab with Home active: every tab is still there');

    await withStores(d, (_, st) => {
      st.session.getState().closeSession('__home__');
      st.session.getState().removeSession('__home__');
      return true;
    }, null, { label: 'try to close Home' });
    rec.check('closeSession and removeSession leave Home', (await sessionIds(d)).includes(HOME), await sessionIds(d));

    await activate(d, terminal);
    const menu = await mainEval(d, ({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View');
      const items = view?.submenu?.items ?? [];
      const home = items.find((i) => i.label === 'Home');
      home?.click();
      return { labels: items.map((i) => i.label || i.role || i.type), accelerator: home?.accelerator ?? null };
    }, undefined, { label: 'click View > Home' });
    await waitFor(async () => (await activeSession(d)) === HOME, { timeoutMs: 5_000, label: 'Home active after View > Home' }).catch(() => null);
    rec.check('View > Home exists first with CmdOrCtrl+Shift+H and makes Home active', menu.labels[0] === 'Home' && menu.accelerator === 'CmdOrCtrl+Shift+H' && (await activeSession(d)) === HOME, menu);
    await rec.shot('home-after-view-menu', 'After View > Home from the Terminal tab: Home is active');

    await withStores(d, (_, st) => {
      const layout = st.layout.getState();
      layout.splitPane(layout.focusedPaneId, 'horizontal');
      return true;
    }, null, { label: 'split an empty pane' });
    await sleep(800);
    s = await layoutState(d);
    rec.check('an empty second pane shows the Home content', s.panes.length === 2 && s.panes[1].length === 0 && s.homeViews[1] === true, s);
    await rec.shot('empty-second-pane-home', 'Split with an empty second pane: it shows the Home content');

    await activate(d, site);
    await withStores(d, async (folderId) => {
      const { openFolderView } = await import('/src/lib/openDashboard.ts');
      openFolderView(folderId);
      return true;
    }, ids.production, { label: 'open the Production folder view' });
    await sleep(600);
    await rec.shot('zoom-tabbars-folder-tab', 'Zoom 1.5x: tab bars with a folder view tab (folder icon)', { crop: tabbars });

    await activate(d, terminal);
    await setSidebar(d, 'floating');
    await rec.shot('sidebar-floating-before-home', 'Side bar floating open over the Terminal tab, before its Home button');
    await openHome(d);
    await waitFor(async () => (await sidebarMode(d)) === 'none', { timeoutMs: 5_000, label: 'side bar closed' }).catch(() => null);
    const mode = await sidebarMode(d);
    rec.check('the floating side bar closes after its Home button and Home is active', mode === 'none' && (await activeSession(d)) === HOME, { mode, active: await activeSession(d) });
    await rec.shot('sidebar-closed-after-home', 'After the side bar Home button: the floating side bar closed and Home is active');

    await unlockAfterLock(ctx, d);
    await sleep(800);
    s = await layoutState(d);
    rec.check('after lock and unlock Home is back as the only tab in one pane', s.panes.length === 1 && s.panes[0].length === 1 && s.panes[0][0].id === HOME, s.panes);
    await rec.shot('home-after-lock-unlock', 'After lock and unlock: Home is back as the only tab');
  } finally {
    await ctx.quitDevice(d);
  }
}

function writeIndex(rec, failures) {
  const lines = [
    '# NAV: pinned Home tab and navigation',
    '',
    `Captured ${new Date().toISOString().slice(0, 10)} with \`node scripts/verify/capture-dashboard-nav.mjs\` on branch \`advenimus/dashboard-nav\`.`,
    'One local-mode device in dark mode with the "Acme Infrastructure" vault. The Home content is still the old dashboard in this worktree.',
    '',
    '## Checks',
    '',
    '| Result | Check | Seen |',
    '|---|---|---|',
    ...rec.checks.map((c) => `| ${c.ok ? 'ok' : 'FAIL'} | ${c.what} | \`${c.detail.replace(/\|/g, '\\|').slice(0, 300)}\` |`),
    '',
    '## Screenshots',
    '',
    '| File | Shows |',
    '|---|---|',
    ...rec.shots.map((s) => `| \`${s.file}\` | ${s.what} |`),
  ];
  if (failures.length > 0) lines.push('', '## Not captured', '', ...failures.map((f) => `- ${f}`));
  fs.writeFileSync(path.join(OUT_DIR, 'INDEX.md'), `${lines.join('\n')}\n`);
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runCtx = createRunContext();
  installSignalHandlers(runCtx);
  const log = (m) => console.log(`[nav] ${m}`);
  log.file = (name) => runCtx.logPath(name);
  const failures = [];
  const rec = recorder();
  try {
    const mainJs = await buildForRun(runCtx);
    const vite = await startVite(runCtx, await freePort());
    const site = await startTestSite(runCtx);
    const { ctx, close } = scenarioContext({ run: runCtx, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      await run(ctx, site.url, rec);
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message.split('\n')[0]}`);
    log(`run stopped: ${err.stack}`);
  } finally {
    await runCtx.runCleanup();
  }
  writeIndex(rec, failures);
  const failed = rec.checks.filter((c) => !c.ok).length;
  log(`${rec.shots.length} shot(s), ${failed} failed check(s), ${failures.length} failure(s) in ${path.relative(process.cwd(), OUT_DIR)}`);
  return failures.length === 0 && failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[nav] ${err.message}`);
    process.exit(2);
  },
);
