// Personal-sync UI flows on top of flows.mjs: the take-over dialog, the displaced ("soft lock")
// modal, unlocking through a stale-file wait, sync state reads and the review panel.

import { openDialogs, refreshEntries, waitForUnlockOutcome, listEntries } from './flows.mjs';
import { bodyText, clickSelector, clickText, exists, invoke, readSyncState, typeInto, waitFor, waitForText, withTimeout } from './ui.mjs';
import { SYNC_DIALOG, evaluateIn } from './selectors.mjs';

export const TAKEOVER_TITLE = 'Vault open on another device';
export const WAITING_TITLE = 'Getting the latest changes';
export const REVIEW_TITLE = 'Review changes';
const DISPLACED_TITLE = /^(Vault locked|Opened on )/;
const DISPLACING_TEXT = 'Saving your last changes...';
const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const SUBMIT = '[data-dialog-content] form button[type=submit]';
const SYNC_DIALOG_BUTTON = `${SYNC_DIALOG} button`;

/** Title and text of each visible sync dialog (role=dialog with an aria-label, spec 8.3). */
export function dialogDetails(device) {
  const read = device.page.evaluate((css) =>
    [...document.querySelectorAll(css)]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ title: el.getAttribute('aria-label') ?? '', text: el.innerText ?? '' })),
  SYNC_DIALOG);
  return withTimeout(read, 10_000, `${device.name}: read dialog details`);
}

/** Waits for a visible dialog whose title matches (string or RegExp); returns {title, text}. */
export function waitForDialog(device, title, { timeoutMs = 30_000 } = {}) {
  const matches = (t) => (title instanceof RegExp ? title.test(t) : t === title);
  return waitFor(async () => (await dialogDetails(device)).find((d) => matches(d.title)) ?? null, {
    timeoutMs,
    label: `${device.name}: dialog ${title}`,
  });
}

/**
 * The displaced modal (6.6 step 5): "Vault locked" or, after a take-over, "Opened on <device>".
 * The step 1 overlay ("Saving your last changes...") can share the take-over title, so it is waited out.
 */
export function waitForDisplaced(device, { timeoutMs = 35_000 } = {}) {
  const settled = (d) => DISPLACED_TITLE.test(d.title) && !d.text.includes(DISPLACING_TEXT);
  return waitFor(async () => (await dialogDetails(device)).find(settled) ?? null, {
    timeoutMs,
    label: `${device.name}: displaced modal past "${DISPLACING_TEXT}"`,
  });
}

export async function displacedShown(device) {
  return (await dialogDetails(device)).some((d) => DISPLACED_TITLE.test(d.title));
}

/**
 * Unlock outcome that rides out the stale-file wait: while only "Getting the latest changes" is
 * up it keeps waiting; after `openNowAfterMs` it presses [Open now] (always safe, 6.11).
 * Returns {outcome, dialogs?, text?, waited, openedNow}.
 */
export async function unlockOutcome(device, { timeoutMs = 60_000, openNowAfterMs = 30_000 } = {}) {
  const start = Date.now();
  let waited = false;
  let openedNow = false;
  for (;;) {
    const left = timeoutMs - (Date.now() - start);
    if (left <= 0) throw new Error(`${device.name}: unlock still waiting for the cloud drive after ${timeoutMs} ms`);
    const res = await waitForUnlockOutcome(device, { timeoutMs: left });
    // The take-over dialog stays up, its button reading "Opening...", while the retry runs.
    if (res.outcome === 'dialog' && res.text.includes('Opening...')) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const onlyWaiting = res.outcome === 'dialog' && res.dialogs.every((d) => d === WAITING_TITLE);
    if (!onlyWaiting) return { ...res, waited, openedNow };
    waited = true;
    if (!openedNow && Date.now() - start > openNowAfterMs) {
      await clickText(device, 'Open now', { exact: true, selector: SYNC_DIALOG_BUTTON, timeoutMs: 5_000 });
      openedNow = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function expectUnlocked(device, res, action) {
  if (res.outcome !== 'unlocked') {
    throw new Error(`${device.name}: ${action} did not unlock (${res.outcome}${res.dialogs ? `: ${res.dialogs.join(', ')}` : ''})\n${(res.text ?? '').slice(0, 600)}`);
  }
  return res;
}

/** [Use here instead] in the take-over dialog: the unlock repeats with take-over. */
export async function useHereFromTakeover(device) {
  await clickText(device, 'Use here instead', { exact: true, selector: SYNC_DIALOG_BUTTON });
  return expectUnlocked(device, await unlockOutcome(device), 'take-over');
}

/**
 * [Use here instead] in the displaced modal: the unlock dialog opens in take-over mode and asks
 * for the master password again (the soft lock cleared it). Returns the unlock outcome and the
 * dialogs seen in between (a take-over dialog there means the server still refused).
 */
export async function useHereFromDisplaced(device, password) {
  await clickText(device, 'Use here instead', { exact: true, selector: SYNC_DIALOG_BUTTON });
  await waitForText(device, 'Unlock to use this vault here');
  await typeInto(device, PASSWORD_INPUT, password);
  await clickSelector(device, SUBMIT);
  return unlockOutcome(device);
}

/** status.conflictCount of the open vault (null when sync is not running). */
export async function conflictCount(device) {
  const s = await readSyncState(device);
  return s.status?.conflictCount ?? null;
}

export function listConflicts(device) {
  return invoke(device, 'sync_list_conflicts', {});
}

export async function entryById(device, id) {
  return (await listEntries(device)).find((e) => e.id === id) ?? null;
}

/** Waits until the device's entry `id` satisfies `pred(entry)` (null when gone); returns it. */
export function waitForEntry(device, id, pred, { timeoutMs = 30_000, label = 'entry' } = {}) {
  return waitFor(async () => {
    const e = await entryById(device, id);
    return pred(e) ? { entry: e } : null;
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: ${label}` }).then((r) => r.entry);
}

/** The entry's name in the renderer's tree (the store reloads on vault:entry-changed). */
export async function waitForEntryInUi(device, name, { timeoutMs = 15_000 } = {}) {
  await refreshEntries(device);
  return waitForText(device, name, { timeoutMs });
}

function clickVersionInPage({ field, value }, cv) {
  const panel = document.querySelector('[role=dialog][aria-label="Review changes"]');
  if (!panel) return 'no panel';
  const buttons = [...panel.querySelectorAll('button')].filter((b) => (b.innerText ?? '').trim() === 'Use this');
  for (const button of buttons) {
    const row = cv.pickClosest(button, panel, cv.S.reviewField);
    const line = cv.pickClosest(button, panel, cv.S.reviewVersion);
    if (!row || !line) continue;
    const label = cv.pickOne(row, cv.S.reviewFieldLabel)?.innerText?.trim();
    if (label !== field || !(line.innerText ?? '').includes(value)) continue;
    if (button.disabled) return 'disabled';
    button.scrollIntoView({ block: 'center' });
    button.click();
    return 'clicked';
  }
  return `no version "${value}" for ${field}`;
}

/** In the open review panel: [Use this] next to `value` of field `field` (its label, e.g. "Host"). */
export async function useVersionInReview(device, field, value, { timeoutMs = 15_000 } = {}) {
  let last = '';
  await waitFor(async () => {
    last = await evaluateIn(device, clickVersionInPage, { field, value }, { label: 'click Use this' });
    return last === 'clicked';
  }, { timeoutMs, label: `${device.name}: [Use this] for ${field} = ${value} (${last})` });
}

/** Clicks a button inside the open review panel by its exact label. */
export function clickInReview(device, label, opts) {
  return clickText(device, label, { exact: true, selector: '[role=dialog][aria-label="Review changes"] button', ...opts });
}

export function reviewPanelOpen(device) {
  return exists(device, '[role=dialog][aria-label="Review changes"]');
}

/** Closes the review panel with its close button. */
export async function closeReview(device) {
  await clickSelector(device, '[role=dialog][aria-label="Review changes"] button[aria-label="Close"]');
  await waitFor(async () => !(await reviewPanelOpen(device)), { timeoutMs: 10_000, label: `${device.name}: review panel closed` });
}

/** Visible sync dialog titles, for assertions that nothing unexpected is open. */
export { openDialogs, bodyText };
