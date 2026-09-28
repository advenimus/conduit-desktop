/**
 * IPC handler for showing styled popup context menus (spec 7.7).
 *
 * Uses a child BrowserWindow (separate OS window) to render the menu.
 * This renders above everything, including native WebContentsViews,
 * while allowing full CSS styling to match the app theme.
 */

import { ipcMain, BrowserWindow, screen } from 'electron';
import { AppState } from '../services/state.js';
import { sanitizeSvg } from './menu-svg.js';

export const MENU_METRICS = {
  width: 220,
  row: 24,
  separator: 11,
  header: 24,
  padding: 4,
  border: 1,
  /** Transparent space around the visible menu that its shadow draws into. */
  shadowMargin: 12,
  submenuOverlap: 2,
} as const;

const PANEL_CHROME = 2 * MENU_METRICS.border + 2 * MENU_METRICS.padding;
const MENU_ID = /^[A-Za-z0-9_:.-]{1,64}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ITEM_INDEX = /^(0|[1-9]\d{0,5})$/;
const MAX_MENU_ITEMS = 500;
const MESSAGE_PREFIX = '__MENU__:';
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, sans-serif';

export interface MenuColors {
  overlay: string;
  overlayBorder: string;
  inkSecondary: string;
  inkMuted: string;
  selectionBg: string;
  selectionBorder: string;
  danger: string;
  dangerHover: string;
  divider: string;
}

/** Modern scheme values, alpha flattened over the overlay, for colors the renderer did not send as #rrggbb. */
export const MODERN_MENU_COLORS: Readonly<Record<'dark' | 'light', Readonly<MenuColors>>> = {
  dark: {
    overlay: '#202122',
    overlayBorder: '#2a2b2c',
    inkSecondary: '#bfbfbf',
    inkMuted: '#9d9d9d',
    selectionBg: '#243239',
    selectionBorder: '#3994bc',
    danger: '#f48771',
    dangerHover: '#352b2a',
    divider: '#2a2b2c',
  },
  light: {
    overlay: '#fafafd',
    overlayBorder: '#e4e5e6',
    inkSecondary: '#202020',
    inkMuted: '#606060',
    selectionBg: '#e1ecf8',
    selectionBorder: '#0069cc',
    danger: '#ad0707',
    dangerHover: '#f2e2e4',
    divider: '#f0f1f2',
  },
};

export type MenuRow =
  | { readonly kind: 'separator' }
  | { readonly kind: 'header'; readonly label: string }
  | { readonly kind: 'item'; readonly label: string; readonly danger: boolean; readonly iconSvg: string | null; readonly index: number }
  | { readonly kind: 'submenu'; readonly label: string; readonly danger: boolean; readonly iconSvg: string | null; readonly submenu: number };

export interface MenuModel {
  readonly rows: readonly MenuRow[];
  readonly submenus: ReadonlyArray<readonly MenuRow[]>;
  /** The id of each selectable item, by the flattened index the page reports. */
  readonly ids: readonly string[];
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MenuLayout {
  /** The popup window: the visible panels grown by the shadow margin. */
  readonly window: Rect;
  readonly main: Rect;
  readonly submenus: readonly Rect[];
}

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Payload ──

export function menuColors(colors: unknown, theme: unknown): MenuColors {
  const fallback = MODERN_MENU_COLORS[theme === 'light' ? 'light' : 'dark'];
  const given = isRecord(colors) ? colors : {};
  const pick = (key: keyof MenuColors): string => {
    const value = given[key];
    return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback[key];
  };
  return {
    overlay: pick('overlay'),
    overlayBorder: pick('overlayBorder'),
    inkSecondary: pick('inkSecondary'),
    inkMuted: pick('inkMuted'),
    selectionBg: pick('selectionBg'),
    selectionBorder: pick('selectionBorder'),
    danger: pick('danger'),
    dangerHover: pick('dangerHover'),
    divider: pick('divider'),
  };
}

function describeItem(item: unknown): string {
  const id = isRecord(item) ? item.id : item;
  return JSON.stringify(id)?.slice(0, 80) ?? String(id);
}

type PayloadItem =
  | { readonly kind: 'separator' }
  | { readonly kind: 'header'; readonly label: string }
  | { readonly kind: 'action'; readonly id: string; readonly label: string; readonly danger: boolean; readonly iconSvg: string | null; readonly children: readonly unknown[] };

/** One validated payload item, or null (with a warning) when it must be dropped. */
function readItem(item: unknown): PayloadItem | null {
  if (!isRecord(item) || typeof item.id !== 'string' || !MENU_ID.test(item.id)) {
    console.warn(`[menu] Dropped a popup menu item with an invalid id: ${describeItem(item)}`);
    return null;
  }
  if (typeof item.label !== 'string') {
    console.warn(`[menu] Dropped popup menu item "${item.id}": its label is not a string`);
    return null;
  }
  if (item.type === 'separator') return { kind: 'separator' };
  if (item.type === 'header') return { kind: 'header', label: item.label };
  return {
    kind: 'action',
    id: item.id,
    label: item.label,
    danger: item.variant === 'danger',
    iconSvg: sanitizeSvg(item.iconSvg),
    children: Array.isArray(item.children) ? item.children.slice(0, MAX_MENU_ITEMS) : [],
  };
}

/**
 * Validates the payload items into rows. Selectable items are numbered depth first; the page reports that
 * number, so no id ever reaches the page. Submenus nest one level, as the page renders them.
 */
export function buildMenuModel(items: unknown): MenuModel {
  const ids: string[] = [];
  const submenus: MenuRow[][] = [];
  const list = Array.isArray(items) ? items : [];
  if (list.length > MAX_MENU_ITEMS) console.warn(`[menu] Showing the first ${MAX_MENU_ITEMS} of ${list.length} popup menu items`);

  const toRow = (item: unknown, nested: boolean): MenuRow | null => {
    const read = readItem(item);
    if (!read || read.kind !== 'action') return read;
    const { id, label, danger, iconSvg, children } = read;
    const childRows = nested ? [] : children.map((child) => toRow(child, true)).filter((row): row is MenuRow => row !== null);
    if (childRows.length > 0) {
      submenus.push(childRows);
      return { kind: 'submenu', label, danger, iconSvg, submenu: submenus.length - 1 };
    }
    ids.push(id);
    return { kind: 'item', label, danger, iconSvg, index: ids.length - 1 };
  };

  const rows = list.slice(0, MAX_MENU_ITEMS).map((item) => toRow(item, false)).filter((row): row is MenuRow => row !== null);
  return { rows, submenus, ids };
}

/** The item id for a page message, null for a dismissal or anything invalid, undefined for other page logs. */
export function selectionFor(message: string, ids: readonly string[]): string | null | undefined {
  if (!message.startsWith(MESSAGE_PREFIX)) return undefined;
  const value = message.slice(MESSAGE_PREFIX.length);
  if (!ITEM_INDEX.test(value)) return null;
  return ids[Number(value)] ?? null;
}

// ── Geometry ──

function rowHeight(row: MenuRow): number {
  if (row.kind === 'separator') return MENU_METRICS.separator;
  return row.kind === 'header' ? MENU_METRICS.header : MENU_METRICS.row;
}

function panelHeight(rows: readonly MenuRow[]): number {
  return rows.reduce((sum, row) => sum + rowHeight(row), PANEL_CHROME);
}

/** Keeps a span inside [min, max]; when it cannot fit, the start (min) wins. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

function grow(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

/**
 * Flips and clamps the visible menu at the click point (screen DIP) against the work area, places each
 * submenu beside its parent row, and only then adds the shadow margin to get the window.
 */
export function layoutMenu(model: MenuModel, at: { x: number; y: number; anchorRight: boolean; workArea: Rect }): MenuLayout {
  const { width } = MENU_METRICS;
  const area = at.workArea;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const height = panelHeight(model.rows);

  let x = at.anchorRight ? at.x - width : at.x;
  let y = at.y;
  if (x + width > right) x -= width;
  if (y + height > bottom) y -= height;
  x = clamp(x, area.x, right - width);
  y = clamp(y, area.y, bottom - height);
  const main: Rect = { x, y, width, height };

  const overlap = MENU_METRICS.submenuOverlap;
  const subX = x + 2 * width - overlap <= right ? x + width - overlap : x - width + overlap;
  const submenus: Rect[] = [];
  let offset = 0;
  for (const row of model.rows) {
    if (row.kind === 'submenu') {
      const subHeight = panelHeight(model.submenus[row.submenu]);
      submenus.push({ x: subX, y: clamp(y + offset, area.y, bottom - subHeight), width, height: subHeight });
    }
    offset += rowHeight(row);
  }

  return { window: grow(union([main, ...submenus]), MENU_METRICS.shadowMargin), main, submenus };
}

// ── Page ──

function menuCss(c: MenuColors, platform: NodeJS.Platform): string {
  const smoothing = platform === 'darwin' ? ';-electron-corner-smoothing:system-ui' : '';
  return [
    `*{margin:0;padding:0;box-sizing:border-box${smoothing}}`,
    'html,body{width:100%;height:100%;background:transparent;overflow:hidden}',
    `body{position:relative;font-family:${FONT_STACK};cursor:default;user-select:none;-webkit-user-select:none}`,
    `.m,.sm{position:absolute;width:${MENU_METRICS.width}px;padding:${MENU_METRICS.padding}px 0;background:${c.overlay};border:1px solid ${c.overlayBorder};border-radius:8px;box-shadow:0 0 12px rgba(0,0,0,.14)}`,
    `.i{display:flex;align-items:center;height:24px;margin:0 4px;padding:0 8px;border-radius:6px;gap:8px;font-size:13px;line-height:24px;color:${c.inkSecondary};white-space:nowrap}`,
    `.i.o{background:${c.selectionBg}}`,
    `.i.a{background:${c.selectionBg};outline:1px solid ${c.selectionBorder};outline-offset:-1px}`,
    `.i.d{color:${c.danger}}`,
    `.i.d.a{background:${c.dangerHover}}`,
    '.l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
    `.ic{display:flex;flex-shrink:0;width:16px;height:16px;color:${c.inkMuted}}`,
    `.i.d .ic{color:${c.danger}}`,
    `.ch{display:flex;flex-shrink:0;width:16px;height:16px;align-items:center;justify-content:center;color:${c.inkMuted}}`,
    '.ch:empty::after{content:"";width:5px;height:5px;margin-left:-3px;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}',
    `.hd{height:24px;padding:0 12px;font-size:11px;font-weight:600;line-height:24px;color:${c.inkMuted};overflow:hidden;white-space:nowrap;text-overflow:ellipsis}`,
    `.sep{height:1px;margin:5px 0;background:${c.divider}}`,
  ].join('\n');
}

function rowHtml(row: MenuRow, reserveIcon: boolean, chevronSvg: string | null): string {
  if (row.kind === 'separator') return '<div class="sep" role="separator"></div>';
  if (row.kind === 'header') return `<div class="hd" role="presentation">${escapeHtml(row.label)}</div>`;
  const cls = row.danger ? 'i d' : 'i';
  const icon = row.iconSvg ? `<span class="ic">${row.iconSvg}</span>` : reserveIcon ? '<span class="ic"></span>' : '';
  const label = `<span class="l">${escapeHtml(row.label)}</span>`;
  if (row.kind === 'item') return `<div class="${cls}" role="menuitem" data-i="${row.index}">${icon}${label}</div>`;
  return `<div class="${cls}" role="menuitem" aria-haspopup="menu" data-sub="${row.submenu}">${icon}${label}<span class="ch">${chevronSvg ?? ''}</span></div>`;
}

function panelHtml(rows: readonly MenuRow[], chevronSvg: string | null): string {
  const reserveIcon = rows.some((row) => (row.kind === 'item' || row.kind === 'submenu') && row.iconSvg !== null);
  return rows.map((row) => rowHtml(row, reserveIcon, chevronSvg)).join('');
}

// Static: the page reads everything it needs from the markup. It reports the flattened index of the chosen
// item, or "dismiss" for Escape and for a mousedown in the transparent shadow margin, which the window
// would otherwise swallow without losing focus.
const PAGE_SCRIPT = `(function () {
  var main = document.querySelector('.m');
  var active = null, openSub = null, openParent = null, hideTimer = 0;
  function send(value) { console.log('${MESSAGE_PREFIX}' + value); }
  function asElement(node) { return node instanceof Element ? node : null; }
  function rowsOf(panel) { return Array.prototype.filter.call(panel.children, function (el) { return el.classList.contains('i'); }); }
  function setActive(row) {
    if (active) active.classList.remove('a');
    active = row;
    if (row) row.classList.add('a');
  }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; } }
  function hideSub() {
    cancelHide();
    if (!openSub) return;
    if (active && openSub.contains(active)) setActive(null);
    openSub.style.display = 'none';
    openParent.classList.remove('o');
    openSub = null;
    openParent = null;
  }
  function scheduleHide() { if (openSub && !hideTimer) hideTimer = setTimeout(hideSub, 100); }
  function showSub(row) {
    var sub = document.getElementById('s' + row.getAttribute('data-sub'));
    cancelHide();
    if (!sub || sub === openSub) return sub;
    hideSub();
    sub.style.display = 'block';
    row.classList.add('o');
    openSub = sub;
    openParent = row;
    return sub;
  }
  function choose(row) {
    if (row.hasAttribute('data-i')) { send(row.getAttribute('data-i')); return; }
    var sub = showSub(row);
    if (sub) setActive(rowsOf(sub)[0] || null);
  }
  function move(key) {
    var panel = active && openSub && openSub.contains(active) ? openSub : main;
    var rows = rowsOf(panel);
    if (!rows.length) return;
    var i = rows.indexOf(active);
    var last = rows.length - 1;
    var next = key === 'Home' ? 0 : key === 'End' ? last : key === 'ArrowUp' ? (i <= 0 ? last : i - 1) : (i < 0 || i >= last ? 0 : i + 1);
    setActive(rows[next]);
    if (panel === main && rows[next] !== openParent) hideSub();
  }
  document.addEventListener('mousedown', function (e) {
    var target = asElement(e.target);
    if (!target || !target.closest('.m, .sm')) send('dismiss');
  }, true);
  document.addEventListener('mousedown', function (e) {
    var target = asElement(e.target);
    var row = target && target.closest('.i');
    if (row && row.hasAttribute('data-i')) send(row.getAttribute('data-i'));
  });
  document.addEventListener('mouseover', function (e) {
    var target = asElement(e.target);
    if (!target) return;
    var row = target.closest('.i');
    if ((openSub && openSub.contains(target)) || (row && row === openParent)) cancelHide();
    if (!row) return;
    if (row !== active) setActive(row);
    if (row.parentElement !== main) return;
    if (row.hasAttribute('data-sub')) showSub(row); else scheduleHide();
  });
  document.addEventListener('mouseout', function (e) {
    var from = asElement(e.target), to = asElement(e.relatedTarget);
    var fromRow = from && from.closest('.i'), toRow = to && to.closest('.i');
    if (fromRow && fromRow !== toRow && fromRow === active) setActive(null);
    if (openSub && !(to && (openSub.contains(to) || toRow === openParent))) scheduleHide();
  });
  document.addEventListener('keydown', function (e) {
    var key = e.key;
    if (key === 'Escape') { e.preventDefault(); send('dismiss'); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') { e.preventDefault(); move(key); return; }
    if (key === 'Enter' || key === ' ') { e.preventDefault(); if (active) choose(active); return; }
    if (key === 'ArrowRight') { e.preventDefault(); if (active && active.hasAttribute('data-sub')) choose(active); return; }
    if (key === 'ArrowLeft' && active && openSub && openSub.contains(active)) {
      e.preventDefault();
      var parent = openParent;
      hideSub();
      setActive(parent);
    }
  });
})();`;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

export function buildMenuHtml(input: { model: MenuModel; layout: MenuLayout; colors: MenuColors; chevronSvg: string | null; platform: NodeJS.Platform }): string {
  const { model, layout, colors, chevronSvg, platform } = input;
  const at = (rect: Rect) => `left:${rect.x - layout.window.x}px;top:${rect.y - layout.window.y}px`;
  const submenus = model.submenus
    .map((rows, k) => `<div class="sm" id="s${k}" role="menu" style="${at(layout.submenus[k])};display:none">${panelHtml(rows, chevronSvg)}</div>`)
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
${menuCss(colors, platform)}
</style></head><body>
<div class="m" role="menu" style="${at(layout.main)}">${panelHtml(model.rows, chevronSvg)}</div>${submenus}
<script>${PAGE_SCRIPT}</script>
</body></html>`;
}

// ── Window ──

interface MenuRequest {
  items: unknown[];
  x: number;
  y: number;
  anchorRight: boolean;
  theme: unknown;
  colors: unknown;
  submenuIconSvg: unknown;
}

function parseRequest(args: unknown): MenuRequest | null {
  if (!isRecord(args) || !Array.isArray(args.items)) return null;
  const { x, y } = args;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { items: args.items, x, y, anchorRight: args.anchorRight === true, theme: args.theme, colors: args.colors, submenuIconSvg: args.submenuIconSvg };
}

function openPopup(parent: BrowserWindow, bounds: Rect, html: string, ids: readonly string[]): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let popup: BrowserWindow;
    try {
      popup = new BrowserWindow({
        parent,
        ...bounds,
        frame: false,
        transparent: true,
        // Electron 43+ rounds frameless windows on Linux by default; these draw their own shape.
        ...(process.platform === 'linux' ? { roundedCorners: false } : {}),
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
    } catch (err) {
      console.error('[menu] Could not create the popup menu window:', err);
      resolve(null);
      return;
    }

    let resolved = false;
    const done = (id: string | null) => {
      if (resolved) return;
      resolved = true;
      if (!popup.isDestroyed()) popup.close();
      resolve(id);
    };

    popup.on('blur', () => done(null));
    popup.on('closed', () => done(null));
    // Selections arrive as console messages, so the page needs no preload.
    popup.webContents.on('console-message', (ev) => {
      const selection = selectionFor(ev.message, ids);
      if (selection !== undefined) done(selection);
    });
    popup.webContents.on('did-finish-load', () => {
      if (!popup.isDestroyed()) popup.show();
    });
    popup.webContents.on('did-fail-load', (_ev, code, description) => {
      console.error(`[menu] The popup menu page failed to load (${code} ${description})`);
      done(null);
    });
    popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((err: unknown) => {
      if (!resolved) console.error('[menu] Could not load the popup menu page:', err);
      done(null);
    });
  });
}

async function showPopupMenu(args: unknown): Promise<string | null> {
  const parentWindow = AppState.getInstance().getMainWindow();
  if (!parentWindow) return null;

  const request = parseRequest(args);
  if (!request) {
    console.warn('[menu] Ignored a popup menu request with an invalid payload');
    return null;
  }
  const model = buildMenuModel(request.items);
  if (model.rows.length === 0) return null;

  // Use getContentBounds() not getBounds(): the menu point is relative to the page, not the frame.
  const contentBounds = parentWindow.getContentBounds();
  const zoom = parentWindow.webContents.getZoomFactor();
  const x = Math.round(contentBounds.x + request.x * zoom);
  const y = Math.round(contentBounds.y + request.y * zoom);
  const { workArea } = screen.getDisplayNearestPoint({ x, y });

  const layout = layoutMenu(model, { x, y, anchorRight: request.anchorRight, workArea });
  const html = buildMenuHtml({
    model,
    layout,
    colors: menuColors(request.colors, request.theme),
    chevronSvg: model.submenus.length > 0 ? sanitizeSvg(request.submenuIconSvg) : null,
    platform: process.platform,
  });
  return openPopup(parentWindow, layout.window, html, model.ids);
}

export function registerMenuHandlers(): void {
  ipcMain.handle('show_context_menu_popup', (_e, args: unknown) => showPopupMenu(args));
}
