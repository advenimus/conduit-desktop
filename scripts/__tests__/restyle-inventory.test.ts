import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Control = { tag: string; text?: string; title?: string; aria?: string; pressed?: string; type?: string; placeholder?: string; textStartsWith?: string };
type MenuEntry = { kind: string; label?: string; accelerator?: string; children?: MenuEntry[] };
type Inventory = { screen: string; kind: 'controls' | 'menu'; items: (Control | MenuEntry)[]; probes?: Record<string, boolean> };
type Delta = { screen: string; reason: string; changes: { remove?: Control[]; insert?: Control[]; insertBefore?: Control; insertWhen?: string; reason?: string }[] };
type RuleResult = { rule: string; status: string; detail: string };

// The harness is plain .mjs without type declarations.
const inv = (await import('../verify/lib/inventory.mjs' as string)) as {
  compareInventory(before: Inventory, after: Inventory, deltas?: Delta[]): { ok: boolean; lines: string[] };
  normalizeInventory(inv: Inventory, opts?: { vaultDirs?: string[] }): Inventory;
  normalizeText(text: string, opts?: { vaultDirs?: string[] }): string;
  extractControlsInPage(arg: { roots: unknown[] | null; probes: string[] }): { rootsFound: number; items: Control[]; probes: Record<string, boolean> };
  readMenuInPage(): MenuEntry[] | null;
};
const ref = (await import('../verify/lib/restyle-reference.mjs' as string)) as {
  buildManifest(dir: string): { files: Record<string, string> };
  verifyReferenceFolder(dir: string, manifest: { files: Record<string, string> }): { ok: boolean; problems: string[] };
  beforeDir(options: { before?: string | null }, env: Record<string, string | undefined>): string;
  loadManifest(): { files: Record<string, string> };
  loadBeforeInventory(): { screens: Record<string, { kind: string; items: unknown[] }> };
  loadDeltas(): Delta[];
  parseShotName(file: string): { mode: string; nn: string; name: string } | null;
  DEFAULT_BEFORE_DIR: string;
};
const geo = (await import('../verify/lib/geometry.mjs' as string)) as {
  summarizeRules(entries: { screen: string; results: RuleResult[] }[], opts?: { strict?: boolean }): { failed: number; pending: number; lines: string[] };
  domRulesSource(arg?: { cloneSelectors: string[]; stripHeight: number; aiPanelDefault: number }): string;
  twelveTabsInPage(arg: { minWidth: number }): { status: string; detail: string };
};
const { CLONE_SELECTORS } = (await import('../verify/lib/clone-selectors.mjs' as string)) as { CLONE_SELECTORS: string[] };
const screens = (await import('../verify/lib/restyle-screens.mjs' as string)) as {
  SCREENS: Record<string, unknown>;
  MENU_SCREENS: string[];
  SCENARIOS: Record<string, { shots: string[]; screens: string[] }>;
};
type FakePage = { url(): string; evaluate(fn: unknown): Promise<unknown> };
const flows = (await import('../verify/lib/restyle-flows.mjs' as string)) as {
  lookSettings(mode: string, env: Record<string, string | undefined>): Record<string, unknown>;
  iconPackAttributes(device: { name: string; page: FakePage; app: { windows(): FakePage[] } }): Promise<Record<string, string | null>>;
  pickerGlyphResult(markups: (string | null)[]): RuleResult;
};
const capture = (await import('../verify/lib/window-capture.mjs' as string)) as { windowRole(url: string, origin: string): string };

const controls = (screen: string, items: Control[], probes?: Record<string, boolean>): Inventory => ({ screen, kind: 'controls', items, ...(probes ? { probes } : {}) });
const menu = (screen: string, items: MenuEntry[]): Inventory => ({ screen, kind: 'menu', items });

const HEADER: Control[] = [
  { tag: 'button', title: 'Hide sidebar (Ctrl+B)', aria: 'Hide sidebar' },
  { tag: 'button', title: 'Unpin sidebar so it auto-hides (Ctrl+Shift+B)', aria: 'Unpin sidebar', pressed: 'true' },
  { tag: 'button', text: 'Acme Infrastructure', title: '<vault-path>' },
  { tag: 'button', title: 'Show favorites only' },
  { tag: 'input', type: 'text', placeholder: 'Search entries...' },
  { tag: 'button' },
];

describe('compareInventory: controls', () => {
  it('passes identical lists', () => {
    const res = inv.compareInventory(controls('s', HEADER), controls('s', HEADER));
    expect(res).toEqual({ ok: true, lines: [] });
  });

  it('fails a removed, an added, a reordered and a relabeled control', () => {
    const removed = inv.compareInventory(controls('s', HEADER), controls('s', HEADER.slice(1)));
    expect(removed.ok).toBe(false);
    expect(removed.lines).toEqual([`missing    ${JSON.stringify(HEADER[0])}`]);
    const added = inv.compareInventory(controls('s', HEADER), controls('s', [...HEADER, { tag: 'button', title: 'Command palette' }]));
    expect(added.lines).toEqual(['unexpected {"tag":"button","title":"Command palette"}']);
    const reordered = inv.compareInventory(controls('s', HEADER), controls('s', [HEADER[1], HEADER[0], ...HEADER.slice(2)]));
    expect(reordered.ok).toBe(false);
    const relabeled = inv.compareInventory(controls('s', HEADER), controls('s', [{ ...HEADER[0], title: 'Close sidebar' }, ...HEADER.slice(1)]));
    expect(relabeled.ok).toBe(false);
    expect(relabeled.lines.join('\n')).toContain('Close sidebar');
  });

  it('fails a changed tag, type or placeholder', () => {
    expect(inv.compareInventory(controls('s', HEADER), controls('s', [{ ...HEADER[0], tag: 'div' }, ...HEADER.slice(1)])).ok).toBe(false);
    const search = HEADER.map((c) => (c.tag === 'input' ? { ...c, type: 'search' } : c));
    expect(inv.compareInventory(controls('s', HEADER), controls('s', search)).ok).toBe(false);
    const placeholder = HEADER.map((c) => (c.tag === 'input' ? { ...c, placeholder: 'Search' } : c));
    expect(inv.compareInventory(controls('s', HEADER), controls('s', placeholder)).ok).toBe(false);
  });

  it('allows an aria-label, a title or a pressed state added where the reference had none', () => {
    const named = HEADER.map((c, i) => (i === 5 ? { ...c, aria: 'Expand Production', title: 'Expand Production' } : i === 3 ? { ...c, pressed: 'false', aria: 'Show favorites only' } : c));
    expect(inv.compareInventory(controls('s', HEADER), controls('s', named))).toEqual({ ok: true, lines: [] });
    const changedTitle = HEADER.map((c, i) => (i === 3 ? { ...c, title: 'Favorites' } : c));
    expect(inv.compareInventory(controls('s', HEADER), controls('s', changedTitle)).ok).toBe(false);
    const droppedPressed = HEADER.map((c, i) => (i === 1 ? { ...c, pressed: undefined } : c));
    expect(inv.compareInventory(controls('s', HEADER), controls('s', droppedPressed)).ok).toBe(false);
  });

  it('compares CSS-uppercase reference text without case, and only that', () => {
    const before = controls('s', [{ tag: 'h2', text: 'RECENT VAULTS' }, { tag: 'div', text: 'PRODUCTION', title: 'Production' }]);
    const after = controls('s', [{ tag: 'h2', text: 'Recent Vaults' }, { tag: 'div', text: 'Production', title: 'Production' }]);
    expect(inv.compareInventory(before, after).ok).toBe(true);
    expect(inv.compareInventory(controls('s', [{ tag: 'button', text: 'Save' }]), controls('s', [{ tag: 'button', text: 'SAVE' }])).ok).toBe(false);
  });
});

describe('compareInventory: menus', () => {
  const PLUS: MenuEntry[] = [
    { kind: 'item', label: 'Quick Connect' },
    { kind: 'separator' },
    { kind: 'header', label: 'LOCAL SHELL' },
    { kind: 'item', label: 'Home Directory' },
    { kind: 'submenu', label: 'Open With', children: [{ kind: 'item', label: 'Open External' }] },
  ];

  it('ignores the case of headers but not of items', () => {
    const after = PLUS.map((e) => (e.kind === 'header' ? { ...e, label: 'Local Shell' } : e));
    expect(inv.compareInventory(menu('m', PLUS), menu('m', after)).ok).toBe(true);
    const item = PLUS.map((e) => (e.label === 'Home Directory' ? { ...e, label: 'HOME DIRECTORY' } : e));
    expect(inv.compareInventory(menu('m', PLUS), menu('m', item)).ok).toBe(false);
  });

  it('fails a missing separator, a moved item and a changed submenu', () => {
    expect(inv.compareInventory(menu('m', PLUS), menu('m', PLUS.filter((e) => e.kind !== 'separator'))).ok).toBe(false);
    expect(inv.compareInventory(menu('m', PLUS), menu('m', [PLUS[3], ...PLUS.filter((_, i) => i !== 3)])).ok).toBe(false);
    const sub = PLUS.map((e) => (e.kind === 'submenu' ? { ...e, children: [] } : e));
    expect(inv.compareInventory(menu('m', PLUS), menu('m', sub)).ok).toBe(false);
  });

  it('compares accelerators of the application menu', () => {
    const app: MenuEntry[] = [{ kind: 'submenu', label: 'File', children: [{ kind: 'item', label: 'Open Vault...', accelerator: 'CmdOrCtrl+O' }] }];
    const changed: MenuEntry[] = [{ kind: 'submenu', label: 'File', children: [{ kind: 'item', label: 'Open Vault...', accelerator: 'CmdOrCtrl+P' }] }];
    expect(inv.compareInventory(menu('a', app), menu('a', app)).ok).toBe(true);
    expect(inv.compareInventory(menu('a', app), menu('a', changed)).ok).toBe(false);
  });
});

describe('normalization', () => {
  it('turns times ago, sync states, ports, emails and the vault folder into tokens on both sides', () => {
    const before = controls('s', [
      { tag: 'button', title: 'Up to date. Last synced 4 seconds ago', aria: 'Sync: Up to date' },
      { tag: 'button', text: 'Acme Infrastructure /tmp/cv-4f4fcc/vaults', title: '/tmp/cv-4f4fcc/vaults/Acme Infrastructure.conduit' },
      { tag: 'span', title: 'connect ECONNREFUSED 127.0.0.1:1' },
      { tag: 'button', text: 'Intranet Status 21m ago' },
    ]);
    const after = controls('s', [
      { tag: 'button', title: '1 change not yet synced. Last synced 1 second ago', aria: 'Sync: 1 change not yet synced' },
      { tag: 'button', text: 'Acme Infrastructure /Users/me/run/vaults', title: '/Users/me/run/vaults/Acme Infrastructure.conduit' },
      { tag: 'span', title: 'connect ECONNREFUSED 127.0.0.1:61234' },
      { tag: 'button', text: 'Intranet Status Just now' },
    ]);
    const a = inv.normalizeInventory(before);
    const b = inv.normalizeInventory(after, { vaultDirs: ['/Users/me/run/vaults'] });
    expect(a.items).toEqual(b.items);
    expect(a.items[0]).toEqual({ tag: 'button', title: '<sync-state>. Last synced <ago>', aria: 'Sync: <sync-state>' });
    expect(a.items[1]).toEqual({ tag: 'button', text: 'Acme Infrastructure <vault-dir>', title: '<vault-path>' });
    expect(inv.compareInventory(a, b).ok).toBe(true);
    expect(inv.normalizeText('verify-20260928-163143-c62375-1@conduit.local')).toBe('<user-email>');
  });

  it('is idempotent and keeps only the compared fields', () => {
    const raw = controls('s', [{ tag: 'select', text: 'Off On', value: '0', options: ['Off', 'On'], disabled: true } as unknown as Control]);
    const once = inv.normalizeInventory(raw);
    expect(once.items).toEqual([{ tag: 'select', text: 'Off On' }]);
    expect(inv.normalizeInventory(once)).toEqual(once);
  });
});

const APPEARANCE_BEFORE: Control[] = [
  { tag: 'button', text: 'Account' },
  { tag: 'label', text: 'Platform Theme' },
  { tag: 'button', text: 'Default Conduit Classic' },
  { tag: 'button', text: 'macOS Tahoe Liquid Glass' },
  { tag: 'button', text: '— ☐ ✕ Windows 11 Fluent Design' },
  { tag: 'button', text: 'Ubuntu GNOME / Libadwaita' },
  { tag: 'label', text: 'Color Scheme' },
  { tag: 'button', text: 'Ocean' },
  { tag: 'button', text: 'Ember' },
  { tag: 'label', text: 'Brightness' },
];
const PACK_SECTION: Control[] = [
  { tag: 'label', text: 'Icon pack' },
  { tag: 'button', text: 'Lucide Default Clean line icons · ISC' },
  { tag: 'button', text: 'Phosphor Soft, rounded icons · MIT' },
  { tag: 'button', text: 'Hugeicons Rounded line icons · MIT' },
  { tag: 'button', text: 'Material Symbols Google Material icons · Apache 2.0' },
  { tag: 'button', text: 'Fluent Windows 11 icons · MIT' },
  { tag: 'button', text: 'Tabler (Classic) The classic Conduit icons · MIT' },
];
const PROBE = '[data-cv-appearance="icon-pack"]';
const appearanceAfter = (withPacks: boolean): Control[] => [
  { tag: 'button', text: 'Account' },
  ...(withPacks ? PACK_SECTION : []),
  { tag: 'label', text: 'Color Scheme' },
  { tag: 'button', text: 'Modern' },
  { tag: 'button', text: 'Ocean' },
  { tag: 'button', text: 'Ember' },
  { tag: 'label', text: 'Brightness' },
];

describe('allowed deltas', () => {
  const deltas = ref.loadDeltas();

  it('has the settings-appearance entry with its reasons', () => {
    expect(deltas.map((d) => d.screen)).toEqual(['settings-appearance']);
    expect(deltas[0].reason).toMatch(/OD-7/);
    for (const c of deltas[0].changes) expect(c.reason).toBeTruthy();
  });

  it('passes the Appearance tab with the Icon pack section in the Platform Theme slot', () => {
    const res = inv.compareInventory(controls('settings-appearance', APPEARANCE_BEFORE), controls('settings-appearance', appearanceAfter(true), { [PROBE]: true }), deltas);
    expect(res).toEqual({ ok: true, lines: [] });
  });

  it('fails the Appearance tab without the Icon pack section, now that R1-FOUNDATION has merged', () => {
    const res = inv.compareInventory(controls('settings-appearance', APPEARANCE_BEFORE), controls('settings-appearance', appearanceAfter(false)), deltas);
    expect(res.ok).toBe(false);
    expect(res.lines).toContain(`missing    ${JSON.stringify({ tag: 'label', text: 'Icon pack' })}`);
    const labelOnly = appearanceAfter(true).filter((c) => !PACK_SECTION.slice(1).includes(c));
    expect(inv.compareInventory(controls('settings-appearance', APPEARANCE_BEFORE), controls('settings-appearance', labelOnly), deltas).ok).toBe(false);
  });

  it('fails a reordered section, a missing Modern card, an extra control and a kept Platform Theme block', () => {
    const before = controls('settings-appearance', APPEARANCE_BEFORE);
    const reordered = appearanceAfter(true).map((c) => (c.text?.startsWith('Hugeicons') ? { ...c, text: 'Fluent Windows 11 icons · MIT' } : c.text?.startsWith('Fluent') ? { ...c, text: 'Hugeicons Rounded line icons · MIT' } : c));
    expect(inv.compareInventory(before, controls('settings-appearance', reordered), deltas).ok).toBe(false);
    const noModern = appearanceAfter(true).filter((c) => c.text !== 'Modern');
    expect(inv.compareInventory(before, controls('settings-appearance', noModern), deltas).ok).toBe(false);
    const extra = [...appearanceAfter(true), { tag: 'label', text: 'Density' }];
    expect(inv.compareInventory(before, controls('settings-appearance', extra), deltas).ok).toBe(false);
    const platformKept = [...APPEARANCE_BEFORE];
    expect(inv.compareInventory(before, controls('settings-appearance', platformKept), deltas).ok).toBe(false);
  });

  it('expects the inserted controls of a change with insertWhen exactly when its probe matched', () => {
    const probed: Delta[] = [{ screen: 'settings-appearance', reason: 'probe', changes: [{ reason: 'probe', remove: APPEARANCE_BEFORE.slice(1, 6), insertWhen: PROBE, insert: PACK_SECTION }, deltas[0].changes[1]] }];
    const before = controls('settings-appearance', APPEARANCE_BEFORE);
    expect(inv.compareInventory(before, controls('settings-appearance', appearanceAfter(true), { [PROBE]: true }), probed).ok).toBe(true);
    expect(inv.compareInventory(before, controls('settings-appearance', appearanceAfter(false), { [PROBE]: false }), probed).ok).toBe(true);
    expect(inv.compareInventory(before, controls('settings-appearance', appearanceAfter(true), { [PROBE]: false }), probed).ok).toBe(false);
    expect(inv.compareInventory(before, controls('settings-appearance', appearanceAfter(false), { [PROBE]: true }), probed).ok).toBe(false);
  });

  it('applies deltas only to their screen', () => {
    const res = inv.compareInventory(controls('settings-general', APPEARANCE_BEFORE), controls('settings-general', appearanceAfter(false), { [PROBE]: false }), deltas);
    expect(res.ok).toBe(false);
  });

  it('reports a delta whose removed controls are not in the reference', () => {
    const res = inv.compareInventory(controls('settings-appearance', APPEARANCE_BEFORE.slice(2)), controls('settings-appearance', appearanceAfter(false), { [PROBE]: false }), deltas);
    expect(res.ok).toBe(false);
    expect(res.lines[0]).toMatch(/does not apply/);
  });
});

describe('extraction in the page', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return (this.textContent ?? '').replace(/\s+/g, ' ').trim(); },
    });
    Element.prototype.getClientRects = function (this: Element) {
      return (this.closest('[hidden]') ? [] : [{ x: 0, y: 0, width: 10, height: 10 }]) as unknown as DOMRectList;
    };
  });
  beforeEach(() => { document.body.innerHTML = ''; });

  it('records controls, headings, labels and titled elements in document order with their fields', () => {
    document.body.innerHTML = `<div id="panel"><h2>Settings</h2><button aria-label="Close" title="Close (Esc)"><svg aria-label="x"></svg></button>
      <label>Master Password</label><input type="password" placeholder="Enter master password">
      <button aria-pressed="true" title="Pin">p</button><span title="connected"></span><div>plain</div><button hidden>gone</button>
      <select aria-label="Lock"><option>Off</option>
      <option>After 5 minutes</option></select></div><button>outside</button>`;
    const res = inv.extractControlsInPage({ roots: ['#panel'], probes: ['#panel', '.missing'] });
    expect(res.items.map((i) => ({ ...i, options: undefined, value: undefined })).map((i) => JSON.parse(JSON.stringify(i)))).toEqual([
      { tag: 'h2', text: 'Settings' },
      { tag: 'button', title: 'Close (Esc)', aria: 'Close' },
      { tag: 'svg', aria: 'x' },
      { tag: 'label', text: 'Master Password' },
      { tag: 'input', type: 'password', placeholder: 'Enter master password' },
      { tag: 'button', text: 'p', title: 'Pin', pressed: 'true' },
      { tag: 'span', title: 'connected' },
      { tag: 'select', text: 'Off After 5 minutes', aria: 'Lock' },
    ]);
    expect(res.probes).toEqual({ '#panel': true, '.missing': false });
  });

  it("leaves nested controls out of a label's text and never records the root itself", () => {
    document.body.innerHTML = `<div id="d" aria-label="Recently deleted"><label><input type="checkbox">Show items deleted more than 30 days ago</label>
      <label><span>Resolution</span><select><option>Match Window</option><option>1920 x 1080</option></select></label>
      <label>Password <button title="Show">Show</button></label></div>`;
    const res = inv.extractControlsInPage({ roots: ['#d'], probes: [] });
    expect(res.items.filter((i) => i.tag === 'label').map((i) => i.text)).toEqual(['Show items deleted more than 30 days ago', 'Resolution', 'Password']);
    expect(res.items.some((i) => i.aria === 'Recently deleted')).toBe(false);
  });

  it('resolves last and around roots', () => {
    document.body.innerHTML = `<div data-dialog-content><button>First</button></div><div data-dialog-content><button>Top</button></div>
      <div id="ai"><header><button title="Switch engine">E</button><button title="New conversation">+</button></header><div><textarea aria-label="Terminal input"></textarea></div></div>
      <textarea aria-label="Terminal input"></textarea>`;
    expect(inv.extractControlsInPage({ roots: [{ last: '[data-dialog-content]' }], probes: [] }).items).toEqual([{ tag: 'button', text: 'Top' }]);
    const ai = inv.extractControlsInPage({ roots: [{ around: ['button[title="Switch engine"]', 'button[title="New conversation"]', 'textarea[aria-label="Terminal input"]'] }], probes: [] });
    expect(ai.items.map((i) => i.tag)).toEqual(['button', 'button', 'textarea']);
    expect(inv.extractControlsInPage({ roots: ['#nothing'], probes: [] }).rootsFound).toBe(0);
  });
});

describe('popup menu reader', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  const EXPECTED: MenuEntry[] = [
    { kind: 'item', label: 'Open Session' },
    { kind: 'submenu', label: 'Open With', children: [{ kind: 'item', label: 'Open External' }, { kind: 'item', label: 'Open with Credential…' }] },
    { kind: 'separator' },
    { kind: 'header', label: 'Local Shell' },
    { kind: 'item', label: 'Delete' },
  ];

  it('reads the original menu markup, icons ignored', () => {
    document.body.innerHTML = `<div class="m" style="width:210px"><div class="i"><svg><path d="M0"/></svg><span>Open Session</span></div>
      <div class="i" data-submenu="open_with"><svg></svg><span style="flex:1">Open With</span><svg></svg></div>
      <div style="height:1px;margin:4px 8px"></div><div style="text-transform:uppercase">Local Shell</div>
      <div class="i" style="color:red"><svg></svg><span>Delete</span></div></div>
      <div class="sm" data-for="open_with"><div class="i"><span>Open External</span></div><div class="i"><span>Open with Credential…</span></div></div><script>1</script>`;
    expect(inv.readMenuInPage()).toEqual(EXPECTED);
  });

  it('reads the hardened menu markup', () => {
    document.body.innerHTML = `<div class="m" role="menu"><div class="i" role="menuitem" data-i="0"><span class="ic"><svg></svg></span><span class="l">Open Session</span></div>
      <div class="i" role="menuitem" aria-haspopup="menu" data-sub="0"><span class="ic"></span><span class="l">Open With</span><span class="ch"></span></div>
      <div class="sep" role="separator"></div><div class="hd" role="presentation">Local Shell</div>
      <div class="i d" role="menuitem" data-i="1"><span class="ic"><svg></svg></span><span class="l">Delete</span></div></div>
      <div class="sm" id="s0" role="menu" style="display:none"><div class="i" role="menuitem" data-i="2"><span class="l">Open External</span></div><div class="i" role="menuitem" data-i="3"><span class="l">Open with Credential…</span></div></div>`;
    expect(inv.readMenuInPage()).toEqual(EXPECTED);
  });
});

describe('the reference folder and its manifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restyle ref '));
    fs.writeFileSync(path.join(dir, 'dark-07-main.png'), 'png-7');
    fs.writeFileSync(path.join(dir, 'INVENTORY.txt'), 'text');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes an untouched folder and ignores files the manifest does not list', () => {
    const manifest = ref.buildManifest(dir);
    expect(Object.keys(manifest.files)).toEqual(['INVENTORY.txt', 'dark-07-main.png']);
    fs.writeFileSync(path.join(dir, 'dark-50-new.png'), 'new');
    expect(ref.verifyReferenceFolder(dir, manifest)).toEqual({ ok: true, problems: [] });
  });

  it('fails a missing file, a changed file and a missing folder', () => {
    const manifest = ref.buildManifest(dir);
    fs.rmSync(path.join(dir, 'dark-07-main.png'));
    fs.writeFileSync(path.join(dir, 'INVENTORY.txt'), 'edited');
    expect(ref.verifyReferenceFolder(dir, manifest)).toEqual({ ok: false, problems: ['changed: INVENTORY.txt', 'missing: dark-07-main.png'] });
    expect(ref.verifyReferenceFolder(path.join(dir, 'gone'), manifest).ok).toBe(false);
  });

  it('takes --before, else CONDUIT_RESTYLE_BEFORE, else the lasting folder', () => {
    expect(ref.beforeDir({ before: '/a' }, { CONDUIT_RESTYLE_BEFORE: '/b' })).toBe('/a');
    expect(ref.beforeDir({ before: null }, { CONDUIT_RESTYLE_BEFORE: '/b' })).toBe('/b');
    expect(ref.beforeDir({}, {})).toBe(ref.DEFAULT_BEFORE_DIR);
    expect(ref.DEFAULT_BEFORE_DIR).toBe(path.join(os.homedir(), '.conduit-verify', 'restyle-before'));
  });

  it('parses reference shot names', () => {
    expect(ref.parseShotName('dark-10b-zoom-tabbars-sidebar-closed.png')).toEqual({ mode: 'dark', nn: '10b', name: '10b-zoom-tabbars-sidebar-closed', file: 'dark-10b-zoom-tabbars-sidebar-closed.png' });
    expect(ref.parseShotName('INVENTORY.txt')).toBeNull();
  });
});

const { createRestyleSession } = (await import('../verify/lib/restyle-session.mjs' as string)) as {
  createRestyleSession(ctx: unknown, id: string, opts: { shots: string[] }): unknown;
};

describe('a restyle scenario', () => {
  it('fails at once when a file of the manifest is missing or changed in the reference folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restyle before '));
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restyle run '));
    try {
      const ctx = { options: { strict: false, before: dir }, run: { runDir }, step: () => {} };
      expect(() => createRestyleSession(ctx, 'screens', { shots: [] })).toThrow(/does not match fixtures\/restyle\/before-manifest\.json[\s\S]*missing: dark-00-auth-screen\.png/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('the committed reference', () => {
  const manifest = ref.loadManifest();
  const before = ref.loadBeforeInventory();

  it('lists the 124 original shots, shots 44 to 49 in both modes and the inventory files', () => {
    const names = Object.keys(manifest.files);
    expect(names.filter((n) => n.endsWith('.png'))).toHaveLength(136);
    for (const nn of ['44', '45', '46', '47', '48', '49']) {
      expect(names.filter((n) => n.startsWith(`dark-${nn}-`) || n.startsWith(`light-${nn}-`))).toHaveLength(2);
    }
    expect(names).toEqual(expect.arrayContaining(['INVENTORY.txt', 'INVENTORY-raw.json']));
    for (const hash of Object.values(manifest.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has a reference inventory for every screen of every scenario, and nothing else', () => {
    const wanted = Object.values(screens.SCENARIOS).flatMap((s) => s.screens).sort();
    expect(Object.keys(before.screens).sort()).toEqual([...new Set(wanted)].sort());
    for (const name of screens.MENU_SCREENS) expect(before.screens[name].kind).toBe('menu');
    for (const name of Object.keys(screens.SCREENS)) expect(before.screens[name].kind).toBe('controls');
  });

  it('names a reference shot for every shot a scenario takes', () => {
    const shots = new Set(Object.keys(manifest.files).map(ref.parseShotName).filter(Boolean).map((s) => s!.name));
    for (const [id, scenario] of Object.entries(screens.SCENARIOS)) {
      for (const shot of scenario.shots) expect(shots.has(shot), `${id}: ${shot}`).toBe(true);
    }
    const covered = new Set(Object.values(screens.SCENARIOS).flatMap((s) => s.shots));
    expect([...shots].filter((s) => !covered.has(s))).toEqual([]);
  });

  it('holds normalized screens only', () => {
    for (const [name, screen] of Object.entries(before.screens)) {
      const normal = inv.normalizeInventory({ screen: name, kind: screen.kind as 'controls' | 'menu', items: screen.items as Control[] });
      expect(normal.items, name).toEqual(screen.items);
    }
  });
});

describe('geometry rules', () => {
  const r = (rule: string, status: string): RuleResult => ({ rule, status, detail: '' });

  it('counts a pending rule as a failure only with --strict', () => {
    const entries = [{ screen: 'dark 07', results: [r('G1', 'pass'), r('G5', 'pending'), r('G8', 'n/a')] }];
    expect(geo.summarizeRules(entries)).toMatchObject({ failed: 0, pending: 1 });
    const strict = geo.summarizeRules(entries, { strict: true });
    expect(strict).toMatchObject({ failed: 1, pending: 1 });
    expect(strict.lines).toContain('dark 07  G5  FAIL (pending, --strict)');
    expect(geo.summarizeRules([{ screen: 's', results: [r('G2', 'fail')] }]).failed).toBe(1);
  });

  // jsdom has no layout: each element's box comes from data-r="left,top,width,height".
  let restore: (() => void) | null = null;
  beforeAll(() => {
    const rects = Element.prototype.getBoundingClientRect;
    const clientRects = Element.prototype.getClientRects;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const [left, top, width, height] = (this.getAttribute('data-r') ?? '0,0,0,0').split(',').map(Number);
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; } } as DOMRect;
    };
    Element.prototype.getClientRects = function (this: Element) {
      return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList;
    };
    restore = () => {
      Element.prototype.getBoundingClientRect = rects;
      Element.prototype.getClientRects = clientRects;
    };
  });
  afterEach(() => { document.body.innerHTML = ''; });
  afterAll(() => restore?.());

  const run = () => Object.fromEntries(((0, eval)(geo.domRulesSource()) as RuleResult[]).map((x) => [x.rule, x]));
  const TODAY = `<div data-sidebar-panel data-docked data-r="0,2,250,766"><button title="Home"></button></div>
    <div><div data-tabbar data-r="250,2,1030,36"><div draggable="true">Terminal</div><button title="New Local Shell"></button><button title="Toggle AI Panel"></button></div></div>`;

  it("reports pending on today's markup, passes G4 and fails a clone part", () => {
    document.body.innerHTML = TODAY;
    const statuses = Object.fromEntries(Object.entries(run()).map(([k, v]) => [k, v.status]));
    expect(statuses).toEqual({ G2: 'pass', G3: 'pending', G4: 'pass', G5: 'pending', G6: 'pending', G7: 'pending', G8: 'n/a', G10: 'pending' });
    const clone = CLONE_SELECTORS.find((css) => /^\[data-cv-[a-z-]+\]$/.test(css))!;
    const clonePart = document.createElement('div');
    clonePart.setAttribute(clone.slice(1, -1), '');
    document.body.appendChild(clonePart);
    expect(run().G2).toEqual({ rule: 'G2', status: 'fail', detail: `found ${clone}` });
  });

  it('checks the docked width against the stored width and the floating side bar at 0, 0', () => {
    document.body.innerHTML = TODAY.replace('0,2,250,766', '0,2,300,766');
    expect(run().G4.status).toBe('fail');
    localStorage.setItem('conduit:sidebar-width', '300');
    expect(run().G4.status).toBe('pass');
    localStorage.removeItem('conduit:sidebar-width');
    document.body.innerHTML = '<div data-sidebar-panel style="position: fixed" data-r="0,0,250,768"></div>';
    expect(run().G4.status).toBe('pass');
    document.body.innerHTML = '<div data-sidebar-panel style="position: fixed" data-r="0,40,250,728"></div>';
    expect(run().G4.status).toBe('fail');
  });

  it('checks the hooked tab bar: 33px at the pane top with its slots, and tabs inside it', () => {
    const bar = (height: number, plusSlot: string) => `<div data-r="250,2,1030,766"><div data-tabbar data-r="250,2,1030,${height}">
      <div class="cv-tabstrip-slot" data-r="250,2,44,${height}"><button data-cv-sidebar-toggle data-r="250,2,44,${height}"></button></div>
      <div data-cv-tab data-r="294,6,120,24">Terminal<button class="cv-tab-close" data-r="396,10,16,16"></button></div>
      <div class="cv-tabstrip-slot" data-r="${plusSlot}"><button data-cv-new-tab></button><button data-cv-ai-toggle title="Toggle AI Panel"></button></div></div></div>`;
    document.body.innerHTML = bar(33, '1200,2,80,33');
    expect(run().G5.status).toBe('pass');
    expect(run().G10.status).toBe('pass');
    document.body.innerHTML = bar(36, '1200,2,80,36');
    expect(run().G5.status).toBe('fail');
    document.body.innerHTML = bar(33, '1100,2,80,33');
    expect(run().G5.detail).toContain('+ is not in the last slot at the right edge');
    document.body.innerHTML = bar(33, '1200,2,80,33').replace('396,10,16,16', '410,10,16,16');
    expect(run().G10.status).toBe('fail');
  });

  it('checks the side bar order once the header and footer carry their hooks', () => {
    document.body.innerHTML = `<div data-sidebar-panel data-docked data-r="0,2,250,766"><div data-cv-sidebar-header data-r="0,2,250,33"></div>
      <div data-cv-sidebar-search data-r="0,35,250,40"></div><div data-cv-sidebar-footer data-r="0,700,250,68"></div></div>`;
    expect(run().G7.status).toBe('pass');
    document.body.innerHTML = document.body.innerHTML.replace('0,700,250,68', '0,600,250,68');
    expect(run().G7.status).toBe('fail');
  });

  it('checks the AI divider and panel close their row', () => {
    document.body.innerHTML = `<div><div data-r="0,0,876,768"></div><div data-cv-ai-divider data-r="876,0,4,768"></div><div data-cv-ai-panel data-r="880,0,400,768"><button title="New conversation"></button></div></div>`;
    expect(run().G8.status).toBe('pass');
    document.body.innerHTML = `<div><div data-cv-ai-divider data-r="876,0,4,768"></div><div data-cv-ai-panel data-r="880,0,400,768"><button title="New conversation"></button></div><div data-r="0,0,1,1"></div></div>`;
    expect(run().G8.status).toBe('fail');
    document.body.innerHTML = '<div><button title="New conversation"></button></div>';
    expect(run().G8.status).toBe('pending');
  });

  it('reports the twelve-tab check pending without data-cv-tab', () => {
    document.body.innerHTML = '<div data-tabbar><div draggable="true">Terminal</div></div>';
    expect(geo.twelveTabsInPage({ minWidth: 78 }).status).toBe('pending');
  });

  it('keeps every clone selector that invariant L-20 of the spec names', () => {
    const spec = fs.readFileSync(path.resolve(__dirname, '../../docs/VISUAL_REDESIGN.md'), 'utf8');
    const row = spec.split('\n').find((line) => line.startsWith('| L-20 |')) ?? '';
    const named = [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const css of named) expect(CLONE_SELECTORS).toContain(css);
  });
});

describe('the reference look', () => {
  it('pins Ocean, Tabler and the migration version only when recording', () => {
    expect(flows.lookSettings('dark', {})).toEqual({ theme: 'dark' });
    expect(flows.lookSettings('light', { CONDUIT_RESTYLE_REFERENCE_LOOK: '1' })).toEqual({ theme: 'light', color_scheme: 'ocean', icon_pack: 'tabler', appearance_version: 2 });
  });
});

describe('app windows and web sessions', () => {
  const DEV = 'http://localhost:54798';
  const page = (url: string, pack: string | null): FakePage => ({ url: () => url, evaluate: async () => pack });

  it('takes only pages of the dev server for the app windows', () => {
    expect(capture.windowRole(`${DEV}/`, DEV)).toBe('main');
    expect(capture.windowRole(`${DEV}/?view=main#x`, DEV)).toBe('main');
    expect(capture.windowRole(`${DEV}/overlay.html`, DEV)).toBe('overlay');
    expect(capture.windowRole(`${DEV}/picker.html`, DEV)).toBe('picker');
    expect(capture.windowRole(`${DEV}/gallery.html`, DEV)).toBe('other');
    expect(capture.windowRole('data:text/html;charset=utf-8,<menu>', DEV)).toBe('menu');
    expect(capture.windowRole('http://127.0.0.1:54803/', DEV)).toBe('other');
    expect(capture.windowRole('http://localhost:547980/', DEV)).toBe('other');
  });

  it('reads the main window from device.page, never from a web session page at the root of its own origin', async () => {
    const main = page(`${DEV}/`, 'lucide');
    const device = { name: 'd', page: main, app: { windows: () => [main, page('http://127.0.0.1:54803/', null), page(`${DEV}/overlay.html`, 'lucide')] } };
    expect(await flows.iconPackAttributes(device)).toEqual({ main: 'lucide', overlay: 'lucide' });
    const picker = { ...device, app: { windows: () => [page('http://127.0.0.1:54803/', null), main, page(`${DEV}/picker.html`, 'hugeicons')] } };
    expect(await flows.iconPackAttributes(picker)).toEqual({ main: 'lucide', picker: 'hugeicons' });
  });
});

describe('the picker icon check of the packs scenario', () => {
  const six = (make: (i: number) => string | null) => Array.from({ length: 6 }, (_, i) => make(i));

  it('passes six different icon sets, defers one set for all packs, and fails anything else', () => {
    expect(flows.pickerGlyphResult(six((i) => `<svg id="${i}"></svg>`)).status).toBe('pass');
    const same = flows.pickerGlyphResult(six(() => '<svg></svg>'));
    expect(same.status).toBe('deferred');
    expect(same.detail).toMatch(/R3-PICKER/);
    expect(flows.pickerGlyphResult(six((i) => `<svg id="${i % 3}"></svg>`)).status).toBe('fail');
    expect(flows.pickerGlyphResult(six((i) => (i === 2 ? null : `<svg id="${i}"></svg>`))).status).toBe('fail');
  });

  it('lists a deferred result without counting it, even with --strict', () => {
    const entries = [{ screen: 'dark picker icons', results: [{ rule: 'packs', status: 'deferred', detail: 'until R3-PICKER' }] }];
    for (const strict of [false, true]) {
      const summary = geo.summarizeRules(entries, { strict });
      expect(summary.failed).toBe(0);
      expect(summary.pending).toBe(0);
      expect(summary.lines).toEqual(['dark picker icons  packs  DEFERRED  until R3-PICKER']);
    }
  });
});
