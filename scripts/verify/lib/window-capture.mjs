// Real window captures for the restyle suite (docs/VISUAL_REDESIGN.md 8.6 step 1). On macOS each
// window is captured with `screencapture -l <windowId>` (the native window frame and native web views
// included) and child windows (popup menus, the toast overlay) are laid over the main window at their
// screen offset, so nothing on the rest of the screen can get into the image. Elsewhere, and when
// macOS refuses the capture, the page is screenshotted instead.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { mainEval, withTimeout } from './ui.mjs';

const execFileAsync = promisify(execFile);
const CAPTURE_TIMEOUT_MS = 15_000;

let sharpModule = null;
async function sharp() {
  sharpModule ??= (await import('sharp')).default;
  return sharpModule;
}

/** The origin of the dev server that serves the app's own pages (the main, overlay and picker windows). */
export const devOrigin = (device) => new URL(device.page.url()).origin;

/**
 * The role of a window or page by its URL: 'menu' (popup menus), 'overlay' (toasts), 'picker', 'main'
 * or 'other'. Only pages served from `origin` are the app's own, so a web session's page at the root of
 * another origin is never taken for the main window.
 */
export function windowRole(url, origin) {
  if (url.startsWith('data:text/html')) return 'menu';
  if (url !== origin && !url.startsWith(`${origin}/`)) return 'other';
  const rest = url.slice(origin.length);
  if (/^\/overlay\.html(\?|#|$)/.test(rest)) return 'overlay';
  if (/^\/picker\.html(\?|#|$)/.test(rest)) return 'picker';
  return /\.html(\?|#|$)/.test(rest) ? 'other' : 'main';
}

/**
 * Every visible window of the device, main first: {id, cg, role, url, bounds, content}. `role` is
 * 'main', 'menu' (popup menus), 'overlay' (toasts), 'picker' or 'other'.
 */
export async function listWindows(device) {
  const origin = devOrigin(device);
  const windows = await mainEval(device, ({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w.isVisible())
    .map((w) => ({ id: w.id, cg: Number(w.getMediaSourceId().split(':')[1]), url: w.webContents.getURL(), bounds: w.getBounds(), content: w.getContentBounds() })),
  undefined, { label: 'list windows' });
  return windows
    .map((w) => ({ ...w, role: windowRole(w.url, origin) }))
    .sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : 0));
}

// The window server sometimes refuses a window for a moment right after another window appears.
const CAPTURE_ATTEMPTS = 4;

async function screencapture(cg, file) {
  let last = null;
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
    try {
      await withTimeout(execFileAsync('screencapture', ['-x', '-o', '-l', String(cg), file]), CAPTURE_TIMEOUT_MS, `screencapture -l ${cg}`);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
      last = new Error(`screencapture wrote nothing for window ${cg}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * Captures the main window with the given child window roles laid over it, into `file`.
 * Returns {file, method: 'window' | 'page', scale, main, missing}: `missing` lists the open child
 * windows of those roles that a page screenshot leaves out.
 */
export async function captureWindow(device, file, { overlays = ['menu', 'overlay'] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'darwin') {
    try {
      return await captureMacWindows(device, file, overlays);
    } catch (err) {
      device.captureWarning = `window capture failed (${err.message}); page screenshot instead`;
    }
  }
  // CSS pixels, so the crops (given in CSS pixels at scale 1) cut the right region on HiDPI screens.
  await withTimeout(device.page.screenshot({ path: file, scale: 'css' }), CAPTURE_TIMEOUT_MS, `${device.name}: page screenshot`);
  const open = await listWindows(device).catch(() => []);
  const missing = [...new Set(open.filter((w) => overlays.includes(w.role)).map((w) => w.role))];
  return { file, method: 'page', scale: 1, main: null, missing };
}

async function captureMacWindows(device, file, overlays) {
  const windows = await listWindows(device);
  const main = windows.find((w) => w.role === 'main');
  if (!main) throw new Error('no main window');
  const tmp = (name) => `${file}.${name}.tmp.png`;
  const img = await sharp();
  await screencapture(main.cg, tmp('main'));
  const meta = await img(tmp('main')).metadata();
  const scale = meta.width / main.bounds.width;
  let base = await img(tmp('main')).png().toBuffer();
  try {
    for (const w of windows.filter((x) => overlays.includes(x.role))) {
      await screencapture(w.cg, tmp(`w${w.id}`));
      base = await addChildWindow(img, base, tmp(`w${w.id}`), { main, child: w, scale });
    }
    await img(base).png().toFile(file);
  } finally {
    for (const f of fs.readdirSync(path.dirname(file))) {
      if (f.startsWith(`${path.basename(file)}.`) && f.endsWith('.tmp.png')) fs.rmSync(path.join(path.dirname(file), f), { force: true });
    }
  }
  return { file, method: 'window', scale, main, missing: [] };
}

/**
 * Captures the first window of `role` alone into `file`: the credential picker opens near the pointer,
 * often away from the main window, so it cannot be cut out of a main window capture. On macOS a window
 * capture, elsewhere (or when macOS refuses) a screenshot of its page.
 */
export async function captureChildWindow(device, role, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const child = (await listWindows(device)).find((w) => w.role === role);
  if (!child) throw new Error(`${device.name}: no ${role} window to capture`);
  if (process.platform === 'darwin') {
    try {
      await screencapture(child.cg, file);
      return file;
    } catch (err) {
      device.captureWarning = `${role} window capture failed (${err.message}); page screenshot instead`;
    }
  }
  const origin = devOrigin(device);
  const page = device.app.windows().find((p) => windowRole(p.url(), origin) === role);
  if (!page) throw new Error(`${device.name}: no ${role} page to screenshot`);
  await withTimeout(page.screenshot({ path: file, scale: 'css' }), CAPTURE_TIMEOUT_MS, `${device.name}: ${role} page screenshot`);
  return file;
}

const near = (a, b) => Math.abs(a - b) <= 2;

/**
 * macOS returns either the child window alone or the child's window group (the main window with its
 * children drawn in place, framed on the union of their bounds). Both end up as the main window with
 * the child on top.
 */
async function addChildWindow(img, base, source, { main, child, scale }) {
  const got = await img(source).metadata();
  const left = Math.round((child.bounds.x - main.bounds.x) * scale);
  const top = Math.round((child.bounds.y - main.bounds.y) * scale);
  if (near(got.width, child.bounds.width * scale) && near(got.height, child.bounds.height * scale)) {
    const layer = await clipLayer(img, source, left, top, await img(base).metadata());
    return layer ? img(base).composite([layer]).png().toBuffer() : base;
  }
  const ux = Math.min(main.bounds.x, child.bounds.x);
  const uy = Math.min(main.bounds.y, child.bounds.y);
  const uw = Math.max(main.bounds.x + main.bounds.width, child.bounds.x + child.bounds.width) - ux;
  const uh = Math.max(main.bounds.y + main.bounds.height, child.bounds.y + child.bounds.height) - uy;
  if (!near(got.width, uw * scale) || !near(got.height, uh * scale)) {
    throw new Error(`window ${child.cg} (${child.role}) came back ${got.width}x${got.height}, neither the window nor its group`);
  }
  const width = Math.round(main.bounds.width * scale);
  const height = Math.round(main.bounds.height * scale);
  return img(source).extract({ left: Math.round((main.bounds.x - ux) * scale), top: Math.round((main.bounds.y - uy) * scale), width, height }).png().toBuffer();
}

/** A child window image cut to the part that lies over the main window, as a sharp composite layer. */
async function clipLayer(img, source, left, top, meta) {
  const layerMeta = await img(source).metadata();
  const x0 = Math.max(0, -left);
  const y0 = Math.max(0, -top);
  const width = Math.min(layerMeta.width - x0, meta.width - Math.max(0, left));
  const height = Math.min(layerMeta.height - y0, meta.height - Math.max(0, top));
  if (width <= 0 || height <= 0) return null;
  const input = await img(source).extract({ left: x0, top: y0, width, height }).png().toBuffer();
  return { input, left: Math.max(0, left), top: Math.max(0, top) };
}

/**
 * Crops a region given in CSS pixels of the main window's content area out of a window capture and
 * scales it by `zoom` (the reference's 1.5x and 2x crops).
 */
export async function cropCapture(capture, rect, file, { zoom = 1 } = {}) {
  const img = await sharp();
  const meta = await img(capture.file).metadata();
  const frameTop = capture.main ? capture.main.content.y - capture.main.bounds.y : 0;
  const s = capture.scale;
  const left = Math.max(0, Math.round(rect.x * s));
  const top = Math.max(0, Math.round((rect.y + frameTop) * s));
  const width = Math.min(meta.width - left, Math.round(rect.width * s));
  const height = Math.min(meta.height - top, Math.round(rect.height * s));
  let pipeline = img(capture.file).extract({ left, top, width, height });
  if (zoom !== 1) pipeline = pipeline.resize(Math.round(width * zoom), null, { kernel: 'lanczos3' });
  await pipeline.png().toFile(file);
  return file;
}
