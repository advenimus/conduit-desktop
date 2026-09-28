// Flows the restyle suite shares between scenarios: devices in the reference look, the reference
// main screen, crop regions, popup menus, toasts, the Settings content scroll and the picker window.

import { captureMenu, closeMenus, menuPage } from './inventory.mjs';
import {
  expandFolders,
  fillAcme,
  openReferenceSessions,
  selectEntry,
  setSidebar,
  vaultPath,
  ACME,
  VAULT_PASSWORD,
} from './restyle-data.mjs';
import { createVault, enterLocalMode, waitForScreen } from './flows.mjs';
import { devOrigin, listWindows, windowRole } from './window-capture.mjs';
import { mainEval, sleep, waitFor, withTimeout } from './ui.mjs';

const MENU_PAINT_MS = 500;

/**
 * Settings every restyle device starts with: the mode, and with CONDUIT_RESTYLE_REFERENCE_LOOK=1 the
 * reference's own look (scheme Ocean, Tabler icons), used to record new reference shots. The version
 * keeps the one-time migration from moving the old default scheme Ocean to Modern.
 */
export function lookSettings(mode, env = process.env) {
  if (env.CONDUIT_RESTYLE_REFERENCE_LOOK !== '1') return { theme: mode };
  return { theme: mode, color_scheme: 'ocean', icon_pack: 'tabler', appearance_version: 2 };
}

/** Launches device `${prefix}-${mode[0]}` in `mode`, with popup menus kept open while unfocused. */
export function launchInMode(ctx, prefix, mode, opts = {}) {
  return ctx.launchDevice(`${prefix}-${mode[0]}`, {
    ...opts,
    env: { CV_KEEP_POPUPS: '1', ...(opts.env ?? {}) },
    settings: { ...lookSettings(mode), ...(opts.settings ?? {}) },
  });
}

/**
 * The reference main screen: local mode, "Acme Infrastructure" filled, optionally the reference
 * sessions split in two panes, the side bar docked with both folders open and web-01 selected.
 * Returns {ids, sessions}.
 */
export async function referenceMain(device, { siteUrl, sessions = true, sidebar = 'docked', select = 'web' } = {}) {
  await enterLocalMode(device);
  await createVault(device, vaultPath(device, ACME), VAULT_PASSWORD);
  await waitForScreen(device, 'main');
  const ids = await fillAcme(device, { siteUrl });
  const opened = sessions ? await openReferenceSessions(device, ids) : null;
  await setSidebar(device, sidebar === 'hidden' ? 'floating' : sidebar);
  await expandFolders(device);
  if (select) await selectEntry(device, ids[select]);
  if (sidebar === 'hidden') await setSidebar(device, 'hidden');
  return { ids, sessions: opened };
}

function regionsInPage() {
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0;
  const rect = (el) => el.getBoundingClientRect();
  const panel = [...document.querySelectorAll('[data-sidebar-panel]')].find(visible) ?? null;
  const out = { panel: panel ? rect(panel).toJSON() : null, header: null, footer: null, tabbars: null };
  if (panel) {
    // The hooks where the restyle has added them, today's elements otherwise.
    const search = panel.querySelector('[data-cv-sidebar-search]') ?? panel.querySelector('input[placeholder="Search entries..."]');
    if (search) out.header = { x: rect(panel).left, y: 0, width: rect(panel).width, height: rect(search).bottom + (search.matches('input') ? 12 : 0) };
    let footer = panel.querySelector('[data-cv-sidebar-footer]');
    if (!footer) {
      const home = panel.querySelector('button[title="Home"]');
      footer = home;
      while (footer && footer.parentElement && footer.parentElement !== panel && !footer.parentElement.contains(search)) footer = footer.parentElement;
      if (footer === home) footer = null;
    }
    if (footer) out.footer = { x: rect(panel).left, y: rect(footer).top, width: rect(panel).width, height: rect(panel).bottom - rect(footer).top };
  }
  const bars = [...document.querySelectorAll('[data-tabbar]')].filter(visible).map(rect);
  if (bars.length > 0) {
    const left = Math.min(...bars.map((b) => b.left));
    const right = Math.max(...bars.map((b) => b.right));
    out.tabbars = { x: left, y: 0, width: right - left, height: Math.max(...bars.map((b) => b.bottom)) + 4 };
  }
  return out;
}

/** CSS-pixel regions of the side bar header (with search), the side bar footer and the tab bar row. */
export async function regions(device) {
  return withTimeout(device.page.evaluate(regionsInPage), 10_000, `${device.name}: regions`);
}

const clampTo = (r, content) => {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { ...r, x, y, width: Math.min(content.width - x, r.width - (x - r.x)), height: Math.min(content.height - y, r.height - (y - r.y)) };
};

/** The region around the first window of `role` (menu, overlay, picker), relative to the content area. */
export async function childWindowRegion(device, role, { padX = 60, padY = 12, zoom = 1.5 } = {}) {
  const windows = await listWindows(device);
  const main = windows.find((w) => w.role === 'main');
  const child = windows.find((w) => w.role === role);
  if (!main || !child) throw new Error(`${device.name}: no ${role} window to crop around`);
  const r = { x: child.bounds.x - main.content.x - padX, y: child.bounds.y - main.content.y - padY, width: child.bounds.width + 2 * padX, height: child.bounds.height + 2 * padY, zoom };
  return clampTo(r, main.content);
}

const MENU_ATTEMPTS = 3;

/**
 * Runs `open()` (a click or right-click), waits for the popup menu window to paint, returns its items.
 * A menu closes when its window loses focus, which a web view that is still loading can cause, so a
 * menu that is gone after painting is opened again.
 */
export async function openMenu(device, open) {
  for (let attempt = 1; ; attempt++) {
    await open();
    const { items } = await captureMenu(device);
    await sleep(MENU_PAINT_MS);
    if (menuPage(device) && (await listWindows(device)).some((w) => w.role === 'menu')) return items;
    if (attempt >= MENU_ATTEMPTS) throw new Error(`${device.name}: the popup menu closed by itself ${MENU_ATTEMPTS} times`);
    await sleep(1_000);
  }
}

/** Hovers the popup menu item labeled `label` (opens its submenu). */
export async function hoverMenuItem(device, label) {
  const page = menuPage(device);
  if (!page) throw new Error(`${device.name}: no popup menu to hover`);
  const box = await withTimeout(page.evaluate((text) => {
    const el = [...document.querySelectorAll('.i, [role=menuitem]')].find((e) => (e.querySelector('.l') ?? e.querySelector('span') ?? e).textContent.trim() === text);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label), 5_000, `${device.name}: find menu item ${label}`);
  if (!box) throw new Error(`${device.name}: no menu item "${label}"`);
  await withTimeout(page.mouse.move(box.x, box.y, { steps: 4 }), 5_000, `${device.name}: hover ${label}`);
  await sleep(MENU_PAINT_MS);
}

/** The outerHTML of the icon of menu item `label` in the open popup menu (packs scenario). */
export async function menuItemIcon(device, label) {
  const page = menuPage(device);
  if (!page) return null;
  return withTimeout(page.evaluate((text) => {
    const el = [...document.querySelectorAll('.i, [role=menuitem]')].find((e) => (e.querySelector('.l') ?? e.querySelector('span') ?? e).textContent.trim() === text);
    return el?.querySelector('svg')?.outerHTML ?? null;
  }, label), 5_000, `${device.name}: menu icon`);
}

export { closeMenus };

const TOAST_ATTEMPTS = 3;

function pushToasts(device) {
  return withTimeout(device.page.evaluate(async () => {
    const { toast } = await import('/src/components/common/Toast.tsx');
    const keep = { persistent: true };
    window.__cvToastIds = [
      toast.success('Username copied', keep),
      toast.info('Sidebar pinned. The window is too narrow to dock it, so it will float until there is more room.', keep),
      toast.warning('Sync paused', { ...keep, message: 'The vault folder is not reachable. Changes are kept on this device.', actions: [{ label: 'Retry', onClick: () => {} }] }),
      toast.error('No password available', keep),
    ];
    return window.__cvToastIds.length;
  }), 15_000, `${device.name}: show toasts`);
}

/**
 * The overlay hides the toasts while the main window is not focused, and a test device is rarely the
 * active app; a focus event on the main window (no real focus change) shows them again.
 */
function announceMainFocus(device) {
  return mainEval(device, ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => /^https?:\/\/[^/]+\/?(\?|#|$)/.test(w.webContents.getURL()));
    main?.emit('focus');
    return Boolean(main);
  }, undefined, { label: 'main window focus event' });
}

async function toastsDrawn(device) {
  await announceMainFocus(device);
  const page = childPage(device, 'overlay');
  const text = page ? await withTimeout(page.evaluate(() => document.body?.innerText ?? ''), 5_000, 'overlay text') : '';
  return text.includes('No password available') && (await listWindows(device)).some((w) => w.role === 'overlay');
}

/**
 * The four toasts of the reference (success, info, warning with an action, error), through the app's
 * toast API. The first toasts can reach the overlay window before its page listens, so they are shown
 * again until the overlay draws them.
 */
export async function showReferenceToasts(device) {
  for (let attempt = 1; ; attempt++) {
    await pushToasts(device);
    const drawn = await waitFor(() => toastsDrawn(device), { timeoutMs: 6_000, label: 'toasts drawn' }).catch(() => false);
    if (drawn) break;
    if (attempt >= TOAST_ATTEMPTS) throw new Error(`${device.name}: the overlay window did not draw the toasts after ${TOAST_ATTEMPTS} tries`);
    await clearToasts(device);
    await sleep(800);
  }
  await sleep(500);
}

/** Dismisses the toasts showReferenceToasts showed. */
export function clearToasts(device) {
  return withTimeout(device.page.evaluate(async () => {
    const { toast } = await import('/src/components/common/Toast.tsx');
    for (const id of window.__cvToastIds ?? []) toast.dismiss(id);
    window.__cvToastIds = [];
    return true;
  }), 10_000, `${device.name}: clear toasts`);
}

function scrollInPage({ part, target }) {
  const dialogs = [...document.querySelectorAll('[data-dialog-content]')].filter((d) => d.getClientRects().length > 0);
  const root = dialogs[dialogs.length - 1];
  if (!root) return 'no dialog';
  const nav = root.querySelector('[data-cv-settings-nav]') ?? root.querySelector('.w-52');
  const scrollable = (el) => el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  const all = [...root.querySelectorAll('*')].filter(scrollable);
  const el = target === 'nav' ? all.find((e) => nav && (e === nav || nav.contains(e) || e.contains(nav))) : all.find((e) => !(nav && (e === nav || nav.contains(e) || e.contains(nav))));
  if (!el) return 'nothing scrolls';
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = part === 'top' ? 0 : part === 'middle' ? Math.round(max / 2) : max;
  return 'scrolled';
}

/** Scrolls the Settings content (or its nav, target 'nav') to 'top', 'middle' or 'bottom'. */
export async function scrollSettings(device, part, { target = 'content' } = {}) {
  const res = await withTimeout(device.page.evaluate(scrollInPage, { part, target }), 10_000, `${device.name}: scroll settings`);
  await sleep(250);
  return res;
}

/** Opens the credential picker window the way its global shortcut does. */
export async function openPicker(device) {
  const ok = await mainEval(device, () => (typeof globalThis.__cvShortcut === 'function' ? globalThis.__cvShortcut('CommandOrControl+Shift+Space') : false), undefined, { label: 'picker shortcut' });
  if (!ok) throw new Error(`${device.name}: the picker shortcut is not registered`);
  await waitFor(async () => (await listWindows(device)).some((w) => w.role === 'picker'), { timeoutMs: 15_000, label: `${device.name}: picker window` });
  await sleep(700);
}

/** Closes the picker window. */
export function closePicker(device) {
  return mainEval(device, ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (/\/picker\.html/.test(w.webContents.getURL())) w.close();
    return true;
  }, undefined, { label: 'close picker' });
}

/** The app's own page of `role` ('overlay' or 'picker'), or null; web session pages never count. */
function childPage(device, role) {
  const origin = devOrigin(device);
  return device.app.windows().find((p) => windowRole(p.url(), origin) === role) ?? null;
}

/** `<html data-cv-icon-pack>` of the main window (device.page) and of the overlay and picker windows when open. */
export async function iconPackAttributes(device) {
  const read = (page, role) => withTimeout(page.evaluate(() => document.documentElement.getAttribute('data-cv-icon-pack')), 5_000, `${device.name}: icon pack of ${role}`).catch(() => null);
  const out = { main: await read(device.page, 'main') };
  for (const role of ['overlay', 'picker']) {
    const page = childPage(device, role);
    if (page) out[role] = await read(page, role);
  }
  return out;
}
