#!/usr/bin/env node
// One-off screenshot pass for the Home dashboard package (docs/DASHBOARD.md 10.3): one quiet device per
// mode in local mode, the dashboard IPC answered by temporary fake handlers, no checks. Writes
// .verify/dashboard/home/<mode>-<nn>-<name>.png and INDEX.md.
// Usage: node scripts/verify/capture-dashboard-home.mjs [--mode dark|light]

import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createVault, enterLocalMode, waitForScreen } from './lib/flows.mjs';
import { launchInMode } from './lib/restyle-flows.mjs';
import { fillAcme, openEntry, openTerminal, setSidebar, startTestSite, vaultPath, withStores, ACME, VAULT_PASSWORD } from './lib/restyle-data.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { clickSelector, clickText, mainEval, pressKey, sleep, typeInto, waitFor, waitForText, withTimeout } from './lib/ui.mjs';
import { captureWindow } from './lib/window-capture.mjs';

const MODES = Object.freeze(['dark', 'light']);
const SETTLE_MS = 400;
const HOME_ID = '__home__';
const COMBOBOX = 'input[role=combobox]';
const DAY_MIN = 60 * 24;

function parseArgs(argv) {
  const i = argv.indexOf('--mode');
  const modes = i === -1 ? MODES : [argv[i + 1]];
  if (!modes.every((m) => MODES.includes(m))) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  return { modes };
}

/**
 * The DATA package's handlers are not on this branch: answer the eight dashboard channels from
 * globalThis.__homeFixtures, which fixtures() fills once the entry ids exist. Times are minutes ago.
 */
function installFakeHandlers(d) {
  return mainEval(d, ({ ipcMain }) => {
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    const fx = () => globalThis.__homeFixtures ?? { recent: [], ages: [], ai: [] };
    const channels = {
      connection_history_start: () => ({ id: `fake-${Date.now()}` }),
      connection_history_end: () => undefined,
      connection_history_recent: () => fx().recent.map((r) => ({ ...r, lastStartedAt: ago(r.min), lastEndedAt: null, lastDurationMs: null, count: 2 })),
      connection_history_for_entry: () => [],
      connection_history_clear: () => {
        const deleted = fx().recent.length;
        fx().recent = [];
        return { deleted };
      },
      password_age_list: () => fx().ages.map((a) => ({ entryId: a.entryId, setAt: ago(a.min), source: 'created' })),
      ai_activity_recent: () => ({ items: fx().ai.map((a) => ({ ...a, at: ago(a.min), durationMs: 12 })), logFound: true }),
      reachability_check: (_e, args) => ({ entryId: args?.entryId ?? '', status: 'not_checkable', host: null, port: null, latencyMs: null, checkedAt: ago(0) }),
    };
    for (const [channel, fn] of Object.entries(channels)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, fn);
    }
    return true;
  }, undefined, { label: 'install fake dashboard handlers' });
}

function setFixtures(d, ids, sessions) {
  const fixtures = {
    recent: [
      { entryId: ids.web, protocol: 'ssh', lastOutcome: 'open', min: 1 },
      { entryId: ids.dc, protocol: 'rdp', lastOutcome: 'closed', min: 125 },
      { entryId: ids.site, protocol: 'web', lastOutcome: 'failed', min: DAY_MIN + 90 },
      { entryId: ids.db, protocol: 'ssh', lastOutcome: 'closed', min: 3 * DAY_MIN },
    ],
    ages: [
      { entryId: ids.admin, min: 400 * DAY_MIN },
      { entryId: ids.db, min: 250 * DAY_MIN },
      { entryId: ids.dc, min: 20 * DAY_MIN },
    ],
    ai: [
      { tool: 'terminal_execute', outcome: 'success', entryId: ids.web, sessionId: null, min: 2 },
      { tool: 'website_screenshot', outcome: 'error', entryId: null, sessionId: sessions.site, min: 9 },
      { tool: 'entry_list', outcome: 'success', entryId: null, sessionId: null, min: 14 },
      { tool: 'credential_read', outcome: 'access_denied', entryId: ids.admin, sessionId: null, min: 40 },
      { tool: 'rdp_screenshot', outcome: 'rate_limited', entryId: ids.dc, sessionId: null, min: 65 },
    ],
  };
  return mainEval(d, (_, f) => {
    globalThis.__homeFixtures = f;
    return true;
  }, fixtures, { label: 'set dashboard fixtures' });
}

/** The renderer states Needs attention reads: a sync review, a stale local backup, a full plan and a trial. */
function attentionState(d) {
  return withTimeout(d.page.evaluate(async () => {
    const { useSyncStore } = await import('/src/stores/syncStore.ts');
    const { useTierStore } = await import('/src/stores/tierStore.ts');
    const { useVaultStore } = await import('/src/stores/vaultStore.ts');
    const status = {
      lineageId: 'fake', fileName: 'Acme Infrastructure.conduit', kind: 'up-to-date', pauseReason: null, waiting: null,
      pendingPublish: false, unsyncedOps: 0, conflictCount: 2, lastSyncedMs: Date.now(), backoffUntilMs: null,
      sessionBadge: null, networkRoot: false, prompts: [], otherCopies: [],
    };
    useSyncStore.setState({ state: { enabled: true, killSwitch: false, vault: null, status, deviceLimit: null, sideFiles: [], notices: [], pendingVaults: [], softLocked: false, ownership: null, deviceCap: null } });
    useTierStore.setState({ maxConnections: 5, isTrialing: true, trialDaysRemaining: 2 });
    useVaultStore.setState({
      localBackupState: { status: 'backed-up', lastBackedUpAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), error: null, enabled: true, backupPath: '/tmp', retentionDays: 7 },
    });
    return true;
  }), 15_000, `${d.name}: attention state`);
}

function focusHome(d) {
  return withStores(d, (id, s) => {
    const { sessions, addSession } = s.session.getState();
    if (!sessions.some((x) => x.id === id)) addSession({ id, type: 'dashboard', title: 'Home', status: 'connected' });
    const layout = s.layout.getState();
    const walk = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(walk));
    const pane = walk(layout.root).find((l) => l.sessionIds.includes(id));
    layout.setFocusedPane(pane.id);
    layout.setActiveSessionInPane(pane.id, id);
    return true;
  }, HOME_ID, { label: 'focus Home' });
}

/** Scrolls the visible Home page so `selector` (or the bottom) is in view. */
function scrollHome(d, selector) {
  return withTimeout(d.page.evaluate((sel) => {
    const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent.startsWith('Welcome back') && h.getClientRects().length > 0);
    const scroller = h1?.closest('.overflow-y-auto');
    if (!scroller) return false;
    if (sel === 'top') scroller.scrollTop = 0;
    else if (sel === 'bottom') scroller.scrollTop = scroller.scrollHeight;
    else document.querySelector(sel)?.scrollIntoView({ block: 'center' });
    return true;
  }, selector), 10_000, `${d.name}: scroll Home`);
}

function recorder(d, mode, outDir) {
  let seq = 0;
  const shots = [];
  return {
    shots,
    async shot(name, what) {
      seq += 1;
      const file = `${mode}-${String(seq).padStart(2, '0')}-${name}.png`;
      await sleep(SETTLE_MS);
      await captureWindow(d, path.join(outDir, file), { method: 'page' });
      shots.push({ file, what: `${what} (${mode})` });
      console.log(`[home] saved ${file}`);
    },
  };
}

async function captureMode(ctx, { mode, outDir, siteUrl }) {
  const d = await launchInMode(ctx, 'home', mode);
  const rec = recorder(d, mode, outDir);
  const failures = [];
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${mode} ${label}: ${err.message.split('\n')[0]}`);
      console.log(`[home] ${mode} ${label} failed: ${err.message}`);
      for (let i = 0; i < 3; i++) await pressKey(d, 'Escape').catch(() => {});
    }
  };
  try {
    await installFakeHandlers(d);
    await enterLocalMode(d);
    await createVault(d, vaultPath(d, ACME), VAULT_PASSWORD);
    await waitForScreen(d, 'main');
    await setSidebar(d, 'hidden');
    await focusHome(d);
    await waitForText(d, 'Welcome to Conduit');
    await rec.shot('empty-vault-welcome', 'Home in an empty vault: the welcome block');

    const ids = await fillAcme(d, { siteUrl });
    await openTerminal(d);
    await openEntry(d, ids.web);
    const site = await openEntry(d, ids.site);
    await setFixtures(d, ids, { site });
    await attentionState(d);
    // Home mounted its cards before the fixtures existed (AI activity polls only every 30 s): open it afresh.
    await withStores(d, (id, s) => {
      s.session.getState().removeSession(id);
      return true;
    }, HOME_ID, { label: 'close Home' });
    await sleep(200);
    await focusHome(d);
    await waitForText(d, 'Recently connected', { timeoutMs: 15_000 });
    await waitForText(d, 'Recent tool calls from AI agents on this device', { timeoutMs: 15_000 });
    await waitForText(d, 'passwords older than', { timeoutMs: 15_000 });
  } catch (err) {
    failures.push(`${mode} setup: ${err.message.split('\n')[0]}`);
    await ctx.quitDevice(d);
    return { shots: rec.shots, failures };
  }

  await step('full Home', async () => {
    await scrollHome(d, 'top');
    await rec.shot('home-top', 'Home, every section filled, top of the page (side bar hidden)');
    await scrollHome(d, 'bottom');
    await rec.shot('home-bottom', 'Home, every section filled, scrolled to the bottom');
    await setSidebar(d, 'docked');
    await scrollHome(d, 'top');
    await rec.shot('home-top-sidebar-docked', 'Home with the side bar docked (narrower column)');
    await setSidebar(d, 'hidden');
  });

  await step('search', async () => {
    await scrollHome(d, 'top');
    await withTimeout(d.page.evaluate((sel) => document.querySelector(sel)?.focus(), COMBOBOX), 10_000, 'focus search');
    await typeInto(d, COMBOBOX, 'in');
    await waitFor(async () => (await withTimeout(d.page.evaluate(() => document.querySelectorAll('[role=option]').length), 5_000, 'count options')) > 1, { timeoutMs: 10_000, label: 'search results' });
    await pressKey(d, 'ArrowDown');
    await rec.shot('search-results', 'Quick bar search "in" with results, second row active');
    await pressKey(d, 'Escape');
  });

  await step('password list', async () => {
    await attentionState(d);
    await clickText(d, 'Show', { exact: true, selector: '[data-attention="password-age"] button' });
    await waitForText(d, 'Hide');
    await scrollHome(d, '[data-attention="password-age"]');
    await rec.shot('attention-password-list', 'Needs attention with the password list open');
    await clickText(d, 'Hide', { exact: true, selector: '[data-attention="password-age"] button' });
  });

  await step('customize', async () => {
    await scrollHome(d, 'top');
    await clickText(d, 'Customize', { exact: true, selector: 'button' });
    await waitForText(d, 'Customize Home');
    await rec.shot('customize-popover', 'Customize popover');
    await clickText(d, 'Favorites', { exact: true, selector: '[aria-label="Customize Home"] label' });
    await clickText(d, 'AI activity', { exact: true, selector: '[aria-label="Customize Home"] label' });
    await pressKey(d, 'Escape');
    await sleep(300);
    await clickSelector(d, 'h1');
    await rec.shot('home-two-hidden', 'Home with Favorites and AI activity hidden');
    await scrollHome(d, 'bottom');
    await rec.shot('home-two-hidden-bottom', 'Home with Favorites and AI activity hidden, scrolled to the bottom');
  });

  await ctx.quitDevice(d);
  return { shots: rec.shots, failures };
}

function writeIndex(outDir, shots, failures) {
  const lines = [
    '# Home dashboard screenshots',
    '',
    `Captured ${new Date().toISOString().slice(0, 10)} with \`node scripts/verify/capture-dashboard-home.mjs\` on branch \`advenimus/dashboard-home\`.`,
    'Local mode, vault "Acme Infrastructure"; the dashboard IPC is answered by temporary fake handlers (the DATA package is not on this branch).',
    '',
    '| File | Shows |',
    '|---|---|',
    ...shots.map((s) => `| \`${s.file}\` | ${s.what} |`),
  ];
  if (failures.length > 0) lines.push('', '## Not captured', '', ...failures.map((f) => `- ${f}`));
  fs.writeFileSync(path.join(outDir, 'INDEX.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const { modes } = parseArgs(process.argv.slice(2));
  const outDir = path.join(VERIFY_DIR, 'dashboard', 'home');
  fs.mkdirSync(outDir, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const log = (m) => console.log(`[home] ${m}`);
  log.file = (name) => run.logPath(name);
  const shots = [];
  const failures = [];
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const site = await startTestSite(run);
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      for (const mode of modes) {
        const res = await captureMode(ctx, { mode, outDir, siteUrl: site.url });
        shots.push(...res.shots);
        failures.push(...res.failures);
      }
    } finally {
      await close();
    }
  } catch (err) {
    failures.push(`run stopped: ${err.message}`);
  } finally {
    await run.runCleanup();
  }
  writeIndex(outDir, shots.filter((s) => fs.existsSync(path.join(outDir, s.file))), failures);
  log(`${shots.length} shot(s) in ${path.relative(process.cwd(), outDir)}, ${failures.length} failure(s)`);
  for (const f of failures) log(`  FAILED ${f}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[home] ${err.message}`);
    process.exit(2);
  },
);
