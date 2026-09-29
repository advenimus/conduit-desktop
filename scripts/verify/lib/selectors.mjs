// Harness hook contract (docs/VISUAL_REDESIGN.md 8.2 and Appendix B, "Final" column). Every
// selector is a stable data-cv-* hook (or data-sidebar-panel). The class selectors the harness read
// before the restyle, and the per-scope choice between them and the hooks, are gone.

import { waitFor, withTimeout } from './ui.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_CALL_TIMEOUT_MS = 10_000;

/** Sync-style dialogs. The Dialog primitive names every other dialog with aria-labelledby (8.3). */
export const SYNC_DIALOG = '[role=dialog][aria-label]';

export const SELECTORS = Object.freeze({
  // B1: the Settings panel
  settingsRoot: '[data-cv-settings]',
  // B2, scope: the Settings root
  settingsNavButton: '[data-cv-settings-nav] button',
  // B3, scope: the Settings root
  settingsFooterButton: '[data-cv-dialog-footer] button',
  // B4, scopes: the Settings root, then the status box
  syncStatus: '[data-cv-sync-status]',
  syncStatusLabel: '[data-cv-sync-status-label]',
  syncStatusDetail: '[data-cv-sync-status-detail]',
  // B36
  syncPlan: '[data-cv-sync-plan]',
  // B5, scopes: the Settings root, then each row
  deviceRow: '[data-cv-device-row]',
  deviceName: '[data-cv-device-name]',
  deviceLine: '[data-cv-device-line]',
  // B6 and B38, scopes: the Settings root (or any root), then each notice
  syncNotice: '[data-cv-sync-notice]',
  syncNoticeText: '[data-cv-sync-notice-text]',
  // B7
  syncPaused: '[data-cv-sync-paused]',
  // B8, scope: one [data-dialog-content] or one sync dialog
  dialogError: '[data-cv-error]',
  // B11: the field row (closest from its [Use this]), its label, and a version line's value
  reviewField: '[data-cv-review-field]',
  reviewFieldLabel: '[data-cv-review-field-label]',
  reviewValue: '[data-cv-review-value]',
  // B47: a version line (closest from its [Use this]) holds the value, the In use now badge and the button
  reviewVersion: '[data-cv-review-version]',
  // B13
  reviewButton: '[data-cv-review-button]',
  // B15, scope: each [role=status] banner
  bannerText: '[data-cv-banner-text]',
  // B16: the toggle that opens a closed side bar, and the proof that it is open
  sidebarOpener: '[data-cv-sidebar-toggle][aria-expanded="false"]',
  sidebarOpen: '[data-sidebar-panel]',
  // B17
  vaultSwitcher: '[data-cv-vault-switcher]',
  // B18, scopes: the panel, then each row
  deletedRow: '[data-cv-deleted-list] label',
  deletedTitle: '[data-cv-row-title]',
  deletedDetail: '[data-cv-row-detail]',
  // B19
  stackedConfirmButton: '[data-cv-layer="stacked"] [data-dialog-content] button',
  // B20: the rows of the panel (and the row of a title, by closest), and each row's title and detail
  copyRow: '[data-cv-copy-row]',
  copyTitle: '[data-cv-row-title]',
  copyDetail: '[data-cv-row-detail]',
  // B21, scope: each row label
  massChangeTitle: '[data-cv-row-title]',
  // B22 (closest from the title label) and B39 (scope: the row)
  toggleRow: '[data-cv-toggle-row]',
  toggle: '[data-cv-toggle]',
  // B40 and B23, scopes: the Settings root, the files list, then each row
  backupFiles: '[data-cv-backup-files]',
  backupRow: '[data-cv-backup-row]',
  backupName: '[data-cv-backup-name]',
  backupMeta: '[data-cv-backup-meta]',
  // B24 (closest from the title label) and B41 (scope: the section)
  cloudBackupSection: '[data-cv-cloud-backup-section]',
  cloudBackupBadge: '[data-cv-cloud-backup-badge]',
  // B25: the Backup Manager panel
  backupManager: '[data-cv-backup-manager]',
  // B48: a tree folder's expand button
  treeTwistie: '[data-cv-tree-twistie]',
});

/**
 * DOM helpers for in-page code. page.evaluate ships this function's source into the renderer
 * (see inPage), so its body must not use anything from this module's scope.
 */
export function pageHelpers(S) {
  const queryAll = (scope, css) => (scope && css ? [...scope.querySelectorAll(css)] : []);
  const queryOne = (scope, css) => (scope && css ? scope.querySelector(css) : null);
  /** closest(), limited to ancestors inside `scope`. */
  const closestIn = (el, scope, css) => {
    const hit = el && css ? el.closest(css) : null;
    return hit && scope?.contains(hit) ? hit : null;
  };
  const scopes = (css) => (css ? [...document.querySelectorAll(css)] : [document]);
  const find = (scopeCss, css) => scopes(scopeCss).flatMap((s) => queryAll(s, css));
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').trim();
  return { S, queryAll, queryOne, closestIn, scopes, find, visible, text };
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

/** True when a visible element matches `css` inside any element matching `scope` (default: the page). */
export function existsIn(device, css, { scope } = {}) {
  return evaluateIn(device, ({ scope, css }, cv) => cv.find(scope, css).some(cv.visible), { scope, css }, { label: `query ${css}` });
}

/** innerText of the first element matching `css` inside the first matching scope, or null. */
export function textIn(device, css, { scope } = {}) {
  const read = ({ scope, css }, cv) => {
    const el = cv.find(scope, css)[0];
    return el ? (el.innerText ?? el.textContent ?? '') : null;
  };
  return evaluateIn(device, read, { scope, css }, { label: `read ${css}` });
}

function clickHookInPage({ scope, css, label, exact, index }, cv) {
  const els = cv.find(scope, css).filter(cv.visible);
  const match = label === null ? els : els.filter((el) => (exact ? cv.text(el) === label : cv.text(el).includes(label)));
  const el = match[index];
  if (!el) return null;
  if (el.disabled) return 'disabled';
  el.scrollIntoView({ block: 'center' });
  el.click();
  return cv.text(el).slice(0, 80) || el.tagName;
}

/**
 * ui.clickText for a hook: clicks the first (or index-th) visible element matching `css` whose text
 * contains (or equals, with exact) `label`; label null clicks the first match. The query runs again
 * on every try, so markup that renders late is still seen.
 */
export function clickIn(device, label, css, { scope, exact = false, index = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const what = label === null ? css : `"${label}"`;
  return waitFor(async () => {
    const res = await evaluateIn(device, clickHookInPage, { scope, css, label, exact, index }, { label: `click ${what}` });
    return res && res !== 'disabled' ? res : null;
  }, { timeoutMs, label: `${device.name}: clickable ${what}` });
}
