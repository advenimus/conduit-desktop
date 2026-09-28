// The reference data of docs/VISUAL_REDESIGN.md 3.1 for the restyle suite: vault "Acme Infrastructure"
// with its folders and entries, the empty "Scratch" vault, a local test page for the web entry, and
// the sessions of the reference screens (Terminal, Runbook, web-01, Intranet Status split right).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createVault, refreshEntries, waitForScreen, waitForUnlockOutcome } from './flows.mjs';
import { clickSelector, clickText, invoke, sleep, stubFileDialogs, typeInto, waitFor, waitForText, withTimeout } from './ui.mjs';

export const VAULT_PASSWORD = 'restyle-reference-pw-1';
export const ACME = 'Acme Infrastructure';
export const SCRATCH = 'Scratch';
const RUNBOOK = '# Runbook\n\n- Check backups\n- Rotate keys\n';
const TEST_PAGE = `<!doctype html><html><head><title>Intranet Status</title><style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f4f6f8;color:#1f2933}
header{background:#1f6feb;color:#fff;padding:18px 28px;font-size:20px;font-weight:600}
main{padding:28px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.ok{color:#1a7f37;font-weight:600}</style></head><body><header>Intranet Status (test page)</header>
<main><div class="card"><h3>Web server</h3><p class="ok">Healthy</p></div>
<div class="card"><h3>Database</h3><p class="ok">Healthy</p></div>
<div class="card"><h3>Backups</h3><p>Last run 02:00</p></div></main></body></html>`;

/** Serves the "Intranet Status (test page)" on 127.0.0.1; closed at run cleanup. Returns {url, close}. */
export async function startTestSite(run) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = run.onCleanup('stop the restyle test page', () => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${server.address().port}/`, close };
}

/** The device's own vault folder (a run-wide folder would clash between the dark and light devices). */
export function vaultDir(device) {
  const dir = path.join(device.root, 'vaults');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const vaultPath = (device, name) => path.join(vaultDir(device), `${name}.conduit`);

async function create(device, fields) {
  const entry = await invoke(device, 'entry_create', fields);
  // Recently Modified sorts by modification time; keep every entry in its own millisecond.
  await sleep(25);
  return entry;
}

/**
 * Fills the open vault as "Acme Infrastructure": Production (db-01, DC-01, web-01 to 127.0.0.1:1,
 * favorite), Staging (Build Mac, Intranet Status on the test page, favorite), Domain Admin and
 * Runbook at the root. The order gives the reference's Recently Modified list. Returns the ids.
 */
export async function fillAcme(device, { siteUrl }) {
  const production = await invoke(device, 'folder_create', { name: 'Production' });
  const staging = await invoke(device, 'folder_create', { name: 'Staging' });
  const admin = await create(device, { name: 'Domain Admin', entry_type: 'credential', username: 'admin', password: 'Reference-Only-1', credential_type: 'password' });
  const db = await create(device, { name: 'db-01', entry_type: 'ssh', folder_id: production.id, host: '10.0.10.4', port: 22, username: 'postgres' });
  const dc = await create(device, { name: 'DC-01', entry_type: 'rdp', folder_id: production.id, host: '10.0.10.5', port: 3389, credential_id: admin.id });
  const mac = await create(device, { name: 'Build Mac', entry_type: 'vnc', folder_id: staging.id, host: '10.0.20.7', port: 5900 });
  const runbook = await create(device, { name: 'Runbook', entry_type: 'document', config: { content: RUNBOOK } });
  const web = await create(device, { name: 'web-01', entry_type: 'ssh', folder_id: production.id, host: '127.0.0.1', port: 1, username: 'deploy' });
  const site = await create(device, { name: 'Intranet Status', entry_type: 'web', folder_id: staging.id, host: siteUrl });
  await invoke(device, 'entry_update', { id: web.id, is_favorite: true });
  await sleep(25);
  await invoke(device, 'entry_update', { id: site.id, is_favorite: true });
  await refreshEntries(device);
  // The app reloads its credential list when it creates a credential itself; IPC does not tell it.
  await withStores(device, async (_, st) => {
    await st.vault.getState().loadCredentials();
    return true;
  }, null, { label: 'reload credentials' });
  return { production: production.id, staging: staging.id, admin: admin.id, db: db.id, dc: dc.id, mac: mac.id, runbook: runbook.id, web: web.id, site: site.id };
}

/** Creates "Acme Infrastructure" from the hub and fills it (fillAcme). */
export async function createAcme(device, { siteUrl }) {
  await createVault(device, vaultPath(device, ACME), VAULT_PASSWORD);
  return fillAcme(device, { siteUrl });
}

const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const CONFIRM_INPUT = 'input[placeholder="Confirm master password"]';
const SUBMIT = '[data-dialog-content] form button[type=submit]';

/**
 * Hub "New Vault" for `file` with both passwords typed; `onDialog()` runs while the filled Create
 * Vault dialog is open, then the form is submitted and the vault opens.
 */
export async function createVaultShowing(device, file, { onDialog } = {}) {
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  await waitForScreen(device, 'hub');
  await stubFileDialogs(device, file);
  await clickText(device, 'New Vault', { exact: true, selector: 'button' });
  await waitForText(device, 'Set a master password');
  await typeInto(device, PASSWORD_INPUT, VAULT_PASSWORD);
  await typeInto(device, CONFIRM_INPUT, VAULT_PASSWORD);
  if (onDialog) await onDialog();
  await clickSelector(device, SUBMIT);
  const res = await waitForUnlockOutcome(device);
  if (res.outcome !== 'unlocked') throw new Error(`${device.name}: creating ${path.basename(file)} ended in ${res.outcome}`);
}

/** Clicks the button labeled exactly `label` in the topmost dialog. */
export function clickInTopDialog(device, label, opts = {}) {
  return waitFor(() => withTimeout(device.page.evaluate(({ label }) => {
    const dialogs = [...document.querySelectorAll('[data-dialog-content]')].filter((d) => d.getClientRects().length > 0);
    const top = dialogs[dialogs.length - 1];
    const button = top && [...top.querySelectorAll('button')].find((b) => (b.innerText ?? '').trim() === label && b.getClientRects().length > 0);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, { label }), 10_000, `${device.name}: click ${label}`), { timeoutMs: opts.timeoutMs ?? 15_000, label: `${device.name}: "${label}" in the top dialog` });
}

/** Waits until `count` dialogs ([data-dialog-content]) are visible. */
export function waitForDialogs(device, count, { timeoutMs = 15_000 } = {}) {
  return waitFor(() => withTimeout(device.page.evaluate((n) => [...document.querySelectorAll('[data-dialog-content]')].filter((d) => d.getClientRects().length > 0).length === n, count), 10_000, 'count dialogs'), {
    timeoutMs,
    label: `${device.name}: ${count} dialog(s) open`,
  });
}

/**
 * Runs `fn(arg, modules)` in the renderer with the app's own store modules (the dev server serves
 * each module once, so these are the instances the app uses).
 */
export function withStores(device, fn, arg, { timeoutMs = 30_000, label = 'store call' } = {}) {
  const source = `(async () => {
    const [session, layout, entry, sidebar, vault] = await Promise.all([
      import('/src/stores/sessionStore.ts'), import('/src/stores/layoutStore.ts'),
      import('/src/stores/entryStore.ts'), import('/src/stores/sidebarStore.ts'), import('/src/stores/vaultStore.ts'),
    ]);
    const stores = { session: session.useSessionStore, layout: layout.useLayoutStore, entry: entry.useEntryStore, sidebar: sidebar.useSidebarStore, vault: vault.useVaultStore };
    return (${fn})(${JSON.stringify(arg ?? null)}, stores);
  })()`;
  return withTimeout(device.page.evaluate(source), timeoutMs, `${device.name}: ${label}`);
}

/** Opens a local shell ("Terminal") in the focused pane and runs the reference command in it. */
export async function openTerminal(device) {
  const id = await withStores(device, (_, s) => s.session.getState().createLocalShell(), null, { label: 'open a local shell' });
  const command = 'echo "Conduit reference session" && uname -sm\r';
  await sleep(600);
  await invoke(device, 'terminal_write', { sessionId: id, data: [...Buffer.from(command)] }).catch(() => null);
  return id;
}

/** Opens entry `id` the way a double click in the tree does; returns once its tab exists. */
export async function openEntry(device, id) {
  await withStores(device, (entryId, s) => {
    void s.entry.getState().openEntry(entryId);
    return true;
  }, id, { label: `open entry ${id}` });
  return waitFor(() => withStores(device, (entryId, s) => {
    const found = s.session.getState().sessions.find((x) => x.entryId === entryId);
    return found ? found.id : null;
  }, id), { timeoutMs: 20_000, label: `${device.name}: tab of entry ${id}` });
}

/** Moves session `sessionId` into a new pane to the right of its pane ("Split Right"). */
export function splitRight(device, sessionId) {
  return withStores(device, (sid, s) => {
    const layout = s.layout.getState();
    const find = (node) => {
      if (!node) return null;
      if (node.type === 'leaf') return node.sessionIds?.includes(sid) ? node.id : null;
      return (node.children ?? []).map(find).find(Boolean) ?? null;
    };
    const paneId = find(layout.root);
    if (!paneId) return 'no pane';
    layout.splitPane(paneId, 'horizontal', sid);
    return 'split';
  }, sessionId, { label: 'split right' });
}

/**
 * The reference sessions: Terminal, Runbook and web-01 in the left pane, Intranet Status split into
 * a right pane, the Terminal tab active on the left. Returns their session ids.
 */
export async function openReferenceSessions(device, ids) {
  const terminal = await openTerminal(device);
  const runbook = await openEntry(device, ids.runbook);
  const web = await openEntry(device, ids.web);
  const site = await openEntry(device, ids.site);
  const res = await splitRight(device, site);
  if (res !== 'split') throw new Error(`${device.name}: could not split Intranet Status to the right (${res})`);
  await withStores(device, (sid, s) => {
    const layout = s.layout.getState();
    const leaves = [];
    const walk = (n) => (n.type === 'leaf' ? leaves.push(n) : (n.children ?? []).forEach(walk));
    walk(layout.root);
    const left = leaves.find((l) => l.sessionIds.includes(sid));
    layout.setActiveSessionInPane(left.id, sid);
    return true;
  }, terminal, { label: 'activate Terminal' });
  await waitForWebStatus(device, site);
  return { terminal, runbook, web, site };
}

async function waitForWebStatus(device, sessionId) {
  await waitFor(() => withStores(device, (sid, s) => s.session.getState().sessions.find((x) => x.id === sid)?.status === 'connected', sessionId), {
    timeoutMs: 20_000,
    label: `${device.name}: web session connected`,
  });
}

/** Side bar state through its store: 'hidden', 'floating' or 'docked' (pinned and open). */
export async function setSidebar(device, mode) {
  await withStores(device, (m, s) => {
    const sb = s.sidebar.getState();
    if (m === 'docked') {
      sb.setPinned(true);
      sb.expand();
    } else {
      sb.setPinned(false);
      if (m === 'floating') sb.expand();
      else sb.collapse();
    }
    return true;
  }, mode, { label: `side bar ${mode}` });
  const want = { hidden: 'none', floating: 'floating', docked: 'docked' }[mode];
  await waitFor(async () => (await sidebarMode(device)) === want, { timeoutMs: 10_000, label: `${device.name}: side bar ${mode}` });
  await sleep(350);
}

/** 'none', 'floating' or 'docked' from the DOM. */
export function sidebarMode(device) {
  return withTimeout(device.page.evaluate(() => {
    const panel = document.querySelector('[data-sidebar-panel]');
    if (!panel || panel.getClientRects().length === 0) return 'none';
    return panel.hasAttribute('data-docked') ? 'docked' : 'floating';
  }), 10_000, `${device.name}: side bar mode`);
}

/** Closes every session and waits until no tab is left. */
export async function closeAllSessions(device) {
  await withStores(device, async (_, s) => {
    for (const x of [...s.session.getState().sessions]) await s.session.getState().closeSession(x.id);
    return true;
  }, null, { label: 'close all sessions' });
}

/** Clicks the side bar footer's Home button (the Home dashboard tab). */
export function openHome(device) {
  return clickSelector(device, '[data-sidebar-panel] button[title="Home"]');
}

/**
 * In-page: clicks the twistie of `folder` unless `child` already shows. B48: the hooked twistie
 * (data-cv-tree-twistie, which has a name), else the row's only unnamed button (markup before the hook).
 */
export function expandFolderInPage({ folder, child }) {
  const panel = document.querySelector('[data-sidebar-panel]');
  if (!panel) return 'no side bar';
  const ownText = (e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  const visibleText = (t) => [...panel.querySelectorAll('span, div')].some((el) => ownText(el) === t && el.getClientRects().length > 0);
  if (visibleText(child)) return 'expanded';
  const label = [...panel.querySelectorAll('span, div')].find((el) => ownText(el) === folder);
  const hooked = panel.querySelector('[data-cv-tree-twistie]') !== null;
  const isTwistie = hooked
    ? (b) => b.hasAttribute('data-cv-tree-twistie')
    : (b) => !b.title && !b.getAttribute('aria-label') && !(b.innerText ?? b.textContent).trim();
  for (let el = label; el && el !== panel; el = el.parentElement) {
    const toggle = [...el.querySelectorAll('button')].find(isTwistie);
    if (toggle) {
      toggle.click();
      return 'clicked';
    }
  }
  return `no toggle for ${folder}`;
}

/** Expands the Production and Staging folders in the side bar tree (the side bar must be open). */
export async function expandFolders(device) {
  for (const [folder, child] of [['Production', 'db-01'], ['Staging', 'Build Mac']]) {
    await waitFor(async () => {
      const res = await withTimeout(device.page.evaluate(expandFolderInPage, { folder, child }), 10_000, `${device.name}: expand ${folder}`);
      if (res === 'expanded') return true;
      if (res !== 'clicked') throw new Error(res);
      return false;
    }, { timeoutMs: 10_000, intervalMs: 300, label: `${device.name}: folder ${folder} expanded` });
  }
}

/** Selects entry `id` in the tree (the highlighted row of the reference shots). */
export function selectEntry(device, id) {
  return withStores(device, (entryId, s) => {
    s.entry.getState().setSelectedEntry(entryId);
    return true;
  }, id, { label: 'select entry' });
}

function contextMenuInPage({ scope, text, x }) {
  const root = document.querySelector(scope);
  if (!root) return `no ${scope}`;
  const ownText = (e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  const el = [...root.querySelectorAll('span, div, button')].find((e) => ownText(e) === text && e.getClientRects().length > 0);
  if (!el) return `no "${text}" in ${scope}`;
  const r = el.getBoundingClientRect();
  const clientX = x ?? r.left + r.width / 2;
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX, clientY: r.top + r.height / 2 }));
  return 'opened';
}

/** Where the reference shots (14 to 17) right-clicked a side bar row: near its left edge, in CSS pixels. */
export const TREE_MENU_X = 38;

/**
 * Right-clicks the element showing exactly `text` inside `scope` (a tree row, a tab), at its center
 * or at window x `x` on its middle line. The popup menu opens where the click lands.
 */
export async function rightClick(device, scope, text, { x = null } = {}) {
  const res = await withTimeout(device.page.evaluate(contextMenuInPage, { scope, text, x }), 10_000, `${device.name}: right-click ${text}`);
  if (res !== 'opened') throw new Error(`${device.name}: ${res}`);
}
