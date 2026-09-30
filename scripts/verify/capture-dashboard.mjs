#!/usr/bin/env node
// One-off app run for the merged Home dashboard (docs/DASHBOARD.md 11.2): the real dashboard IPC, no
// fake handlers. One local-mode device per mode: a vault with folders, favorites, an SSH entry on a
// closed local port, web entries on the harness test page and passwords backdated in the vault file.
// Real sessions are opened and closed so the connection history is real. Writes
// .verify/dashboard/final/<mode>-<nn>-<name>.png and INDEX.md with the checks it made.
// Usage: node scripts/verify/capture-dashboard.mjs [--mode dark|light]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { clearConnectionHistory, clickInTopDialog, closeAllSessions, openTerminal, setSidebar, startTestSite, vaultPath, withStores } from './lib/restyle-data.mjs';
import { captureInventory } from './lib/inventory.mjs';
import { screen as restyleScreen } from './lib/restyle-screens.mjs';
import { launchInMode, regions } from './lib/restyle-flows.mjs';
import { createVault, enterLocalMode, lockVault, openVault, refreshEntries, waitForScreen } from './lib/flows.mjs';
import { captureWindow, cropCapture } from './lib/window-capture.mjs';
import { bodyText, clickText, invoke, pressKey, sleep, typeInto, waitFor, waitForText, withTimeout } from './lib/ui.mjs';

const OUT_DIR = path.join(VERIFY_DIR, 'dashboard', 'final');
const MODES = Object.freeze(['dark', 'light']);
const PASSWORD = 'dashboard-final-pw-1';
const VAULT = 'Acme';
const HOME = '__home__';
const SETTLE_MS = 500;
const DAY_MS = 86_400_000;
const COMBOBOX = 'input[role=combobox]';

const log = (m) => console.log(`[dashboard] ${m}`);

function parseArgs(argv) {
  const i = argv.indexOf('--mode');
  const modes = i === -1 ? MODES : [argv[i + 1]];
  if (!modes.every((m) => MODES.includes(m))) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  return { modes };
}

function recorder(d, mode) {
  let seq = 0;
  const shots = [];
  const checks = [];
  return {
    shots,
    checks,
    async shot(name, what, { crop } = {}) {
      seq += 1;
      const file = `${mode}-${String(seq).padStart(2, '0')}-${name}.png`;
      const out = path.join(OUT_DIR, file);
      await sleep(SETTLE_MS);
      const full = crop ? `${out}.full.png` : out;
      const capture = await captureWindow(d, full, { method: 'page' });
      if (crop) {
        await cropCapture(capture, await crop(), out, { zoom: 1.5 });
        fs.rmSync(full, { force: true });
      }
      shots.push({ file, what: `${what} (${mode})` });
      log(`saved ${file}`);
    },
    check(what, ok, detail) {
      checks.push({ what: `${what} (${mode})`, ok: Boolean(ok), detail: JSON.stringify(detail ?? null) });
      log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    },
  };
}

async function create(d, fields) {
  const entry = await invoke(d, 'entry_create', fields);
  await sleep(25);
  return entry;
}

/**
 * Production (with sub-folder Web) holds six connections for Open all; Staging one; Domain Admin and
 * Runbook sit at the root. web-01 gets a second password so it has a history row.
 */
async function fillVault(d, { siteUrl, closedPort, closedPort2 }) {
  const production = await invoke(d, 'folder_create', { name: 'Production' });
  const web = await invoke(d, 'folder_create', { name: 'Web', parent_id: production.id });
  const staging = await invoke(d, 'folder_create', { name: 'Staging' });
  const admin = await create(d, { name: 'Domain Admin', entry_type: 'credential', username: 'admin', password: 'Final-Only-1', credential_type: 'password' });
  const ids = {
    production: production.id,
    admin: admin.id,
    web01: (await create(d, { name: 'web-01', entry_type: 'ssh', folder_id: production.id, host: '127.0.0.1', port: closedPort, username: 'deploy', password: 'Old-Pass-1' })).id,
    db: (await create(d, { name: 'db-01', entry_type: 'ssh', folder_id: production.id, host: '10.255.255.1', port: 22, username: 'postgres', password: 'Db-Pass-1' })).id,
    dc: (await create(d, { name: 'DC-01', entry_type: 'rdp', folder_id: production.id, host: 'dc-01.invalid', port: 3389, credential_id: admin.id })).id,
    mac: (await create(d, { name: 'Build Mac', entry_type: 'vnc', folder_id: production.id, host: '127.0.0.1', port: closedPort2 })).id,
    site: (await create(d, { name: 'Intranet Status', entry_type: 'web', folder_id: web.id, host: siteUrl })).id,
    grafana: (await create(d, { name: 'Grafana', entry_type: 'web', folder_id: web.id, host: 'https://grafana.invalid/' })).id,
    staging: (await create(d, { name: 'staging-01', entry_type: 'ssh', folder_id: staging.id, host: '127.0.0.1', port: closedPort, username: 'deploy' })).id,
    runbook: (await create(d, { name: 'Runbook', entry_type: 'document', config: { content: '# Runbook\n\n- Check backups\n' } })).id,
  };
  await invoke(d, 'entry_update', { id: ids.web01, password: 'New-Pass-2' });
  await invoke(d, 'entry_update', { id: ids.web01, is_favorite: true });
  await invoke(d, 'entry_update', { id: ids.site, is_favorite: true });
  await refreshEntries(d);
  return ids;
}

/** Backdates passwords in the locked vault file: web-01's change 400 days ago, db-01 created 250 days ago. */
function backdatePasswords(file, ids) {
  const iso = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
  const sql = [
    `UPDATE password_history SET changed_at = '${iso(400)}' WHERE entry_id = '${ids.web01}';`,
    `UPDATE entries SET created_at = '${iso(250)}' WHERE id = '${ids.db}';`,
    'PRAGMA wal_checkpoint(TRUNCATE);',
  ].join(' ');
  execFileSync('sqlite3', [file, sql]);
  // macOS sqlite3 keeps its -wal and -shm files, which the app reads as an older Conduit still writing.
  for (const side of [`${file}-wal`, `${file}-shm`]) {
    if (!fs.existsSync(side)) continue;
    if (side.endsWith('-wal') && fs.statSync(side).size > 0) throw new Error(`${side} still holds changes after the checkpoint`);
    fs.rmSync(side);
  }
}

/** Audit lines in the device's own HOME, read by the real ai_activity_recent reader. */
function writeAuditLog(d, ids) {
  const file = path.join(d.root, 'home', '.config', 'conduit', 'audit.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const base = { client: 'claude-code', env: 'preview', duration_ms: 40, result: { type: 'success' } };
  const lines = [
    { ...base, timestamp: at(42), tool: 'entry_info', parameters: { id: ids.db } },
    { ...base, timestamp: at(9), tool: 'website_screenshot', parameters: { entry_id: ids.site }, result: { type: 'error', message: 'timeout' } },
    { ...base, timestamp: at(2), tool: 'terminal_execute', parameters: { entry_id: ids.web01 } },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const sessionOf = (d, entryId) => withStores(d, (id, s) => s.session.getState().sessions.find((x) => x.entryId === id) ?? null, entryId, { label: 'read session' });
const activeSession = (d) => withStores(d, (_, s) => s.session.getState().activeSessionId, null, { label: 'active session' });

async function openUntil(d, entryId, status) {
  await withStores(d, (id, s) => {
    void s.entry.getState().openEntry(id).catch(() => {});
    return true;
  }, entryId, { label: `open ${entryId}` });
  return waitFor(async () => {
    const s = await sessionOf(d, entryId);
    return s && s.status === status ? s : null;
  }, { timeoutMs: 30_000, label: `session of ${entryId} ${status}` });
}

async function closeSession(d, sessionId) {
  await withStores(d, (id, s) => s.session.getState().closeSession(id), sessionId, { label: 'close session' });
}

function activate(d, id) {
  return withStores(d, (sid, s) => {
    const layout = s.layout.getState();
    const walk = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(walk));
    const pane = walk(layout.root).find((l) => l.sessionIds.includes(sid));
    layout.setFocusedPane(pane.id);
    layout.setActiveSessionInPane(pane.id, sid);
    return true;
  }, id, { label: `activate ${id}` });
}

/** Scrolls the visible Home page to the top, the bottom, or `selector`. */
function scrollHome(d, where) {
  return withTimeout(d.page.evaluate((sel) => {
    const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent.startsWith('Welcome back') && h.getClientRects().length > 0);
    const scroller = h1?.closest('.overflow-y-auto');
    if (!scroller) return false;
    if (sel === 'top') scroller.scrollTop = 0;
    else if (sel === 'bottom') scroller.scrollTop = scroller.scrollHeight;
    else document.querySelector(sel)?.scrollIntoView({ block: 'center' });
    return true;
  }, where), 10_000, `${d.name}: scroll Home`);
}

function tabState(d) {
  return withTimeout(d.page.evaluate(() => [...document.querySelectorAll('[data-tabbar]')].map((bar) =>
    [...bar.querySelectorAll('[data-cv-tab]')].map((t) => ({
      id: t.dataset.cvTab,
      home: t.hasAttribute('data-cv-home-tab'),
      close: t.querySelector('.cv-tab-close') !== null,
    })))), 10_000, `${d.name}: tabs`);
}

async function pressShortcut(d, key) {
  await withTimeout(d.page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }), 10_000, 'blur');
  await pressKey(d, key);
}

function clickIn(d, selector, label) {
  return waitFor(() => withTimeout(d.page.evaluate(({ selector: s, label: l }) => {
    const button = [...document.querySelectorAll(s)].find((b) => (b.getAttribute('title') ?? b.innerText.trim()) === l && b.getClientRects().length > 0);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, { selector, label }), 10_000, `click ${label}`), { timeoutMs: 15_000, label: `"${label}" in ${selector}` });
}

async function seed(ctx, d, net) {
  await enterLocalMode(d);
  const file = vaultPath(d, VAULT);
  await createVault(d, file, PASSWORD);
  await waitForScreen(d, 'main');
  const ids = await fillVault(d, net);
  await lockVault(d);
  backdatePasswords(file, ids);
  writeAuditLog(d, ids);
  await openVault(d, file, PASSWORD, { expect: 'unlocked' });
  await waitForScreen(d, 'main');
  log('vault seeded and reopened');
  return ids;
}

/** Real history: Intranet Status opened and closed, web-01 fails on its closed port, then Intranet Status and a terminal stay open. */
async function makeHistory(d, ids) {
  const first = await openUntil(d, ids.site, 'connected');
  await sleep(1_500);
  await closeSession(d, first.id);
  await waitFor(async () => (await sessionOf(d, ids.site)) === null, { timeoutMs: 15_000, label: 'web tab closed' });
  const failed = await openUntil(d, ids.web01, 'disconnected');
  const terminal = await openTerminal(d);
  const site = await openUntil(d, ids.site, 'connected');
  log('history recorded');
  return { terminal, site: site.id, web01: failed.id };
}

async function homeScreens(d, rec, sessions) {
  await setSidebar(d, 'hidden');
  await activate(d, HOME);
  await waitForText(d, 'Recently connected', { timeoutMs: 20_000 });
  await waitForText(d, 'passwords older than', { timeoutMs: 20_000 });
  await waitForText(d, 'Recent tool calls from AI agents on this device', { timeoutMs: 40_000 }).catch(() => null);
  const text = await bodyText(d);
  rec.check('Home shows the real sections', ['Recently connected', 'Open now', 'Favorites', 'Needs attention', 'Overview'].every((t) => text.includes(t)), null);
  rec.check('Needs attention counts the two backdated passwords', text.includes('2 passwords older than 180 days'), null);
  rec.check('Recently connected lists the web entry and the failed SSH entry', /Intranet Status[\s\S]*web-01|web-01[\s\S]*Intranet Status/.test(text) && text.includes('Failed'), null);
  rec.check('AI activity reads the device audit log', text.includes('Terminal execute'), null);
  await scrollHome(d, 'top');
  await rec.shot('home-top', 'Home, top: header, quick bar, Recently connected, Open now, Favorites, Needs attention');
  await scrollHome(d, 'bottom');
  await rec.shot('home-bottom', 'Home, bottom: AI activity, Vault status, Overview');

  await scrollHome(d, 'top');
  await hoverRow(d, 'Recently connected', 'web-01');
  await rec.shot('home-row-actions-hover', 'Recently connected row under the pointer: Copy password and View info cover the time');
  await hoverRow(d, 'Favorites', 'Intranet Status');
  await rec.shot('favorites-row-actions-hover', 'Favorites row under the pointer: the same actions over the type label');
  await d.page.mouse.move(5, 400);

  await clickText(d, 'Show entries', { exact: true, selector: '[data-attention="password-age"] button' });
  await waitForText(d, 'Hide entries');
  await scrollHome(d, '[data-attention="password-age"]');
  await rec.shot('attention-password-list', 'Needs attention with the old password list open (web-01 1 year, db-01 8 months)');
  await clickText(d, 'Hide entries', { exact: true, selector: '[data-attention="password-age"] button' });

  await setSidebar(d, 'docked');
  await scrollHome(d, 'top');
  await rec.shot('home-sidebar-docked', 'Home with the side bar docked');
  await setSidebar(d, 'hidden');

  await scrollHome(d, 'top');
  await withTimeout(d.page.evaluate((sel) => document.querySelector(sel)?.focus(), COMBOBOX), 10_000, 'focus search');
  await typeInto(d, COMBOBOX, 'web');
  await waitFor(async () => (await withTimeout(d.page.evaluate(() => document.querySelectorAll('[role=option]').length), 5_000, 'options')) > 1, { timeoutMs: 10_000, label: 'search results' });
  await pressKey(d, 'ArrowDown');
  await rec.shot('search-results', 'Quick search "web": entries and the Web folder, second row active');
  await pressKey(d, 'Escape');

  await clickText(d, 'Customize', { exact: true, selector: 'button' });
  await waitForText(d, 'Customize Home');
  await rec.shot('customize', 'Customize popover');
  await pressKey(d, 'Escape');

  const tabs = await tabState(d);
  rec.check('Home is the first tab, without a close button, before the open sessions', tabs.length === 1 && tabs[0][0]?.id === HOME && !tabs[0][0].close && tabs[0].length === 4, tabs);
  await rec.shot('tabbar-pinned-home', 'Zoom 1.5x: pinned Home tab before web-01, Terminal and Intranet Status', { crop: async () => (await regions(d)).tabbars });

  await activate(d, sessions.terminal);
  await rec.shot('terminal-before-shortcut', 'Terminal tab active, before Cmd+Shift+H');
  await pressShortcut(d, 'Meta+Shift+KeyH');
  await waitFor(async () => (await activeSession(d)) === HOME, { timeoutMs: 5_000, label: 'Home active' }).catch(() => null);
  rec.check('Cmd+Shift+H goes back to Home', (await activeSession(d)) === HOME, await activeSession(d));
  await rec.shot('home-after-shortcut', 'After Cmd+Shift+H: Home is the active tab');
}

/** Moves the pointer over the row labelled `label` in the Home card titled `card`. */
async function hoverRow(d, card, label) {
  const box = await withTimeout(d.page.evaluate(({ c, l }) => {
    const heading = [...document.querySelectorAll('h3')].find((h) => h.textContent === c && h.getClientRects().length > 0);
    const row = [...(heading?.closest('.border-card-border')?.querySelectorAll('.group\\/row') ?? [])].find((r) => r.textContent?.startsWith(l));
    const rect = row?.getBoundingClientRect();
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, { c: card, l: label }), 10_000, `${d.name}: find ${label} in ${card}`);
  if (!box) throw new Error(`no ${label} row in ${card}`);
  await d.page.mouse.move(box.x, box.y);
}

/**
 * Home as the restyle suite's shot 40 sees it: only the pinned Home tab, no connection history, the
 * side bar docked. Saves the home-dashboard-full-window inventory for refreshing that suite's delta.
 */
async function homeAloneScreen(d, rec, mode) {
  await closeAllSessions(d);
  await withStores(d, (_, s) => {
    const layout = s.layout.getState();
    const walk = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(walk));
    for (const leaf of walk(layout.root)) if (leaf.sessionIds.length === 0) layout.collapsePaneIfEmpty(leaf.id);
    return true;
  }, null, { label: 'collapse empty panes' });
  await clearConnectionHistory(d);
  await setSidebar(d, 'docked');
  await activate(d, HOME);
  await waitForText(d, 'Welcome back');
  await sleep(1_000);
  const text = await bodyText(d);
  rec.check('Home alone hides Recently connected and Open now', !text.includes('Recently connected') && !text.includes('Open now'), null);
  await scrollHome(d, 'top');
  await rec.shot('home-alone', 'Only the pinned Home tab and no connection history (the restyle suite\'s shot 40 state)');
  const inventory = await captureInventory(d, restyleScreen('home-dashboard-full-window'));
  fs.writeFileSync(path.join(OUT_DIR, `${mode}-home-alone-inventory.json`), `${JSON.stringify(inventory, null, 2)}\n`);
}

async function folderScreens(d, rec, ids) {
  await withStores(d, async (folderId) => {
    const { openFolderView } = await import('/src/lib/openDashboard.ts');
    openFolderView(folderId);
    return true;
  }, ids.production, { label: 'open the Production folder view' });
  await waitFor(() => withTimeout(d.page.evaluate(() => !!document.querySelector('[data-cv-folder-list]')), 5_000, 'folder list'), { timeoutMs: 15_000, label: 'folder view' });
  await clickIn(d, '[data-cv-folder-view] button', 'Check all');
  await waitFor(async () => {
    const t = await bodyText(d);
    return t.includes('Check all') && !t.includes('Checking ');
  }, { timeoutMs: 30_000, label: 'Check all done' });
  await d.page.mouse.move(5, 400);
  const text = await bodyText(d);
  rec.check('Check all shows Up, Port closed, No answer and Unknown host', ['Up', 'Port closed', 'No answer', 'Unknown host'].every((t) => text.includes(t)), null);
  await rec.shot('folder-view-checked', 'Production folder view after Check all (real checks)');
  await rec.shot('tabbar-folder-tab', 'Zoom 1.5x: tab bar with the folder view tab (folder icon)', { crop: async () => (await regions(d)).tabbars });

  await clickIn(d, '[data-cv-folder-view] button', 'Open all');
  await waitForText(d, 'Open 6 connections?');
  await rec.shot('folder-open-all-confirm', 'Open all confirm for the six connections');
  await clickInTopDialog(d, 'Cancel');
  await sleep(300);
}

async function entryInfoScreens(d, rec, ids) {
  for (const [id, name, label] of [[ids.site, 'entry-info-web', 'Intranet Status'], [ids.web01, 'entry-info-ssh', 'web-01']]) {
    await withStores(d, async (entryId) => {
      const { openDashboardForEntry } = await import('/src/lib/openDashboard.ts');
      openDashboardForEntry(entryId);
      return true;
    }, id, { label: `open ${label} info` });
    await waitForText(d, 'Is it up?');
    await waitForText(d, 'Recent connections');
    // Folder view checks are shared with entry info, so the row may already offer Check again.
    await clickIn(d, 'button', (await bodyText(d)).includes('Check again') ? 'Check again' : 'Check');
    await waitForText(d, 'Check again', { timeoutMs: 10_000 });
    const text = await bodyText(d);
    const expected = id === ids.site ? ['Up', 'Connected now', 'Connected'] : ['Port closed', 'Could not connect'];
    rec.check(`${label} info shows its check and real history`, expected.every((t) => text.includes(t)), expected);
    await rec.shot(name, `Entry info for ${label}: Is it up? checked and Recent connections`);
  }
}

async function splitScreen(d, rec) {
  await withStores(d, (_, s) => {
    const layout = s.layout.getState();
    layout.splitPane(layout.focusedPaneId, 'horizontal');
    return true;
  }, null, { label: 'split an empty pane' });
  await sleep(800);
  const homeViews = await withTimeout(d.page.evaluate(() => [...document.querySelectorAll('[data-cv-session-area]')].map((a) =>
    [...a.querySelectorAll('h1')].some((h) => h.getClientRects().length > 0 && (h.textContent ?? '').startsWith('Welcome back')))), 10_000, 'home views');
  rec.check('an empty split pane shows Home', homeViews.length === 2 && homeViews[1] === true, homeViews);
  await rec.shot('split-empty-pane-home', 'Split with an empty right pane: it shows Home');
}

async function captureMode(ctx, { mode, net }) {
  const d = await launchInMode(ctx, 'dash', mode);
  const rec = recorder(d, mode);
  const failures = [];
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${mode} ${label}: ${err.message.split('\n')[0]}`);
      log(`${mode} ${label} failed: ${err.message}`);
      await captureWindow(d, path.join(OUT_DIR, `${mode}-zz-failure-${label.replace(/\W+/g, '-')}.png`), { method: 'page' }).catch(() => {});
      for (let i = 0; i < 3; i++) await pressKey(d, 'Escape').catch(() => {});
    }
  };
  try {
    const ids = await seed(ctx, d, net);
    const sessions = await makeHistory(d, ids);
    await step('home', () => homeScreens(d, rec, sessions));
    await step('folder view', () => folderScreens(d, rec, ids));
    await step('entry info', () => entryInfoScreens(d, rec, ids));
    await step('split pane', () => splitScreen(d, rec));
    await step('home alone', () => homeAloneScreen(d, rec, mode));
  } catch (err) {
    failures.push(`${mode} setup: ${err.message.split('\n')[0]}`);
    log(`${mode} setup failed: ${err.stack}`);
  } finally {
    await ctx.quitDevice(d);
  }
  return { shots: rec.shots, checks: rec.checks, failures };
}

function writeIndex(shots, checks, failures) {
  const lines = [
    '# Home dashboard: final app run',
    '',
    `Captured ${new Date().toISOString().slice(0, 10)} with \`node scripts/verify/capture-dashboard.mjs\` on branch \`advenimus/dashboard\`.`,
    'One local-mode device per mode, real dashboard IPC (no fake handlers). Vault "Acme": Production (web-01 SSH on a closed local port, db-01 on a black-hole address, DC-01 on an unknown host, Build Mac VNC on a closed port, sub-folder Web with Intranet Status on the harness test page and Grafana on an unknown host), Staging, Domain Admin and Runbook. Favorites: web-01 and Intranet Status.',
    'Connection history is real: Intranet Status was opened and closed, web-01 failed, then a Terminal and Intranet Status stayed open. Password ages were backdated in the locked vault file (web-01 changed 400 days ago, db-01 created 250 days ago). The AI activity lines were written to the device audit log by the script and read by the real reader.',
    '',
    '## Checks',
    '',
    '| Result | Check | Seen |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.ok ? 'ok' : 'FAIL'} | ${c.what} | \`${c.detail.replace(/\|/g, '\\|').slice(0, 300)}\` |`),
    '',
    '## Screenshots',
    '',
    '| File | Shows |',
    '|---|---|',
    ...shots.map((s) => `| \`${s.file}\` | ${s.what} |`),
  ];
  if (failures.length > 0) lines.push('', '## Not captured', '', ...failures.map((f) => `- ${f}`));
  fs.writeFileSync(path.join(OUT_DIR, 'INDEX.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const { modes } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) if (modes.some((m) => f.startsWith(`${m}-`))) fs.rmSync(path.join(OUT_DIR, f));
  const run = createRunContext();
  installSignalHandlers(run);
  const step = (m) => log(m);
  step.file = (name) => run.logPath(name);
  const shots = [];
  const checks = [];
  const failures = [];
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const site = await startTestSite(run);
    const net = { siteUrl: site.url, closedPort: await freePort(), closedPort2: await freePort() };
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step });
    try {
      for (const mode of modes) {
        const res = await captureMode(ctx, { mode, net });
        shots.push(...res.shots);
        checks.push(...res.checks);
        failures.push(...res.failures);
      }
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message}`);
  } finally {
    await run.runCleanup();
  }
  writeIndex(shots, checks, failures);
  const failed = checks.filter((c) => !c.ok).length;
  log(`${shots.length} shot(s), ${failed} failed check(s), ${failures.length} failure(s) in ${path.relative(process.cwd(), OUT_DIR)}`);
  for (const f of failures) log(`  FAILED ${f}`);
  return failures.length === 0 && failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[dashboard] ${err.message}`);
    process.exit(2);
  },
);
