// Low-level page helpers that work in this app: IPC through window.electron.invoke, DOM clicks through
// page.evaluate (Playwright locator clicks time out here), React-safe input filling, screenshots.

const DEFAULT_TIMEOUT_MS = 30_000;
const CLICKABLE = 'button, [role=button], a, [role=menuitem], [role=tab], [role=option], label, li';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rejects after `ms`. Every call into a page goes through this: a blocked main thread must not hang the run. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function evaluate(device, fn, arg, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'page.evaluate' } = {}) {
  return withTimeout(device.page.evaluate(fn, arg), timeoutMs, `${device.name}: ${label}`);
}

/** Calls an IPC channel like the renderer does. Resolves {ok, value} or {ok: false, error}. */
export function invokeResult(device, channel, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return evaluate(
    device,
    async ({ channel, args }) => {
      try {
        return { ok: true, value: await window.electron.invoke(channel, args) };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
    { channel, args },
    { timeoutMs, label: `invoke ${channel}` },
  );
}

/** Calls an IPC channel and returns its value; a rejected handler throws. */
export async function invoke(device, channel, args, opts) {
  const res = await invokeResult(device, channel, args, opts);
  if (!res.ok) throw new Error(`${device.name}: ${channel} failed: ${res.error}`);
  return res.value;
}

/** Runs `fn(electronModule, arg)` in the device's main process. */
export function mainEval(device, fn, arg, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'main evaluate' } = {}) {
  return withTimeout(device.app.evaluate(fn, arg), timeoutMs, `${device.name}: ${label}`);
}

export function bodyText(device, opts) {
  return evaluate(device, () => document.body?.innerText ?? '', undefined, { label: 'read text', ...opts });
}

/**
 * Polls `predicate()` (a Node-side async function) until it returns something truthy, and returns it.
 * Errors inside the predicate count as "not yet" until the deadline.
 */
export async function waitFor(predicate, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const why = lastError ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${why}`);
}

/** Waits until the page text contains `text` (string or RegExp) and returns the full text. */
export function waitForText(device, text, opts = {}) {
  const matches = (t) => (text instanceof RegExp ? text.test(t) : t.includes(text));
  return waitFor(async () => {
    const t = await bodyText(device, { timeoutMs: 10_000 });
    return matches(t) ? t : null;
  }, { label: `${device.name}: text ${text}`, ...opts });
}

function clickInPage({ label, exact, selector, index, clickable }) {
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el.innerText ?? el.textContent ?? '').trim();
  const els = [...document.querySelectorAll(selector ?? clickable)].filter(visible);
  const match = label === null ? els : els.filter((el) => (exact ? text(el) === label : text(el).includes(label)));
  const el = match[index ?? 0];
  if (!el) return null;
  if (el.disabled) return 'disabled';
  el.scrollIntoView({ block: 'center' });
  el.click();
  return text(el).slice(0, 80) || el.tagName;
}

async function clickUntilFound(device, spec, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const what = spec.label === null ? spec.selector : `"${spec.label}"`;
  return waitFor(async () => {
    const res = await evaluate(device, clickInPage, { ...spec, clickable: CLICKABLE }, { timeoutMs: 10_000, label: `click ${what}` });
    return res && res !== 'disabled' ? res : null;
  }, { timeoutMs, label: `${device.name}: clickable ${what}` });
}

/** Clicks the first visible element whose text contains (or equals, with exact) `label`. */
export function clickText(device, label, { exact = false, selector, index = 0, timeoutMs } = {}) {
  return clickUntilFound(device, { label, exact, selector, index }, { timeoutMs });
}

/** Clicks the first (or index-th) visible element matching a CSS selector. */
export function clickSelector(device, selector, { index = 0, timeoutMs } = {}) {
  return clickUntilFound(device, { label: null, exact: false, selector, index }, { timeoutMs });
}

/** Sets an input's value so React sees it (native setter + input/change events). */
export async function typeInto(device, selector, value, { index = 0, timeoutMs } = {}) {
  const fill = ({ selector, value, index }) => {
    const els = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
    const el = els[index];
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  await waitFor(() => evaluate(device, fill, { selector, value, index }, { timeoutMs: 10_000, label: `fill ${selector}` }), {
    timeoutMs,
    label: `${device.name}: input ${selector}`,
  });
}

export function exists(device, selector) {
  return evaluate(device, (s) => [...document.querySelectorAll(s)].some((el) => el.getClientRects().length > 0), selector, {
    timeoutMs: 10_000,
    label: `query ${selector}`,
  });
}

export function pressKey(device, key) {
  return withTimeout(device.page.keyboard.press(key), 10_000, `${device.name}: press ${key}`);
}

/** Dispatches a renderer document event, for example "conduit:lock-vault". */
export function dispatchDocumentEvent(device, type, detail) {
  return evaluate(device, ({ type, detail }) => document.dispatchEvent(new CustomEvent(type, { detail })), { type, detail }, {
    label: `dispatch ${type}`,
  });
}

/** Saves a PNG under .verify/<runId>/shots/ and returns its path. */
export async function screenshot(device, label) {
  const file = device.run.nextShotPath(`${device.name}-${label}`);
  await withTimeout(device.page.screenshot({ path: file }), 15_000, `${device.name}: screenshot ${label}`);
  return file;
}

/** The personal-vault sync state (sync_get_state): {enabled, vault, status, deviceLimit, ...}. */
export function readSyncState(device) {
  return invoke(device, 'sync_get_state', {});
}

/** Makes the next native open/save dialog in this device answer `filePath`. */
export function stubFileDialogs(device, filePath) {
  return mainEval(
    device,
    ({ dialog }, fp) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fp] });
    },
    filePath,
    { label: 'stub file dialogs' },
  );
}
