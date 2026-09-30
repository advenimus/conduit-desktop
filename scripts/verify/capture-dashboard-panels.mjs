#!/usr/bin/env node
// One-off screenshot pass for the PANELS package of docs/DASHBOARD.md: the side bar folder menu with
// View Info, the folder view (Check all, Open all confirm, search and sort, row actions) and the entry
// info tab ("Is it up?" and Recent connections). The DATA handlers are not in this branch, so fake
// handlers for reachability_check and the two history channels answer from the main process.
// Local mode, one dark device. Writes .verify/dashboard/panels/<nn>-<name>.png and INDEX.md.
// Usage: node scripts/verify/capture-dashboard-panels.mjs

import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { closeMenus, launchInMode, openMenu } from './lib/restyle-flows.mjs';
import { menuPage } from './lib/inventory.mjs';
import { createVault, enterLocalMode, refreshEntries, waitForScreen } from './lib/flows.mjs';
import { clickInTopDialog, rightClick, setSidebar, TREE_MENU_X, vaultPath, withStores } from './lib/restyle-data.mjs';
import { captureWindow } from './lib/window-capture.mjs';
import { invoke, mainEval, sleep, typeInto, waitFor, waitForText, withTimeout } from './lib/ui.mjs';

const OUT_DIR = path.join(VERIFY_DIR, 'dashboard', 'panels');
const PASSWORD = 'dashboard-panels-pw-1';
const SETTLE_MS = 400;
const MINUTE = 60_000;

const log = (m) => console.log(`[panels] ${m}`);

function recorder(d) {
  let seq = 0;
  const shots = [];
  return {
    shots,
    async shot(name, what) {
      seq += 1;
      const file = `${String(seq).padStart(2, '0')}-${name}.png`;
      await sleep(SETTLE_MS);
      await captureWindow(d, path.join(OUT_DIR, file), { method: 'page' });
      shots.push({ file, what });
      log(`saved ${file}`);
    },
  };
}

async function create(d, fields) {
  const entry = await invoke(d, 'entry_create', fields);
  await sleep(25);
  return entry;
}

/** Production with sub-folders Web (and Web / Edge) and Accounts; seven connection entries, a command, a document and a credential. */
async function fillVault(d) {
  const prod = await invoke(d, 'folder_create', { name: 'Production' });
  const web = await invoke(d, 'folder_create', { name: 'Web', parent_id: prod.id });
  const edge = await invoke(d, 'folder_create', { name: 'Edge', parent_id: web.id });
  const accounts = await invoke(d, 'folder_create', { name: 'Accounts', parent_id: prod.id });
  await invoke(d, 'folder_create', { name: 'Staging' });
  const ids = {
    web01: (await create(d, { name: 'web-01', entry_type: 'ssh', folder_id: prod.id, host: 'web01.example.com', port: 22, username: 'deploy', notes: '# web-01\n\nFront web server. Deploys run from the Deploy command.' })).id,
    web02: (await create(d, { name: 'web-02', entry_type: 'ssh', folder_id: web.id, host: 'web02.example.com', port: 22, username: 'deploy' })).id,
    web03: (await create(d, { name: 'web-03', entry_type: 'ssh', folder_id: web.id, host: 'web03.example.com', port: 2222, username: 'deploy' })).id,
    dc: (await create(d, { name: 'DC01', entry_type: 'rdp', folder_id: prod.id, host: '10.0.0.10', port: 3389 })).id,
    mac: (await create(d, { name: 'Build Mac', entry_type: 'vnc', folder_id: prod.id, host: '10.0.20.7' })).id,
    lb: (await create(d, { name: 'Edge balancer', entry_type: 'web', folder_id: edge.id, host: 'https://lb.example.com:8443/status' })).id,
    intranet: (await create(d, { name: 'Intranet Status', entry_type: 'web', folder_id: web.id, host: 'http://intranet.example.com/' })).id,
    admin: (await create(d, { name: 'Domain Admin', entry_type: 'credential', folder_id: accounts.id, username: 'admin', password: 'Panels-Only-1', credential_type: 'password' })).id,
    deploy: (await create(d, { name: 'Deploy', entry_type: 'command', folder_id: prod.id })).id,
    runbook: (await create(d, { name: 'Runbook', entry_type: 'document', folder_id: prod.id, config: { content: '# Runbook\n' } })).id,
  };
  await refreshEntries(d);
  await waitFor(() => withStores(d, (_, s) => s.entry.getState().entries.length >= 10), { timeoutMs: 15_000, label: 'entries loaded' });
  return { prod: prod.id, ...ids };
}

/** Fake main-process handlers for the three channels the panels read, with fixed statuses per entry. */
function installFakeHandlers(d, ids) {
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * MINUTE).toISOString();
  const statuses = {
    [ids.web01]: { status: 'reachable', host: 'web01.example.com', port: 22, latencyMs: 24 },
    [ids.web02]: { status: 'refused', host: 'web02.example.com', port: 22, latencyMs: null },
    [ids.web03]: { status: 'timeout', host: 'web03.example.com', port: 2222, latencyMs: null },
    [ids.dc]: { status: 'unreachable', host: '10.0.0.10', port: 3389, latencyMs: null },
    [ids.mac]: { status: 'reachable', host: '10.0.20.7', port: 5900, latencyMs: 3 },
    [ids.lb]: { status: 'not_found', host: 'lb.example.com', port: 8443, latencyMs: null },
    [ids.intranet]: { status: 'reachable', host: 'intranet.example.com', port: 80, latencyMs: 61 },
  };
  const recent = [
    { entryId: ids.web01, protocol: 'ssh', lastStartedAt: ago(5), lastEndedAt: null, lastDurationMs: null, lastOutcome: 'open', count: 12 },
    { entryId: ids.dc, protocol: 'rdp', lastStartedAt: ago(60 * 26), lastEndedAt: ago(60 * 25), lastDurationMs: 60 * MINUTE, lastOutcome: 'closed', count: 3 },
    { entryId: ids.intranet, protocol: 'web', lastStartedAt: ago(60 * 2), lastEndedAt: ago(60 * 2 - 9), lastDurationMs: 9 * MINUTE, lastOutcome: 'closed', count: 5 },
    { entryId: ids.web02, protocol: 'ssh', lastStartedAt: ago(60 * 24 * 3), lastEndedAt: null, lastDurationMs: null, lastOutcome: 'failed', count: 1 },
  ];
  const history = [
    { id: 'h1', entryId: ids.web01, protocol: 'ssh', startedAt: ago(5), endedAt: null, durationMs: null, outcome: 'open' },
    { id: 'h2', entryId: ids.web01, protocol: 'ssh', startedAt: ago(60 * 3), endedAt: ago(60 * 2 - 5), durationMs: 65 * MINUTE, outcome: 'closed' },
    { id: 'h3', entryId: ids.web01, protocol: 'ssh', startedAt: ago(60 * 27), endedAt: ago(60 * 27), durationMs: null, outcome: 'failed' },
    { id: 'h4', entryId: ids.web01, protocol: 'ssh', startedAt: ago(60 * 50), endedAt: ago(60 * 50 - 12), durationMs: 12 * MINUTE, outcome: 'dropped' },
    { id: 'h5', entryId: ids.web01, protocol: 'ssh', startedAt: ago(60 * 75), endedAt: null, durationMs: null, outcome: 'interrupted' },
    { id: 'h6', entryId: ids.web01, protocol: 'ssh', startedAt: ago(60 * 100), endedAt: ago(60 * 100 - 0.7), durationMs: 42_000, outcome: 'closed' },
  ];
  return mainEval(d, ({ ipcMain }, fixture) => {
    const channels = ['reachability_check', 'connection_history_recent', 'connection_history_for_entry'];
    for (const c of channels) ipcMain.removeHandler(c);
    ipcMain.handle('reachability_check', async (_e, args) => {
      const known = fixture.statuses[args?.entryId];
      await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 900)));
      const base = known ?? { status: 'not_checkable', host: null, port: null, latencyMs: null };
      return { entryId: args.entryId, ...base, checkedAt: new Date().toISOString() };
    });
    ipcMain.handle('connection_history_recent', (_e, args) => fixture.recent.slice(0, args?.limit ?? 8));
    ipcMain.handle('connection_history_for_entry', (_e, args) => fixture.history.filter((h) => h.entryId === args?.entryId));
    return channels.length;
  }, { statuses, recent, history }, { label: 'install fake dashboard handlers' });
}

function expandProduction(d) {
  return waitFor(() => withTimeout(d.page.evaluate(() => {
    const panel = document.querySelector('[data-sidebar-panel]');
    const ownText = (e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
    if ([...panel.querySelectorAll('span, div')].some((el) => ownText(el) === 'web-01' && el.getClientRects().length > 0)) return true;
    const label = [...panel.querySelectorAll('span, div')].find((el) => ownText(el) === 'Production');
    for (let el = label; el && el !== panel; el = el.parentElement) {
      const toggle = el.querySelector('[data-cv-tree-twistie]');
      if (toggle) {
        toggle.click();
        return false;
      }
    }
    return false;
  }), 10_000, 'expand Production'), { timeoutMs: 10_000, label: 'Production expanded' });
}

/** Clicks popup menu item `label` in the menu window. */
async function clickMenuItem(d, label) {
  const page = menuPage(d);
  if (!page) throw new Error('no popup menu open');
  const box = await withTimeout(page.evaluate((text) => {
    const el = [...document.querySelectorAll('[role=menuitem]')].find((e) => (e.querySelector('.l') ?? e).textContent.trim() === text);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label), 5_000, `find menu item ${label}`);
  if (!box) throw new Error(`no menu item "${label}"`);
  await withTimeout(page.mouse.click(box.x, box.y), 5_000, `click ${label}`);
}

function clickIn(d, selector, label) {
  return waitFor(() => withTimeout(d.page.evaluate(({ selector: s, label: l }) => {
    const button = [...document.querySelectorAll(s)].find((b) => (b.getAttribute('title') ?? b.innerText.trim()) === l && b.getClientRects().length > 0);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, { selector, label }), 10_000, `click ${label}`), { timeoutMs: 15_000, label: `"${label}" in ${selector}` });
}

function rowSelector(entryId) {
  return `[data-cv-folder-row="${entryId}"]`;
}

async function hoverRow(d, entryId) {
  const box = await withTimeout(d.page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, rowSelector(entryId)), 5_000, 'row box');
  if (!box) throw new Error(`no row ${entryId}`);
  await d.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
}

async function setSort(d, value) {
  await withTimeout(d.page.evaluate((v) => {
    const select = document.getElementById('folder-view-sort');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, v);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value), 5_000, `sort by ${value}`);
}

async function screens(ctx, d, rec) {
  await enterLocalMode(d);
  await createVault(d, vaultPath(d, 'Acme'), PASSWORD);
  await waitForScreen(d, 'main');
  const ids = await fillVault(d);
  await installFakeHandlers(d, ids);
  await setSidebar(d, 'docked');
  await expandProduction(d);

  await openMenu(d, () => rightClick(d, '[data-sidebar-panel]', 'Production', { x: TREE_MENU_X }));
  await rec.shot('folder-menu-view-info', 'Side bar folder menu (Production) with View Info first');
  await clickMenuItem(d, 'View Info');
  await closeMenus(d).catch(() => {});
  await waitFor(() => withTimeout(d.page.evaluate(() => !!document.querySelector('[data-cv-folder-list]')), 5_000, 'folder list'), { timeoutMs: 15_000, label: 'folder view open' });
  await sleep(800);
  await rec.shot('folder-view', 'Folder view: header actions, type cards, search, Sort by, recursive list with sub-folder paths and last connected');

  await hoverRow(d, ids.web02);
  await rec.shot('folder-row-hover', 'Folder view: row actions on hover (Check if it is up, Open, View info)');

  await clickIn(d, '[data-cv-folder-view] button', 'Check all');
  await waitForText(d, 'Checking ', { timeoutMs: 5_000 });
  await rec.shot('folder-check-all-running', 'Folder view: Check all running ("Checking {done} of {total}...")');
  await waitForText(d, 'Check all', { timeoutMs: 20_000 });
  await waitFor(async () => !(await ctx.ui.bodyText(d)).includes('Checking '), { timeoutMs: 20_000, label: 'Check all done' });
  await d.page.mouse.move(5, 400);
  await rec.shot('folder-check-all-done', 'Folder view: badges after Check all (Up, Port closed, No answer, Down, Unknown host)');

  await clickIn(d, '[data-cv-folder-view] button', 'Open all');
  await waitForText(d, 'Open 7 connections?');
  await rec.shot('folder-open-all-confirm', 'Open all confirm for 7 connections');
  await clickInTopDialog(d, 'Cancel');
  await sleep(300);

  await setSort(d, 'status');
  await rec.shot('folder-sort-status', 'Folder view sorted by Status');
  await typeInto(d, 'input[placeholder="Search this folder..."]', 'web');
  await rec.shot('folder-search-sorted', 'Folder view: search "web", sorted by Status');
  await setSort(d, 'last-connected');
  await typeInto(d, 'input[placeholder="Search this folder..."]', 'zzz');
  await waitForText(d, 'No entries match your search');
  await rec.shot('folder-no-match', 'Folder view: no match');
  await typeInto(d, 'input[placeholder="Search this folder..."]', '');
  await rec.shot('folder-sort-last-connected', 'Folder view sorted by Last connected');

  await hoverRow(d, ids.web01);
  await clickIn(d, `${rowSelector(ids.web01)} ~ span button`, 'View info');
  await waitForText(d, 'Is it up?');
  await sleep(900);
  await rec.shot('entry-info-before-check', 'Entry info (web-01, with notes): Is it up? not checked, Recent connections');
  await clickIn(d, 'button', 'Check');
  await waitForText(d, 'Checking...', { timeoutMs: 5_000 });
  await rec.shot('entry-info-checking', 'Entry info: Is it up? checking');
  await waitForText(d, 'Check again', { timeoutMs: 10_000 });
  await rec.shot('entry-info-checked', 'Entry info: Is it up? answered, Recent connections with every outcome');

  await withStores(d, async (id, s) => {
    const { openDashboardForEntry } = await import('/src/lib/openDashboard.ts');
    openDashboardForEntry(id);
    return s.session.getState().sessions.length;
  }, ids.dc, { label: 'open DC01 info' });
  await waitForText(d, 'DC01');
  await clickIn(d, 'button', 'Check');
  await waitForText(d, 'Check again', { timeoutMs: 10_000 });
  await rec.shot('entry-info-no-notes', 'Entry info (DC01, no notes): Down, no history yet');
}

function writeIndex(shots, failures) {
  const lines = [
    '# Dashboard PANELS screenshots',
    '',
    `Captured ${new Date().toISOString().slice(0, 10)} with \`node scripts/verify/capture-dashboard-panels.mjs\` on branch \`advenimus/dashboard-panels\`.`,
    'Local mode, dark, one device. reachability_check, connection_history_recent and connection_history_for_entry are fake main-process handlers (the DATA package is not in this branch).',
    '',
    '| File | Shows |',
    '|---|---|',
    ...shots.map((s) => `| \`${s.file}\` | ${s.what} |`),
  ];
  if (failures.length > 0) lines.push('', '## Not captured', '', ...failures.map((f) => `- ${f}`));
  fs.writeFileSync(path.join(OUT_DIR, 'INDEX.md'), `${lines.join('\n')}\n`);
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const step = (m) => log(m);
  step.file = (name) => run.logPath(name);
  const failures = [];
  let shots = [];
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step });
    try {
      const d = await launchInMode(ctx, 'dp', 'dark');
      const rec = recorder(d);
      try {
        await screens(ctx, d, rec);
      } catch (err) {
        failures.push(err.message.split('\n')[0]);
        await captureWindow(d, path.join(OUT_DIR, 'zz-failure.png'), { method: 'page' }).catch(() => {});
      }
      shots = rec.shots;
      await ctx.quitDevice(d);
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message}`);
  } finally {
    await run.runCleanup();
  }
  writeIndex(shots, failures);
  log(`${shots.length} shot(s) in ${path.relative(process.cwd(), OUT_DIR)}, ${failures.length} failure(s)`);
  for (const f of failures) log(`  FAILED ${f}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[panels] ${err.message}`);
    process.exit(2);
  },
);
