#!/usr/bin/env node
// One-off screenshot pass for the unified title bar: the main window in each side bar mode, with the AI
// panel, split panes and the Vault Hub, in dark and light. Writes .verify/titlebar/<set>/<mode>-<nn>-<name>.png.
// Quiet devices are invisible, so the page is captured and the macOS window buttons are drawn where the
// main process says they sit. CV_QUIET=0 shows the windows and captures them natively instead.
// Usage: node scripts/verify/capture-titlebar.mjs <before|after> [--mode dark|light]

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { startTestSite } from './lib/restyle-data.mjs';
import { launchInMode, referenceMain } from './lib/restyle-flows.mjs';
import { setSidebar, withStores } from './lib/restyle-data.mjs';
import { captureWindow } from './lib/window-capture.mjs';
import { clickSelector, mainEval, sleep } from './lib/ui.mjs';

const SETS = Object.freeze(['before', 'after']);
const MODES = Object.freeze(['dark', 'light']);
const NATIVE = process.platform === 'darwin' && process.env.CV_QUIET === '0';
// Classic macOS window buttons: 12px circles 20px apart.
const BUTTON_D = 12;
const BUTTON_STEP = 20;
const BUTTON_COLORS = Object.freeze(['#ff5f57', '#febc2e', '#28c840']);

function parseArgs(argv) {
  const set = argv[0];
  if (!SETS.includes(set)) throw new Error('usage: node scripts/verify/capture-titlebar.mjs <before|after> [--mode dark|light]');
  const i = argv.indexOf('--mode');
  const modes = i === -1 ? MODES : [argv[i + 1]];
  if (!modes.every((m) => MODES.includes(m))) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  return { set, modes };
}

function windowButtons(d) {
  return mainEval(d, ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible() && !w.webContents.getURL().includes('.html'));
    if (!win) return null;
    return { pos: win.getWindowButtonPosition?.() ?? null, frame: win.getBounds(), content: win.getContentBounds() };
  }, undefined, { label: 'window buttons' });
}

async function drawButtons(file, buttons) {
  if (!buttons?.pos) return;
  const top = buttons.content.y - buttons.frame.y;
  const circles = BUTTON_COLORS.map((c, i) => {
    const cx = buttons.pos.x + i * BUTTON_STEP + BUTTON_D / 2;
    const cy = buttons.pos.y - top + BUTTON_D / 2;
    return `<circle cx="${cx}" cy="${cy}" r="${BUTTON_D / 2}" fill="${c}"/>`;
  }).join('');
  const meta = await sharp(file).metadata();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${circles}</svg>`);
  const out = await sharp(file).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
  fs.writeFileSync(file, out);
}

function recorder(d, mode, outDir) {
  let seq = 0;
  const shots = [];
  return {
    shots,
    async shot(name, what) {
      seq += 1;
      const file = `${mode}-${String(seq).padStart(2, '0')}-${name}.png`;
      const out = path.join(outDir, file);
      await sleep(500);
      const res = await captureWindow(d, out, { method: NATIVE ? 'window' : 'page', overlays: [] });
      if (res.method === 'page') await drawButtons(out, await windowButtons(d));
      shots.push({ file, what: `${what} (${mode})` });
      console.log(`[titlebar] saved ${file}`);
    },
  };
}

function setAiPanel(d, open) {
  return d.page.evaluate((want) => {
    const btn = document.querySelector('[data-cv-ai-toggle]');
    if (btn && (btn.getAttribute('aria-pressed') === 'true') !== want) btn.click();
    return true;
  }, open);
}

async function captureMode(ctx, { mode, outDir, siteUrl }) {
  const d = await launchInMode(ctx, 'tb', mode);
  const rec = recorder(d, mode, outDir);
  const failures = [];
  const section = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${mode} ${label}: ${err.message}`);
    }
  };
  try {
    await section('main', async () => {
      await referenceMain(d, { siteUrl });
      await rec.shot('docked-split', 'Side bar docked, two panes');
      await setSidebar(d, 'hidden');
      await rec.shot('hidden-split', 'Side bar hidden, two panes');
      await setSidebar(d, 'floating');
      await rec.shot('floating', 'Side bar floating open');
      await setSidebar(d, 'hidden');
      await setAiPanel(d, true);
      await rec.shot('hidden-ai', 'Side bar hidden, AI panel open');
      await setSidebar(d, 'docked');
      await rec.shot('docked-ai', 'Side bar docked, AI panel open');
      await setAiPanel(d, false);
      await withStores(d, (_, s) => {
        const layout = s.layout.getState();
        const walk = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(walk));
        const right = walk(layout.root)[1];
        if (right) layout.splitPane(right.id, 'vertical', right.activeSessionId);
        return true;
      }, null, { label: 'split down' });
      await setSidebar(d, 'hidden');
      await rec.shot('hidden-split-down', 'Side bar hidden, right pane split down');
    });
    await section('hub', async () => {
      await ctx.flows.lockVault(d);
      await ctx.flows.waitForScreen(d, 'hub');
      await rec.shot('vault-hub', 'Vault Hub');
    });
  } finally {
    await ctx.quitDevice(d).catch(() => {});
  }
  return { shots: rec.shots, failures };
}

async function main() {
  const { set, modes } = parseArgs(process.argv.slice(2));
  const outDir = path.join(VERIFY_DIR, 'titlebar', NATIVE ? `${set}-native` : set);
  fs.mkdirSync(outDir, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const log = (m) => console.log(`[titlebar] ${m}`);
  log.file = (name) => run.logPath(name);
  const failures = [];
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const site = await startTestSite(run);
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      for (const mode of modes) failures.push(...(await captureMode(ctx, { mode, outDir, siteUrl: site.url })).failures);
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message}`);
  } finally {
    await run.runCleanup();
  }
  for (const f of failures) log(`  FAILED ${f}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[titlebar] ${err.message}`);
    process.exit(2);
  },
);
