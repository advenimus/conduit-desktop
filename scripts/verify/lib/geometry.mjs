// Geometry rules G1 to G10 of the restyle suite (docs/VISUAL_REDESIGN.md 8.6 step 4). Each rule
// reports pass, fail, pending (the hooks it needs are not in the markup yet) or n/a (nothing on the
// screen for it to check). --strict turns pending into a failure.

import { CLONE_SELECTORS } from './clone-selectors.mjs';
import { mainEval, withTimeout } from './ui.mjs';
import { listWindows } from './window-capture.mjs';

export const RULES = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']);
export const STRIP_HEIGHT = 33;
export const TAB_MIN_WIDTH = 78;
const AI_PANEL_DEFAULT = 400;
const FREEZE_SETTLE_MS = 3_000;

// ---------- in-page rules: each ships as source next to ruleHelpers, so none may use module scope ----------

/** In-page: what every DOM rule shares, and the facts of the current screen. */
export function ruleHelpers(arg) {
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (css, root = document) => [...root.querySelectorAll(css)].filter(visible);
  const rect = (el) => el.getBoundingClientRect();
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  const px = (n) => `${Math.round(n * 10) / 10}px`;
  const result = (rule, status, detail = '') => ({ rule, status, detail });
  const part = (name, status, detail = '') => ({ part: name, status, detail });
  const combine = (rule, parts) => {
    const status = parts.some((p) => p.status === 'fail') ? 'fail'
      : parts.some((p) => p.status === 'pending') ? 'pending'
        : parts.some((p) => p.status === 'pass') ? 'pass' : 'n/a';
    return result(rule, status, parts.filter((p) => p.status !== 'n/a').map((p) => `${p.part}: ${p.status}${p.detail ? ` (${p.detail})` : ''}`).join('; '));
  };
  const panel = all('[data-sidebar-panel]')[0] ?? null;
  const tabbars = all('[data-tabbar]');
  const screen = {
    panel,
    docked: panel?.hasAttribute('data-docked') ?? false,
    tabbars,
    hooked: tabbars.filter((bar) => bar.querySelector('[data-cv-new-tab]')),
    aiOpen: all('button[title="New conversation"]').length > 0 || all('[data-cv-ai-panel]').length > 0,
    mainLayout: tabbars.length > 0,
  };
  return { ...arg, visible, all, rect, near, px, result, part, combine, screen };
}

/** G2: none of the clone's parts exists. */
export function ruleG2(h) {
  const clones = h.cloneSelectors.filter((css) => document.querySelector(css));
  return h.result('G2', clones.length === 0 ? 'pass' : 'fail', clones.length === 0 ? '' : `found ${clones.join(', ')}`);
}

/** G3: the main accent line (2px, full width, first row, --c-accent) and the floating side bar's own line. */
export function ruleG3(h) {
  const { panel, docked, mainLayout } = h.screen;
  const parts = [];
  if (mainLayout) {
    const line = h.all('[data-cv-accent-line]').find((el) => !el.closest('[data-sidebar-panel]'));
    if (!line) parts.push(h.part('main line', 'pending', 'no [data-cv-accent-line] outside the side bar'));
    else {
      const r = h.rect(line);
      const probe = document.createElement('div');
      probe.style.background = 'var(--c-accent)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const color = getComputedStyle(line).backgroundColor;
      const ok = h.near(r.height, 2, 0.5) && h.near(r.width, document.documentElement.clientWidth) && h.near(r.top, 0) && color === accent;
      parts.push(h.part('main line', ok ? 'pass' : 'fail', ok ? '' : `top ${h.px(r.top)} ${h.px(r.width)} x ${h.px(r.height)}, ${color} vs --c-accent ${accent}`));
    }
  }
  if (panel && !docked) {
    const line = h.all('[data-cv-accent-line]', panel)[0];
    if (!line) parts.push(h.part('floating line', 'pending', 'no [data-cv-accent-line] in the floating side bar'));
    else {
      const r = h.rect(line);
      const ok = h.near(r.height, 2, 0.5) && h.near(r.top, h.rect(panel).top);
      parts.push(h.part('floating line', ok ? 'pass' : 'fail', ok ? '' : `top ${h.px(r.top)}, height ${h.px(r.height)}`));
    }
  }
  return h.combine('G3', parts);
}

/** G4: the docked side bar at x 0 with its stored width; the floating one fixed at 0, 0. */
export function ruleG4(h) {
  const { panel, docked } = h.screen;
  if (!panel) return h.result('G4', 'n/a', 'no side bar');
  const r = h.rect(panel);
  if (!docked) {
    const position = getComputedStyle(panel).position;
    const ok = position === 'fixed' && h.near(r.left, 0) && h.near(r.top, 0);
    return h.result('G4', ok ? 'pass' : 'fail', `floating (${position}) at ${h.px(r.left)}, ${h.px(r.top)}`);
  }
  let stored = NaN;
  try {
    stored = parseInt(localStorage.getItem('conduit:sidebar-width') ?? '', 10);
  } catch {
    stored = NaN;
  }
  const width = Number.isFinite(stored) ? Math.min(Math.max(stored, 200), 500) : 250;
  const ok = h.near(r.left, 0) && h.near(r.width, width);
  return h.result('G4', ok ? 'pass' : 'fail', `docked at x ${h.px(r.left)}, ${h.px(r.width)} wide (stored ${width})`);
}

/** G5: each tab bar with [data-cv-new-tab] is 33px at its pane's top, with the toggle and + in its end slots. */
export function ruleG5(h) {
  const { hooked, mainLayout } = h.screen;
  const parts = [];
  if (mainLayout && hooked.length === 0) parts.push(h.part('tab bars', 'pending', 'no [data-cv-new-tab]'));
  for (const bar of hooked) {
    const r = h.rect(bar);
    const slots = [...bar.querySelectorAll('.cv-tabstrip-slot')];
    const [first, last] = [slots[0], slots[slots.length - 1]];
    const problems = [];
    if (!h.near(r.height, h.stripHeight)) problems.push(`height ${h.px(r.height)}`);
    if (!h.near(r.top, h.rect(bar.parentElement).top)) problems.push(`top ${h.px(r.top)} is not the pane's top`);
    const toggle = bar.querySelector('[data-cv-sidebar-toggle]');
    if (toggle && (!first || !first.contains(toggle) || !h.near(h.rect(first).left, r.left))) problems.push('the side bar toggle is not in the first slot at the left edge');
    if (!last || !last.contains(bar.querySelector('[data-cv-new-tab]')) || !h.near(h.rect(last).right, r.right)) problems.push('+ is not in the last slot at the right edge');
    parts.push(h.part('tab bar', problems.length === 0 ? 'pass' : 'fail', problems.join(', ')));
  }
  if (h.all('button[title="Toggle AI Panel"]').length > 0 || h.all('[data-cv-ai-toggle]').length > 0) {
    const toggles = h.all('[data-cv-ai-toggle]');
    if (toggles.length === 0) parts.push(h.part('AI toggle', 'pending', 'no [data-cv-ai-toggle]'));
    else {
      const misplaced = toggles.filter((t) => {
        const slots = [...(t.closest('[data-tabbar]')?.querySelectorAll('.cv-tabstrip-slot') ?? [])];
        return slots.length === 0 || !slots[slots.length - 1].contains(t);
      });
      parts.push(h.part('AI toggle', toggles.length === 1 && misplaced.length === 0 ? 'pass' : 'fail', `${toggles.length} toggle(s), ${misplaced.length} outside the last slot`));
    }
  }
  return h.combine('G5', parts);
}

/** G6: the side bar header, the top-row tab bars and the AI header are 33px and share one bottom edge. */
export function ruleG6(h) {
  const { panel, docked, hooked, mainLayout, aiOpen } = h.screen;
  const parts = [];
  const height = (name, el) => parts.push(h.part(name, h.near(h.rect(el).height, h.stripHeight) ? 'pass' : 'fail', h.px(h.rect(el).height)));
  const header = h.all('[data-cv-sidebar-header]')[0];
  if (panel && !header) parts.push(h.part('side bar header', 'pending', 'no [data-cv-sidebar-header]'));
  if (header) height('side bar header', header);
  if (mainLayout && hooked.length === 0) parts.push(h.part('top tab bars', 'pending', 'no [data-cv-new-tab]'));
  const rowTop = hooked.length > 0 ? Math.min(...hooked.map((b) => h.rect(b).top)) : null;
  const topBars = hooked.filter((b) => h.near(h.rect(b).top, rowTop));
  for (const bar of topBars) height('top tab bar', bar);
  const aiHeader = h.all('[data-cv-ai-header]')[0];
  if (aiOpen && !aiHeader) parts.push(h.part('AI header', 'pending', 'no [data-cv-ai-header]'));
  if (aiHeader) height('AI header', aiHeader);
  if (header && topBars.length > 0 && aiHeader && docked) {
    const bottoms = [h.rect(header).bottom, ...topBars.map((b) => h.rect(b).bottom), h.rect(aiHeader).bottom];
    parts.push(h.part('one bottom edge', bottoms.every((b) => h.near(b, bottoms[0])) ? 'pass' : 'fail', bottoms.map(h.px).join(', ')));
  }
  return h.combine('G6', parts);
}

/** G7: the side bar's rows in the order of L-6, the header first and the footer at its bottom. */
export function ruleG7(h) {
  const { panel } = h.screen;
  if (!panel) return h.result('G7', 'n/a', 'no side bar');
  const head = h.all('[data-cv-sidebar-header]', panel)[0];
  const footer = h.all('[data-cv-sidebar-footer]', panel)[0];
  if (!head || !footer) return h.result('G7', 'pending', 'needs [data-cv-sidebar-header] and [data-cv-sidebar-footer]');
  const search = h.all('[data-cv-sidebar-search]', panel)[0];
  const tops = [head, search, footer].filter(Boolean).map((el) => h.rect(el).top);
  const ordered = tops.every((t, i) => i === 0 || t >= tops[i - 1]);
  const atBottom = h.near(h.rect(footer).bottom, h.rect(panel).bottom);
  const above = [...panel.querySelectorAll('*')].filter(h.visible)
    .filter((el) => !el.hasAttribute('data-cv-accent-line') && !el.contains(head) && !head.contains(el) && h.rect(el).height > 0)
    .some((el) => h.rect(el).top < h.rect(head).top - 0.5);
  const ok = ordered && atBottom && !above;
  return h.result('G7', ok ? 'pass' : 'fail', `order ${ordered ? 'ok' : 'wrong'}, footer at the bottom ${atBottom}, header first ${!above}`);
}

/** G8: while the AI panel is open, the 4px divider and the panel are the last two children of its row. */
export function ruleG8(h) {
  if (!h.screen.aiOpen) return h.result('G8', 'n/a', 'AI panel closed');
  const divider = h.all('[data-cv-ai-divider]')[0];
  const ai = h.all('[data-cv-ai-panel]')[0];
  if (!divider || !ai) return h.result('G8', 'pending', 'needs [data-cv-ai-divider] and [data-cv-ai-panel]');
  const lastTwo = [...ai.parentElement.children].filter(h.visible).slice(-2);
  const ok = lastTwo[0] === divider && lastTwo[1] === ai && h.near(h.rect(divider).width, 4);
  const width = h.rect(ai).width;
  return h.result('G8', ok ? 'pass' : 'fail', `last two children ${ok ? 'divider and panel' : 'wrong'}, divider ${h.px(h.rect(divider).width)}, panel ${h.px(width)}${h.near(width, h.aiPanelDefault) ? ' (default)' : ''}`);
}

/** G10: every tab inside its tab bar and every tab's close button inside its tab. */
export function ruleG10(h) {
  const hasTabs = h.screen.tabbars.some((bar) => bar.querySelector('[draggable], [data-cv-tab]'));
  if (!hasTabs) return h.result('G10', 'n/a', 'no tabs');
  const tabs = h.all('[data-cv-tab]');
  if (tabs.length === 0) return h.result('G10', 'pending', 'no [data-cv-tab]');
  const bad = [];
  for (const tab of tabs) {
    const t = h.rect(tab);
    const b = h.rect(tab.closest('[data-tabbar]'));
    if (t.left < b.left - 0.5 || t.right > b.right + 0.5) bad.push(`tab "${tab.innerText.trim()}" outside its bar`);
    const close = tab.querySelector('.cv-tab-close');
    if (close && (h.rect(close).left < t.left - 0.5 || h.rect(close).right > t.right + 0.5)) bad.push(`close of "${tab.innerText.trim()}" outside its tab`);
  }
  return h.result('G10', bad.length === 0 ? 'pass' : 'fail', bad.join('; '));
}

const DOM_RULES = [ruleG2, ruleG3, ruleG4, ruleG5, ruleG6, ruleG7, ruleG8, ruleG10];

/** Page source that runs every DOM rule and returns [{rule, status, detail}]. */
export function domRulesSource(arg = { cloneSelectors: CLONE_SELECTORS, stripHeight: STRIP_HEIGHT, aiPanelDefault: AI_PANEL_DEFAULT }) {
  return `(() => { const h = (${ruleHelpers})(${JSON.stringify(arg)}); return [${DOM_RULES.map((r) => `(${r})(h)`).join(', ')}]; })()`;
}

/**
 * In-page, for the twelve-tab part of G10: the first pane's tabs, each at least `minWidth` wide, in a
 * row that scrolls, with the active tab inside the strip.
 */
export function twelveTabsInPage({ minWidth }) {
  const bar = document.querySelector('[data-tabbar]');
  if (!bar) return { status: 'fail', detail: 'no tab bar' };
  const tabs = [...bar.querySelectorAll('[data-cv-tab]')];
  if (tabs.length === 0) return { status: 'pending', detail: 'no [data-cv-tab]' };
  const narrow = tabs.filter((t) => t.getBoundingClientRect().width < minWidth - 0.5);
  const row = tabs[0].parentElement;
  const scrolls = row.scrollWidth > row.clientWidth;
  const b = row.getBoundingClientRect();
  const a = tabs.find((t) => t.hasAttribute('data-active'))?.getBoundingClientRect();
  const inside = Boolean(a) && a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
  const ok = tabs.length >= 12 && narrow.length === 0 && scrolls && inside;
  return { status: ok ? 'pass' : 'fail', detail: `${tabs.length} tabs, ${narrow.length} under ${minWidth}px, scrolls ${scrolls}, active tab inside ${inside}` };
}

// ---------- main-process facts ----------

/** G1 and the web view half of G9, from the main process: {bounds, content, webViews}. */
export async function windowFacts(device) {
  const main = (await listWindows(device)).find((w) => w.role === 'main');
  if (!main) return null;
  return mainEval(device, ({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id);
    if (!win) return null;
    const views = typeof globalThis.__cvAttachedWebViews === 'function' ? globalThis.__cvAttachedWebViews() : null;
    return { bounds: win.getBounds(), content: win.getContentBounds(), webViews: views ? views.filter((v) => v.id !== win.webContents.id).length : null };
  }, main.id, { label: 'window facts' });
}

/** In-page G9 facts: an open dialog and the freeze holders. */
export function freezeFactsInPage() {
  const dialog = [...document.querySelectorAll('[data-dialog-content], [role=dialog]')].some((el) => el.getClientRects().length > 0);
  const hook = typeof window.__conduitFreeze === 'function';
  return { dialog, hook, holders: hook ? window.__conduitFreeze().length : null };
}

function ruleG1(facts) {
  if (!facts) return { rule: 'G1', status: 'fail', detail: 'no main window' };
  const smaller = facts.content.height < facts.bounds.height && facts.content.width <= facts.bounds.width;
  return { rule: 'G1', status: smaller ? 'pass' : 'fail', detail: `window ${facts.bounds.width} x ${facts.bounds.height}, content ${facts.content.width} x ${facts.content.height}` };
}

/** G9: a dialog over a web session holds a freeze and the web view is detached (the 32b bug stays fixed). */
async function ruleG9(device, facts, webSession) {
  const freeze = await withTimeout(device.page.evaluate(freezeFactsInPage), 10_000, `${device.name}: freeze facts`);
  if (!freeze.dialog || !webSession) return { rule: 'G9', status: 'n/a', detail: freeze.dialog ? 'no web session' : 'no dialog open' };
  if (!freeze.hook) return { rule: 'G9', status: 'pending', detail: 'window.__conduitFreeze is missing' };
  let current = facts;
  // The web view is detached once the renderer has captured its frozen image, a moment after the hold.
  for (let waited = 0; current?.webViews > 0 && waited < FREEZE_SETTLE_MS; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    current = await windowFacts(device);
  }
  if (typeof current?.webViews !== 'number') return { rule: 'G9', status: 'fail', detail: 'the launcher does not track attached views' };
  const ok = freeze.holders > 0 && current.webViews === 0;
  return { rule: 'G9', status: ok ? 'pass' : 'fail', detail: `${freeze.holders} freeze holder(s), ${current.webViews} web view(s) attached` };
}

/**
 * Every rule on the device's current screen: [{rule, status, detail}], G1 to G10 in order.
 * `webSession`: whether a web session is open (G9 applies while a dialog covers it).
 */
export async function evaluateRules(device, { webSession = false } = {}) {
  const dom = await withTimeout(device.page.evaluate(domRulesSource()), 15_000, `${device.name}: geometry rules`);
  const facts = await windowFacts(device);
  const results = [...dom, ruleG1(facts), await ruleG9(device, facts, webSession)];
  const byRule = new Map(results.map((r) => [r.rule, r]));
  return RULES.map((rule) => byRule.get(rule) ?? { rule, status: 'n/a', detail: '' });
}

/**
 * Folds rule results into {failed, pending, lines}: a fail always counts, a pending counts as a
 * failure only with strict. A deferred result (a check a named later package turns on, such as the
 * packs scenario's picker icons before R3-PICKER) is listed and never counts.
 */
export function summarizeRules(entries, { strict = false } = {}) {
  const lines = [];
  let failed = 0;
  let pending = 0;
  for (const { screen, results } of entries) {
    for (const r of results) {
      if (r.status === 'n/a') continue;
      if (r.status === 'fail') failed += 1;
      if (r.status === 'pending') pending += 1;
      const mark = r.status === 'pending' && strict ? 'FAIL (pending, --strict)' : r.status.toUpperCase();
      lines.push(`${screen}  ${r.rule}  ${mark}${r.detail ? `  ${r.detail}` : ''}`);
    }
  }
  return { failed: failed + (strict ? pending : 0), pending, lines };
}
