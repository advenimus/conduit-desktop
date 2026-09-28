// Generic page helpers on top of ui.mjs: labeled inputs, selects and checkboxes (React-safe),
// buttons inside a titled dialog, sync banners, native menu items, split open/save dialog stubs,
// and toasts (they render in a separate overlay window; the launcher records them in main).

import { clickText, mainEval, waitFor, withTimeout } from './ui.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Polls `attempt()` until it returns `done`; on timeout the error names the last other result. */
export function retryUntil(attempt, done, { timeoutMs = DEFAULT_TIMEOUT_MS, label }) {
  return waitFor(async () => {
    const res = await attempt();
    if (res === done) return true;
    throw new Error(String(res));
  }, { timeoutMs, label });
}

function evaluateIn(page, device, fn, arg, label) {
  return withTimeout(page.evaluate(fn, arg), 10_000, `${device.name}: ${label}`);
}

/** CSS for the visible sync-style dialog titled `title` (role=dialog aria-label). */
export function dialogSelector(title) {
  return `[role=dialog][aria-label="${title.replace(/"/g, '\\"')}"]`;
}

function fillLabeledInPage({ label, value, scope, index }) {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return 'no scope';
  const labels = [...root.querySelectorAll('label')].filter((l) => l.getClientRects().length > 0);
  const own = (l) => (l.querySelector('span')?.innerText ?? l.innerText ?? '').trim();
  const match = labels.filter((l) => own(l) === label)[index];
  const input = match?.querySelector('input, textarea, select');
  if (!input) return 'no input';
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'filled';
}

/** Fills the input inside the <label> whose first span (or text) is exactly `label` (PasswordInput style). */
export async function typeIntoLabeled(device, label, value, { scope, index = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  await retryUntil(() => evaluateIn(device.page, device, fillLabeledInPage, { label, value, scope, index }, `fill "${label}"`), 'filled', { timeoutMs, label: `${device.name}: labeled input "${label}"` });
}

function selectInPage({ selector, value }) {
  const el = [...document.querySelectorAll(selector)].find((e) => e.getClientRects().length > 0);
  if (!el) return 'missing';
  if (![...el.options].some((o) => o.value === String(value))) return `no option ${value}`;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, String(value));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'selected';
}

/** Picks option `value` of the visible <select> matching `selector` so React sees it. */
export async function selectOption(device, selector, value, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  await retryUntil(() => evaluateIn(device.page, device, selectInPage, { selector, value }, `select ${selector}`), 'selected', { timeoutMs, label: `${device.name}: select ${selector} = ${value}` });
}

function checkboxInPage({ text, scope, checked }) {
  const root = scope ? document.querySelector(scope) : document;
  const label = [...(root?.querySelectorAll('label') ?? [])].find((l) => l.getClientRects().length > 0 && (l.innerText ?? '').includes(text));
  const box = label?.querySelector('input[type=checkbox]');
  if (!box) return 'missing';
  if (box.disabled) return 'disabled';
  if (box.checked !== checked) box.click();
  return box.checked === checked ? 'ok' : 'unchanged';
}

/** Sets the checkbox inside the visible <label> containing `text` to `checked`. */
export async function setCheckbox(device, text, checked, { scope, timeoutMs = 15_000 } = {}) {
  await retryUntil(() => evaluateIn(device.page, device, checkboxInPage, { text, scope, checked }, `checkbox "${text}"`), 'ok', { timeoutMs, label: `${device.name}: checkbox "${text}" -> ${checked}` });
}

/** Clicks button `label` (exact text) inside the visible dialog titled `title`. */
export function clickInDialog(device, title, label, opts = {}) {
  return clickText(device, label, { exact: true, selector: `${dialogSelector(title)} button`, ...opts });
}

/** Text of each visible sync banner (role=status strip) with its button labels. */
export function banners(device) {
  const read = () => [...document.querySelectorAll('[role=status]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ text: (el.querySelector('span.flex-1')?.innerText ?? el.innerText ?? '').trim(), actions: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()) }));
  return evaluateIn(device.page, device, read, undefined, 'read banners');
}

/** Waits for a banner whose text matches (string: includes; or RegExp); returns {text, actions}. */
export function waitForBanner(device, text, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const matches = (t) => (text instanceof RegExp ? text.test(t) : t.includes(text));
  return waitFor(async () => (await banners(device)).find((b) => matches(b.text)) ?? null, { timeoutMs, label: `${device.name}: banner ${text}` });
}

function clickBannerInPage({ text, label, isRegex }) {
  const re = isRegex ? new RegExp(text) : null;
  const banner = [...document.querySelectorAll('[role=status]')].find((el) => {
    const t = el.innerText ?? '';
    return el.getClientRects().length > 0 && (re ? re.test(t) : t.includes(text));
  });
  const button = [...(banner?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === label);
  if (!button) return banner ? 'no button' : 'no banner';
  if (button.disabled) return 'disabled';
  button.click();
  return 'clicked';
}

/** Clicks button `label` on the banner whose text matches `text`. */
export async function clickBannerAction(device, text, label, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const arg = { text: text instanceof RegExp ? text.source : text, label, isRegex: text instanceof RegExp };
  await retryUntil(() => evaluateIn(device.page, device, clickBannerInPage, arg, `banner [${label}]`), 'clicked', { timeoutMs, label: `${device.name}: banner ${text} [${label}]` });
}

/**
 * Makes the next native dialogs answer: `open` for showOpenDialog (a file or a folder), `save` for
 * showSaveDialog. A side left out is answered as canceled.
 */
export function stubDialogs(device, { open = null, save = null } = {}) {
  return mainEval(device, ({ dialog }, paths) => {
    dialog.showOpenDialog = async () => (paths.open ? { canceled: false, filePaths: [paths.open] } : { canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => (paths.save ? { canceled: false, filePath: paths.save } : { canceled: true, filePath: undefined });
  }, { open, save }, { label: 'stub open/save dialogs' });
}

/** Clicks the application menu item labeled `label` (for example 'Change Password...'), like a user would. */
export async function clickMenuItem(device, label) {
  const res = await mainEval(device, ({ Menu }, wanted) => {
    const find = (items) => {
      for (const item of items ?? []) {
        if (item.label === wanted) return item;
        const inner = find(item.submenu?.items);
        if (inner) return inner;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu()?.items);
    if (!item) return 'missing';
    if (!item.enabled) return 'disabled';
    item.click();
    return 'clicked';
  }, label, { label: `menu ${label}` });
  if (res !== 'clicked') throw new Error(`${device.name}: menu item "${label}" is ${res}`);
}

/** The toast overlay window of `device` (created on the first toast; hidden, not closed, after). */
export function overlayPage(device) {
  const page = device.app.windows().find((p) => p.url().includes('overlay.html'));
  if (!page) throw new Error(`${device.name}: no toast overlay window`);
  return page;
}

function readToastRecorder(device) {
  return mainEval(device, () => {
    const rec = globalThis.__cvToasts;
    return rec ? { log: rec.log, now: rec.now } : null;
  }, undefined, { label: 'read toasts' }).then((rec) => {
    if (!rec) throw new Error(`${device.name}: no toast recorder (the launcher installs it; is this a harness device?)`);
    return rec;
  });
}

/**
 * Every toast the renderer showed since launch, in order: [{id, type, title, message, actions, at}].
 * Recorded in the main process, so a 5-second toast is never missed.
 */
export async function toastLog(device) {
  return (await readToastRecorder(device)).log;
}

/** Position in the toast log; pass it as {after} to wait only for toasts that come later. */
export async function toastMark(device) {
  return (await toastLog(device)).length;
}

/** Toasts on screen now: [{title, actions}] (action labels). */
export async function toasts(device) {
  return (await readToastRecorder(device)).now.map((t) => ({ title: t.title, actions: t.actions.map((a) => a.label) }));
}

function titleMatches(title) {
  return (t) => (title instanceof RegExp ? title.test(t) : t.includes(title));
}

/**
 * Waits for a toast whose title matches (string: includes; or RegExp) among those logged at or after
 * position `after` (default 0: any since launch); returns the log entry.
 */
export function waitForToast(device, title, { after = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const matches = titleMatches(title);
  return waitFor(async () => (await toastLog(device)).slice(after).find((t) => matches(t.title)) ?? null, {
    timeoutMs,
    label: `${device.name}: toast ${title}`,
  });
}

/**
 * Presses action `label` of the toast on screen whose title matches: the same overlay:action-clicked
 * message the overlay window sends, so it works while that window is still loading or hidden.
 */
export async function clickToastAction(device, title, label, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const matches = titleMatches(title);
  const actionId = await waitFor(async () => {
    const live = (await readToastRecorder(device)).now.find((t) => matches(t.title));
    if (!live) throw new Error('no such toast on screen');
    const action = live.actions.find((a) => a.label === label);
    if (!action) throw new Error(`toast has actions ${JSON.stringify(live.actions.map((a) => a.label))}`);
    return action.id;
  }, { timeoutMs, label: `${device.name}: toast ${title} [${label}]` });
  await mainEval(device, ({ ipcMain }, id) => {
    ipcMain.emit('overlay:action-clicked', { sender: null }, { actionId: id });
  }, actionId, { label: `toast action ${label}` });
}
