// Harness hook contract (docs/VISUAL_REDESIGN.md 8.2 and Appendix B, "Final" column). Every entry
// of SELECTORS is `{hook}`, a stable data-cv-* hook (or data-sidebar-panel). Wave 1 paired each hook
// with the class selector the markup had before the restyle and chose one per scope; the class
// halves and that choice are gone, and the helpers keep their wave-1 names so callers did not change.

import { waitFor, withTimeout } from './ui.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_CALL_TIMEOUT_MS = 10_000;

/** Sync-style dialogs. The Dialog primitive names every other dialog with aria-labelledby (8.3). */
export const SYNC_DIALOG = '[role=dialog][aria-label]';

const hook = (css) => Object.freeze({ hook: css });

export const SELECTORS = Object.freeze({
  // B1: the Settings panel
  settingsRoot: hook('[data-cv-settings]'),
  // B2, scope: the Settings root
  settingsNavButton: hook('[data-cv-settings-nav] button'),
  // B3, scope: the Settings root
  settingsFooterButton: hook('[data-cv-dialog-footer] button'),
  // B4, scopes: the Settings root, then the status box
  syncStatus: hook('[data-cv-sync-status]'),
  syncStatusLabel: hook('[data-cv-sync-status-label]'),
  syncStatusDetail: hook('[data-cv-sync-status-detail]'),
  // B36
  syncPlan: hook('[data-cv-sync-plan]'),
  // B5, scopes: the Settings root, then each row
  deviceRow: hook('[data-cv-device-row]'),
  deviceName: hook('[data-cv-device-name]'),
  deviceLine: hook('[data-cv-device-line]'),
  // B6 and B38, scopes: the Settings root (or any root), then each notice
  syncNotice: hook('[data-cv-sync-notice]'),
  syncNoticeText: hook('[data-cv-sync-notice-text]'),
  // B7
  syncPaused: hook('[data-cv-sync-paused]'),
  // B8, scope: one [data-dialog-content] or one sync dialog
  dialogError: hook('[data-cv-error]'),
  // B11: the field row (closest from its [Use this]), its label, and a version line's value
  reviewField: hook('[data-cv-review-field]'),
  reviewFieldLabel: hook('[data-cv-review-field-label]'),
  reviewValue: hook('[data-cv-review-value]'),
  // B47: a version line (closest from its [Use this]) holds the value, the In use now badge and the button
  reviewVersion: hook('[data-cv-review-version]'),
  // B13
  reviewButton: hook('[data-cv-review-button]'),
  // B15, scope: each [role=status] banner
  bannerText: hook('[data-cv-banner-text]'),
  // B16: the toggle that opens a closed side bar, and the proof that it is open
  sidebarOpener: hook('[data-cv-sidebar-toggle][aria-expanded="false"]'),
  sidebarOpen: hook('[data-sidebar-panel]'),
  // B17
  vaultSwitcher: hook('[data-cv-vault-switcher]'),
  // B18, scopes: the panel, then each row
  deletedRow: hook('[data-cv-deleted-list] label'),
  deletedTitle: hook('[data-cv-row-title]'),
  deletedDetail: hook('[data-cv-row-detail]'),
  // B19
  stackedConfirmButton: hook('[data-cv-layer="stacked"] [data-dialog-content] button'),
  // B20: the rows of the panel (and the row of a title, by closest), and each row's title and detail
  copyRow: hook('[data-cv-copy-row]'),
  copyTitle: hook('[data-cv-row-title]'),
  copyDetail: hook('[data-cv-row-detail]'),
  // B21, scope: each row label
  massChangeTitle: hook('[data-cv-row-title]'),
  // B22 (closest from the title label) and B39 (scope: the row)
  toggleRow: hook('[data-cv-toggle-row]'),
  toggle: hook('[data-cv-toggle]'),
  // B40 and B23, scopes: the Settings root, the files list, then each row
  backupFiles: hook('[data-cv-backup-files]'),
  backupRow: hook('[data-cv-backup-row]'),
  backupName: hook('[data-cv-backup-name]'),
  backupMeta: hook('[data-cv-backup-meta]'),
  // B24 (closest from the title label) and B41 (scope: the section)
  cloudBackupSection: hook('[data-cv-cloud-backup-section]'),
  cloudBackupBadge: hook('[data-cv-cloud-backup-badge]'),
  // B25: the Backup Manager panel
  backupManager: hook('[data-cv-backup-manager]'),
  // B48: a tree folder's expand button
  treeTwistie: hook('[data-cv-tree-twistie]'),
});

/**
 * DOM helpers for in-page code. page.evaluate ships this function's source into the renderer
 * (see inPage), so its body must not use anything from this module's scope.
 */
export function pageHelpers(S) {
  const usesHook = (scope, p) => Boolean(scope?.querySelector(p.hook));
  const pickAll = (scope, p) => (scope ? [...scope.querySelectorAll(p.hook)] : []);
  const pickOne = (scope, p) => scope?.querySelector(p.hook) ?? null;
  /** closest(), limited to ancestors inside `scope`. */
  const pickClosest = (el, scope, p) => {
    const hit = el ? el.closest(p.hook) : null;
    return hit && scope?.contains(hit) ? hit : null;
  };
  const scopes = (css) => (css ? [...document.querySelectorAll(css)] : [document]);
  const find = (scopeCss, p) => scopes(scopeCss).flatMap((s) => pickAll(s, p));
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').trim();
  return { S, usesHook, pickAll, pickOne, pickClosest, scopes, find, visible, text };
}

/** The helpers bound to SELECTORS, for Node-side DOM code such as jsdom tests. */
export const helpers = pageHelpers(SELECTORS);

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

/** True when a visible element matches hook `p` inside any element matching `scope` (default: the page). */
export function existsIn(device, p, { scope } = {}) {
  return evaluateIn(device, ({ scope, p }, cv) => cv.find(scope, p).some(cv.visible), { scope, p }, { label: `query ${p.hook}` });
}

/** innerText of the first element matching hook `p` inside the first matching scope, or null. */
export function textIn(device, p, { scope } = {}) {
  const read = ({ scope, p }, cv) => {
    const el = cv.find(scope, p)[0];
    return el ? (el.innerText ?? el.textContent ?? '') : null;
  };
  return evaluateIn(device, read, { scope, p }, { label: `read ${p.hook}` });
}

function clickHookInPage({ scope, p, label, exact, index }, cv) {
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
 * ui.clickText for a hook: clicks the first (or index-th) visible element matching `p` whose text
 * contains (or equals, with exact) `label`; label null clicks the first match. The query runs again
 * on every try, so markup that renders late is still seen.
 */
export function clickIn(device, label, p, { scope, exact = false, index = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const what = label === null ? p.hook : `"${label}"`;
  return waitFor(async () => {
    const res = await evaluateIn(device, clickHookInPage, { scope, p, label, exact, index }, { label: `click ${what}` });
    return res && res !== 'disabled' ? res : null;
  }, { timeoutMs, label: `${device.name}: clickable ${what}` });
}
