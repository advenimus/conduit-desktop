// Promo footage plumbing: a device sized 1440x900 at device scale 2 (PNG 2880x1800) in the Modern scheme,
// page captures with the macOS window buttons drawn on, and the shots.json manifest of element rects.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { launchInMode } from './restyle-flows.mjs';
import { dispatchDocumentEvent, invoke, mainEval, sleep, waitFor, withTimeout } from './ui.mjs';
import { withStores } from './restyle-data.mjs';

export const WIDTH = 1440;
export const HEIGHT = 900;
export const SCALE = 2;
const BUTTON_D = 12;
const BUTTON_STEP = 20;
const BUTTON_COLORS = Object.freeze(['#ff5f57', '#febc2e', '#28c840']);

/** Launches a quiet device in `mode` (dark or light): Modern scheme, Lucide icons, 1440x900 at scale 2. */
export async function launchPromoDevice(ctx, name, mode = 'dark', { env = {} } = {}) {
  const d = await launchInMode(ctx, name, mode, {
    args: [`--force-device-scale-factor=${SCALE}`],
    env,
    settings: { color_scheme: 'modern', icon_pack: 'lucide', appearance_version: 2 },
  });
  await mainEval(d, ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('.html'));
    win.setMinimumSize(size.w, size.h);
    win.setContentSize(size.w, size.h);
    win.center();
    return true;
  }, { w: WIDTH, h: HEIGHT }, { label: 'size the window' });
  await d.page.addStyleTag({ content: '*::-webkit-scrollbar { display: none !important; }' });
  await waitFor(async () => {
    const dims = await d.page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]);
    return dims[0] === WIDTH && dims[1] === HEIGHT && dims[2] === SCALE;
  }, { timeoutMs: 15_000, label: `${d.name}: ${WIDTH}x${HEIGHT} at scale ${SCALE}` });
  return d;
}

/** Switches the look live, the way Settings > Appearance does: {iconPack, theme, colorScheme}. */
export async function setLook(d, detail) {
  await dispatchDocumentEvent(d, 'conduit:theme-change', detail);
  await sleep(900);
}

/**
 * Switching away from a terminal tab and back cuts the shell prompt line (the app shows "deploy@we"). The
 * mock SSH shell redraws its line on Ctrl+L, so the active SSH tab gets one before it is photographed.
 */
export async function redrawSshPrompt(d) {
  const id = await withStores(d, (_, s) => {
    const walk = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(walk));
    const pane = walk(s.layout.getState().root).find((l) => l.id === s.layout.getState().focusedPaneId) ?? walk(s.layout.getState().root)[0];
    const active = s.session.getState().sessions.find((x) => x.id === pane?.activeSessionId);
    return active?.type === 'ssh' ? active.id : null;
  }, null, { label: 'find the active SSH tab' });
  if (id === null) return;
  await invoke(d, 'terminal_write', { sessionId: id, data: [0x0c] });
  await sleep(500);
}

async function drawButtons(file, d) {
  const buttons = await mainEval(d, ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible() && !w.webContents.getURL().includes('.html'));
    return win ? { pos: win.getWindowButtonPosition?.() ?? null, frame: win.getBounds(), content: win.getContentBounds() } : null;
  }, undefined, { label: 'window buttons' });
  if (!buttons?.pos) return;
  const top = buttons.content.y - buttons.frame.y;
  const circles = BUTTON_COLORS.map((color, i) => {
    const cx = (buttons.pos.x + i * BUTTON_STEP + BUTTON_D / 2) * SCALE;
    const cy = (buttons.pos.y - top + BUTTON_D / 2) * SCALE;
    return `<circle cx="${cx}" cy="${cy}" r="${(BUTTON_D / 2) * SCALE}" fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>`;
  }).join('');
  const meta = await sharp(file).metadata();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${circles}</svg>`);
  fs.writeFileSync(file, await sharp(file).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer());
}

/** In-page: the rect (in image pixels) of each target; a target is {label, selector} or {label, text, within}. */
function rectsInPage({ targets, scale }) {
  const visible = (el) => el.getClientRects().length > 0;
  const own = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  const climb = (el) => {
    let node = el;
    while (node.parentElement && node.getBoundingClientRect().height < el.getBoundingClientRect().height * 3) node = node.parentElement;
    return node;
  };
  return targets.map((t) => {
    let el = null;
    if (t.selector) el = [...document.querySelectorAll(t.selector)].filter(visible)[t.index ?? 0] ?? null;
    else if (t.text) {
      const found = [...document.querySelectorAll('h1, h2, h3, h4, span, p, div, button, label')].filter((e) => visible(e) && own(e) === t.text)[t.index ?? 0];
      el = found ? (t.card ? climb(found) : found) : null;
    }
    if (!el) return { label: t.label, missing: true };
    const r = el.getBoundingClientRect();
    return { label: t.label, x: Math.round(r.left * scale), y: Math.round(r.top * scale), w: Math.round(r.width * scale), h: Math.round(r.height * scale) };
  });
}

/** Writes PNGs into `outDir` and records them, with element rects, for footage/desktop/shots.json. */
export function createRecorder(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [];
  return {
    shots,
    outDir,
    async shot(d, { scene, name, description, targets = [], settleMs = 500, crop = null }) {
      const seq = String(shots.filter((s) => s.scene === scene).length + 1).padStart(2, '0');
      const file = `${scene}-${seq}-${name}.png`;
      const out = path.join(outDir, file);
      await sleep(settleMs);
      await redrawSshPrompt(d);
      await withTimeout(d.page.screenshot({ path: out, scale: 'device' }), 20_000, `${d.name}: screenshot ${file}`);
      await drawButtons(out, d);
      const rects = await withTimeout(d.page.evaluate(rectsInPage, { targets, scale: SCALE }), 10_000, 'read rects');
      const missing = rects.filter((r) => r.missing).map((r) => r.label);
      if (missing.length > 0) console.log(`[promo] ${file}: no element for ${missing.join(', ')}`);
      shots.push({ file, scene, description, rects: rects.filter((r) => !r.missing) });
      console.log(`[promo] saved ${file}`);
      if (crop) await this.cropShot(out, scene, `${name}-crop`, description, rects.find((r) => r.label === crop.label), crop.pad ?? 24);
      return file;
    },
    /**
     * One frame of a sequence of real captures: `<scene>-seq-<name>-<nnn>.png`, no settle wait. The manifest
     * lists the sequence once, with the rects of the last frame that gave `targets`.
     */
    async frame(d, { scene, name, description, targets = null }) {
      let entry = shots.find((s) => s.scene === scene && s.sequence === name);
      if (!entry) {
        entry = { file: `${scene}-seq-${name}-%03d.png`, scene, sequence: name, description, frames: 0, rects: [] };
        shots.push(entry);
      }
      entry.frames += 1;
      const file = `${scene}-seq-${name}-${String(entry.frames).padStart(3, '0')}.png`;
      const out = path.join(outDir, file);
      await withTimeout(d.page.screenshot({ path: out, scale: 'device' }), 20_000, `${d.name}: screenshot ${file}`);
      await drawButtons(out, d);
      if (targets) entry.rects = (await withTimeout(d.page.evaluate(rectsInPage, { targets, scale: SCALE }), 10_000, 'read rects')).filter((r) => !r.missing);
      return file;
    },
    /** A second PNG cut from the full frame around one rect, listed in the manifest with its own rects (none). */
    async cropShot(source, scene, name, description, rect, pad) {
      if (!rect || rect.missing) return;
      const meta = await sharp(source).metadata();
      const left = Math.max(0, rect.x - pad);
      const top = Math.max(0, rect.y - pad);
      const width = Math.min(meta.width - left, rect.w + 2 * pad);
      const height = Math.min(meta.height - top, rect.h + 2 * pad);
      const seq = String(shots.filter((s) => s.scene === scene).length + 1).padStart(2, '0');
      const file = `${scene}-${seq}-${name}.png`;
      await sharp(source).extract({ left, top, width, height }).toFile(path.join(outDir, file));
      shots.push({ file, scene, description: `${description} (crop)`, rects: [] });
      console.log(`[promo] saved ${file}`);
    },
    writeManifest() {
      const file = path.join(outDir, 'shots.json');
      // A scene's stills and its sequences are captured by different runs; a rerun replaces only its own kind.
      const kind = (s) => `${s.scene}:${s.sequence ? 'sequence' : 'still'}`;
      const ran = new Set(shots.map(kind));
      const earlier = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).shots.filter((s) => !ran.has(kind(s))) : [];
      const all = [...earlier, ...shots].sort((a, b) => a.file.localeCompare(b.file));
      const body = JSON.stringify({ width: WIDTH * SCALE, height: HEIGHT * SCALE, shots: all }, null, 2);
      fs.writeFileSync(file, `${body}\n`);
    },
  };
}

/**
 * Plays the CSS animations and transitions that `trigger()` starts as real frames: they are paused at the
 * start and stepped through `frames` times (the page renders each step as it would at that moment), then
 * finished. `onFrame(i)` takes the screenshot. Returns the length of the animation in ms.
 */
export async function stepAnimations(d, trigger, frames, onFrame) {
  await trigger();
  const total = await d.page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const running = document.getAnimations();
    for (const a of running) a.pause();
    globalThis.__promoAnims = running;
    return Math.max(0, ...running.map((a) => a.effect?.getComputedTiming().endTime ?? 0));
  });
  for (let i = 0; i < frames; i++) {
    const t = (total * i) / Math.max(1, frames - 1);
    await d.page.evaluate(async (time) => {
      for (const a of globalThis.__promoAnims) a.currentTime = Math.min(time, a.effect?.getComputedTiming().endTime ?? time);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, t);
    await onFrame(i);
  }
  await d.page.evaluate(() => {
    for (const a of globalThis.__promoAnims) a.finish();
    globalThis.__promoAnims = [];
  });
  return total;
}
