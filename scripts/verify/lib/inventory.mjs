// Layout inventories for the restyle suite (docs/VISUAL_REDESIGN.md 8.6 step 3): every visible
// control of a screen region in document order, popup menus as a tree, the native application menu,
// the normalization both sides go through, and the comparison against the reference with the allowed
// deltas of fixtures/restyle/allowed-deltas.json.

import { mainEval, waitFor, withTimeout } from './ui.mjs';

/** The fields a control is compared on. Captures also keep disabled, checked, value and options. */
export const INVENTORY_FIELDS = Object.freeze(['tag', 'text', 'title', 'aria', 'pressed', 'type', 'placeholder']);
const ADDABLE = new Set(['title', 'aria', 'pressed']);
const PAGE_CALL_TIMEOUT_MS = 15_000;

/**
 * In-page: the visible controls under `roots` and whether each `probes` selector matches a visible
 * element. A root is a CSS selector (every visible match), {last: css} (the last visible match, the
 * topmost dialog), or {around: [css, ...]} (the nearest ancestor of the first selector's match that
 * also holds a match of every other one); a root itself is never recorded, only what is inside it.
 * null roots mean the whole body. Self-contained for page.evaluate.
 */
export function extractControlsInPage({ roots, probes }) {
  const CANDIDATES = 'h1,h2,h3,button,input,select,textarea,label,[title],[aria-label]';
  const NESTED = 'button,input,select,textarea';
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ownLabelText = (label) => {
    let text = label.innerText ?? '';
    for (const nested of label.querySelectorAll(NESTED)) {
      const inner = nested.innerText ?? '';
      if (inner.trim() !== '') text = text.replace(inner, ' ');
    }
    return clean(text);
  };
  const record = (el) => {
    const tag = el.tagName.toLowerCase();
    const item = { tag };
    const text = tag === 'label' ? ownLabelText(el) : clean(el.innerText);
    if (text) item.text = text;
    const title = el.getAttribute('title');
    if (title) item.title = title;
    const aria = el.getAttribute('aria-label');
    if (aria) item.aria = aria;
    const pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) item.pressed = pressed;
    if (tag === 'input') item.type = el.type;
    const placeholder = (tag === 'input' || tag === 'textarea') ? el.getAttribute('placeholder') : null;
    if (placeholder) item.placeholder = placeholder;
    if (el.disabled === true) item.disabled = true;
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) item.checked = el.checked;
    if (tag === 'select') {
      item.value = el.value;
      item.options = [...el.options].map((o) => clean(o.textContent));
    }
    return item;
  };
  const matches = (css) => [...document.querySelectorAll(css)].filter(visible);
  const around = ([first, ...others]) => {
    for (let el = matches(first)[0]?.parentElement ?? null; el; el = el.parentElement) {
      if (others.every((css) => [...el.querySelectorAll(css)].some(visible))) return [el];
    }
    return [];
  };
  const resolve = (root) => {
    if (typeof root === 'string') return matches(root);
    if (root.last) return matches(root.last).slice(-1);
    if (root.around) return around(root.around);
    return [];
  };
  const scopes = roots === null ? [document.body] : roots.flatMap(resolve);
  const seen = new Set();
  const items = [];
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll(CANDIDATES)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (visible(el)) items.push(record(el));
    }
  }
  const probeResults = Object.fromEntries((probes ?? []).map((css) => [css, [...document.querySelectorAll(css)].some(visible)]));
  return { rootsFound: scopes.length, items, probes: probeResults };
}

/**
 * Records screen `screen` ({name, roots, probes}) on the device's main page:
 * {screen, kind: 'controls', items, probes}. Throws when none of the roots is on the page.
 */
export async function captureInventory(device, screen) {
  const roots = screen.roots ?? null;
  const res = await withTimeout(
    device.page.evaluate(extractControlsInPage, { roots, probes: screen.probes ?? [] }),
    PAGE_CALL_TIMEOUT_MS,
    `${device.name}: inventory ${screen.name}`,
  );
  if (res.rootsFound === 0) throw new Error(`${device.name}: inventory ${screen.name}: no element matches ${JSON.stringify(roots)}`);
  return { screen: screen.name, kind: 'controls', items: res.items, probes: res.probes };
}

/**
 * In-page, inside a popup menu window: the menu as [{kind, label, children}]. Reads both the original
 * markup (.m panel, .i items, .sm[data-for] submenus) and the hardened one (role=menu, .hd, .sep,
 * [data-sub] and #s<k> submenus). Icons and styles are ignored.
 */
export function readMenuInPage() {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const panel = document.querySelector('.m') ?? document.querySelector('[role=menu]');
  if (!panel) return null;
  const submenuPanel = (id) => document.querySelector(`.sm[data-for="${CSS.escape(id)}"]`) ?? document.getElementById(`s${id}`);
  const entry = (el) => {
    if (el.matches('[role=separator], .sep')) return { kind: 'separator' };
    if (!el.matches('.i, [role=menuitem]')) {
      const text = clean(el.textContent);
      return text ? { kind: 'header', label: text } : { kind: 'separator' };
    }
    const labelEl = el.querySelector('.l') ?? el.querySelector('span');
    const label = clean((labelEl ?? el).textContent);
    const sub = el.getAttribute('data-submenu') ?? el.getAttribute('data-sub');
    if (sub === null) return { kind: 'item', label };
    const subPanel = submenuPanel(sub);
    return { kind: 'submenu', label, children: subPanel ? read(subPanel) : [] };
  };
  const read = (root) => [...root.children].filter((el) => el.tagName !== 'SCRIPT').map(entry);
  return read(panel);
}

const isMenuPage = (page) => page.url().startsWith('data:text/html');

/** The open popup menu window's page, or null. */
export function menuPage(device) {
  return device.app.windows().find(isMenuPage) ?? null;
}

/** Waits for the popup menu window and returns {page, items}. */
export async function captureMenu(device, { timeoutMs = 10_000 } = {}) {
  return waitFor(async () => {
    const page = menuPage(device);
    if (!page) return null;
    const items = await withTimeout(page.evaluate(readMenuInPage), 5_000, `${device.name}: read popup menu`);
    return items && items.length > 0 ? { page, items } : null;
  }, { timeoutMs, label: `${device.name}: popup menu window` });
}

/** Closes every popup menu window (the menu resolves as dismissed). */
export function closeMenus(device) {
  return mainEval(device, ({ BrowserWindow }) => {
    let closed = 0;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents.getURL().startsWith('data:text/html')) {
        w.close();
        closed += 1;
      }
    }
    return closed;
  }, undefined, { label: 'close popup menus' });
}

/** The native application menu: [{kind, label, accelerator?, children?}] from Menu.getApplicationMenu(). */
export function captureAppMenu(device) {
  return mainEval(device, ({ Menu }) => {
    const read = (menu) => menu.items.filter((it) => it.visible !== false).map((it) => {
      if (it.type === 'separator') return { kind: 'separator' };
      const accelerator = it.accelerator || (typeof it.getDefaultRoleAccelerator === 'function' ? it.getDefaultRoleAccelerator() : undefined);
      const base = accelerator ? { label: it.label, accelerator: String(accelerator) } : { label: it.label };
      return it.submenu ? { kind: 'submenu', ...base, children: read(it.submenu) } : { kind: 'item', ...base };
    });
    const menu = Menu.getApplicationMenu();
    return menu ? read(menu) : [];
  }, undefined, { label: 'read application menu' });
}

// ---------- normalization ----------

const DEFAULT_VAULT_DIRS = [/\/(?:private\/)?tmp\/cv-[0-9a-f]{6}(?:\/[a-z][a-z0-9-]{0,11})?\/vaults/g];

const TEXT_RULES = [
  [/<vault-dir>\/[^\n]*?\.conduit\b/g, '<vault-path>'],
  [/\b(localhost|127\.0\.0\.1|\[::1\]):\d+\b/g, '$1:<port>'],
  [/\b\d+ (?:second|minute|hour|day)s? ago\b/g, '<ago>'],
  [/\b\d+[smhd] ago\b/g, '<ago>'],
  [/\bjust now\b/gi, '<ago>'],
  [/\bverify-[\w.-]+@conduit\.local\b/g, '<user-email>'],
  [/\bUp to date\b/g, '<sync-state>'],
  [/\b\d+ changes? not yet synced\b/g, '<sync-state>'],
];

/** One string through the rules: the vault directory, vault paths, ports, times ago and sync states. */
export function normalizeText(text, { vaultDirs = [] } = {}) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const dir of vaultDirs) out = out.split(dir).join('<vault-dir>');
  for (const re of DEFAULT_VAULT_DIRS) out = out.replace(re, '<vault-dir>');
  for (const [re, to] of TEXT_RULES) out = out.replace(re, to);
  return out;
}

function normalizeControl(item, opts) {
  const out = {};
  for (const field of INVENTORY_FIELDS) {
    if (item[field] !== undefined && item[field] !== null && item[field] !== '') out[field] = normalizeText(item[field], opts);
  }
  return out;
}

function normalizeMenuEntry(entry, opts) {
  const out = { kind: entry.kind };
  if (entry.kind === 'separator') return out;
  out.label = normalizeText(entry.label, opts);
  if (entry.accelerator) out.accelerator = entry.accelerator;
  if (entry.kind === 'submenu') out.children = (entry.children ?? []).map((c) => normalizeMenuEntry(c, opts));
  return out;
}

/**
 * The comparable form of a capture or a reference screen ({screen, kind, items, probes}): controls
 * keep only INVENTORY_FIELDS, menus only kind, label, accelerator and children, and every string goes
 * through normalizeText. `vaultDirs` are the run's vault directories. Idempotent.
 */
export function normalizeInventory(inv, { vaultDirs = [] } = {}) {
  const opts = { vaultDirs: vaultDirs.map(String) };
  const norm = inv.kind === 'menu' ? (e) => normalizeMenuEntry(e, opts) : (c) => normalizeControl(c, opts);
  return { screen: inv.screen, kind: inv.kind, items: inv.items.map(norm), ...(inv.probes ? { probes: inv.probes } : {}) };
}

// ---------- comparison ----------

const hasLower = (s) => /\p{Ll}/u.test(s);
const hasLetter = (s) => /\p{L}/u.test(s);

/** Text rule: exact, a textStartsWith pattern, or case-insensitive when the reference text is all caps (CSS uppercase). */
function textMatches(expected, actual) {
  if (expected.textStartsWith !== undefined) return typeof actual.text === 'string' && actual.text.startsWith(expected.textStartsWith);
  if (expected.text === actual.text) return true;
  if (typeof expected.text !== 'string' || typeof actual.text !== 'string') return false;
  return hasLetter(expected.text) && !hasLower(expected.text) && actual.text.toUpperCase() === expected.text;
}

/** True when control `actual` is the reference control `expected` under the rules of 8.6 step 3. */
export function controlMatches(expected, actual) {
  if (expected.tag !== actual.tag || !textMatches(expected, actual)) return false;
  return INVENTORY_FIELDS.filter((f) => f !== 'tag' && f !== 'text').every((f) => {
    if (expected[f] === actual[f]) return true;
    return ADDABLE.has(f) && expected[f] === undefined;
  });
}

/** Menu entries: same kind, label (headers ignore case), accelerator and children. */
export function menuEntryMatches(expected, actual) {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'separator') return true;
  const label = expected.kind === 'header' ? expected.label?.toUpperCase() === actual.label?.toUpperCase() : expected.label === actual.label;
  if (!label || (expected.accelerator ?? null) !== (actual.accelerator ?? null)) return false;
  if (expected.kind !== 'submenu') return true;
  const [a, b] = [expected.children ?? [], actual.children ?? []];
  return a.length === b.length && a.every((e, i) => menuEntryMatches(e, b[i]));
}

/** Longest common subsequence alignment of two lists: [{expected?, actual?}] in order. */
function align(expected, actual, eq) {
  const n = expected.length;
  const m = actual.length;
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = eq(expected[i], actual[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let [i, j] = [0, 0];
  while (i < n || j < m) {
    if (i < n && j < m && eq(expected[i], actual[j])) out.push({ expected: expected[i++], actual: actual[j++] });
    else if (j < m && (i === n || table[i][j + 1] >= table[i + 1][j])) out.push({ actual: actual[j++] });
    else out.push({ expected: expected[i++] });
  }
  return out;
}

const show = (x) => JSON.stringify(x);

function findRun(list, patterns) {
  for (let i = 0; i + patterns.length <= list.length; i++) {
    if (patterns.every((p, k) => controlMatches(p, list[i + k]) && (p.text === undefined || list[i + k].text === p.text))) return i;
  }
  return -1;
}

/**
 * The reference list with `screen`'s deltas applied: {expected, problems}. A change `remove`s a run
 * of reference controls and puts `insert` in its place, or inserts before `insertBefore`; with
 * `insertWhen`, the inserted controls are expected only when that selector probed true.
 */
export function applyDeltas(items, deltas, screen, probes = {}) {
  let expected = [...items];
  const problems = [];
  for (const delta of deltas.filter((d) => d.screen === screen)) {
    for (const change of delta.changes ?? []) {
      const include = change.insertWhen === undefined || probes[change.insertWhen] === true;
      const insert = include ? (change.insert ?? []) : [];
      if (change.remove) {
        const at = findRun(expected, change.remove);
        if (at < 0) {
          problems.push(`delta "${change.reason ?? delta.reason}" does not apply: ${show(change.remove)} is not in the reference`);
          continue;
        }
        expected = [...expected.slice(0, at), ...insert, ...expected.slice(at + change.remove.length)];
      } else if (change.insertBefore) {
        const at = findRun(expected, [change.insertBefore]);
        if (at < 0) {
          problems.push(`delta "${change.reason ?? delta.reason}" does not apply: no ${show(change.insertBefore)} in the reference`);
          continue;
        }
        expected = [...expected.slice(0, at), ...insert, ...expected.slice(at)];
      }
    }
  }
  return { expected, problems };
}

/**
 * Compares a capture with its reference, both {screen, kind, items} (the capture with its probes),
 * after normalizeInventory. Returns {ok, lines}: one line per missing, unexpected or changed control.
 */
export function compareInventory(before, after, deltas = []) {
  if (before.screen !== after.screen) throw new Error(`compareInventory: screens differ (${before.screen} and ${after.screen})`);
  if (before.kind !== after.kind) return { ok: false, lines: [`${before.screen}: reference is a ${before.kind} list, capture a ${after.kind} list`] };
  const { expected, problems } = before.kind === 'menu'
    ? { expected: before.items, problems: [] }
    : applyDeltas(before.items, deltas, before.screen, after.probes ?? {});
  const eq = before.kind === 'menu' ? menuEntryMatches : controlMatches;
  const lines = [...problems];
  for (const step of align(expected, after.items, eq)) {
    if (step.expected && step.actual) continue;
    if (step.expected) lines.push(`missing    ${show(step.expected)}`);
    else lines.push(`unexpected ${show(step.actual)}`);
  }
  return { ok: lines.length === 0, lines };
}

