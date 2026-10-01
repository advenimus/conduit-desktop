#!/usr/bin/env node
// One-off pass for the stacked agent panes in the AI panel: open 1, 2 and 3 agents, check + is disabled
// at 3, close the middle one with its X, and ask the main process which agent terminals are still alive.
// Writes .verify/agent-panes/<mode>-<nn>-<name>.png. Usage: node scripts/verify/capture-agent-panes.mjs [--mode dark|light]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { startTestSite } from './lib/restyle-data.mjs';
import { launchInMode, referenceMain } from './lib/restyle-flows.mjs';
import { captureWindow } from './lib/window-capture.mjs';
import { invoke, mainEval, sleep, waitFor } from './lib/ui.mjs';

const MODES = Object.freeze(['dark', 'light']);
const PLUS = '[data-cv-ai-header] button[aria-label="New agent"]';

function parseArgs(argv) {
  const i = argv.indexOf('--mode');
  const modes = i === -1 ? MODES : [argv[i + 1]];
  if (!modes.every((m) => MODES.includes(m))) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  return { modes };
}

function readPanes(d) {
  return d.page.evaluate((plusSel) => {
    const plus = document.querySelector(plusSel);
    const panes = [...document.querySelectorAll('[data-agent-pane]')].map((el) => ({
      id: el.getAttribute('data-agent-pane'),
      session: el.querySelector('[data-agent-session]')?.getAttribute('data-agent-session') ?? null,
      header: el.querySelector('.h-6 button[aria-haspopup]')?.textContent ?? null,
      close: !!el.querySelector('button[aria-label^="Close"]'),
      height: Math.round(el.getBoundingClientRect().height),
      text: el.innerText.slice(0, 80),
    }));
    const focusedPane = document.activeElement?.closest('[data-agent-pane]')?.getAttribute('data-agent-pane') ?? null;
    const headerButtons = [...document.querySelectorAll('[data-cv-ai-header] button')].map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title'));
    return { headerButtons, panes, plusDisabled: plus?.disabled ?? null, plusTitle: plus?.getAttribute('title') ?? null, focusedPane };
  }, PLUS);
}

async function waitForPanes(d, count) {
  return waitFor(async () => {
    const s = await readPanes(d);
    return s.panes.length === count && s.panes.every((p) => p.session) ? s : null;
  }, { timeoutMs: 30_000, label: `${count} agent panes running` });
}

function clickIn(d, selector) {
  return d.page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    el.click();
    return true;
  }, selector);
}

async function openPaneMenu(d, paneId) {
  await d.page.evaluate((id) => {
    document.querySelector(`[data-agent-pane="${id}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }, paneId);
  return clickIn(d, `[data-agent-pane="${paneId}"] button[aria-haspopup="menu"]`);
}

async function pickMenuItem(d, name) {
  await waitFor(() => d.page.evaluate((n) => [...document.querySelectorAll('[role=menu] [role=menuitem]')].some((el) => el.textContent.startsWith(n)), name), { timeoutMs: 5_000, label: `menu item ${name}` });
  await d.page.evaluate((n) => [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((el) => el.textContent.startsWith(n)).click(), name);
}

async function switchPaneEngine(d, paneId, name) {
  await openPaneMenu(d, paneId);
  await sleep(300);
  await pickMenuItem(d, name);
}

async function alive(d, sessions) {
  const out = {};
  for (const id of sessions) out[id] = await invoke(d, 'terminal_is_connected', { sessionId: id });
  return out;
}

function childProcesses(pid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  return rows.map((r) => r.trim().split(/\s+/)).filter((c) => c[1] === String(pid)).map((c) => c.slice(2).join(' '));
}

async function captureMode(ctx, { mode, outDir, siteUrl }) {
  const d = await launchInMode(ctx, 'ap', mode, { settings: { engine_picker_completed: true, default_engine: 'claude-code' } });
  const failures = [];
  const report = [];
  let seq = 0;
  const shot = async (name) => {
    seq += 1;
    await sleep(1500);
    const file = path.join(outDir, `${mode}-${String(seq).padStart(2, '0')}-${name}.png`);
    await captureWindow(d, file, { method: 'page', overlays: [] });
    console.log(`[agent-panes] saved ${path.basename(file)}`);
  };
  const check = (label, ok, detail) => {
    report.push(`${ok ? 'PASS' : 'FAIL'} ${mode} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
    if (!ok) failures.push(`${mode} ${label}`);
  };
  try {
    await referenceMain(d, { siteUrl, sessions: false });
    await d.page.evaluate(() => {
      const btn = document.querySelector('[data-cv-ai-toggle]');
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    });
    const mainPid = await mainEval(d, () => process.pid);

    const one = await waitForPanes(d, 1);
    check('one pane has no pane header or X', !one.panes[0].close, one);
    check('one pane keeps the top engine switcher', one.headerButtons.includes('Switch engine for this session'), one.headerButtons);
    await shot('one-agent');

    await clickIn(d, PLUS);
    const two = await waitForPanes(d, 2);
    check('two panes each have an X', two.panes.every((p) => p.close), two);
    check('two panes leave only + in the top header', two.headerButtons.join() === 'New agent', two.headerButtons);
    await sleep(800);
    const twoFocus = await readPanes(d);
    check('keyboard focus moved to the new pane', twoFocus.focusedPane === two.panes[1].id, twoFocus);
    await shot('two-agents');

    await clickIn(d, PLUS);
    const three = await waitForPanes(d, 3);
    check('+ is disabled at three with the limit tooltip', three.plusDisabled === true && /Up to 3/.test(three.plusTitle ?? ''), three);
    const heights = three.panes.map((p) => p.height);
    check('three panes share the height equally', Math.max(...heights) - Math.min(...heights) <= 2, heights);
    await sleep(800);
    const threeFocus = await readPanes(d);
    check('keyboard focus moved to the third pane', threeFocus.focusedPane === three.panes[2].id, threeFocus);
    const firstSessions = three.panes.map((p) => p.session);
    check('all three terminals alive in the main process', Object.values(await alive(d, firstSessions)).every(Boolean), await alive(d, firstSessions));
    await shot('three-agents');

    await switchPaneEngine(d, three.panes[1].id, 'Codex');
    await openPaneMenu(d, three.panes[2].id);
    await shot('bottom-pane-engine-menu');
    await pickMenuItem(d, 'Grok Build');
    const mixed = await waitFor(async () => {
      const s = await readPanes(d);
      return s.panes.length === 3 && s.panes.every((p, i) => p.session && (i === 0 || p.session !== firstSessions[i])) ? s : null;
    }, { timeoutMs: 30_000, label: 'panes 2 and 3 restarted' });
    check('pane headers show Claude Code, Codex, Grok Build', mixed.panes.map((p) => p.header).join('|') === 'Claude Code|Codex|Grok Build', mixed.panes.map((p) => p.header));
    check('pane 1 kept its terminal', mixed.panes[0].session === firstSessions[0], mixed);
    const sessions = mixed.panes.map((p) => p.session);
    await sleep(3000);
    const swapped = await alive(d, [...firstSessions.slice(1), ...sessions]);
    check('swapped panes ended their old terminals, all three new ones alive', !swapped[firstSessions[1]] && !swapped[firstSessions[2]] && sessions.every((id) => swapped[id]), swapped);
    const kidsAtThree = childProcesses(mainPid);
    check('claude, codex and grok run side by side under the main process', ['claude', 'codex', 'grok'].every((bin) => kidsAtThree.some((c) => c.includes(bin))), kidsAtThree);
    await shot('mixed-engines');

    const sash = await d.page.evaluate(() => {
      const r = document.querySelector('[data-agent-pane] + [role=separator], [role=separator]')?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    await d.page.mouse.move(sash.x, sash.y);
    await d.page.mouse.down();
    await d.page.mouse.move(sash.x, sash.y + 40, { steps: 4 });
    await d.page.mouse.move(sash.x, sash.y + 80, { steps: 4 });
    await d.page.mouse.up();
    const dragged = (await readPanes(d)).panes.map((p) => p.height);
    check('dragging the first divider grows the top pane and shrinks the middle one', dragged[0] - heights[0] >= 70 && heights[1] - dragged[1] >= 70 && Math.abs(dragged[2] - heights[2]) <= 2, { heights, dragged });
    await shot('three-agents-dragged');

    await clickIn(d, `[data-agent-pane="${three.panes[1].id}"] button[aria-label^="Close"]`);
    const after = await waitForPanes(d, 2);
    check('the middle pane is gone and the outer two stay', after.panes.map((p) => p.id).join() === [three.panes[0].id, three.panes[2].id].join(), after);
    check('+ is enabled again', after.plusDisabled === false, after);
    await sleep(1500);
    const live = await alive(d, sessions);
    check('main process: closed pane terminal is gone, others alive', live[sessions[0]] && !live[sessions[1]] && live[sessions[2]], live);
    const kidsAfter = childProcesses(mainPid);
    check('one fewer pty child of the main process', kidsAfter.length === kidsAtThree.length - 1, { kidsAtThree, kidsAfter });
    await shot('middle-closed');
  } catch (err) {
    failures.push(`${mode} stopped: ${err.message}`);
  } finally {
    await ctx.quitDevice(d).catch(() => {});
  }
  for (const line of report) console.log(`[agent-panes] ${line}`);
  return failures;
}

async function main() {
  const { modes } = parseArgs(process.argv.slice(2));
  const outDir = path.join(VERIFY_DIR, 'agent-panes');
  fs.mkdirSync(outDir, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const log = (m) => console.log(`[agent-panes] ${m}`);
  log.file = (name) => run.logPath(name);
  const failures = [];
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const site = await startTestSite(run);
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      for (const mode of modes) failures.push(...(await captureMode(ctx, { mode, outDir, siteUrl: site.url })));
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
    console.error(`[agent-panes] ${err.message}`);
    process.exit(2);
  },
);
