// Harness hook contract (docs/VISUAL_REDESIGN.md 8.2 and Appendix B). Each class-based selector the
// harness used before the redesign is paired with the stable data-cv-* hook that replaces it, and
// pickSelector() picks one half per scope: the hook when any element in the scope carries it, else
// the legacy selector. The halves are never joined into one comma list: querySelector() returns
// whichever match comes first in the document and closest() whichever ancestor is nearest, so an
// unrelated element that keeps a legacy class after a restyle could win over the hooked one.
// W4-HARNESS deletes the legacy halves.

import { waitFor, withTimeout } from './ui.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_CALL_TIMEOUT_MS = 10_000;

/** Sync-style dialogs. The Dialog primitive names every other dialog with aria-labelledby (8.3). */
export const SYNC_DIALOG = '[role=dialog][aria-label]';

/**
 * `probe` (default: the hook) is what decides the half: a hook on an element that is not always
 * rendered (an optional badge, the rows of a list that can be empty) is probed through a sibling
 * hook of the same component that is.
 */
function pair(hook, legacy, probe) {
  return Object.freeze(probe ? { hook, legacy, probe } : { hook, legacy });
}

export const SELECTORS = Object.freeze({
  // B2, scope: the Settings root
  settingsNavButton: pair('[data-cv-settings-nav] button', '.w-52 button'),
  // B3, scope: the Settings root
  settingsFooterButton: pair('[data-cv-dialog-footer] button', ':scope > div:last-child button'),
  // B4, scopes: the Settings root, then the status box
  syncStatus: pair('[data-cv-sync-status]', '.bg-well.border'),
  syncStatusLabel: pair('[data-cv-sync-status-label]', 'p.font-medium'),
  syncStatusDetail: pair('[data-cv-sync-status-detail]', 'p.text-xs'),
  // B36: the legacy half is the first <p> whose text starts with "Your plan:"
  syncPlan: pair('[data-cv-sync-plan]', 'p'),
  // B5, scopes: the Settings root, then each row
  deviceRow: pair('[data-cv-device-row]', '.divide-y > div'),
  deviceName: pair('[data-cv-device-name]', 'p.text-sm'),
  deviceLine: pair('[data-cv-device-line]', 'p.text-xs'),
  // B6 and B38, scopes: the Settings root (or any root), then each notice
  syncNotice: pair('[data-cv-sync-notice]', '.bg-amber-500\\/10'),
  syncNoticeText: pair('[data-cv-sync-notice-text]', 'p'),
  // B7
  syncPaused: pair('[data-cv-sync-paused]', 'p.text-amber-400'),
  // B8, scope: one [data-dialog-content] or one sync dialog. unlockError is flows.mjs's wider match.
  dialogError: pair('[data-cv-error]', 'p.text-red-400'),
  unlockError: pair('[data-cv-error]', '.text-red-400'),
  // B11: the field row (closest from its [Use this]), its label, and a version line's value
  reviewField: pair('[data-cv-review-field]', '.rounded-md'),
  reviewFieldLabel: pair('[data-cv-review-field-label]', 'span'),
  reviewValue: pair('[data-cv-review-value]', '.font-mono'),
  // B13
  reviewButton: pair('[data-cv-review-button]', 'button[title="Review changes from your other devices"]'),
  // B15, scope: each [role=status] banner
  bannerText: pair('[data-cv-banner-text]', 'span.flex-1'),
  // B16: the toggle that opens a closed side bar, and the proof that it is open
  sidebarOpener: pair('[data-cv-sidebar-toggle][aria-expanded="false"]', 'button[title="Open sidebar (Ctrl+B)"]', '[data-cv-sidebar-toggle]'),
  sidebarOpen: pair('[data-sidebar-panel]', 'button[title="Close sidebar (Ctrl+B)"]'),
  // B17
  vaultSwitcher: pair('[data-cv-vault-switcher]', 'button[title]'),
  // B18, scopes: the panel, then each row
  deletedRow: pair('[data-cv-deleted-list] label', '.max-h-80 label', '[data-cv-deleted-list]'),
  deletedTitle: pair('[data-cv-row-title]', 'p.text-sm'),
  deletedDetail: pair('[data-cv-row-detail]', 'p.text-xs'),
  // B19
  stackedConfirmButton: pair('[data-cv-layer="stacked"] [data-dialog-content] button', '.z-\\[70\\] [data-dialog-content] button'),
  // B20: rows of the panel, the row of a title (closest), and each row's title and detail
  copyRow: pair('[data-cv-copy-row]', '.border-b'),
  copyRowOf: pair('[data-cv-copy-row]', '.flex.items-start'),
  copyTitle: pair('[data-cv-row-title]', 'p.text-sm'),
  copyDetail: pair('[data-cv-row-detail]', 'p.text-xs'),
  // B21, scope: each row label
  massChangeTitle: pair('[data-cv-row-title]', 'span.text-ink'),
  // B22 (closest from the title label) and B39 (scope: the row)
  toggleRow: pair('[data-cv-toggle-row]', '.justify-between'),
  toggle: pair('[data-cv-toggle]', ':scope > button'),
  // B40: the legacy half is structural (the "Backup Files (N)" label's parent), so the reader supplies it
  backupFiles: pair('[data-cv-backup-files]', null),
  // B23, scopes: the files list, then each row
  backupRow: pair('[data-cv-backup-row]', '.border-b'),
  backupName: pair('[data-cv-backup-name]', 'span.block'),
  backupMeta: pair('[data-cv-backup-meta]', 'span.text-\\[10px\\]'),
  // B24 (closest from the title label) and B41 (decided on the section, legacy read in the label's parent)
  cloudBackupSection: pair('[data-cv-cloud-backup-section]', '.space-y-3'),
  cloudBackupBadge: pair('[data-cv-cloud-backup-badge]', 'span', '[data-cv-cloud-backup-section]'),
});

/**
 * DOM helpers for in-page code. page.evaluate ships this function's source into the renderer
 * (see inPage), so its body must not use anything from this module's scope.
 */
export function pageHelpers(S) {
  const usesHook = (scope, p) => Boolean(scope?.querySelector(p.probe ?? p.hook));
  const pickSelector = (scope, hook, legacy, probe = hook) => (scope?.querySelector(probe) ? hook : legacy);
  const pick = (scope, p) => pickSelector(scope, p.hook, p.legacy, p.probe ?? p.hook);
  const pickAll = (scope, p) => {
    const css = pick(scope, p);
    return scope && css ? [...scope.querySelectorAll(css)] : [];
  };
  /** The first match. `legacyScope` is where the legacy half is read when it differs from `scope`. */
  const pickOne = (scope, p, legacyScope = scope) => {
    if (usesHook(scope, p)) return scope.querySelector(p.hook);
    return p.legacy ? (legacyScope?.querySelector(p.legacy) ?? null) : null;
  };
  /** closest() on the half `scope` picks, limited to ancestors inside `scope`. */
  const pickClosest = (el, scope, p) => {
    const css = pick(scope, p);
    const hit = el && css ? el.closest(css) : null;
    return hit && scope.contains(hit) ? hit : null;
  };
  const scopes = (css) => (css ? [...document.querySelectorAll(css)] : [document]);
  const find = (scopeCss, p) => scopes(scopeCss).flatMap((s) => pickAll(s, p));
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').trim();
  return { S, usesHook, pickSelector, pick, pickAll, pickOne, pickClosest, scopes, find, visible, text };
}

/** The helpers bound to SELECTORS, for Node-side DOM code such as jsdom tests. */
export const helpers = pageHelpers(SELECTORS);
export const { pickSelector } = helpers;

/**
 * Page source that calls `fn(arg, cv)` with cv = pageHelpers(SELECTORS). `fn` must be
 * self-contained, as for page.evaluate; `arg` must survive JSON.
 */
export function inPage(fn, arg) {
  return `(${fn})(${JSON.stringify(arg ?? null)}, (${pageHelpers})(${JSON.stringify(SELECTORS)}))`;
}

/** page.evaluate of inPage(fn, arg), with a timeout. */
export function evaluateIn(device, fn, arg, { timeoutMs = PAGE_CALL_TIMEOUT_MS, label = 'page.evaluate' } = {}) {
  return withTimeout(device.page.evaluate(inPage(fn, arg)), timeoutMs, `${device.name}: ${label}`);
}

const pairLabel = (p) => p.hook;

/** True when a visible element matches `p` inside any element matching `scope` (default: the page). */
export function existsIn(device, p, { scope } = {}) {
  return evaluateIn(device, ({ scope, p }, cv) => cv.find(scope, p).some(cv.visible), { scope, p }, { label: `query ${pairLabel(p)}` });
}

/** innerText of the first element matching `p` inside the first matching scope, or null. */
export function textIn(device, p, { scope } = {}) {
  const read = ({ scope, p }, cv) => {
    const el = cv.find(scope, p)[0];
    return el ? (el.innerText ?? el.textContent ?? '') : null;
  };
  return evaluateIn(device, read, { scope, p }, { label: `read ${pairLabel(p)}` });
}

function clickPairInPage({ scope, p, label, exact, index }, cv) {
  const els = cv.find(scope, p).filter(cv.visible);
  const match = label === null ? els : els.filter((el) => (exact ? cv.text(el) === label : cv.text(el).includes(label)));
  const el = match[index];
  if (!el) return null;
  if (el.disabled) return 'disabled';
  el.scrollIntoView({ block: 'center' });
  el.click();
  return cv.text(el).slice(0, 80) || el.tagName;
}

/**
 * ui.clickText for a selector pair: clicks the first (or index-th) visible element matching `p`
 * whose text contains (or equals, with exact) `label`; label null clicks the first match. The pair
 * is resolved again on every try, so markup that renders late is still seen.
 */
export function clickIn(device, label, p, { scope, exact = false, index = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const what = label === null ? pairLabel(p) : `"${label}"`;
  return waitFor(async () => {
    const res = await evaluateIn(device, clickPairInPage, { scope, p, label, exact, index }, { label: `click ${what}` });
    return res && res !== 'disabled' ? res : null;
  }, { timeoutMs, label: `${device.name}: clickable ${what}` });
}
