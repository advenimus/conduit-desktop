// @vitest-environment node
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface JsdomModule {
  JSDOM: new (html: string, options: { runScripts: 'dangerously'; virtualConsole: unknown }) => {
    window: { document: Document; KeyboardEvent: typeof KeyboardEvent; MouseEvent: typeof MouseEvent; close(): void };
  };
  VirtualConsole: new () => { on(event: 'log', listener: (message: unknown) => void): unknown };
}
// jsdom ships no type declarations and the electron tsconfig type-checks tests, so it is loaded untyped.
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as JsdomModule;

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: FakeWindow[] = [];
  interface FakeWindow {
    options: Record<string, unknown>;
    url: string;
    closed: boolean;
    shown: boolean;
    events: Map<string, (...args: unknown[]) => void>;
    contentEvents: Map<string, (...args: unknown[]) => void>;
  }
  class BrowserWindow {
    private readonly state: FakeWindow;
    readonly webContents: { on: (event: string, cb: (...args: unknown[]) => void) => void };
    constructor(options: Record<string, unknown>) {
      this.state = { options, url: '', closed: false, shown: false, events: new Map(), contentEvents: new Map() };
      windows.push(this.state);
      this.webContents = { on: (event, cb) => void this.state.contentEvents.set(event, cb) };
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      this.state.events.set(event, cb);
    }
    loadURL(url: string) {
      this.state.url = url;
      return Promise.resolve();
    }
    isDestroyed() {
      return this.state.closed;
    }
    close() {
      this.state.closed = true;
      this.state.events.get('closed')?.();
    }
    show() {
      this.state.shown = true;
    }
  }
  return {
    handlers,
    windows,
    BrowserWindow,
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) },
    screen: { getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) },
    parent: {
      getContentBounds: () => ({ x: 50, y: 60, width: 1200, height: 800 }),
      webContents: { getZoomFactor: () => 1.25 },
    } as unknown,
  };
});

vi.mock('electron', () => ({ ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow, screen: electron.screen }));
vi.mock('../../services/state.js', () => ({
  AppState: { getInstance: () => ({ getMainWindow: () => electron.parent }) },
}));

import {
  MENU_METRICS,
  MODERN_MENU_COLORS,
  buildMenuHtml,
  buildMenuModel,
  escapeHtml,
  layoutMenu,
  menuColors,
  registerMenuHandlers,
  selectionFor,
  type MenuModel,
} from '../menu.js';

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
const M = MENU_METRICS.shadowMargin;
const W = MENU_METRICS.minWidth;
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"></path></svg>';
const CLEAN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path d="M0 0h16v16H0z"></path></svg>';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `item_${i}`, label: `Item ${i}` }));

describe('escapeHtml', () => {
  it('escapes & < > " and \'', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
});

describe('buildMenuModel', () => {
  it('drops items whose id is not [A-Za-z0-9_:.-]{1,64}, with a warning', () => {
    const model = buildMenuModel([
      { id: 'ok_1', label: 'Kept' },
      { id: 'bad id', label: 'Space' },
      { id: `x'onmouseover='y`, label: 'Quote' },
      { id: '', label: 'Empty' },
      { id: 'a'.repeat(65), label: 'Long' },
      { id: 'agent_claude-code', label: 'Hyphen' },
      { id: 'ns:id.v2', label: 'Colon and dot' },
      { id: 42, label: 'Number' },
    ]);
    expect(model.ids).toEqual(['ok_1', 'agent_claude-code', 'ns:id.v2']);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it('drops malformed items and ignores unknown types and variants', () => {
    const model = buildMenuModel([null, 'x', { id: 'no_label' }, { id: 'a', label: 'A', type: 'bogus', variant: 'loud' }]);
    expect(model.ids).toEqual(['a']);
    expect(model.rows).toEqual([{ kind: 'item', label: 'A', danger: false, iconSvg: null, index: 0 }]);
  });

  it('numbers selectable items depth first and never numbers separators, headers or submenu parents', () => {
    const model = buildMenuModel([
      { id: 'h', label: 'Header', type: 'header' },
      { id: 'open', label: 'Open' },
      { id: 'sep', label: '', type: 'separator' },
      { id: 'open_with', label: 'Open With', children: [{ id: 'ext', label: 'External' }, { id: 'cred', label: 'Credential' }] },
      { id: 'sep', label: '', type: 'separator' },
      { id: 'delete', label: 'Delete', variant: 'danger' },
    ]);
    expect(model.ids).toEqual(['open', 'ext', 'cred', 'delete']);
    expect(model.rows.map((r) => r.kind)).toEqual(['header', 'item', 'separator', 'submenu', 'separator', 'item']);
    expect(model.submenus).toHaveLength(1);
    expect(model.submenus[0]).toEqual([
      { kind: 'item', label: 'External', danger: false, iconSvg: null, index: 1 },
      { kind: 'item', label: 'Credential', danger: false, iconSvg: null, index: 2 },
    ]);
    expect(model.rows[5]).toEqual({ kind: 'item', label: 'Delete', danger: true, iconSvg: null, index: 3 });
  });

  it('sanitizes each icon and drops the ones the allowlist rejects', () => {
    const model = buildMenuModel([
      { id: 'a', label: 'A', iconSvg: ICON },
      { id: 'b', label: 'B', iconSvg: '<svg><script>alert(1)</script></svg>' },
    ]);
    expect(model.rows).toEqual([
      { kind: 'item', label: 'A', danger: false, iconSvg: CLEAN_ICON, index: 0 },
      { kind: 'item', label: 'B', danger: false, iconSvg: null, index: 1 },
    ]);
  });

  it('treats an empty children list as a plain item and ignores nested submenus', () => {
    const model = buildMenuModel([
      { id: 'leaf', label: 'Leaf', children: [] },
      { id: 'parent', label: 'Parent', children: [{ id: 'child', label: 'Child', children: [{ id: 'grandchild', label: 'Deep' }] }] },
    ]);
    expect(model.ids).toEqual(['leaf', 'child']);
    expect(model.submenus[0]).toEqual([{ kind: 'item', label: 'Child', danger: false, iconSvg: null, index: 1 }]);
  });

  it('shows a parent whose children were all dropped as a plain item', () => {
    const model = buildMenuModel([{ id: 'parent', label: 'Parent', children: [{ id: 'bad id', label: 'x' }] }, { id: 'next', label: 'Next' }]);
    expect(model.submenus).toEqual([]);
    expect(model.rows).toEqual([
      { kind: 'item', label: 'Parent', danger: false, iconSvg: null, index: 0 },
      { kind: 'item', label: 'Next', danger: false, iconSvg: null, index: 1 },
    ]);
    expect(model.ids).toEqual(['parent', 'next']);
  });
});

describe('selectionFor', () => {
  const ids = ['open', 'ext', 'delete'];
  it('maps a flattened index back to its id', () => {
    expect(selectionFor('__MENU__:0', ids)).toBe('open');
    expect(selectionFor('__MENU__:2', ids)).toBe('delete');
  });
  it.each(['__MENU__:dismiss', '__MENU__:', '__MENU__:3', '__MENU__:-1', '__MENU__:1.5', '__MENU__:01', '__MENU__: 1', '__MENU__:delete'])(
    'resolves %s to null',
    (message) => {
      expect(selectionFor(message, ids)).toBeNull();
    },
  );
  it('ignores console messages that are not menu messages', () => {
    expect(selectionFor('some page log', ids)).toBeUndefined();
  });
});

describe('menuColors', () => {
  const valid = {
    overlay: '#101112',
    overlayBorder: '#202122',
    inkSecondary: '#303132',
    inkMuted: '#404142',
    selectionBg: '#505152',
    selectionBorder: '#606162',
    danger: '#707172',
    dangerHover: '#808182',
    divider: '#909192',
  };

  it('keeps valid #rrggbb values, inkSecondary and dangerHover included', () => {
    expect(menuColors(valid, 'dark')).toEqual(valid);
  });

  it('falls back to the Modern value for each invalid color, per theme', () => {
    const colors = { ...valid, inkSecondary: 'red', dangerHover: 'rgba(1,2,3,0.1)', divider: '#fff', overlay: '#12345g', inkMuted: '#1234567' };
    expect(menuColors(colors, 'light')).toEqual({
      ...valid,
      inkSecondary: MODERN_MENU_COLORS.light.inkSecondary,
      dangerHover: MODERN_MENU_COLORS.light.dangerHover,
      divider: MODERN_MENU_COLORS.light.divider,
      overlay: MODERN_MENU_COLORS.light.overlay,
      inkMuted: MODERN_MENU_COLORS.light.inkMuted,
    });
  });

  it('uses the dark Modern set for a missing payload or an unknown theme', () => {
    expect(menuColors(undefined, undefined)).toEqual(MODERN_MENU_COLORS.dark);
    expect(menuColors('x', 'sepia')).toEqual(MODERN_MENU_COLORS.dark);
  });

  it("falls back to Modern's overlay colors with Conduit's sky accent (spec 7.1, D-25)", () => {
    expect(MODERN_MENU_COLORS.dark).toEqual({
      overlay: '#202122',
      overlayBorder: '#2a2b2c',
      inkSecondary: '#bfbfbf',
      inkMuted: '#9d9d9d',
      selectionBg: '#1d3540',
      selectionBorder: '#0ea5e9',
      danger: '#f48771',
      dangerHover: '#352b2a',
      divider: '#2a2b2c',
    });
    expect(MODERN_MENU_COLORS.light).toEqual({
      overlay: '#fafafd',
      overlayBorder: '#e4e5e6',
      inkSecondary: '#202020',
      inkMuted: '#606060',
      selectionBg: '#e2f2fb',
      selectionBorder: '#0ea5e9',
      danger: '#ad0707',
      dangerHover: '#f2e2e4',
      divider: '#f0f1f2',
    });
  });

  it('holds only #rrggbb values in the built-in sets', () => {
    for (const set of [MODERN_MENU_COLORS.dark, MODERN_MENU_COLORS.light]) {
      expect(Object.keys(set).sort()).toEqual(Object.keys(valid).sort());
      for (const value of Object.values(set)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('layoutMenu', () => {
  const chrome = 2 * MENU_METRICS.border + 2 * MENU_METRICS.padding;
  const plain = buildMenuModel(items(4));
  const H = 4 * MENU_METRICS.row + chrome;
  const grow = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x - M, y: r.y - M, width: r.width + 2 * M, height: r.height + 2 * M });

  it('measures rows, separators and headers at 24, 11 and 24 plus the container chrome', () => {
    const model = buildMenuModel([
      { id: 'h', label: 'H', type: 'header' },
      { id: 'a', label: 'A' },
      { id: 's', label: '', type: 'separator' },
      { id: 'b', label: 'B' },
    ]);
    expect(layoutMenu(model, { x: 10, y: 10, anchorRight: false, workArea: WORK_AREA }).main.height).toBe(24 + 24 + 11 + 24 + chrome);
    expect(chrome).toBe(10);
  });

  it('keeps the visible menu at the click point and grows the window by 12 on each side', () => {
    const layout = layoutMenu(plain, { x: 100, y: 200, anchorRight: false, workArea: WORK_AREA });
    expect(layout.main).toEqual({ x: 100, y: 200, width: W, height: H });
    expect(layout.window).toEqual({ x: 88, y: 188, width: W + 24, height: H + 24 });
  });

  it('flips left and up using the visible rect', () => {
    const layout = layoutMenu(plain, { x: 1800, y: 1000, anchorRight: false, workArea: WORK_AREA });
    expect(layout.main).toEqual({ x: 1800 - W, y: 1000 - H, width: W, height: H });
    expect(layout.window).toEqual(grow(layout.main));
  });

  it('does not flip when only the shadow margin crosses the edge', () => {
    const layout = layoutMenu(plain, { x: 1920 - W, y: 1080 - H, anchorRight: false, workArea: WORK_AREA });
    expect(layout.main).toEqual({ x: 1920 - W, y: 1080 - H, width: W, height: H });
    expect(layout.window.x + layout.window.width).toBe(1920 + M);
  });

  it('anchors the right edge at x in anchorRight mode', () => {
    const layout = layoutMenu(plain, { x: 500, y: 40, anchorRight: true, workArea: WORK_AREA });
    expect(layout.main.x).toBe(500 - W);
    expect(layout.window.x).toBe(500 - W - M);
  });

  it('clamps the visible rect into the work area of any display', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 };
    const layout = layoutMenu(plain, { x: -1900, y: 5, anchorRight: true, workArea: secondary });
    expect(layout.main.x).toBe(-1920);
    expect(layout.window.x).toBe(-1920 - M);
    const tall = buildMenuModel(items(60));
    const clamped = layoutMenu(tall, { x: 10, y: 900, anchorRight: false, workArea: WORK_AREA });
    expect(clamped.main.y).toBe(0);
  });

  describe('with a submenu', () => {
    const model: MenuModel = buildMenuModel([
      { id: 'open', label: 'Open' },
      { id: 'with', label: 'Open With', children: items(2) },
      { id: 'close', label: 'Close' },
    ]);
    const mainH = 3 * MENU_METRICS.row + chrome;
    const subH = 2 * MENU_METRICS.row + chrome;
    const overlap = MENU_METRICS.submenuOverlap;

    it('opens to the right, level with its parent row, and grows the union by 12', () => {
      const layout = layoutMenu(model, { x: 100, y: 100, anchorRight: false, workArea: WORK_AREA });
      expect(layout.main).toEqual({ x: 100, y: 100, width: W, height: mainH });
      expect(layout.submenus).toEqual([{ x: 100 + W - overlap, y: 100 + MENU_METRICS.row, width: W, height: subH }]);
      const union = { x: 100, y: 100, width: 2 * W - overlap, height: Math.max(mainH, MENU_METRICS.row + subH) };
      expect(layout.window).toEqual(grow(union));
    });

    it('opens to the left when the right side has no room, without moving the main menu', () => {
      const layout = layoutMenu(model, { x: 1600, y: 100, anchorRight: false, workArea: WORK_AREA });
      expect(layout.main.x).toBe(1600);
      expect(layout.submenus[0].x).toBe(1600 - W + overlap);
      expect(layout.window.x).toBe(1600 - W + overlap - M);
      expect(layout.window.x + layout.window.width).toBe(1600 + W + M);
    });

    it('keeps the submenu inside the bottom of the work area', () => {
      const long = buildMenuModel([{ id: 'a', label: 'A' }, { id: 'p', label: 'P', children: items(4) }, { id: 'b', label: 'B' }]);
      const layout = layoutMenu(long, { x: 100, y: 1080 - mainH, anchorRight: false, workArea: WORK_AREA });
      expect(layout.main.y).toBe(1080 - mainH);
      expect(layout.submenus[0].y + layout.submenus[0].height).toBe(1080);
      expect(layout.submenus[0].y).toBeLessThan(layout.main.y + MENU_METRICS.row);
    });
  });
});

describe('menu width', () => {
  const at = { x: 100, y: 100, anchorRight: false, workArea: WORK_AREA };
  const width = (input: unknown[]) => layoutMenu(buildMenuModel(input), at).main.width;

  it('keeps menus with short labels at the 220 minimum', () => {
    expect(width(items(3))).toBe(220);
    expect(width([{ id: 'r', label: 'Remove from Recents' }, { id: 'c', label: 'Copy Path', iconSvg: ICON }])).toBe(220);
  });

  it('widens a menu whose longest label would be cut off at 220', () => {
    // The label measures 177px at 13px in the macOS system font; the row adds 2 + 8 + 16 + 16 + 8 around it.
    const w = width([
      { id: 'hd', label: 'Local mode', type: 'header' },
      { id: 'signin', label: 'Sign in to start a free Pro trial', iconSvg: ICON },
    ]);
    expect(w).toBeGreaterThanOrEqual(177 + 50);
    expect(w).toBeLessThanOrEqual(260);
  });

  it('measures headers and wide or non-Latin text, and stops at 320 so a long email ellipsizes', () => {
    expect(width([{ id: 'hd', label: 'chris.vautour.long.address@example-company.com (Offline)', type: 'header' }, ...items(1)])).toBe(320);
    expect(width([{ id: 'w', label: 'WWWWWWWWWWWWWWWW' }])).toBeGreaterThan(220);
    expect(width([{ id: 'cjk', label: '连接到远程桌面服务器并打开会话窗口' }])).toBeGreaterThan(220);
  });

  it('places a wider submenu beside its parent by its own width', () => {
    const model = buildMenuModel([{ id: 'p', label: 'P', children: [{ id: 'c', label: 'Copy the connection string to the clipboard' }] }]);
    const layout = layoutMenu(model, { ...at, x: 1920 - 220 - 100 });
    const sub = layout.submenus[0];
    expect(sub.width).toBeGreaterThan(220);
    // No room on the right for the wider panel, so it opens to the left of the main menu.
    expect(sub.x).toBe(layout.main.x - sub.width + MENU_METRICS.submenuOverlap);
  });
});

describe('buildMenuHtml', () => {
  const render = (input: unknown[], chevronSvg: string | null = null) => {
    const model = buildMenuModel(input);
    const layout = layoutMenu(model, { x: 100, y: 100, anchorRight: false, workArea: WORK_AREA });
    return buildMenuHtml({ model, layout, colors: MODERN_MENU_COLORS.dark, chevronSvg, platform: 'linux' });
  };

  it('escapes labels and never writes ids into the page', () => {
    const html = render([
      { id: 'zz_marker_id', label: '<img src=x onerror=alert(1)>' },
      { id: 'hdr_marker', label: `"quoted" & 'single'`, type: 'header' },
    ]);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;quoted&quot; &amp; &#39;single&#39;');
    expect(html).not.toContain('zz_marker_id');
    expect(html).not.toContain('hdr_marker');
    expect(html).toContain('data-i="0"');
  });

  it('uses the spec sizes, font and colors', () => {
    const c = MODERN_MENU_COLORS.dark;
    const html = render(items(2));
    expect(html).toContain(`width:${W}px`);
    expect(html).not.toMatch(/\.m,\.sm\{[^}]*width:/);
    expect(html).toMatch(/\.i\{[^}]*height:24px;margin:0 4px;padding:0 8px;border-radius:6px;gap:8px;font-size:13px;line-height:24px/);
    expect(html).toMatch(/\.sep\{height:1px;margin:5px 0;background:#2a2b2c\}/i);
    expect(html).toMatch(/\.hd\{[^}]*height:24px;[^}]*font-size:11px;font-weight:600;[^}]*color:#9d9d9d/i);
    expect(html).not.toMatch(/uppercase/);
    expect(html).toContain('-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, sans-serif');
    expect(html).toContain('box-shadow:0 0 12px rgba(0,0,0,.14)');
    expect(html).toContain(`background:${c.overlay};border:1px solid ${c.overlayBorder};border-radius:8px`);
    expect(html).toContain(`color:${c.inkSecondary}`);
    expect(html).toContain(`.i.a{background:${c.selectionBg};outline:1px solid ${c.selectionBorder};outline-offset:-1px}`);
    expect(html).toContain(`.i.d{color:${c.danger}}`);
    expect(html).toContain(`.i.d.a{background:${c.dangerHover}}`);
    expect(html).toContain(`.ic{display:flex;flex-shrink:0;width:16px;height:16px;color:${c.inkMuted}}`);
  });

  it('places the main menu at the shadow margin inside the window, at its own width', () => {
    expect(render(items(1))).toContain(`class="m" role="menu" style="left:${M}px;top:${M}px;width:${W}px"`);
  });

  it('gives a submenu its own width', () => {
    const html = render([{ id: 'p', label: 'P', children: [{ id: 'c', label: 'Copy the connection string to the clipboard' }] }]);
    expect(html).toMatch(/class="m" role="menu" style="left:\d+px;top:\d+px;width:220px"/);
    expect(html).toMatch(/class="sm" id="s0" role="menu" style="left:\d+px;top:\d+px;width:(2[3-9]\d|3[01]\d|320)px;display:none"/);
  });

  it('embeds sanitized icons and the submenu chevron', () => {
    const html = render(
      [
        { id: 'a', label: 'A', iconSvg: ICON },
        { id: 'p', label: 'P', children: [{ id: 'c', label: 'C' }] },
      ],
      CLEAN_ICON,
    );
    expect(html).toContain(`<span class="ic">${CLEAN_ICON}</span>`);
    expect(html).toContain(`<span class="ch">${CLEAN_ICON}</span>`);
    expect(html).not.toContain('aria-hidden');
  });

  it('adds the macOS corner smoothing only on darwin', () => {
    const model = buildMenuModel(items(1));
    const layout = layoutMenu(model, { x: 0, y: 0, anchorRight: false, workArea: WORK_AREA });
    const colors = MODERN_MENU_COLORS.light;
    expect(buildMenuHtml({ model, layout, colors, chevronSvg: null, platform: 'darwin' })).toContain('-electron-corner-smoothing:system-ui');
    expect(buildMenuHtml({ model, layout, colors, chevronSvg: null, platform: 'win32' })).not.toContain('corner-smoothing');
  });
});

describe('the menu page', () => {
  function openPage(input: unknown[]) {
    const model = buildMenuModel(input);
    const layout = layoutMenu(model, { x: 100, y: 100, anchorRight: false, workArea: WORK_AREA });
    const html = buildMenuHtml({ model, layout, colors: MODERN_MENU_COLORS.dark, chevronSvg: null, platform: 'linux' });
    const logs: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('log', (message: unknown) => logs.push(String(message)));
    const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole });
    const { document, KeyboardEvent, MouseEvent } = dom.window;
    return {
      document,
      key: (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
      mouse: (type: string, target: Element) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })),
      active: () => document.querySelector('.i.a')?.textContent ?? null,
      results: () => logs.map((m) => selectionFor(m, model.ids)),
      close: () => dom.window.close(),
    };
  }

  const MIXED = [
    { id: 'h', label: 'Header', type: 'header' },
    { id: 'first', label: 'First' },
    { id: 's1', label: '', type: 'separator' },
    { id: 'with', label: 'Open With', children: [{ id: 'ext', label: 'External' }, { id: 'cred', label: 'Credential' }] },
    { id: 's2', label: '', type: 'separator' },
    { id: 'last', label: 'Last', variant: 'danger' },
  ];

  it('dismisses on a mousedown in the transparent margin', () => {
    const page = openPage(MIXED);
    page.mouse('mousedown', page.document.body);
    expect(page.results()).toEqual([null]);
    page.close();
  });

  it('does nothing for a mousedown on a header or separator', () => {
    const page = openPage(MIXED);
    page.mouse('mousedown', page.document.querySelector('.hd')!);
    page.mouse('mousedown', page.document.querySelector('.sep')!);
    expect(page.results()).toEqual([]);
    page.close();
  });

  it('reports the index of the clicked item, which maps back to its id', () => {
    const page = openPage(MIXED);
    page.mouse('mousedown', page.document.querySelectorAll('.m .l')[2]);
    page.mouse('mousedown', page.document.querySelector('#s0 .l')!);
    expect(page.results()).toEqual(['last', 'ext']);
    page.close();
  });

  it('moves with Up, Down, Home and End, skipping separators and headers, and wraps', () => {
    const page = openPage(MIXED);
    expect(page.active()).toBeNull();
    page.key('ArrowDown');
    expect(page.active()).toBe('First');
    page.key('ArrowDown');
    expect(page.active()).toBe('Open With');
    page.key('ArrowDown');
    expect(page.active()).toBe('Last');
    page.key('ArrowDown');
    expect(page.active()).toBe('First');
    page.key('ArrowUp');
    expect(page.active()).toBe('Last');
    page.key('Home');
    expect(page.active()).toBe('First');
    page.key('End');
    expect(page.active()).toBe('Last');
    expect(page.results()).toEqual([]);
    page.close();
  });

  it('starts from the last item on Up', () => {
    const page = openPage(MIXED);
    page.key('ArrowUp');
    expect(page.active()).toBe('Last');
    page.close();
  });

  it('chooses the active item with Enter or Space', () => {
    const page = openPage(MIXED);
    page.key('ArrowDown');
    page.key('Enter');
    page.key('End');
    page.key(' ');
    expect(page.results()).toEqual(['first', 'last']);
    page.close();
  });

  it('opens a submenu with Right, Enter or a hover and closes it with Left', () => {
    const page = openPage(MIXED);
    const sub = page.document.getElementById('s0') as HTMLElement;
    page.key('ArrowDown');
    page.key('ArrowRight');
    expect(sub.style.display).toBe('none');
    page.key('ArrowDown');
    page.key('ArrowRight');
    expect(sub.style.display).toBe('block');
    expect(page.active()).toBe('External');
    page.key('ArrowDown');
    expect(page.active()).toBe('Credential');
    page.key('ArrowDown');
    expect(page.active()).toBe('External');
    page.key('ArrowLeft');
    expect(sub.style.display).toBe('none');
    expect(page.active()).toBe('Open With');
    page.key('Enter');
    expect(sub.style.display).toBe('block');
    page.key('End');
    page.key('Enter');
    expect(page.results()).toEqual(['cred']);
    page.close();
  });

  it('closes a hovered submenu when the keyboard moves off its parent', () => {
    const page = openPage(MIXED);
    const sub = page.document.getElementById('s0') as HTMLElement;
    page.mouse('mouseover', page.document.querySelector('[data-sub="0"]')!);
    expect(sub.style.display).toBe('block');
    page.key('ArrowDown');
    expect(sub.style.display).toBe('none');
    expect(page.active()).toBe('Last');
    page.close();
  });

  it('opens a submenu on hover and highlights hovered rows', () => {
    const page = openPage(MIXED);
    const parent = page.document.querySelector('[data-sub="0"]')!;
    page.mouse('mouseover', parent);
    expect((page.document.getElementById('s0') as HTMLElement).style.display).toBe('block');
    expect(page.active()).toBe('Open With');
    page.mouse('mouseover', page.document.querySelector('#s0 .i')!);
    expect(page.active()).toBe('External');
    page.close();
  });

  it('dismisses on Escape', () => {
    const page = openPage(MIXED);
    page.key('Escape');
    expect(page.results()).toEqual([null]);
    page.close();
  });
});

describe('show_context_menu_popup', () => {
  registerMenuHandlers();
  const handler = electron.handlers.get('show_context_menu_popup')!;
  const show = (args: unknown) => handler({}, args) as Promise<string | null>;
  const lastWindow = () => electron.windows[electron.windows.length - 1];
  const pageHtml = () => decodeURIComponent(lastWindow().url.replace('data:text/html;charset=utf-8,', ''));

  beforeEach(() => {
    electron.windows.length = 0;
  });

  it('sizes the window as the visible menu grown by 12, at the zoomed click point', async () => {
    const pending = show({ items: items(3), x: 100, y: 40, theme: 'dark' });
    const win = lastWindow();
    const H = 3 * MENU_METRICS.row + 10;
    // content origin (50, 60) + CSS point x zoom 1.25
    expect(win.options).toMatchObject({ x: 175 - M, y: 110 - M, width: W + 2 * M, height: H + 2 * M, transparent: true, frame: false, hasShadow: false });
    expect(electron.screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 175, y: 110 });
    win.contentEvents.get('did-finish-load')!();
    expect(win.shown).toBe(true);
    win.contentEvents.get('console-message')!({ message: '__MENU__:2' });
    await expect(pending).resolves.toBe('item_2');
    expect(win.closed).toBe(true);
  });

  it('resolves a margin click to null and closes the popup', async () => {
    const pending = show({ items: items(2), x: 0, y: 0 });
    lastWindow().contentEvents.get('console-message')!({ message: '__MENU__:dismiss' });
    await expect(pending).resolves.toBeNull();
    expect(lastWindow().closed).toBe(true);
  });

  it('ignores other page logs and resolves null on blur', async () => {
    const pending = show({ items: items(2), x: 0, y: 0 });
    lastWindow().contentEvents.get('console-message')!({ message: 'unrelated' });
    expect(lastWindow().closed).toBe(false);
    lastWindow().events.get('blur')!();
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null when the page fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pending = show({ items: items(1), x: 0, y: 0 });
    lastWindow().contentEvents.get('did-fail-load')!({}, -2, 'failed');
    await expect(pending).resolves.toBeNull();
  });

  it('renders escaped labels, sanitized icons and the validated colors', async () => {
    const pending = show({
      items: [{ id: 'danger_id', label: '<b>Delete</b>', variant: 'danger', iconSvg: ICON }],
      x: 0,
      y: 0,
      theme: 'light',
      colors: { ...MODERN_MENU_COLORS.dark, danger: '#abcdef', dangerHover: 'not a color' },
      submenuIconSvg: '<svg onload="x"></svg>',
    });
    const html = pageHtml();
    expect(html).toContain('&lt;b&gt;Delete&lt;/b&gt;');
    expect(html).not.toContain('danger_id');
    expect(html).toContain(CLEAN_ICON);
    expect(html).toContain('.i.d{color:#abcdef}');
    expect(html).toContain(`.i.d.a{background:${MODERN_MENU_COLORS.light.dangerHover}}`);
    lastWindow().events.get('blur')!();
    await pending;
  });

  it.each([
    ['no payload', undefined],
    ['a non-finite x', { items: items(1), x: Number.NaN, y: 0 }],
    ['a string y', { items: items(1), x: 0, y: '5' }],
    ['items that are not a list', { items: 'x', x: 0, y: 0 }],
    ['no valid items', { items: [{ id: 'bad id', label: 'x' }], x: 0, y: 0 }],
  ])('returns null without a window for %s', async (_label, args) => {
    await expect(show(args)).resolves.toBeNull();
    expect(electron.windows).toHaveLength(0);
  });
});
